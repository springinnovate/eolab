"""Resolve catalog and private raster references for the same original-data readers."""

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hashlib
import json
import math
import sys
from typing import Any

import rasterio

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    run_bounded_process,
)
from eolab_app.raster.geographic_bounds import transform_bounds_to_wgs84
from eolab_app.raster.errors import RasterAssetError, RasterConflictError
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.ports import RasterSourceAuthorizer
from eolab_app.raster.source_contract import (
    require_pixel_source_structure,
    require_bounded_source_structure,
    require_raster_analysis_georeferencing,
    require_signed_raster_dependencies,
)
from eolab_app.raster.source_models import (
    RasterAnalysisSourceReference,
    TemporalRasterSelection,
    TemporalIntervalSelection,
)
from eolab_app.raster.temporal import TemporalObservation
from eolab_app.raster.reader import RasterData, open_raster_data
from eolab_app.source_files import LeasedSourceFiles, SourceFileError


@dataclass(frozen=True)
class RasterReadSource:
    """Original raster data available inside an authorized source-access scope.

    Attributes:
        data: Confined file or observation consumed only by native readers.
        cache_identity: Source selection identity, including private access when needed.
        version: Public source selection identity, without credentials or paths.
        private: Whether this raster is a session-owned run file.
    """

    data: RasterData
    cache_identity: tuple[object, ...]
    version: str
    private: bool = False


def raster_read_process(
    writer: Any, reader: Callable[..., Any], arguments: tuple[Any, ...]
) -> None:
    """Run a raster reader in a child process with a 2 GiB Linux memory limit.

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
    """Read a private raster in a supervised process with a 30-second deadline.

    The supervisor stops and joins the child process before cancellation returns.
    Source acquisition, cache identity and numerical policy remain outside this helper.

    Args:
        reader: Trusted installed numerical reader.
        arguments: Already-authorized reader arguments.

    Returns:
        The value returned by the supplied reader.

    Raises:
        RasterConflictError: If native reading is invalid, fails or times out.
        ValueError: If the reader rejects the data or requested sampling area.
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


def describe_raster_data(data: RasterData) -> dict[str, Any]:
    """Inspect original raster metadata and report the current readers' supported operations.

    Args:
        data: Authorized original file or selected temporal observation.

    Returns:
        Path-free grid metadata and pixel/statistics capability explanations.
        Geographic bounds are null when extent projection is unavailable;
        this does not change the independent numerical capabilities.

    Raises:
        ValueError: If georeferencing or signed file dependencies are unsupported.
        OSError: If native source metadata cannot be read.
        RasterioError: If native metadata cannot be read.
    """
    with (
        rasterio.Env(GDAL_CACHEMAX=32 * 1024**2),
        open_raster_data(data) as dataset,
    ):
        require_signed_raster_dependencies(dataset, data)
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
        try:
            bounds = transform_bounds_to_wgs84(dataset.crs, tuple(dataset.bounds))
            if not all(math.isfinite(value) for value in bounds):
                bounds = None
        except (ValueError, rasterio.errors.RasterioError):
            bounds = None
        return {
            "bounds": bounds,
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
        """Configure source access for catalog rasters and private run files.

        Args:
            catalog: Resolves admitted raster files and temporal observations.
            files: Optional private immutable-file access composed by the application.
        """
        self.catalog, self.files = catalog, files
        self._metadata_slots = asyncio.Semaphore(2)

    @asynccontextmanager
    async def open(
        self, reference: RasterAnalysisSourceReference, owner: str | None = None
    ) -> AsyncIterator[RasterReadSource]:
        """Return original raster data, retaining private files for the complete read.

        Args:
            reference: Validated file identity or temporal observation selection.
            owner: Server-derived session hash required only for private references.

        Yields:
            Authorized original raster with an ownership-aware cache identity.

        Raises:
            RasterFeatureError: On invalid catalog metadata or a non-raster artifact.
            SourceFileError: If private source access is unavailable or changes.
            Exception: If the owning authority rejects access.
        """
        if isinstance(reference, (CatalogRasterRequest, TemporalRasterSelection)):
            yield await self.resolve(reference, owner)
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

    async def resolve(
        self, reference: RasterAnalysisSourceReference, owner: str | None = None
    ) -> RasterReadSource:
        """Authorize an original raster for the ordinary short-read pipeline.

        Args:
            reference: Validated file identity or temporal observation selection.
            owner: Server-derived session hash for a private output.

        Returns:
            Original file or observation and its selection identity, without a retention lease.

        Raises:
            RasterFeatureError: If catalog authorization or the format fails.
            SourceFileError: If ownership, expiry or file resolution fails.
        """
        if isinstance(reference, TemporalRasterSelection):
            (observation,) = await self.catalog.get_observations(reference)
            identity = (
                "temporal",
                reference.collection_id,
                reference.item_id,
                reference.variable,
                reference.time.isoformat(),
            )
            version = hashlib.sha256(json.dumps(identity).encode()).hexdigest()
            return RasterReadSource(observation, identity, version)
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
            return RasterReadSource(source.source_path, ("catalog", *identity), version)
        if self.files is None or owner is None:
            raise SourceFileError(
                "This raster result is unavailable to this session.", 404
            )
        source = await self.files.resolve(
            owner, reference.job_id, reference.artifact_id
        )
        if source.media_type != "image/tiff":
            raise RasterAssetError("Choose a GeoTIFF raster result.")
        return RasterReadSource(
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
        self, reference: RasterAnalysisSourceReference, owner: str | None = None
    ) -> dict[str, Any]:
        """Return original metadata and capabilities without exposing source paths.

        Args:
            reference: Requested file identity or temporal observation selection.
            owner: Server-derived private session hash when required.

        Returns:
            Source reference, selection version, grid metadata and current reader support.

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
                metadata = await read_private_raster(describe_raster_data, source.data)
            except ValueError as error:
                raise RasterConflictError(str(error)) from error
            return {
                "source": reference.model_dump(by_alias=True),
                "version": source.version,
                **metadata,
            }

    async def get_observations(
        self,
        selection: TemporalIntervalSelection,
    ) -> tuple[TemporalObservation, ...]:
        """Return ordered observations and their time support for a requested period.

        Args:
            selection: Path-free dataset, variable and requested period.

        Returns:
            Ordered available observations, retaining their original time support.
            Gaps remain absent; the caller decides how to summarize them.

        Raises:
            RasterFeatureError: If the Catalog or selected source cannot be read.
        """
        return await self.catalog.get_observations(selection)
