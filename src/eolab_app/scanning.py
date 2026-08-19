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
import psycopg

from eolab_app.geotiff import build_stac_item


STAC_ITEM_BATCH_SIZE = 100
MAX_SCAN_ERROR_DETAILS = 100
CATALOG_WRITE_TIMEOUT_SECONDS = 120

# The scanner currently puts all discovered Items in one fixed Collection.
# Collection metadata can move into scan configuration when EOLab supports
# independently described sources.
DEFAULT_SCAN_COLLECTION = {
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

    async def upsert_items(self, items: list[dict[str, Any]]) -> None:
        """Create or replace a batch of STAC Items."""


class CatalogWriter(Protocol):
    """Factory for a scan-scoped catalog write session."""

    def session(self) -> AbstractAsyncContextManager[CatalogWriteSession]:
        """Open one catalog write session."""


class CatalogDatabase(Protocol):
    """Provide the scanner's direct pgSTAC database operations."""

    async def existing_item_ids(self, collection_identifier: str) -> set[str]:
        """Return the identifiers already stored in one Collection."""

    async def invalidate_search_count_cache(self) -> None:
        """Discard cached Item Search counts after a scan."""


class PgStacCatalogDatabase:
    """Access pgSTAC through the standard libpq environment."""

    async def existing_item_ids(self, collection_identifier: str) -> set[str]:
        """Return the Item identifiers in one pgSTAC Collection."""
        async with await psycopg.AsyncConnection.connect() as connection:
            cursor = await connection.execute(
                "SELECT id FROM pgstac.items WHERE collection = %s",
                (collection_identifier,),
            )
            return {row[0] async for row in cursor}

    async def invalidate_search_count_cache(self) -> None:
        """Discard cached Item Search counts after a scan."""
        async with await psycopg.AsyncConnection.connect() as connection:
            await connection.execute("DELETE FROM pgstac.search_wheres")


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
            timeout=CATALOG_WRITE_TIMEOUT_SECONDS,
        )
        return self

    async def __aexit__(self, *exception_details: object) -> None:
        if self.client is not None:
            await self.client.aclose()

    async def upsert_collection(self, collection: dict[str, Any]) -> None:
        """Create or replace a STAC Collection."""
        if self.client is None:
            raise RuntimeError("Catalog write session has not been opened")

        collection_identifier = collection["id"]
        resource_path = f"/collections/{collection_identifier}"
        existing_response = await self.client.get(resource_path)
        if existing_response.status_code == 404:
            write_response = await self.client.post("/collections", json=collection)
        elif existing_response.is_success:
            write_response = await self.client.put(resource_path, json=collection)
        else:
            _raise_catalog_error(existing_response)
            return

        if not write_response.is_success:
            _raise_catalog_error(write_response)

    async def upsert_items(self, items: list[dict[str, Any]]) -> None:
        """Create or replace STAC Items through one Bulk Transaction request."""
        if self.client is None:
            raise RuntimeError("Catalog write session has not been opened")

        collection_identifier = items[0]["collection"]
        write_response = await self.client.post(
            f"/collections/{collection_identifier}/bulk_items",
            json={
                "method": "upsert",
                "items": {item["id"]: item for item in items},
            },
        )
        if not write_response.is_success:
            _raise_catalog_error(write_response)


class ScanManager:
    """Own the single in-process scan and its observable progress."""

    def __init__(
        self,
        source_root: Path,
        source_paths: tuple[Path, ...],
        catalog_writer: CatalogWriter,
        catalog_database: CatalogDatabase,
        metadata_worker_count: int,
    ) -> None:
        self.source_root = source_root
        self.source_paths = source_paths
        self.catalog_writer = catalog_writer
        self.catalog_database = catalog_database
        self.metadata_worker_count = metadata_worker_count
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
            existing_item_ids = (
                await self.catalog_database.existing_item_ids(
                    DEFAULT_SCAN_COLLECTION["id"]
                )
            )
            geotiff_paths, discovery_errors = await asyncio.to_thread(
                _discover_geotiffs,
                self.source_root,
                self.source_paths,
            )
            self._status["discovered"] = len(geotiff_paths)
            self._status["failed"] = len(discovery_errors)
            self._status["errors"].extend(
                discovery_errors[:MAX_SCAN_ERROR_DETAILS]
            )
            self._status["errorsTruncated"] = (
                len(discovery_errors) > MAX_SCAN_ERROR_DETAILS
            )
            self._status["state"] = "scanning"

            async with self.catalog_writer.session() as catalog_session:
                await catalog_session.upsert_collection(DEFAULT_SCAN_COLLECTION)
                path_queue: asyncio.Queue[Path | None] = asyncio.Queue(
                    maxsize=self.metadata_worker_count * 2
                )
                result_queue: asyncio.Queue[
                    tuple[Path, dict[str, Any] | Exception] | None
                ] = asyncio.Queue(maxsize=STAC_ITEM_BATCH_SIZE * 2)
                path_producer = asyncio.create_task(
                    _enqueue_geotiff_paths(
                        geotiff_paths,
                        path_queue,
                        self.metadata_worker_count,
                    )
                )
                metadata_workers = [
                    asyncio.create_task(
                        _read_geotiff_metadata(
                            self.source_root,
                            path_queue,
                            result_queue,
                        )
                    )
                    for _ in range(self.metadata_worker_count)
                ]
                pending_items: list[dict[str, Any]] = []
                completed_workers = 0
                try:
                    while completed_workers < self.metadata_worker_count:
                        metadata_result = await result_queue.get()
                        if metadata_result is None:
                            completed_workers += 1
                            continue

                        geotiff_path, item_or_error = metadata_result
                        relative_path = geotiff_path.relative_to(
                            self.source_root
                        ).as_posix()
                        self._status["currentFile"] = relative_path
                        self._status["processed"] += 1
                        if isinstance(item_or_error, Exception):
                            self._status["failed"] += 1
                            if len(self._status["errors"]) < MAX_SCAN_ERROR_DETAILS:
                                self._status["errors"].append(
                                    {
                                        "path": relative_path,
                                        "error": str(item_or_error),
                                    }
                                )
                            else:
                                self._status["errorsTruncated"] = True
                        else:
                            pending_items.append(item_or_error)

                        if len(pending_items) == STAC_ITEM_BATCH_SIZE:
                            await self._upsert_items(
                                catalog_session,
                                pending_items,
                                existing_item_ids,
                            )
                            pending_items = []
                finally:
                    path_producer.cancel()
                    for metadata_worker in metadata_workers:
                        metadata_worker.cancel()
                    await asyncio.gather(
                        path_producer,
                        *metadata_workers,
                        return_exceptions=True,
                    )

                if pending_items:
                    await self._upsert_items(
                        catalog_session,
                        pending_items,
                        existing_item_ids,
                    )

            await self.catalog_database.invalidate_search_count_cache()
            self._status["state"] = "completed"
        except Exception as error:
            self._status["state"] = "failed"
            self._status["errors"].append(
                {"path": None, "error": f"Scan stopped: {error}"}
            )
        finally:
            self._status["currentFile"] = None
            self._status["finishedAt"] = _utc_now()

    async def _upsert_items(
        self,
        catalog_session: CatalogWriteSession,
        items: list[dict[str, Any]],
        existing_item_ids: set[str],
    ) -> None:
        """Write one batch and classify its successfully cataloged Items."""
        await catalog_session.upsert_items(items)
        self._status["indexed"] += len(items)
        self._status["alreadyInCatalog"] += sum(
            item["id"] in existing_item_ids for item in items
        )

    @staticmethod
    def _new_status(state: str) -> dict[str, Any]:
        return {
            "id": str(uuid4()),
            "state": state,
            "discovered": 0,
            "processed": 0,
            "indexed": 0,
            "alreadyInCatalog": 0,
            "failed": 0,
            "currentFile": None,
            "startedAt": None,
            "finishedAt": None,
            "errors": [],
            "errorsTruncated": False,
        }


async def _enqueue_geotiff_paths(
    geotiff_paths: list[Path],
    path_queue: asyncio.Queue[Path | None],
    metadata_worker_count: int,
) -> None:
    """Feed discovered paths to a bounded metadata-work queue."""
    for geotiff_path in geotiff_paths:
        await path_queue.put(geotiff_path)
    for _ in range(metadata_worker_count):
        await path_queue.put(None)


async def _read_geotiff_metadata(
    source_root: Path,
    path_queue: asyncio.Queue[Path | None],
    result_queue: asyncio.Queue[
        tuple[Path, dict[str, Any] | Exception] | None
    ],
) -> None:
    """Read GeoTIFF metadata until the producer signals completion."""
    while (geotiff_path := await path_queue.get()) is not None:
        try:
            item_or_error = await asyncio.to_thread(
                build_stac_item,
                source_root,
                geotiff_path,
            )
        except Exception as error:
            item_or_error = error
        await result_queue.put((geotiff_path, item_or_error))
    await result_queue.put(None)


def _discover_geotiffs(
    source_root: Path,
    source_paths: tuple[Path, ...],
) -> tuple[list[Path], list[dict[str, str]]]:
    """Find GeoTIFFs recursively without stopping on unreadable directories.

    Args:
        source_root: Directory at the root of the configured scan mount.
        source_paths: Directories within the mount to search recursively.

    Returns:
        Discovered `.tif` and `.tiff` paths in deterministic traversal order,
        together with any directory-walk errors keyed by relative path.
    """
    geotiff_paths: list[Path] = []
    errors: list[dict[str, str]] = []

    def record_walk_error(error: OSError) -> None:
        error_path = Path(error.filename).relative_to(source_root).as_posix()
        errors.append({"path": error_path, "error": str(error)})

    for source_path in source_paths:
        for directory_path, directory_names, file_names in os.walk(
            source_path,
            onerror=record_walk_error,
        ):
            directory_names.sort()
            for file_name in sorted(file_names):
                if Path(file_name).suffix.lower() in {".tif", ".tiff"}:
                    geotiff_paths.append(Path(directory_path) / file_name)
    geotiff_paths.sort(key=lambda path: path.relative_to(source_root).as_posix())
    return geotiff_paths, errors


def _raise_catalog_error(response: httpx2.Response) -> None:
    detail = response.text[:500]
    raise RuntimeError(
        f"STAC API returned {response.status_code} for {response.request.method} "
        f"{response.request.url.path}: {detail}"
    )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
