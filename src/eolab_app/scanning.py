"""Run mounted-directory GeoTIFF scans and write their STAC records."""

import asyncio
import os
from contextlib import AbstractAsyncContextManager
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol
from uuid import uuid4

import httpx2

from eolab_app.geotiff import build_stac_item


MOUNTED_GEOTIFF_COLLECTION = {
    "type": "Collection",
    "stac_version": "1.0.0",
    "id": "eolab-mounted-geotiffs",
    "title": "Mounted GeoTIFFs",
    "description": (
        "GeoTIFF files discovered in the configured read-only EOLab scan source. "
        "When acquisition metadata is unavailable, an Item's datetime is the "
        "source file's filesystem modification time and its description identifies "
        "that fallback."
    ),
    "license": "other",
    "extent": {
        "spatial": {"bbox": [[-180, -90, 180, 90]]},
        "temporal": {"interval": [[None, None]]},
    },
    "links": [],
}


class CatalogWriteSession(Protocol):
    """Catalog operations required by one scan."""

    async def upsert_collection(self, collection: dict[str, Any]) -> None:
        """Create or replace a STAC Collection."""

    async def upsert_item(self, item: dict[str, Any]) -> None:
        """Create or replace a STAC Item."""


class CatalogWriter(Protocol):
    """Factory for a scan-scoped catalog write session."""

    def session(self) -> AbstractAsyncContextManager[CatalogWriteSession]:
        """Open one catalog write session."""


class StacApiWriter:
    """Write catalog records through the internal STAC Transactions API."""

    def __init__(
        self,
        catalog_internal_url: str,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        """Configure the internal catalog client."""
        self.catalog_internal_url = catalog_internal_url.rstrip("/")
        self.transport = transport

    def session(self) -> "StacApiWriteSession":
        """Open a shared HTTP session for one scan."""
        return StacApiWriteSession(self.catalog_internal_url, self.transport)


class StacApiWriteSession:
    """Create or update STAC records over one shared HTTP connection pool."""

    def __init__(
        self,
        catalog_internal_url: str,
        transport: httpx2.AsyncBaseTransport | None,
    ) -> None:
        self.catalog_internal_url = catalog_internal_url
        self.transport = transport
        self.client: httpx2.AsyncClient | None = None

    async def __aenter__(self) -> "StacApiWriteSession":
        self.client = httpx2.AsyncClient(
            base_url=self.catalog_internal_url,
            transport=self.transport,
            timeout=30,
        )
        return self

    async def __aexit__(self, *exception_details: object) -> None:
        if self.client is not None:
            await self.client.aclose()

    async def upsert_collection(self, collection: dict[str, Any]) -> None:
        """Create or replace a STAC Collection."""
        collection_identifier = collection["id"]
        await self._upsert(
            resource_path=f"/collections/{collection_identifier}",
            create_path="/collections",
            document=collection,
        )

    async def upsert_item(self, item: dict[str, Any]) -> None:
        """Create or replace a STAC Item."""
        collection_identifier = item["collection"]
        item_identifier = item["id"]
        await self._upsert(
            resource_path=(
                f"/collections/{collection_identifier}/items/{item_identifier}"
            ),
            create_path=f"/collections/{collection_identifier}/items",
            document=item,
        )

    async def _upsert(
        self,
        resource_path: str,
        create_path: str,
        document: dict[str, Any],
    ) -> None:
        if self.client is None:
            raise RuntimeError("Catalog write session has not been opened")

        existing_response = await self.client.get(resource_path)
        if existing_response.status_code == 404:
            write_response = await self.client.post(create_path, json=document)
        elif existing_response.is_success:
            write_response = await self.client.put(resource_path, json=document)
        else:
            _raise_catalog_error(existing_response)
            return

        if not write_response.is_success:
            _raise_catalog_error(write_response)


class ScanManager:
    """Own the single in-process scan and its observable progress."""

    def __init__(self, source_root: Path, catalog_writer: CatalogWriter) -> None:
        self.source_root = source_root
        self.catalog_writer = catalog_writer
        self._start_lock = asyncio.Lock()
        self._task: asyncio.Task[None] | None = None
        self._status = self._new_status("not_started")

    def status(self) -> dict[str, Any]:
        """Return an isolated snapshot of current scan progress."""
        return deepcopy(self._status)

    async def start(self) -> dict[str, Any]:
        """Start a scan unless one is already running.

        Returns:
            Initial status for the newly started scan.

        Raises:
            RuntimeError: If a scan is already running.
        """
        async with self._start_lock:
            if self._task is not None and not self._task.done():
                raise RuntimeError("A GeoTIFF scan is already running")
            self._status = self._new_status("discovering")
            self._status["startedAt"] = _utc_now()
            self._task = asyncio.create_task(self._run())
            return self.status()

    async def _run(self) -> None:
        try:
            geotiff_paths, discovery_errors = await asyncio.to_thread(
                _discover_geotiffs,
                self.source_root,
            )
            self._status["discovered"] = len(geotiff_paths)
            self._status["failed"] = len(discovery_errors)
            self._status["errors"].extend(discovery_errors)
            self._status["state"] = "scanning"

            async with self.catalog_writer.session() as catalog_session:
                await catalog_session.upsert_collection(MOUNTED_GEOTIFF_COLLECTION)
                for geotiff_path in geotiff_paths:
                    relative_path = geotiff_path.relative_to(self.source_root).as_posix()
                    self._status["currentFile"] = relative_path
                    try:
                        item = await asyncio.to_thread(
                            build_stac_item,
                            self.source_root,
                            geotiff_path,
                        )
                        await catalog_session.upsert_item(item)
                    except Exception as error:
                        self._status["failed"] += 1
                        self._status["errors"].append(
                            {"path": relative_path, "error": str(error)}
                        )
                    else:
                        self._status["indexed"] += 1
                    finally:
                        self._status["processed"] += 1

            self._status["state"] = "completed"
        except Exception as error:
            self._status["state"] = "failed"
            self._status["errors"].append(
                {"path": None, "error": f"Scan stopped: {error}"}
            )
        finally:
            self._status["currentFile"] = None
            self._status["finishedAt"] = _utc_now()

    @staticmethod
    def _new_status(state: str) -> dict[str, Any]:
        return {
            "id": str(uuid4()),
            "state": state,
            "discovered": 0,
            "processed": 0,
            "indexed": 0,
            "failed": 0,
            "currentFile": None,
            "startedAt": None,
            "finishedAt": None,
            "errors": [],
        }


def _discover_geotiffs(source_root: Path) -> tuple[list[Path], list[dict[str, str]]]:
    geotiff_paths: list[Path] = []
    errors: list[dict[str, str]] = []

    def record_walk_error(error: OSError) -> None:
        error_path = Path(error.filename).relative_to(source_root).as_posix()
        errors.append({"path": error_path, "error": str(error)})

    for directory_path, directory_names, file_names in os.walk(
        source_root,
        onerror=record_walk_error,
    ):
        directory_names.sort()
        for file_name in sorted(file_names):
            if Path(file_name).suffix.lower() in {".tif", ".tiff"}:
                geotiff_paths.append(Path(directory_path) / file_name)
    return geotiff_paths, errors


def _raise_catalog_error(response: httpx2.Response) -> None:
    detail = response.text[:500]
    raise RuntimeError(
        f"STAC API returned {response.status_code} for {response.request.method} "
        f"{response.request.url.path}: {detail}"
    )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
