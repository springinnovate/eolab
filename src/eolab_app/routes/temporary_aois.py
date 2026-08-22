"""Bounded multipart HTTP boundary for temporary uploaded AOIs."""

from collections.abc import AsyncIterator
from typing import BinaryIO, Protocol, cast

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from starlette.datastructures import FormData, UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from eolab_app.temporary_aoi.errors import (
    TemporaryAoiConflictError,
    TemporaryAoiError,
    TemporaryAoiNotFoundError,
    TemporaryAoiRequestError,
    TemporaryAoiTooLargeError,
    TemporaryAoiValidationError,
)
from eolab_app.temporary_aoi.models import (
    TemporaryAoiReadyResponse,
    TemporaryAoiSelectionRequest,
    TemporaryAoiSelectionRequiredResponse,
    TemporaryAoiUploadResponse,
)
from eolab_app.temporary_aoi.validation import MAX_UPLOAD_BYTES


MAX_MULTIPART_FRAMING_BYTES = 64 * 1024
MAX_MULTIPART_BODY_BYTES = MAX_UPLOAD_BYTES + MAX_MULTIPART_FRAMING_BYTES


class TemporaryAoiController(Protocol):
    """Application operations exposed by the temporary-AOI router.

    Implementations own validation, opaque identities, and temporary files;
    the route owns only multipart parsing and HTTP error translation.
    """

    async def upload(
        self,
        filename: str,
        content: BinaryIO,
        replacement_id: str | None = None,
    ) -> TemporaryAoiUploadResponse:
        """Validate and stage one uploaded container.

        Args:
            filename: Untrusted original browser filename.
            content: Rewound readable multipart file stream.
            replacement_id: Optional opaque superseded AOI identifier.

        Returns:
            Ready geometry or an explicit dataset-selection response.

        Raises:
            TemporaryAoiError: If the upload violates its application contract.
        """

    async def select(
        self,
        temporary_id: str,
        choice_id: str,
    ) -> TemporaryAoiReadyResponse:
        """Select one opaque dataset choice from a staged upload.

        Args:
            temporary_id: Opaque staged-upload identifier.
            choice_id: Opaque server-issued dataset choice identifier.

        Returns:
            Ready bounded WGS 84 geometry.

        Raises:
            TemporaryAoiError: If identity, lifecycle, or geometry is invalid.
        """

    async def remove(self, temporary_id: str) -> None:
        """Remove one temporary AOI and its server-owned files.

        Args:
            temporary_id: Opaque temporary AOI identifier.

        Returns:
            None.

        Raises:
            TemporaryAoiError: If the identifier is absent or expired.
        """


class BoundedMultiPartParser(MultiPartParser):
    """Starlette multipart parser that also bounds streamed file parts.

    Starlette's `max_part_size` limits ordinary fields but deliberately does
    not limit file parts. This focused subclass adds that missing owned-boundary
    check before each file chunk is written to the parser's spooled file.

    Attributes:
        maximum_file_bytes: Maximum bytes accepted for one file part.
    """

    def __init__(
        self,
        *args: object,
        maximum_file_bytes: int,
        **kwargs: object,
    ) -> None:
        """Configure Starlette parsing plus a strict file-part byte ceiling.

        Args:
            *args: Positional arguments accepted by Starlette's parser.
            maximum_file_bytes: Maximum bytes accepted for one file part.
            **kwargs: Keyword arguments accepted by Starlette's parser.

        Raises:
            ValueError: If the file byte ceiling is not positive.
        """
        if maximum_file_bytes <= 0:
            raise ValueError("Multipart file limit must be greater than zero")
        super().__init__(*args, **kwargs)
        self.maximum_file_bytes = maximum_file_bytes
        self._current_file_bytes = 0

    def on_part_begin(self) -> None:
        """Reset byte accounting when the multipart parser starts a part.

        Returns:
            None.
        """
        super().on_part_begin()
        self._current_file_bytes = 0

    def on_part_data(self, data: bytes, start: int, end: int) -> None:
        """Reject excessive file bytes before Starlette writes them.

        Args:
            data: Parser callback buffer containing current part bytes.
            start: Inclusive start offset of current part bytes.
            end: Exclusive end offset of current part bytes.

        Returns:
            None.

        Raises:
            MultiPartException: If a file part exceeds the configured ceiling.
        """
        if self._current_part.file is not None:
            self._current_file_bytes += end - start
            if self._current_file_bytes > self.maximum_file_bytes:
                raise MultiPartException(
                    f"AOI file exceeds the {self.maximum_file_bytes}-byte limit"
                )
        super().on_part_data(data, start, end)


def temporary_aoi_http_exception(error: TemporaryAoiError) -> HTTPException:
    """Translate one application failure into the public HTTP contract.

    Args:
        error: Application-level temporary-AOI failure.

    Returns:
        FastAPI exception with a stable status and browser-safe detail.

    Raises:
        TypeError: If a new application failure has no explicit HTTP mapping.
    """
    status_codes: tuple[tuple[type[TemporaryAoiError], int], ...] = (
        (TemporaryAoiTooLargeError, 413),
        (TemporaryAoiRequestError, 400),
        (TemporaryAoiNotFoundError, 404),
        (TemporaryAoiConflictError, 409),
        (TemporaryAoiValidationError, 422),
    )
    for error_type, status_code in status_codes:
        if isinstance(error, error_type):
            return HTTPException(status_code=status_code, detail=error.detail)
    raise TypeError(f"Unmapped temporary AOI failure: {type(error).__name__}")


async def bounded_request_stream(request: Request) -> AsyncIterator[bytes]:
    """Yield request chunks while enforcing the complete body-size ceiling.

    Args:
        request: Incoming multipart upload request.

    Yields:
        ASGI request body chunks within the 25 MiB file limit plus 64 KiB of
        bounded multipart framing.

    Raises:
        TemporaryAoiTooLargeError: If the streamed body exceeds the bounded
            file-plus-framing limit.
    """
    received_bytes = 0
    async for chunk in request.stream():
        received_bytes += len(chunk)
        if received_bytes > MAX_MULTIPART_BODY_BYTES:
            raise TemporaryAoiTooLargeError(
                f"AOI multipart requests cannot exceed {MAX_MULTIPART_BODY_BYTES} bytes"
            )
        yield chunk


def validate_declared_body_size(request: Request) -> None:
    """Reject malformed or excessive declared multipart body lengths.

    Args:
        request: Incoming multipart upload request.

    Returns:
        None.

    Raises:
        TemporaryAoiRequestError: If Content-Length is malformed or negative.
        TemporaryAoiTooLargeError: If Content-Length exceeds the bounded
            file-plus-framing limit.
    """
    content_length = request.headers.get("content-length")
    if content_length is None:
        return
    try:
        declared_bytes = int(content_length)
    except ValueError as error:
        raise TemporaryAoiRequestError(
            "The AOI upload Content-Length is malformed"
        ) from error
    if declared_bytes < 0:
        raise TemporaryAoiRequestError(
            "The AOI upload Content-Length cannot be negative"
        )
    if declared_bytes > MAX_MULTIPART_BODY_BYTES:
        raise TemporaryAoiTooLargeError(
            f"AOI multipart requests cannot exceed {MAX_MULTIPART_BODY_BYTES} bytes"
        )


async def parse_temporary_aoi_form(request: Request) -> FormData:
    """Parse the exact bounded multipart upload form.

    Args:
        request: Incoming request expected to contain one file and at most one
            replacement identifier.

    Returns:
        Parsed form whose caller must close after using its UploadFile.

    Raises:
        TemporaryAoiRequestError: If media type, fields, files, or parser syntax
            violate the exact contract.
        TemporaryAoiTooLargeError: If declared or streamed bytes exceed a
            resource ceiling.
    """
    validate_declared_body_size(request)
    if request.headers.get("content-type", "").partition(";")[0].lower() != (
        "multipart/form-data"
    ):
        raise TemporaryAoiRequestError(
            "Temporary AOI uploads require multipart/form-data"
        )
    parser = BoundedMultiPartParser(
        request.headers,
        bounded_request_stream(request),
        max_files=1,
        max_fields=1,
        max_part_size=1024,
        maximum_file_bytes=MAX_UPLOAD_BYTES,
    )
    try:
        form = await parser.parse()
    except TemporaryAoiTooLargeError:
        raise
    except MultiPartException as error:
        detail = str(error)
        if "exceeds" in detail or "maximum" in detail.lower():
            raise TemporaryAoiTooLargeError(detail) from error
        raise TemporaryAoiRequestError(
            f"The AOI multipart form is invalid: {detail}"
        ) from error
    except Exception as error:
        raise TemporaryAoiRequestError(
            "The AOI multipart form is malformed"
        ) from error
    items = form.multi_items()
    allowed_names = {"file", "replacementId"}
    if any(name not in allowed_names for name, _value in items):
        await form.close()
        raise TemporaryAoiRequestError(
            "The AOI multipart form contains an unsupported field"
        )
    if sum(name == "file" for name, _value in items) != 1:
        await form.close()
        raise TemporaryAoiRequestError(
            "The AOI multipart form requires exactly one file field"
        )
    if sum(name == "replacementId" for name, _value in items) > 1:
        await form.close()
        raise TemporaryAoiRequestError(
            "The AOI multipart form accepts at most one replacementId"
        )
    file_value = form.get("file")
    replacement_value = form.get("replacementId")
    if not isinstance(file_value, UploadFile):
        await form.close()
        raise TemporaryAoiRequestError("The AOI file field must be a file")
    if replacement_value is not None and not isinstance(replacement_value, str):
        await form.close()
        raise TemporaryAoiRequestError(
            "The replacementId field must be text"
        )
    return form


def create_temporary_aoi_router(
    controller: TemporaryAoiController,
) -> APIRouter:
    """Create focused upload, selection, and removal routes.

    Args:
        controller: Application lifecycle service receiving validated route
            inputs and owning all temporary storage.

    Returns:
        Router exposing the temporary-AOI HTTP contract.
    """
    router = APIRouter(prefix="/api/temporary-aois", tags=["temporary AOI"])

    @router.post(
        "",
        response_model=(
            TemporaryAoiReadyResponse | TemporaryAoiSelectionRequiredResponse
        ),
    )
    async def upload_temporary_aoi(request: Request) -> JSONResponse:
        """Upload one bounded temporary GeoPackage or zipped Shapefile.

        Args:
            request: Incoming exact multipart form.

        Returns:
            HTTP 201 ready geometry or HTTP 202 explicit selection choices.

        Raises:
            HTTPException: If multipart, validation, or lifecycle fails.
        """
        try:
            form = await parse_temporary_aoi_form(request)
            try:
                upload_file = cast(UploadFile, form["file"])
                await upload_file.seek(0)
                result = await controller.upload(
                    upload_file.filename or "",
                    upload_file.file,
                    form.get("replacementId"),
                )
            finally:
                await form.close()
        except TemporaryAoiError as error:
            raise temporary_aoi_http_exception(error) from error
        status_code = (
            202
            if isinstance(result, TemporaryAoiSelectionRequiredResponse)
            else 201
        )
        return JSONResponse(
            status_code=status_code,
            content=result.model_dump(mode="json", by_alias=True),
        )

    @router.post(
        "/{temporary_id}/selection",
        response_model=TemporaryAoiReadyResponse,
    )
    async def select_temporary_aoi_dataset(
        temporary_id: str,
        selection: TemporaryAoiSelectionRequest,
    ) -> TemporaryAoiReadyResponse:
        """Select one opaque dataset from a staged multi-dataset upload.

        Args:
            temporary_id: Opaque staged-upload identifier.
            selection: Exact opaque choice request.

        Returns:
            Ready bounded WGS 84 geometry.

        Raises:
            HTTPException: If identity, lifecycle, or geometry is invalid.
        """
        try:
            return await controller.select(
                temporary_id,
                selection.choice_id,
            )
        except TemporaryAoiError as error:
            raise temporary_aoi_http_exception(error) from error

    @router.delete("/{temporary_id}", status_code=204)
    async def remove_temporary_aoi(temporary_id: str) -> Response:
        """Remove one temporary AOI and invalidate its opaque identifier.

        Args:
            temporary_id: Opaque active temporary AOI identifier.

        Returns:
            Empty HTTP 204 response after deterministic cleanup.

        Raises:
            HTTPException: If the identifier is absent or expired.
        """
        try:
            await controller.remove(temporary_id)
        except TemporaryAoiError as error:
            raise temporary_aoi_http_exception(error) from error
        return Response(status_code=204)

    return router
