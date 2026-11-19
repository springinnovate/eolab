"""Store immutable, browser-owned GeoPackages on the application's upload volume.

One application process owns writes to this volume. Each upload is published by
renaming a directory containing its original file and metadata together. Pending
uploads and interrupted deletions are removed at application startup. Processing
retains hard links separately until its accepted calculations stop.
"""

import asyncio
from collections.abc import AsyncIterable
from datetime import datetime, timezone
import logging
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4

import fiona
from pydantic import BaseModel, ValidationError

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    ProcessResultWriter,
    run_bounded_process,
)
from eolab_app.upload_storage import (
    UploadError,
    UploadRecord,
    UploadStorage,
    UploadWriter,
    finish_upload_disk_operation,
    read_stored_upload,
)
from eolab_app.vector_field_values import (
    INVENTORY_ADAPTER,
    VectorFieldValuePage,
    VectorFieldValueQuery,
    VectorFieldValuesUnavailable,
    page_field_values,
    read_field_value_inventory,
)

LOGGER = logging.getLogger(__name__)


class VectorUploadError(Exception):
    """An upload admission, ownership or storage failure safe to return to a user."""

    def __init__(self, status: int, message: str) -> None:
        """Record the HTTP status and public explanation.

        Args:
            status: HTTP status representing this failure.
            message: Explanation without private paths or credentials.
        """
        super().__init__(message)
        self.status = status


class UploadLayer(BaseModel):
    """Metadata read once from the sole polygon layer of an admitted GeoPackage."""

    layer_name: str
    geometry_type: Literal["Polygon", "MultiPolygon"]
    crs_wkt: str
    fields: dict[str, str]


class VectorUpload(UploadLayer, UploadRecord):
    """Public upload record; its opaque ID never reveals a path or browser identity."""

    kind: Literal["vector"] = "vector"


def inspect_geopackage(result: ProcessResultWriter, path: Path) -> None:
    """Return an upload's layer metadata and private string inventory for admission.

    Args:
        result: Pipe receiving a pair of layer metadata and serialized string
            inventory, or a safe admission error string.
        path: Server-created staging file, never a client-supplied path. Its
            inventory retains up to 255 choices per field; the source is never
            rewritten. The upload owner budgets metadata before publication.
    """

    try:
        with fiona.open(path, enabled_drivers=["GPKG"]) as dataset:
            if len(fiona.listlayers(path)) != 1:
                raise VectorUploadError(
                    422, "Upload a GeoPackage with exactly one layer."
                )
            geometry = str(dataset.schema["geometry"]).removeprefix("3D ")
            if geometry not in {"Polygon", "MultiPolygon"}:
                raise VectorUploadError(
                    422, "The GeoPackage layer must contain polygons or multipolygons."
                )
            if not dataset.crs:
                raise VectorUploadError(
                    422, "The GeoPackage layer needs a coordinate reference system."
                )
            metadata = UploadLayer(
                layer_name=dataset.name,
                geometry_type=geometry,
                crs_wkt=dataset.crs.to_wkt(),
                fields=dict(dataset.schema["properties"]),
            )
        inventory = read_field_value_inventory(
            str(path), metadata.layer_name, metadata.fields
        )
        serialized_inventory = INVENTORY_ADAPTER.dump_json(inventory)
    except VectorUploadError as error:
        result.put(str(error))
    except (fiona.errors.FionaError, RuntimeError, ValueError, OSError):
        result.put("The file could not be read as a GeoPackage.")
    else:
        result.put((metadata, serialized_inventory))


class VectorUploadStore:
    """Own upload admission, private metadata and removal on a persistent volume."""

    def __init__(
        self, root: Path, max_bytes: int | None, *, storage: UploadStorage | None = None
    ) -> None:
        """Configure storage without touching the filesystem.

        Args:
            root: Absolute upload directory validated by application settings.
            max_bytes: Optional stricter GeoPackage byte cap. Shared upload
                budgets always apply, including when this value is None.
            storage: Shared upload lifecycle composed once for all format adapters.
                Standalone callers use the same default budgets on this root.
        """
        self.root = root
        self.max_bytes = max_bytes
        self.storage = storage if storage is not None else UploadStorage(root)

    def initialize(self) -> None:
        """Remove interrupted writes before this application's routes begin serving.

        The deployment has one API writer. Published uploads are never inspected
        or modified here; their original files remain immutable across restarts.

        Raises:
            OSError: If the upload volume cannot be created or cleaned.
        """
        try:
            self.storage.initialize()
        except UploadError as error:
            raise VectorUploadError(error.status, str(error)) from error

    async def create(
        self,
        owner: str,
        name: str,
        chunks: AsyncIterable[bytes] | UploadWriter,
        *,
        identifier: UUID | None = None,
    ) -> VectorUpload:
        """Admit one private GeoPackage from a stream or writer and publish it atomically.

        Args:
            owner: Hash produced by the browser identity boundary.
            name: Display name validated by the upload HTTP boundary.
            chunks: Incoming body chunks or a writer for a new file within the
                upload budget. The complete file is never buffered.
            identifier: Optional server-assigned ID for a retriable admission.

        Returns:
            Published metadata describing the unchanged uploaded file.

        Raises:
            VectorUploadError: For oversized or invalid files and unavailable storage.
            asyncio.CancelledError: After native inspection and staging cleanup stop.
        """
        try:
            async with self.storage.stage(
                owner, "vector", chunks, max_bytes=self.max_bytes
            ) as pending:
                inspected = await run_bounded_process(
                    inspect_geopackage, (pending.source_path,), 60
                )
                if isinstance(inspected, str):
                    raise VectorUploadError(422, inspected)
                metadata, inventory = inspected
                upload = VectorUpload(
                    **metadata.model_dump(),
                    id=identifier if identifier is not None else uuid4(),
                    name=name,
                    size_bytes=pending.size_bytes,
                    created_at=datetime.now(timezone.utc),
                )
                await finish_upload_disk_operation(
                    lambda: self.storage.publish(
                        pending, upload, {"values.json": inventory}
                    )
                )
                return upload
        except UploadError as error:
            raise VectorUploadError(error.status, str(error)) from error
        except ProcessDeadlineError as error:
            raise VectorUploadError(
                422, "The GeoPackage could not be inspected within 60 seconds."
            ) from error
        except OSError as error:
            LOGGER.exception("Could not store vector upload")
            raise VectorUploadError(
                503, "Upload storage is unavailable. Try again shortly."
            ) from error

    def list_uploads(self, owner: str) -> list[VectorUpload]:
        """List this browser's published records without reopening their datasets.

        Args:
            owner: Hash produced by the browser identity boundary.

        Returns:
            Upload metadata, newest first; another browser's uploads are excluded.

        Raises:
            VectorUploadError: If persisted metadata or storage cannot be read.
        """
        try:
            uploads = []
            try:
                directories = list((self.root / owner).iterdir())
            except FileNotFoundError:
                return []
            for directory in directories:
                if directory.name.startswith("."):
                    continue
                try:
                    record = read_stored_upload(
                        (directory / "metadata.json").read_bytes()
                    )
                    if (
                        isinstance(record, UploadRecord)
                        and record.kind == "vector"
                        and record.expires_at > datetime.now(timezone.utc)
                    ):
                        uploads.append(self.get_upload_source(owner, record.id)[0])
                except FileNotFoundError:
                    # A concurrent deletion has withdrawn this published directory.
                    continue
            return sorted(uploads, key=lambda upload: upload.created_at, reverse=True)
        except (OSError, ValidationError) as error:
            LOGGER.exception("Could not list vector uploads")
            raise VectorUploadError(
                503, "Upload storage could not be read. Try again shortly."
            ) from error

    def get_upload_source(
        self, owner: str, identifier: UUID
    ) -> tuple[VectorUpload, Path]:
        """Return this browser's upload metadata and original GeoPackage path.

        The vector source resolver calls this to locate a file for its readers.
        The metadata and source paths must stay inside the requested upload's
        directory. The GeoPackage is immutable and is not reopened or rescanned.
        Returning its path does not prevent deletion; a later read can fail if
        the browser owner deletes the upload in the meantime.

        Args:
            owner: Hash produced by the browser identity boundary.
            identifier: Opaque upload ID validated by the HTTP boundary.

        Returns:
            Stored metadata and the original GeoPackage path on the server.

        Raises:
            VectorUploadError: If the upload is unavailable to this browser,
                either file is missing or outside its directory, or the stored
                metadata cannot be read.
        """
        try:
            _record, source_path = self.storage.get_upload_source(
                owner, identifier, "vector"
            )
            metadata_path = source_path.parent / "metadata.json"
            metadata = VectorUpload.model_validate_json(
                metadata_path.read_text(encoding="utf-8")
            )
            return metadata, source_path
        except UploadError as error:
            raise VectorUploadError(error.status, str(error)) from error
        except FileNotFoundError as error:
            raise VectorUploadError(
                404, "This upload is not available to this browser."
            ) from error
        except (OSError, ValidationError) as error:
            LOGGER.exception("Could not read vector upload metadata or locate its file")
            raise VectorUploadError(
                503, "Upload storage could not be read. Try again shortly."
            ) from error

    def get_field_values(
        self, owner: str, identifier: UUID, query: VectorFieldValueQuery
    ) -> VectorFieldValuePage:
        """Return a page of this browser's prepared upload field values.

        Args:
            owner: Hash supplied by the validated browser identity boundary.
            identifier: Opaque upload ID.
            query: Field, substring search and matching-value page bounds.

        Returns:
            Exact strings from stored metadata, without reopening the GeoPackage.

        Raises:
            VectorUploadError: If ownership/storage fails, the inventory is
                missing, or the field is not a prepared string field.
        """
        _metadata, source_path = self.get_upload_source(owner, identifier)
        try:
            values_path = (source_path.parent / "values.json").resolve(strict=True)
            if values_path.parent != source_path.parent:
                raise VectorUploadError(
                    404, "This upload is not available to this browser."
                )
            inventory = INVENTORY_ADAPTER.validate_json(values_path.read_bytes())
            return page_field_values(inventory, query)
        except FileNotFoundError as error:
            raise VectorUploadError(
                409, "Values were not prepared for this upload. Upload the file again."
            ) from error
        except VectorFieldValuesUnavailable as error:
            raise VectorUploadError(422, str(error)) from error
        except (OSError, ValidationError) as error:
            raise VectorUploadError(
                503, "Upload field values could not be read."
            ) from error

    def prepare_source_read(self, source_path: Path) -> None:
        """Allow the map server and Jobs worker to read an authorized upload.

        Args:
            source_path: Exact original path returned by get_upload_source. The
                caller has already checked ownership and path confinement.

        Raises:
            VectorUploadError: If filesystem permissions cannot be set. Readers
                mount this volume read-only; staging directories stay private.
        """
        try:
            for directory in (self.root, source_path.parent.parent, source_path.parent):
                directory.chmod(0o755)
            source_path.chmod(0o644)
            (source_path.parent / "metadata.json").chmod(0o644)
        except OSError as error:
            raise VectorUploadError(
                503, "The uploaded file could not be made readable by the server."
            ) from error

    def retain_source(self, source_path: Path) -> str:
        """Keep an authorized GeoPackage available after its upload is deleted.

        Creates a hard link on the upload volume without copying or inspecting
        the immutable file. Processing serializes this operation and admission
        with retained-file cleanup.

        Args:
            source_path: Original file returned by the authorized source resolver.

        Returns:
            Opaque server-only token identifying the retained file.

        Raises:
            VectorUploadError: If deletion wins before the link is made, or the
                retained file cannot be created or made readable by the worker.
        """
        try:
            return self.storage.retain_source(source_path)
        except UploadError as error:
            raise VectorUploadError(error.status, str(error)) from error

    def get_retained_source(self, token: str) -> Path:
        """Locate a GeoPackage retained for an accepted Processing calculation.

        Args:
            token: Server-only token recorded with the accepted job.

        Returns:
            Existing source path confined to retained upload storage.

        Raises:
            VectorUploadError: If the file is missing, outside retained storage,
                or its path cannot be read.
        """
        try:
            return self.storage.get_retained_source(token)
        except UploadError as error:
            raise VectorUploadError(error.status, str(error)) from error

    def remove_unretained_sources(self, active: set[str]) -> None:
        """Remove upload links no unfinished calculation needs.

        Processing calls this while holding its admission lock, after reading
        the authoritative active tokens from job storage. That also removes
        links left by interrupted or rejected admission.

        Args:
            active: Tokens used by queued, running or cancelling jobs.

        Raises:
            VectorUploadError: If retained storage cannot be accessed or cleaned.
        """
        try:
            self.storage.remove_unretained_sources(active)
        except UploadError as error:
            raise VectorUploadError(error.status, str(error)) from error

    def delete(self, owner: str, identifier: UUID) -> None:
        """Withdraw and delete one browser-owned upload and its original file.

        Args:
            owner: Hash produced by the browser identity boundary.
            identifier: Opaque upload ID validated by the HTTP boundary.

        Raises:
            VectorUploadError: If this browser has no such upload or deletion fails.
        """
        try:
            self.storage.delete(owner, identifier)
        except UploadError as error:
            raise VectorUploadError(error.status, str(error)) from error
