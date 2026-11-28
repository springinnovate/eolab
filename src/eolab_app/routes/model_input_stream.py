"""Receive a compact model invocation and its input documents in one request."""

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable
from hashlib import sha256
from pathlib import Path

from fastapi import HTTPException
from pydantic import TypeAdapter, ValidationError

from eolab_app.drawings.models import DrawingFeatureCollection
from eolab_app.catalog_selection import SavedDrawingReference
from eolab_app.processing.model_run_contracts import ModelRunRequest
from eolab_app.processing.models import (
    MAX_STAGED_INPUT_BYTES,
    JobInputDocument,
    JobInputReference,
    OpaqueId,
)


async def input_lines(chunks: AsyncIterator[bytes]) -> AsyncGenerator[bytes, None]:
    """Read the invocation, ordered input IDs and one JSON line per attached source.

    Args:
        chunks: Request body chunks in transport order.

    Yields:
        The first two lines within 16 KiB each, then individually size-checked inputs.

    Raises:
        HTTPException: If a line exceeds its limit before JSON parsing.
    """
    line = bytearray()
    number = 0
    async for chunk in chunks:
        start = 0
        while start < len(chunk):
            newline = chunk.find(b"\n", start)
            end = len(chunk) if newline < 0 else newline
            limit = 16 * 1024 if number < 2 else MAX_STAGED_INPUT_BYTES
            if len(line) + end - start > limit:
                raise HTTPException(
                    413, f"This submission part exceeds {limit:,} bytes."
                )
            line.extend(memoryview(chunk)[start:end])
            if newline >= 0:
                number += 1
                complete = bytes(line)
                line.clear()
                yield complete
                del complete
            start = end + 1
    if line:
        yield bytes(line)


def prepare_drawing(
    body: bytes, reference: JobInputReference, path: Path
) -> JobInputDocument | SavedDrawingReference:
    """Write original drawing features or identify the editor revision to read.

    Args:
        body: Original document bytes, excluding the newline delimiter.
        reference: Input identity in the submitted model invocation.
        path: Private file assigned by the request handler.

    Returns:
        The validated features on disk, or a revision requiring an authorized editor read.

    Raises:
        HTTPException: The checksum, geometry or normalized input size is invalid.
        OSError: The request's temporary directory is unavailable.
    """
    if sha256(body).hexdigest() != reference.sha256:
        raise HTTPException(
            422, "The attached drawing does not match the selected input."
        )
    try:
        if reference.media_type == "application/json":
            return SavedDrawingReference.model_validate_json(body)
        document = DrawingFeatureCollection.normalize_document(body).encode("utf-8")
    except ValidationError as error:
        raise HTTPException(
            422,
            error.errors(include_input=False, include_context=False, include_url=False),
        ) from error
    if len(document) > MAX_STAGED_INPUT_BYTES:
        raise HTTPException(413, "The drawing exceeds the private input size limit.")
    path.write_bytes(document)
    return JobInputDocument(reference, path)


class ModelInputStream:
    """Read source files only for private vector inputs declared by this model run."""

    def __init__(
        self,
        chunks: AsyncIterator[bytes],
        directory: Path,
        capture_filter: Callable[[SavedDrawingReference], Awaitable[bytes]],
    ) -> None:
        """Bind the request stream to its private temporary directory.

        Args:
            chunks: Incoming newline-delimited JSON.
            directory: Directory owned and removed by the HTTP request.
            capture_filter: Read the selected polygons at the requested editor revision.
        """
        self.lines = input_lines(chunks)
        self.directory = directory
        self.capture_filter = capture_filter

    async def read_invocation(self) -> ModelRunRequest:
        """Return the compact invocation before reading its input attachments.

        Raises:
            HTTPException: The first line does not contain a valid model invocation.
        """
        try:
            return ModelRunRequest.model_validate_json(await anext(self.lines, b""))
        except ValidationError as error:
            raise HTTPException(
                422,
                error.errors(
                    include_input=False, include_context=False, include_url=False
                ),
            ) from error

    async def receive_inputs(
        self, references: dict[str, JobInputReference]
    ) -> tuple[JobInputDocument, ...]:
        """Read each declared attachment exactly once after the model is validated.

        Args:
            references: Private sources required by the validated calculation.

        Returns:
            Request-owned files that can be committed with the job.

        Raises:
            HTTPException: Input IDs, source data or the number of attachments are invalid.
        """
        try:
            ids = TypeAdapter(list[OpaqueId]).validate_json(
                await anext(self.lines, b"")
            )
        except ValidationError as error:
            raise HTTPException(
                422, "Choose valid input IDs for the attached drawings."
            ) from error
        if not ids or len(set(ids)) != len(ids) or not references.keys() >= set(ids):
            raise HTTPException(
                422,
                "Each attached drawing must identify a distinct input of this model.",
            )
        documents = []
        for index, key in enumerate(ids):
            body = await anext(self.lines, b"")
            path = self.directory / str(index)
            reference = references[key]
            document = await asyncio.to_thread(prepare_drawing, body, reference, path)
            del body
            if isinstance(document, SavedDrawingReference):
                polygons = await self.capture_filter(document)
                await asyncio.to_thread(path.write_bytes, polygons)
                del polygons
                document = JobInputDocument(reference, path)
            documents.append(document)
        if await anext(self.lines, None) is not None:
            raise HTTPException(422, "The submission contains an unexpected drawing.")
        return tuple(documents)
