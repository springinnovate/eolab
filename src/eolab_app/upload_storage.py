"""Keep private uploads within shared storage budgets and their seven-day lifetime.

One API process owns admission to this volume. Format-specific adapters inspect
staged originals, then publish their metadata without rewriting the data. Hard
links keep accepted calculations and active readers alive after access expires.
"""

import asyncio
from collections.abc import AsyncIterable, AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
import re
import shutil
from tempfile import TemporaryDirectory
from threading import RLock
from typing import BinaryIO, Literal, TypeVar
from uuid import UUID, uuid4

from pydantic import AwareDatetime, BaseModel, Field, ValidationError, computed_field

from eolab_app.source_files import finish_source_task

UploadKind = Literal["vector", "raster"]
UPLOAD_LIFETIME = timedelta(days=7)
T = TypeVar("T")


class UploadError(Exception):
    """A path-free upload admission, ownership, budget or storage failure."""

    def __init__(self, status: int, message: str) -> None:
        """Record the public HTTP status and explanation.

        Args:
            status: HTTP status representing the failure.
            message: Explanation safe to return without private paths.
        """
        super().__init__(message)
        self.status = status


class UploadRecord(BaseModel):
    """Identify an immutable uploaded original and its fixed deletion date.

    Existing GeoPackage records have no kind field and retain their original
    creation time. The default identifies those records without reopening data.
    """

    id: UUID
    kind: UploadKind = "vector"
    name: str
    size_bytes: int = Field(ge=0)
    created_at: AwareDatetime

    @computed_field
    @property
    def expires_at(self) -> datetime:
        """Return the upload's seven-day authorization deadline."""
        return self.created_at + UPLOAD_LIFETIME


class UploadSummary(BaseModel):
    """Describe visible originals and occupied upload storage for one browser."""

    uploads: list[UploadRecord]
    used_files: int
    max_files: Literal[5] = 5
    used_bytes: int
    max_bytes: int
    max_file_bytes: int
    retained_files: int


class RetainedUpload(BaseModel):
    """Keep quota ownership when a hard-linked original is no longer published."""

    owner: str = Field(pattern=r"^[a-f0-9]{64}$")
    upload: UploadRecord


@dataclass
class PendingUpload:
    """An incoming original whose format adapter owns admission inspection.

    Attributes:
        owner: Validated browser identity hash.
        kind: Uploaded format family.
        directory: Private staging directory, removed unless published.
        source_path: Exact streamed original, never a caller-supplied path.
        size_bytes: Original byte count established while streaming.
        sha256: Original checksum established while streaming, without a reread.
    """

    owner: str
    kind: UploadKind
    directory: Path
    source_path: Path
    size_bytes: int
    sha256: str


@dataclass
class StorageUsage:
    """Account for unique originals and physical file bytes on the upload volume."""

    files: dict[str | None, set[str]]
    bytes: dict[str | None, int]
    uploads: dict[str, list[UploadRecord]]
    retained: dict[str | None, set[str]]


@dataclass
class ActiveUploadRead:
    """Keep one stable original-file link while its authorized readers remain.

    Attributes:
        path: Confined hard link shared by all active readers of this original.
        readers: Number of open read scopes that still protect the shared path.
    """

    path: Path
    readers: int = 0


async def finish_upload_disk_operation(operation: Callable[[], T]) -> T:
    """Finish an owned disk operation before cancellation releases its files.

    Args:
        operation: Synchronous upload storage operation.

    Returns:
        The operation's result.

    Raises:
        asyncio.CancelledError: After the operation stops using its files.
        OSError: If the disk operation fails.
    """
    task = asyncio.create_task(asyncio.to_thread(operation))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await finish_source_task(task)
        raise


class UploadStorage:
    """Own shared upload slots, byte budgets, expiry and retained original files."""

    def __init__(
        self,
        root: Path,
        max_bytes: int = 100 * 1024**2,
        owner_max_bytes: int = 500 * 1024**2,
        global_max_bytes: int = 10 * 1024**3,
    ) -> None:
        """Configure the sole API writer without touching storage.

        Args:
            root: Absolute persistent volume validated by application settings.
            max_bytes: Maximum original bytes in one new upload.
            owner_max_bytes: Maximum stored bytes charged to one browser.
            global_max_bytes: Maximum stored bytes across all browser owners.
        """
        self.root = root
        self.max_bytes = max_bytes
        self.owner_max_bytes = owner_max_bytes
        self.global_max_bytes = global_max_bytes
        self._admission = asyncio.Lock()
        self._disk_lock = RLock()
        self._incoming_usage: StorageUsage | None = None
        self._active_reads: dict[tuple[str, UUID, UploadKind], ActiveUploadRead] = {}

    def initialize(self) -> None:
        """Clean interrupted API writes and reads, then remove expired originals.

        Only the API writer calls this at startup. Processing's retained inputs
        survive restarts and are released from authoritative active job tokens.

        Raises:
            OSError: If the upload volume cannot be initialized.
            UploadError: If persisted metadata cannot be read safely.
        """
        with self._disk_lock:
            self.root.mkdir(parents=True, exist_ok=True)
            for pattern in ("*/.pending-*", "*/.deleting-*"):
                for directory in self.root.glob(pattern):
                    self._remove_directory(directory)
            reading = self._link_directory(".reading")
            if reading.exists():
                self._remove_directory(reading)
            self.sweep_expired()

    def _remove_directory(self, directory: Path) -> None:
        """Remove an upload-owned directory after checking volume confinement.

        Args:
            directory: Exact staging, withdrawn, reading or expired directory.

        Raises:
            UploadError: If a filesystem link redirects deletion outside storage.
            OSError: If deletion fails.
        """
        resolved = directory.resolve()
        root = self.root.resolve()
        if resolved == root or not resolved.is_relative_to(root):
            raise UploadError(503, "Upload storage could not be cleaned safely.")
        shutil.rmtree(directory)

    def _read_record(self, directory: Path) -> UploadRecord:
        """Read admitted metadata without opening or revalidating its dataset.

        Args:
            directory: Confined directory holding an admitted original.

        Returns:
            Common metadata, retaining existing upload dates and IDs.

        Raises:
            UploadError: If metadata leaves its upload directory.
            OSError: If metadata is unavailable.
            ValidationError: If persisted metadata is invalid.
        """
        metadata = (directory / "metadata.json").resolve(strict=True)
        if metadata.parent != directory.resolve():
            raise UploadError(404, "This upload is not available to this browser.")
        return UploadRecord.model_validate_json(metadata.read_bytes())

    def _usage(self) -> StorageUsage:
        """Read metadata and file sizes, counting hard-linked bytes only once.

        Returns:
            Occupied original slots and bytes, including staging and retained files.
            Old retained links without ownership metadata count globally until
            Processing releases them. Source pixels and features are never read.

        Raises:
            OSError: If the storage inventory cannot be read.
            ValidationError: If persisted ownership metadata is invalid.
            UploadError: If a filesystem entry leaves the upload volume.
        """
        usage = StorageUsage({}, {}, {}, {})
        charged: dict[tuple[int, int], tuple[int, str | None]] = {}
        originals: dict[tuple[int, int], tuple[str, str]] = {}
        root = self.root.resolve()

        def charge(path: Path, owner: str | None) -> tuple[int, int]:
            """Charge one physical file once and return its hard-link identity.

            Args:
                path: File on the upload volume.
                owner: Known browser owner, or None for legacy retained files.

            Returns:
                Filesystem device and inode used solely for byte accounting.

            Raises:
                UploadError: If a link leads outside upload storage.
                OSError: If file size accounting fails.
            """
            if not path.resolve().is_relative_to(root):
                raise UploadError(503, "Upload storage could not be read safely.")
            status = path.stat()
            identity = (status.st_dev, status.st_ino)
            if identity not in charged or charged[identity][1] is None:
                charged[identity] = (status.st_size, owner)
            return identity

        if not self.root.exists():
            return usage
        for owner_directory in self.root.iterdir():
            if owner_directory.name.startswith(".") or not owner_directory.is_dir():
                continue
            owner = owner_directory.name
            for directory in owner_directory.iterdir():
                if not directory.is_dir():
                    charge(directory, owner)
                    continue
                record = None
                try:
                    record = self._read_record(directory)
                except FileNotFoundError:
                    pass
                identifier = str(record.id) if record else directory.name
                usage.files.setdefault(owner, set()).add(identifier)
                if record and not directory.name.startswith("."):
                    if record.expires_at > datetime.now(timezone.utc):
                        usage.uploads.setdefault(owner, []).append(record)
                for path in directory.rglob("*"):
                    if path.is_file():
                        identity = charge(path, owner)
                        if path.name in {"source.gpkg", "source.tif"}:
                            originals[identity] = (owner, identifier)
        for name in (".retained", ".reading"):
            directory = self._link_directory(name)
            if not directory.exists():
                continue
            for path in directory.iterdir():
                if path.suffix not in {".gpkg", ".tif"}:
                    continue
                sidecar = path.with_suffix(".json")
                retained = (
                    RetainedUpload.model_validate_json(sidecar.read_bytes())
                    if sidecar.exists()
                    else None
                )
                status = path.stat()
                identity = (status.st_dev, status.st_ino)
                owner, identifier = (
                    (retained.owner, str(retained.upload.id))
                    if retained
                    else originals.get(identity, (None, str(identity)))
                )
                usage.files.setdefault(owner, set()).add(identifier)
                usage.retained.setdefault(owner, set()).add(identifier)
                charge(path, owner)
                if sidecar.exists():
                    charge(sidecar, owner)
            for path in directory.glob("*.json"):
                if not any(
                    path.with_suffix(suffix).exists() for suffix in (".gpkg", ".tif")
                ):
                    retained = RetainedUpload.model_validate_json(path.read_bytes())
                    charge(path, retained.owner)
        for size, owner in charged.values():
            usage.bytes[owner] = usage.bytes.get(owner, 0) + size
        return usage

    def summary(self, owner: str) -> UploadSummary:
        """Return this browser's available uploads and all its occupied storage.

        Args:
            owner: Hash supplied by the browser identity boundary.

        Returns:
            Common metadata, limits, usage and unavailable originals still retained.

        Raises:
            UploadError: If persisted storage usage cannot be read.
        """
        try:
            with self._disk_lock:
                usage = self._usage()
                uploads = sorted(
                    usage.uploads.get(owner, []),
                    key=lambda upload: upload.created_at,
                    reverse=True,
                )
                used_files = len(usage.files.get(owner, set()))
                return UploadSummary(
                    uploads=uploads,
                    used_files=used_files,
                    used_bytes=usage.bytes.get(owner, 0),
                    max_bytes=self.owner_max_bytes,
                    max_file_bytes=self.max_bytes,
                    retained_files=len(
                        usage.retained.get(owner, set())
                        - {str(upload.id) for upload in uploads}
                    ),
                )
        except (OSError, ValidationError) as error:
            raise UploadError(
                503, "Upload storage could not be read. Try again shortly."
            ) from error

    def _check_bytes(self, usage: StorageUsage, owner: str, added: int) -> None:
        """Reject a proposed physical-byte addition beyond owner or global budgets.

        Args:
            usage: Current accounted bytes before the proposed write.
            owner: Browser being charged for the additional bytes.
            added: Number of bytes about to be written.

        Raises:
            UploadError: If owner or global storage has no room for the write.
        """
        if usage.bytes.get(owner, 0) + added > self.owner_max_bytes:
            raise UploadError(
                413,
                "Your upload storage is full. Delete an uploaded file in Your uploads, then try again.",
            )
        if sum(usage.bytes.values()) + added > self.global_max_bytes:
            raise UploadError(
                503,
                "Upload storage is full. Delete an uploaded file or try again later.",
            )

    @asynccontextmanager
    async def stage(
        self,
        owner: str,
        kind: UploadKind,
        chunks: AsyncIterable[bytes],
        *,
        max_bytes: int | None = None,
    ) -> AsyncIterator[PendingUpload]:
        """Stream one original while holding the shared admission slot and budgets.

        Args:
            owner: Hash from the validated browser identity boundary.
            kind: Format family selecting the internal original filename.
            chunks: Request body fragments; the full file is never buffered.
            max_bytes: Optional stricter format-specific original byte limit.

        Yields:
            Staged original for bounded format inspection and publish().

        Raises:
            UploadError: If five files or a byte budget is exhausted, another
                upload is active, or the incoming body exceeds 120 seconds.
            OSError: If staging fails.
            asyncio.CancelledError: After pending writes and cleanup finish.
        """
        if self._admission.locked():
            raise UploadError(
                429, "Another upload is being received. Try again shortly."
            )
        async with self._admission:
            await finish_upload_disk_operation(self.sweep_expired)
            with self._disk_lock:
                usage = self._usage()
                if len(usage.files.get(owner, set())) >= 5:
                    raise UploadError(
                        409,
                        "You have 5 uploaded files. Delete an uploaded file in Your uploads before uploading another. Files in use count until the calculation stops.",
                    )
                owner_path = self.root / owner
                owner_path.mkdir(parents=True, exist_ok=True)
                temporary = TemporaryDirectory(prefix=".pending-", dir=owner_path)
                directory = Path(temporary.name)
                source = directory / (
                    "source.gpkg" if kind == "vector" else "source.tif"
                )
                self._incoming_usage = None
            try:
                limit = (
                    min(self.max_bytes, max_bytes)
                    if max_bytes is not None
                    else self.max_bytes
                )
                size = 0
                checksum = hashlib.sha256()
                try:
                    async with asyncio.timeout(120):
                        with source.open("wb", buffering=0) as output:
                            async for chunk in chunks:
                                next_size = size + len(chunk)
                                if next_size > limit:
                                    raise UploadError(
                                        413,
                                        f"The file exceeds the upload limit of {limit} bytes.",
                                    )
                                await finish_upload_disk_operation(
                                    lambda: self._write_chunk(output, owner, chunk)
                                )
                                checksum.update(chunk)
                                size = next_size
                except TimeoutError as error:
                    raise UploadError(
                        408,
                        "The upload did not finish within 120 seconds. Try again with a smaller file or a faster connection.",
                    ) from error
                yield PendingUpload(
                    owner, kind, directory, source, size, checksum.hexdigest()
                )
            finally:

                def cleanup() -> None:
                    """Remove this admission's remaining files before releasing its slot."""
                    with self._disk_lock:
                        if directory.exists():
                            self._remove_directory(directory)
                        temporary.cleanup()
                        self._incoming_usage = None

                await finish_upload_disk_operation(cleanup)

    def _write_chunk(self, output: BinaryIO, owner: str, chunk: bytes) -> None:
        """Charge and write one body chunk while other storage changes are excluded.

        Args:
            output: Open unbuffered staging file owned by the active admission.
            owner: Browser identity being charged for this file.
            chunk: Next raw request-body bytes.

        Raises:
            UploadError: If the current shared byte budget is exhausted.
            OSError: If writing the original fails.
        """
        with self._disk_lock:
            if self._incoming_usage is None:
                self._incoming_usage = self._usage()
            self._check_bytes(self._incoming_usage, owner, len(chunk))
            remaining = memoryview(chunk)
            while remaining:
                written = output.write(remaining)
                if not written:
                    raise OSError("Upload storage stopped accepting data")
                remaining = remaining[written:]
            self._incoming_usage.bytes[owner] = self._incoming_usage.bytes.get(
                owner, 0
            ) + len(chunk)

    def publish(
        self,
        pending: PendingUpload,
        metadata: UploadRecord,
        prepared_files: Mapping[str, bytes] | None = None,
    ) -> None:
        """Publish an inspected original and its format metadata atomically.

        Args:
            pending: Original produced by stage() in its active admission context.
            metadata: Format adapter's validated record, including common fields.
            prepared_files: Optional adapter-owned metadata files, keyed by fixed
                internal filenames. These are not user-supplied paths or datasets.

        Raises:
            UploadError: If inspection metadata exceeds a stored-byte budget.
            OSError: If publication fails.
        """
        with self._disk_lock:
            content = metadata.model_dump_json(exclude={"expires_at"}).encode("utf-8")
            usage = self._usage()
            files = prepared_files or {}
            self._check_bytes(
                usage, pending.owner, len(content) + sum(map(len, files.values()))
            )
            for name, data in files.items():
                (pending.directory / name).write_bytes(data)
            (pending.directory / "metadata.json").write_bytes(content)
            pending.directory.rename(self.root / pending.owner / str(metadata.id))
            self._incoming_usage = None

    def get_upload_source(
        self, owner: str, identifier: UUID, kind: UploadKind
    ) -> tuple[UploadRecord, Path]:
        """Authorize one unexpired original without reopening its admitted dataset.

        Args:
            owner: Browser identity hash supplied by the ownership boundary.
            identifier: Opaque UUID from the validated public reference.
            kind: Format family accepted by the calling source adapter.

        Returns:
            Immutable admission metadata and the confined original file path.

        Raises:
            UploadError: If ownership, expiry, kind, confinement or storage fails.
        """
        try:
            with self._disk_lock:
                expected = self.root.resolve() / owner / str(identifier)
                directory = expected.resolve(strict=True)
                if directory != expected:
                    raise UploadError(
                        404, "This upload is not available to this browser."
                    )
                metadata = self._read_record(directory)
                if metadata.kind != kind or metadata.expires_at <= datetime.now(
                    timezone.utc
                ):
                    raise UploadError(
                        404, "This upload is not available to this browser."
                    )
                source = (
                    directory / ("source.gpkg" if kind == "vector" else "source.tif")
                ).resolve(strict=True)
                if source.parent != directory:
                    raise UploadError(
                        404, "This upload is not available to this browser."
                    )
                return metadata, source
        except FileNotFoundError as error:
            raise UploadError(
                404, "This upload is not available to this browser."
            ) from error
        except (OSError, ValidationError) as error:
            raise UploadError(
                503, "Upload storage could not be read. Try again shortly."
            ) from error

    def sweep_expired(self) -> None:
        """Withdraw expired originals and retry interrupted deletions.

        Retained calculation and active-reader hard links survive this sweep.
        Staging directories belong to live admission and are only swept at startup.

        Raises:
            UploadError: If metadata or filesystem cleanup fails.
        """
        try:
            with self._disk_lock:
                for metadata_path in self.root.glob("*/*/metadata.json"):
                    directory = metadata_path.parent
                    if directory.name.startswith("."):
                        continue
                    record = self._read_record(directory)
                    if record.expires_at <= datetime.now(timezone.utc):
                        self.delete(directory.parent.name, record.id)
                for directory in self.root.glob("*/.deleting-*"):
                    self._remove_directory(directory)
        except (OSError, ValidationError) as error:
            raise UploadError(
                503, "Expired upload files could not be removed."
            ) from error

    def is_available(self, identifier: UUID, kind: UploadKind) -> bool:
        """Check a published original's lifetime for server-owned cleanup.

        This does not authorize access. User-facing readers must still call
        get_upload_source() with the requesting browser's identity.

        Args:
            identifier: Opaque upload ID recorded by a server-owned resource.
            kind: Format family expected by that resource's lifecycle owner.

        Returns:
            Whether an unexpired original of that kind remains published.

        Raises:
            UploadError: If persisted metadata cannot be read safely.
        """
        try:
            with self._disk_lock:
                for directory in self.root.glob(f"*/{identifier}"):
                    if directory.parent.name.startswith("."):
                        continue
                    record = self._read_record(directory)
                    return record.kind == kind and record.expires_at > datetime.now(
                        timezone.utc
                    )
                return False
        except (OSError, ValidationError) as error:
            raise UploadError(
                503, "Upload availability could not be checked."
            ) from error

    def delete(self, owner: str, identifier: UUID) -> None:
        """Withdraw an original immediately and delete its published files.

        Args:
            owner: Hash supplied by the validated browser ownership boundary.
            identifier: Opaque upload UUID, never a path supplied by the caller.

        Raises:
            UploadError: If the upload is absent or removal fails. Retained links
                remain charged until their accepted calculation or read finishes.
        """
        try:
            with self._disk_lock:
                directory = self.root / owner / str(identifier)
                if directory.resolve() != self.root.resolve() / owner / str(identifier):
                    raise UploadError(
                        404, "This upload is not available to this browser."
                    )
                deleting = directory.with_name(f".deleting-{identifier}")
                directory.rename(deleting)
                self._remove_directory(deleting)
                self._incoming_usage = None
        except FileNotFoundError as error:
            raise UploadError(
                404, "This upload is not available to this browser."
            ) from error
        except OSError as error:
            raise UploadError(
                503, "The upload could not be deleted. Try again shortly."
            ) from error

    def _link_directory(self, name: str) -> Path:
        """Return a confined private directory for original hard links.

        Args:
            name: Internal retained or active-reader directory name.

        Returns:
            Confined directory, which may not yet exist.

        Raises:
            UploadError: If a filesystem link leaves the volume.
        """
        root = self.root.resolve()
        directory = (root / name).resolve()
        if directory.parent != root:
            raise UploadError(503, "Retained upload storage is unavailable.")
        return directory

    def _retain(self, source_path: Path, name: str) -> str:
        """Create one original hard link with durable owner and quota metadata.

        Args:
            source_path: Original returned by an authorized source adapter.
            name: Internal calculation or active-reader link directory.

        Returns:
            Opaque token for the new link.

        Raises:
            UploadError: If deletion/expiry wins or retaining the original fails.
        """
        target = None
        sidecar = None
        try:
            with self._disk_lock:
                original = source_path.resolve(strict=True)
                if original.parent.parent.parent != self.root.resolve():
                    raise UploadError(
                        404, "This upload is not available to this browser."
                    )
                owner = original.parent.parent.name
                record = self._read_record(original.parent)
                _, authorized = self.get_upload_source(owner, record.id, record.kind)
                if authorized != original:
                    raise UploadError(
                        404, "This upload is not available to this browser."
                    )
                directory = self._link_directory(name)
                directory.mkdir(exist_ok=True)
                self.root.chmod(0o755)
                directory.chmod(0o755)
                token = uuid4().hex
                target = directory / f"{token}{original.suffix}"
                sidecar = target.with_suffix(".json")
                content = (
                    RetainedUpload(owner=owner, upload=record)
                    .model_dump_json()
                    .encode("utf-8")
                )
                self._check_bytes(self._usage(), owner, len(content))
                target.hardlink_to(original)
                sidecar.write_bytes(content)
                target.chmod(0o644)
                self._incoming_usage = None
                return token
        except FileNotFoundError as error:
            raise UploadError(
                404, "This upload is not available to this browser."
            ) from error
        except (OSError, ValidationError) as error:
            if target is not None:
                target.unlink(missing_ok=True)
            if sidecar is not None:
                sidecar.unlink(missing_ok=True)
            raise UploadError(
                503, "The uploaded file could not be retained for this calculation."
            ) from error

    def retain_source(self, source_path: Path) -> str:
        """Keep an authorized original until its accepted calculation stops.

        Args:
            source_path: Original file returned by the authorized source adapter.

        Returns:
            Server-only token persisted with the accepted Processing job.

        Raises:
            UploadError: If the original expires, is deleted or cannot be retained.
        """
        return self._retain(source_path, ".retained")

    def get_retained_source(self, token: str) -> Path:
        """Locate the original retained for an accepted calculation.

        Args:
            token: Server-only token persisted in accepted job storage.

        Returns:
            Confined GeoPackage or GeoTIFF path, independent of public expiry.

        Raises:
            UploadError: If the token or retained original is unavailable.
        """
        if re.fullmatch(r"[a-f0-9]{32}", token) is None:
            raise UploadError(404, "This calculation's uploaded file is unavailable.")
        try:
            directory = self._link_directory(".retained")
            for suffix in (".gpkg", ".tif"):
                candidate = directory / f"{token}{suffix}"
                if candidate.exists():
                    source = candidate.resolve(strict=True)
                    if source.parent != directory:
                        break
                    return source
        except OSError as error:
            raise UploadError(
                503, "This calculation's uploaded file could not be located."
            ) from error
        raise UploadError(404, "This calculation's uploaded file is unavailable.")

    def remove_unretained_sources(self, active: set[str]) -> None:
        """Release calculation links absent from authoritative unfinished jobs.

        Args:
            active: Server-only tokens still used by queued/running/cancelling jobs.
                Processing serializes this reconciliation with job admission.

        Raises:
            UploadError: If retained files cannot be removed.
        """
        try:
            with self._disk_lock:
                for source in self._link_directory(".retained").glob("*"):
                    if (
                        source.suffix in {".gpkg", ".tif", ".json"}
                        and source.stem not in active
                    ):
                        source.unlink(missing_ok=True)
                self._incoming_usage = None
        except OSError as error:
            raise UploadError(
                503, "Unused calculation input files could not be removed."
            ) from error

    @asynccontextmanager
    async def open_source(
        self, owner: str, identifier: UUID, kind: UploadKind
    ) -> AsyncIterator[tuple[UploadRecord, Path]]:
        """Retain one stable original path until all its authorized reads finish.

        Concurrent scopes share a hard link so a computation reused by several
        readers keeps the same path when its first requester leaves. Every new
        scope still checks browser ownership and expiry before joining the link.

        Args:
            owner: Browser identity supplied by the access boundary.
            identifier: Opaque uploaded source UUID.
            kind: Format family accepted by the source adapter.

        Yields:
            Admission metadata and the original's shared read link. Deletion
            withdraws new access but leaves this path until the last scope exits.

        Raises:
            UploadError: If authorization, retention or cleanup fails.
            asyncio.CancelledError: After the reader exits and its link is removed.
        """
        with self._disk_lock:
            metadata, source = self.get_upload_source(owner, identifier, kind)
            key = (owner, identifier, kind)
            read = self._active_reads.get(key)
            if read is None:
                token = self._retain(source, ".reading")
                link = self._link_directory(".reading") / f"{token}{source.suffix}"
                read = ActiveUploadRead(link)
                self._active_reads[key] = read
            read.readers += 1
        try:
            yield metadata, read.path
        finally:

            def release() -> None:
                """Release this reader and unlink only after the final scope exits.

                Raises:
                    UploadError: If the unused link or its metadata cannot be removed.
                """
                with self._disk_lock:
                    read.readers -= 1
                    if read.readers:
                        return
                    self._active_reads.pop(key)
                    try:
                        read.path.unlink(missing_ok=True)
                        read.path.with_suffix(".json").unlink(missing_ok=True)
                    except OSError as error:
                        raise UploadError(
                            503, "The completed upload read could not be cleaned up."
                        ) from error
                    finally:
                        self._incoming_usage = None

            await finish_upload_disk_operation(release)
