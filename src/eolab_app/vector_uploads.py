"""Store immutable, browser-owned GeoPackages on the application's upload volume.

One application process owns writes to this volume. Each upload is published by
renaming a directory containing its original file and metadata together. Hidden
directories are incomplete uploads or deletions, removed at application startup.
"""

import asyncio
from collections.abc import AsyncIterable, Callable
from datetime import datetime, timezone
import logging
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
from typing import Literal, TypeVar
from uuid import UUID, uuid4

import fiona
from pydantic import BaseModel, ValidationError

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    ProcessResultWriter,
    run_bounded_process,
)
from eolab_app.source_files import finish_source_task

LOGGER = logging.getLogger(__name__)
T = TypeVar("T")


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


class VectorUpload(UploadLayer):
    """Public upload record; its opaque ID never reveals a path or browser identity."""

    id: UUID
    name: str
    size_bytes: int
    created_at: datetime


def inspect_geopackage(result: ProcessResultWriter, path: Path) -> None:
    """Inspect an untrusted file in a supervised native process without rewriting it.

    Args:
        result: Pipe receiving layer metadata or a safe admission error string.
        path: Server-created staging file, never a client-supplied path.
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
    except VectorUploadError as error:
        result.put(str(error))
    except (fiona.errors.FionaError, ValueError, OSError):
        result.put("The file could not be read as a GeoPackage.")
    else:
        result.put(metadata)


async def _finish_disk_operation(operation: Callable[[], T]) -> T:
    """Finish a disk operation before cancellation releases its file or directory.

    Args:
        operation: Synchronous upload-owned disk operation.

    Returns:
        The operation's result.

    Raises:
        asyncio.CancelledError: After the disk operation has stopped using its files.
        OSError: If the disk operation fails.
    """
    task = asyncio.create_task(asyncio.to_thread(operation))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await finish_source_task(task)
        raise


class VectorUploadStore:
    """Own upload admission, private metadata and removal on a persistent volume."""

    def __init__(self, root: Path, max_bytes: int | None) -> None:
        """Configure storage without touching the filesystem.

        Args:
            root: Absolute upload directory validated by application settings.
            max_bytes: Optional positive per-file limit validated by settings;
                None streams uploads without an application file-size cap.
        """
        self.root = root
        self.max_bytes = max_bytes
        self._admission = asyncio.Lock()

    def initialize(self) -> None:
        """Remove interrupted writes before this application's routes begin serving.

        The deployment has one API writer. Published uploads are never inspected
        or modified here; their original files remain immutable across restarts.

        Raises:
            OSError: If the upload volume cannot be created or cleaned.
        """
        self.root.mkdir(parents=True, exist_ok=True)
        for pattern in ("*/.pending-*", "*/.deleting-*"):
            for directory in self.root.glob(pattern):
                shutil.rmtree(directory)

    async def create(
        self, owner: str, name: str, chunks: AsyncIterable[bytes]
    ) -> VectorUpload:
        """Stream and admit one private GeoPackage, then publish it atomically.

        Args:
            owner: Hash produced by the browser identity boundary.
            name: Display name validated by the upload HTTP boundary.
            chunks: Incoming body chunks; no complete in-memory file is required.

        Returns:
            Published metadata describing the unchanged uploaded file.

        Raises:
            VectorUploadError: For oversized or invalid files and unavailable storage.
            asyncio.CancelledError: After native inspection and staging cleanup stop.
        """
        async with self._admission:
            try:
                owner_path = self.root / owner
                await _finish_disk_operation(
                    lambda: owner_path.mkdir(parents=True, exist_ok=True)
                )
                with TemporaryDirectory(prefix=".pending-", dir=owner_path) as staging:
                    pending = Path(staging)
                    size = 0
                    with (pending / "source.gpkg").open("wb") as output:
                        async for chunk in chunks:
                            size += len(chunk)
                            if self.max_bytes is not None and size > self.max_bytes:
                                raise VectorUploadError(
                                    413,
                                    f"The GeoPackage exceeds the upload limit of {self.max_bytes} bytes.",
                                )
                            await _finish_disk_operation(lambda: output.write(chunk))
                    metadata = await run_bounded_process(
                        inspect_geopackage, (pending / "source.gpkg",), 60
                    )
                    if isinstance(metadata, str):
                        raise VectorUploadError(422, metadata)
                    upload = VectorUpload(
                        **metadata.model_dump(),
                        id=uuid4(),
                        name=name,
                        size_bytes=size,
                        created_at=datetime.now(timezone.utc),
                    )

                    def publish() -> None:
                        """Make the file and complete metadata visible in one rename."""
                        (pending / "metadata.json").write_text(
                            upload.model_dump_json(), encoding="utf-8"
                        )
                        pending.rename(owner_path / str(upload.id))

                    await _finish_disk_operation(publish)
                    return upload
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
                    uploads.append(
                        VectorUpload.model_validate_json(
                            (directory / "metadata.json").read_text(encoding="utf-8")
                        )
                    )
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
            upload_path = self.root.resolve() / owner / str(identifier)
            directory = upload_path.resolve(strict=True)
            metadata_path = (directory / "metadata.json").resolve(strict=True)
            source_path = (directory / "source.gpkg").resolve(strict=True)
            if not all(
                path.is_relative_to(upload_path)
                for path in (directory, metadata_path, source_path)
            ):
                raise VectorUploadError(
                    404, "This upload is not available to this browser."
                )
            metadata = VectorUpload.model_validate_json(
                metadata_path.read_text(encoding="utf-8")
            )
            return metadata, source_path
        except FileNotFoundError as error:
            raise VectorUploadError(
                404, "This upload is not available to this browser."
            ) from error
        except (OSError, ValidationError) as error:
            LOGGER.exception("Could not read vector upload metadata or locate its file")
            raise VectorUploadError(
                503, "Upload storage could not be read. Try again shortly."
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

    def delete(self, owner: str, identifier: UUID) -> None:
        """Withdraw and delete one browser-owned upload and its original file.

        Args:
            owner: Hash produced by the browser identity boundary.
            identifier: Opaque upload ID validated by the HTTP boundary.

        Raises:
            VectorUploadError: If this browser has no such upload or deletion fails.
        """
        directory = self.root / owner / str(identifier)
        deleting = directory.with_name(f".deleting-{identifier}")
        try:
            directory.rename(deleting)
        except FileNotFoundError as error:
            raise VectorUploadError(
                404, "This upload is not available to this browser."
            ) from error
        except OSError as error:
            raise VectorUploadError(
                503, "The upload could not be deleted. Try again shortly."
            ) from error
        try:
            shutil.rmtree(deleting)
        except OSError as error:
            LOGGER.exception("Could not finish deleting vector upload")
            raise VectorUploadError(
                503,
                "The upload was removed from the list, but its files could not be deleted. Contact the administrator.",
            ) from error
