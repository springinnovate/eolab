"""Supply registered operations with existing Processing execution capabilities."""

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from eolab_app.catalog_selection import CatalogSelectionReader
from eolab_app.execution.reusable_process import ReusableProcess
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.downstream_models import DownstreamLimits
from eolab_app.processing.ports import JobStore
from eolab_app.raster.models import AuthorizedRaster


@dataclass(frozen=True)
class OperationContext:
    """Worker capabilities supplied to registered Processing operations.

    Attributes:
        jobs: Existing result-cache and lifecycle storage interface.
        areas: Reader for immutable catalog vector selections.
        limits: Deployment clip and lifecycle limits.
        aggregate_limits: Summary computation and mask limits.
        native: Supervised native execution lane.
        run_native: Bounded execution function supplied by the worker.
        reuse_results: Whether this job may use the scalar-results cache.
        source_checksum: Verified published checksum for a private raster input.
        rasters: Additional raster inputs authorized for this operation attempt.
        downstream_limits: Administrator budgets for downstream native work.
    """

    jobs: JobStore
    areas: CatalogSelectionReader | None
    limits: RasterClipLimits
    aggregate_limits: RasterAggregateLimits
    native: ReusableProcess | None
    run_native: Callable[..., Awaitable[Any]]
    reuse_results: bool
    source_checksum: str | None = None
    rasters: dict[str, AuthorizedRaster] = field(default_factory=dict)
    downstream_limits: DownstreamLimits = field(default_factory=DownstreamLimits)
