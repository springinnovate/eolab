"""Resolve catalog and private raster references for the same original-data readers."""

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
import sys
from typing import Any

import rasterio

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    run_bounded_process,
)
from eolab_app.raster.errors import RasterAssetError, RasterConflictError
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.ports import RasterSourceAuthorizer
from eolab_app.raster.source_contract import (
    require_pixel_source_structure,
    require_bounded_source_structure,
    require_raster_analysis_georeferencing,
    require_signed_raster_dependencies,
)
from eolab_app.raster.source_models import RasterSourceReference
from eolab_app.source_files import LeasedSourceFiles, SourceFileError


@dataclass(frozen=True)
class RasterReadSource:
    """Original raster data available inside an authorized source-access scope.

    Attributes:
        source_path: Confined path consumed only by native readers.
        cache_identity: Immutable identity including private access context where needed.
        version: Public immutable version, without ownership credentials or paths.
        private: Whether cancellation must stop supervised work before releasing a lease.
    """

    source_path: Path
    cache_identity: tuple[object, ...]
    version: str
    private: bool = False


def raster_read_process(
    writer: Any, reader: Callable[..., Any], arguments: tuple[Any, ...]
) -> None:
    """Execute an existing raster reader under a killable process deadline.

    Args:
        writer: Supervisor's result pipe.
        reader: Trusted installed reader, never chosen by an HTTP import name.
        arguments: Authorized paths and validated numerical arguments.
    """
    try:
        if sys.platform == "linux":
            import resource

            resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        writer.put(("ok", reader(*arguments)))
    except ValueError as error:
        # Preserve the reader's typed no-overlap/no-valid-values failures so its
        # owning service can produce the same message as for catalog sources.
        writer.put(("invalid", error))
    except Exception:
        writer.put(("error", "The raster could not be read."))


async def read_private_raster(reader: Callable[..., Any], *arguments: Any) -> Any:
    """Call the ordinary numerical reader with a 30-second private-file deadline.

    The existing supervisor kills and joins native work before cancellation returns.
    Source acquisition, cache identity and numerical policy remain outside this helper.

    Args:
        reader: Trusted installed numerical reader.
        arguments: Already-authorized reader arguments.

    Returns:
        The reader's existing result contract.

    Raises:
        RasterConflictError: If native reading is invalid, fails or times out.
        ValueError: The reader's existing invalid-data contract, handled by its caller.
        asyncio.CancelledError: After the child process has stopped.
    """
    try:
        status, result = await run_bounded_process(
            raster_read_process, (reader, arguments), 30
        )
    except ProcessDeadlineError as error:
        raise RasterConflictError(
            "The raster read took too long. Choose a smaller area."
        ) from error
    if status == "invalid":
        raise result
    if status != "ok":
        raise RasterConflictError(result)
    return result


def describe_raster_file(path: Path) -> dict[str, Any]:
    """Inspect original raster metadata and report the current readers' supported operations.

    Args:
        path: Authorized original GeoTIFF path retained for this read.

    Returns:
        Path-free grid metadata and pixel/statistics capability explanations.

    Raises:
        ValueError: If georeferencing or signed file dependencies are unsupported.
        RasterioError: If native metadata cannot be read.
    """
    with (
        rasterio.Env(GDAL_CACHEMAX=32 * 1024**2),
        rasterio.open(path, driver="GTiff") as dataset,
    ):
        require_signed_raster_dependencies(dataset, path)
        require_raster_analysis_georeferencing(dataset)
        try:
            require_pixel_source_structure(dataset)
            pixel_reason = None
        except ValueError as error:
            pixel_reason = str(error)
        try:
            require_bounded_source_structure(dataset)
            statistics_reason = None
        except ValueError as error:
            statistics_reason = str(error)
        nodata = dataset.nodata
        return {
            "width": dataset.width,
            "height": dataset.height,
            "bands": dataset.count,
            "dtype": dataset.dtypes[0],
            "crs": dataset.crs.to_string(),
            "transform": tuple(dataset.transform)[:6],
            "nodata": nodata if nodata is None or math.isfinite(nodata) else None,
            "capabilities": {
                "pixels": {"supported": pixel_reason is None, "reason": pixel_reason},
                "statistics": {
                    "supported": statistics_reason is None,
                    "reason": statistics_reason,
                },
            },
        }


class RasterSourceAccess:
    """Open original raster data through its catalog or private file authority."""

    def __init__(
        self, catalog: RasterSourceAuthorizer, files: LeasedSourceFiles | None = None
    ) -> None:
        """Compose the existing source authorities without changing numerical readers.

        Args:
            catalog: Existing catalog-only authorization, also used by Processing workers.
            files: Optional private immutable-file access composed by the application.
        """
        self.catalog, self.files = catalog, files
        self._metadata_slots = asyncio.Semaphore(2)

    @asynccontextmanager
    async def open(
        self, reference: RasterSourceReference, owner: str | None = None
    ) -> AsyncIterator[RasterReadSource]:
        """Resolve a source and retain its original file for the caller's complete read.

        Args:
            reference: Validated catalog or opaque run/file identity.
            owner: Server-derived session hash required only for private references.

        Yields:
            Authorized original raster with an ownership-aware cache identity.

        Raises:
            RasterFeatureError: On invalid catalog metadata or a non-raster artifact.
            SourceFileError: If private source access is unavailable or changes.
            Exception: If the owning authority rejects access.
        """
        if isinstance(reference, CatalogRasterRequest):
            source = await self.catalog.authorize(reference)
            identity = (
                reference.collection_id,
                reference.item_id,
                source.source_signature,
            )
            version = hashlib.sha256(
                json.dumps(identity, default=str).encode()
            ).hexdigest()
            yield RasterReadSource(source.source_path, ("catalog", *identity), version)
            return
        if self.files is None or owner is None:
            raise SourceFileError(
                "This raster result is unavailable to this session.", 404
            )
        async with self.files.open(
            owner, reference.job_id, reference.artifact_id
        ) as source:
            if source.media_type != "image/tiff":
                raise RasterAssetError("Choose a GeoTIFF raster result.")
            yield RasterReadSource(
                source.path,
                (
                    "runArtifact",
                    owner,
                    reference.job_id,
                    reference.artifact_id,
                    source.sha256,
                    source.size,
                ),
                source.sha256,
                True,
            )

    async def describe(
        self, reference: RasterSourceReference, owner: str | None = None
    ) -> dict[str, Any]:
        """Return original metadata and capabilities without exposing source paths.

        Args:
            reference: Requested catalog or private raster identity.
            owner: Server-derived private session hash when required.

        Returns:
            Source reference, immutable version, grid metadata and current reader support.

        Raises:
            RasterFeatureError: On unsupported or unavailable raster content.
            SourceFileError: On failed authorization, capacity or lifetime checks.
        """
        if self._metadata_slots.locked():
            raise SourceFileError(
                "Raster metadata checks are busy. Try again shortly.", 429
            )
        async with self._metadata_slots, self.open(reference, owner) as source:
            try:
                metadata = await read_private_raster(
                    describe_raster_file, source.source_path
                )
            except ValueError as error:
                raise RasterConflictError(str(error)) from error
            return {
                "source": reference.model_dump(by_alias=True),
                "version": source.version,
                **metadata,
            }
