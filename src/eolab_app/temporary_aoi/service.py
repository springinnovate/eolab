"""Process-local lifecycle service for temporary uploaded AOIs."""

import asyncio
import re
import secrets
import shutil
import tempfile
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import BinaryIO

from eolab_app.temporary_aoi.errors import (
    TemporaryAoiConflictError,
    TemporaryAoiNotFoundError,
    TemporaryAoiRequestError,
    TemporaryAoiTooLargeError,
    TemporaryAoiValidationError,
)
from eolab_app.temporary_aoi.models import (
    DatasetChoice,
    TemporaryAoiChoiceResponse,
    TemporaryAoiReadyResponse,
    TemporaryAoiRecord,
    TemporaryAoiSelectionRequiredResponse,
    TemporaryAoiUploadResponse,
)
from eolab_app.temporary_aoi.processing import run_bounded_operation
from eolab_app.temporary_aoi.validation import (
    MAX_DATASET_CHOICES,
    MAX_UPLOAD_BYTES,
    PROCESSING_TIME_SECONDS,
)


TEMPORARY_AOI_TTL = timedelta(minutes=30)
OPAQUE_IDENTIFIER_BYTES = 24
UPLOAD_COPY_CHUNK_BYTES = 64 * 1024
EXPIRATION_POLL_SECONDS = 30.0
UtcNow = Callable[[], datetime]


def utc_now() -> datetime:
    """Return the current timezone-aware UTC timestamp.

    Returns:
        Current UTC timestamp used by temporary lifecycle decisions.
    """
    return datetime.now(timezone.utc)


class TemporaryAoiService:
    """Validate, retain, replace, expire, and remove temporary AOIs.

    The service owns an isolated operating-system temporary directory and an
    in-memory opaque-ID registry. It never reads or writes the mounted scan
    source, catalog, database, or GeoServer. Records intentionally do not
    survive application restart.

    Attributes:
        root_path: Isolated server-owned temporary storage root.
    """

    def __init__(
        self,
        root_path: Path | None = None,
        *,
        ttl: timedelta = TEMPORARY_AOI_TTL,
        maximum_upload_bytes: int = MAX_UPLOAD_BYTES,
        processing_seconds: float = PROCESSING_TIME_SECONDS,
        now: UtcNow = utc_now,
        forbidden_roots: tuple[Path, ...] = (),
    ) -> None:
        """Create an empty temporary-AOI registry and storage root.

        Args:
            root_path: Optional isolated root supplied by tests. Production
                creates a unique directory under the operating-system temp
                location, outside the repository and scan source.
            ttl: Inactivity-independent lifetime assigned at upload time.
            maximum_upload_bytes: Maximum uploaded file bytes accepted by the
                lifecycle boundary.
            processing_seconds: Maximum geometry-processing duration.
            now: UTC clock dependency used for deterministic lifecycle tests.
            forbidden_roots: Repository and mounted-source roots that must not
                contain or overlap temporary storage.

        Raises:
            ValueError: If TTL, upload, or processing limits are not positive,
                the supplied root is relative, or the root cannot be isolated.
            OSError: If the storage root cannot be created.
        """
        if ttl.total_seconds() <= 0:
            raise ValueError("Temporary AOI TTL must be greater than zero")
        if maximum_upload_bytes <= 0:
            raise ValueError(
                "Temporary AOI upload limit must be greater than zero"
            )
        if processing_seconds <= 0:
            raise ValueError(
                "Temporary AOI processing limit must be greater than zero"
            )
        if root_path is None:
            active_root = Path(tempfile.gettempdir()) / (
                f"eolab-temporary-aoi-{self._new_identifier()}"
            )
        else:
            if not root_path.is_absolute():
                raise ValueError("Temporary AOI root must be absolute")
            active_root = root_path
        self.root_path = active_root.resolve()
        for forbidden_root in forbidden_roots:
            resolved_forbidden_root = forbidden_root.resolve()
            if (
                self.root_path == resolved_forbidden_root
                or self.root_path.is_relative_to(resolved_forbidden_root)
                or resolved_forbidden_root.is_relative_to(self.root_path)
            ):
                raise ValueError(
                    "Temporary AOI root must not overlap the repository or "
                    "mounted scan source"
                )
        self._ttl = ttl
        self._maximum_upload_bytes = maximum_upload_bytes
        self._processing_seconds = processing_seconds
        self._now = now
        self._records: dict[str, TemporaryAoiRecord] = {}
        self._lock = asyncio.Lock()
        self._expiration_task: asyncio.Task[None] | None = None
        self._root_initialized = False
        self._closed = False

    async def start(self) -> None:
        """Start deterministic periodic expiration cleanup.

        Returns:
            None.

        Raises:
            RuntimeError: If the service was already closed.
        """
        if self._closed:
            raise RuntimeError("Temporary AOI service is closed")
        self._ensure_root()
        if self._expiration_task is None:
            self._expiration_task = asyncio.create_task(self._expiration_loop())

    async def close(self) -> None:
        """Stop expiration and remove every service-owned temporary file.

        Returns:
            None.
        """
        expiration_task = self._expiration_task
        self._expiration_task = None
        if expiration_task is not None:
            expiration_task.cancel()
            await asyncio.gather(expiration_task, return_exceptions=True)
        async with self._lock:
            self._records.clear()
            await asyncio.to_thread(
                shutil.rmtree,
                self.root_path,
                True,
            )
            self._closed = True

    async def upload(
        self,
        filename: str,
        content: BinaryIO,
        replacement_id: str | None = None,
    ) -> TemporaryAoiUploadResponse:
        """Stage, validate, and optionally complete one uploaded AOI.

        A replacement remains active when the new upload fails. It is removed
        only after a single-dataset upload becomes ready or after the user
        selects a dataset from a multi-dataset upload.

        Args:
            filename: Untrusted original browser filename used only for display
                and supported-format selection.
            content: Rewound multipart file stream owned by the route.
            replacement_id: Optional opaque identifier of a superseded AOI.

        Returns:
            Ready bounded geometry for one usable dataset, or an explicit
            selection response for multiple usable datasets.

        Raises:
            TemporaryAoiRequestError: If filename or replacement identity is
                invalid.
            TemporaryAoiTooLargeError: If streamed file bytes exceed the
                configured upload ceiling.
            TemporaryAoiValidationError: If container or geometry is invalid.
            TemporaryAoiNotFoundError: If a replacement is absent or expired.
            OSError: If isolated server storage cannot be used.
        """
        suffix = self._validate_filename(filename)
        self._ensure_root()
        await self.expire()
        if replacement_id is not None:
            if not self._is_identifier(replacement_id):
                raise TemporaryAoiNotFoundError(
                    "The temporary AOI does not exist or has expired"
                )
            async with self._lock:
                self._require_record(replacement_id)

        temporary_id = self._new_identifier()
        upload_directory = self.root_path / temporary_id
        upload_directory.mkdir(mode=0o700)
        source_path = upload_directory / f"source{suffix}"
        try:
            await asyncio.to_thread(
                self._copy_upload,
                content,
                source_path,
            )
            choices = await run_bounded_operation(
                "discover",
                (
                    source_path,
                    upload_directory,
                    tuple(
                        self._new_identifier()
                        for _ in range(MAX_DATASET_CHOICES)
                    ),
                ),
                self._processing_seconds,
            )
            record = TemporaryAoiRecord(
                id=temporary_id,
                filename=filename,
                directory=upload_directory,
                choices={choice.id: choice for choice in choices},
                expires_at=self._now() + self._ttl,
                replacement_id=replacement_id,
            )
            if len(choices) > 1:
                async with self._lock:
                    self._records[temporary_id] = record
                return self._selection_response(record)
            ready = await self._build_ready_response(record, choices[0])
            async with self._lock:
                self._records[temporary_id] = record
                if replacement_id is not None:
                    await self._discard_record(replacement_id)
            return ready
        except (
            TemporaryAoiRequestError,
            TemporaryAoiTooLargeError,
            TemporaryAoiValidationError,
            TemporaryAoiNotFoundError,
            TemporaryAoiConflictError,
        ):
            await asyncio.to_thread(shutil.rmtree, upload_directory, True)
            raise
        except Exception as error:
            await asyncio.to_thread(shutil.rmtree, upload_directory, True)
            raise TemporaryAoiValidationError(
                "The uploaded AOI could not be processed safely"
            ) from error

    async def select(
        self,
        temporary_id: str,
        choice_id: str,
    ) -> TemporaryAoiReadyResponse:
        """Complete a staged multi-dataset upload using an opaque choice.

        Args:
            temporary_id: Opaque process-local upload identifier.
            choice_id: Opaque server-issued dataset choice identifier.

        Returns:
            Bounded WGS 84 geometry for the selected dataset.

        Raises:
            TemporaryAoiNotFoundError: If the upload is absent or expired.
            TemporaryAoiConflictError: If the upload does not require a
                selection or the choice identifier is invalid.
            TemporaryAoiValidationError: If selected geometry fails bounded
                processing after metadata validation.
        """
        await self.expire()
        if not self._is_identifier(temporary_id):
            raise TemporaryAoiNotFoundError(
                "The temporary AOI does not exist or has expired"
            )
        async with self._lock:
            record = self._require_record(temporary_id)
            if len(record.choices) < 2:
                raise TemporaryAoiConflictError(
                    "This temporary AOI does not require dataset selection"
                )
            choice = (
                record.choices.get(choice_id)
                if self._is_identifier(choice_id)
                else None
            )
            if choice is None:
                raise TemporaryAoiConflictError(
                    "The selected AOI dataset choice is not valid"
                )
            try:
                ready = await self._build_ready_response(record, choice)
            except TemporaryAoiValidationError:
                await self._discard_record(temporary_id)
                raise
            except Exception as error:
                await self._discard_record(temporary_id)
                raise TemporaryAoiValidationError(
                    "The selected AOI dataset could not be processed safely"
                ) from error
            record.choices = {choice.id: choice}
            if record.replacement_id is not None:
                await self._discard_record(record.replacement_id)
                record.replacement_id = None
            return ready

    async def remove(self, temporary_id: str) -> None:
        """Remove one temporary AOI and all server-owned files immediately.

        Args:
            temporary_id: Opaque process-local AOI identifier.

        Returns:
            None.

        Raises:
            TemporaryAoiNotFoundError: If the identifier is absent or expired.
        """
        await self.expire()
        if not self._is_identifier(temporary_id):
            raise TemporaryAoiNotFoundError(
                "The temporary AOI does not exist or has expired"
            )
        async with self._lock:
            self._require_record(temporary_id)
            await self._discard_record(temporary_id)

    async def expire(self) -> int:
        """Remove all records at or beyond their fixed expiration timestamp.

        Returns:
            Number of expired AOIs removed during this pass.
        """
        current_time = self._now()
        async with self._lock:
            expired_ids = [
                temporary_id
                for temporary_id, record in self._records.items()
                if record.expires_at <= current_time
            ]
            for temporary_id in expired_ids:
                await self._discard_record(temporary_id)
            return len(expired_ids)

    async def _expiration_loop(self) -> None:
        """Run expiration passes until service shutdown cancels the task.

        Returns:
            None.
        """
        while True:
            await asyncio.sleep(EXPIRATION_POLL_SECONDS)
            await self.expire()

    async def _build_ready_response(
        self,
        record: TemporaryAoiRecord,
        choice: DatasetChoice,
    ) -> TemporaryAoiReadyResponse:
        """Read bounded geometry and construct its public response.

        Args:
            record: Active server-owned upload record.
            choice: Validated dataset to read.

        Returns:
            Browser-safe ready response.

        Raises:
            TemporaryAoiValidationError: If processing exceeds its time limit
                or geometry validation fails.
        """
        geometry, bbox = await run_bounded_operation(
            "geometry",
            (choice, self._processing_seconds),
            self._processing_seconds,
        )
        return TemporaryAoiReadyResponse(
            id=record.id,
            filename=record.filename,
            selectedDataset=choice.label,
            expiresAt=record.expires_at,
            bbox=bbox,
            geometry=geometry,
        )

    async def _discard_record(self, temporary_id: str) -> None:
        """Forget one record and remove its isolated directory.

        Args:
            temporary_id: Opaque identifier to discard if present.

        Returns:
            None.
        """
        record = self._records.pop(temporary_id, None)
        if record is not None:
            await asyncio.to_thread(shutil.rmtree, record.directory, True)

    def _require_record(self, temporary_id: str) -> TemporaryAoiRecord:
        """Resolve an opaque identifier without accepting a server path.

        Args:
            temporary_id: Browser-provided opaque identifier.

        Returns:
            Active matching process-local record.

        Raises:
            TemporaryAoiNotFoundError: If the identifier is absent.
        """
        record = self._records.get(temporary_id)
        if record is None:
            raise TemporaryAoiNotFoundError(
                "The temporary AOI does not exist or has expired"
            )
        return record

    def _selection_response(
        self,
        record: TemporaryAoiRecord,
    ) -> TemporaryAoiSelectionRequiredResponse:
        """Construct the public multi-dataset selection response.

        Args:
            record: Newly staged upload record.

        Returns:
            Browser-safe opaque choices in discovery order.
        """
        return TemporaryAoiSelectionRequiredResponse(
            id=record.id,
            filename=record.filename,
            expiresAt=record.expires_at,
            choices=[
                TemporaryAoiChoiceResponse(id=choice.id, label=choice.label)
                for choice in record.choices.values()
            ],
        )

    def _ensure_root(self) -> None:
        """Create the isolated storage root on first lifecycle use.

        Returns:
            None.

        Raises:
            RuntimeError: If the service has already been closed.
            OSError: If the root cannot be created or is not a directory.
        """
        if self._closed:
            raise RuntimeError("Temporary AOI service is closed")
        if self._root_initialized:
            if not self.root_path.is_dir():
                raise OSError("Temporary AOI root is not a directory")
            return
        self.root_path.mkdir(mode=0o700, parents=True, exist_ok=False)
        self._root_initialized = True

    @staticmethod
    def _validate_filename(filename: str) -> str:
        """Validate display-name size and determine the supported suffix.

        Args:
            filename: Untrusted original browser filename.

        Returns:
            Canonical lowercase `.gpkg` or `.zip` suffix.

        Raises:
            TemporaryAoiRequestError: If the name is empty, excessive,
                control-containing, or uses an unsupported extension.
        """
        if (
            not filename
            or len(filename) > 255
            or any(
                ord(character) < 32 or ord(character) == 127
                for character in filename
            )
        ):
            raise TemporaryAoiRequestError(
                "The upload must have a valid filename no longer than 255 characters"
            )
        suffix = Path(filename).suffix.casefold()
        if suffix not in {".gpkg", ".zip"}:
            raise TemporaryAoiRequestError(
                "Upload a GeoPackage (.gpkg) or zipped Shapefile (.zip)"
            )
        return suffix

    def _copy_upload(self, content: BinaryIO, destination: Path) -> None:
        """Copy a rewound multipart stream under the file-size ceiling.

        Args:
            content: Multipart file stream positioned at its beginning.
            destination: New server-owned source path.

        Returns:
            None.

        Raises:
            TemporaryAoiTooLargeError: If content exceeds the configured file
                byte ceiling.
            TemporaryAoiRequestError: If the uploaded file is empty.
            OSError: If the destination cannot be written.
        """
        copied_bytes = 0
        with destination.open("xb") as target:
            while chunk := content.read(UPLOAD_COPY_CHUNK_BYTES):
                copied_bytes += len(chunk)
                if copied_bytes > self._maximum_upload_bytes:
                    raise TemporaryAoiTooLargeError(
                        "AOI uploads cannot exceed "
                        f"{self._maximum_upload_bytes} bytes"
                    )
                target.write(chunk)
        if copied_bytes == 0:
            raise TemporaryAoiRequestError("The uploaded AOI file is empty")

    @staticmethod
    def _new_identifier() -> str:
        """Create a high-entropy URL-safe opaque identifier.

        Returns:
            Unpredictable identifier containing no filename or server path.
        """
        return secrets.token_urlsafe(OPAQUE_IDENTIFIER_BYTES)

    @staticmethod
    def _is_identifier(value: str) -> bool:
        """Return whether browser text matches the exact opaque-ID syntax.

        Args:
            value: Untrusted browser-provided identifier text.

        Returns:
            Whether the value is one 32-character URL-safe token.
        """
        return (
            len(value) == 32
            and re.fullmatch(r"[A-Za-z0-9_-]{32}", value) is not None
        )
