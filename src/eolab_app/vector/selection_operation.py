"""Measure filtered vector polygons in a Job service execution process."""

import asyncio
from pathlib import Path

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    NonNegativeInt,
    model_validator,
)

from eolab_app.catalog_selection import VectorSelection, SelectionUnavailableError

# These are internal Compose endpoints, not caller-supplied source locations.
CATALOG_URL = "http://stac-api:8080"
SCAN_MOUNT = Path("/scan-source")
UPLOAD_MOUNT = Path("/vector-uploads")


class SelectionMeasurementInput(BaseModel):
    """Identify a vector layer and filter, with server-only ownership for uploads."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    selection: VectorSelection
    uploadOwner: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class FeatureMeasurements(BaseModel):
    """Counts and WGS84 bounds of matching polygons; contains no geometry."""

    model_config = ConfigDict(extra="forbid")
    bbox: tuple[FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat]
    matched: NonNegativeInt
    total: NonNegativeInt
    coordinates: NonNegativeInt
    rings: NonNegativeInt
    exactGeometryBytes: NonNegativeInt

    @model_validator(mode="after")
    def check_counts_and_bounds(self) -> "FeatureMeasurements":
        """Reject inconsistent measurements returned across the Jobs boundary.

        Returns:
            The measured feature counts and bounds.

        Raises:
            ValueError: If no feature matched, counts disagree, or bounds reverse.
        """
        if not 0 < self.matched <= self.total or (
            self.bbox[0] > self.bbox[2] or self.bbox[1] > self.bbox[3]
        ):
            raise ValueError("Invalid selected-feature measurements")
        return self


class SelectionMeasurementResult(BaseModel):
    """Measurements or an expected source/geometry error safe to show the user.

    Invalid polygons and empty filters are completed checks with no measurements.
    Unexpected exceptions still fail the job and remain private to service logs.
    """

    model_config = ConfigDict(extra="forbid")
    measurements: FeatureMeasurements | None = None
    error: str | None = Field(default=None, min_length=1, max_length=1024)

    @model_validator(mode="after")
    def require_measurements_or_error(self) -> "SelectionMeasurementResult":
        """Require exactly one completed measurement or readable error.

        Returns:
            The validated operation result.

        Raises:
            ValueError: If both alternatives are present or both are absent.
        """
        if (self.measurements is None) == (self.error is None):
            raise ValueError("Expected measurements or a selection error")
        return self


def measure_selected_features(
    inputs: SelectionMeasurementInput,
) -> SelectionMeasurementResult:
    """Read matching polygons once and return their counts and bounding envelope.

    Args:
        inputs: Source identity, immutable filter and private upload owner if needed.

    Returns:
        Measurements, or a safe explanation of empty, invalid, or unreadable inputs.

    Raises:
        VectorFeatureError: Catalog cannot authorize the requested layer/filter.
        OSError: A source file or the process memory limit cannot be inspected.
        ValueError: Native measurements do not match the result schema.
    """
    from eolab_app.bounded_geometry import GeometryValidationError
    from eolab_app.vector_uploads import VectorUploadError

    try:
        return asyncio.run(_measure_selected_features(inputs))
    except (
        GeometryValidationError,
        SelectionUnavailableError,
        VectorUploadError,
    ) as error:
        return SelectionMeasurementResult(error=str(error))


async def _measure_selected_features(
    inputs: SelectionMeasurementInput,
) -> SelectionMeasurementResult:
    """Measure a vector layer's filtered polygons within the native read limits.

    Args:
        inputs: Path-free source descriptor established by Vector selection.

    Returns:
        Counts/bounds for the same source identified by the request.

    Raises:
        SelectionUnavailableError: The requested source identity is invalid.
        VectorUploadError: The upload is unavailable to the submitted owner.
        GeometryValidationError: No polygons match, geometry is invalid, or a
            polygon exceeds its read budget.
        VectorFeatureError: Catalog cannot authorize the requested layer/filter.
        OSError: A source file or the process memory limit cannot be inspected.
        ValueError: Native measurements do not match the result schema.
    """
    # Discovery must not import native GIS libraries into the Jobs HTTP process.
    import httpx2
    from eolab_app.bounded_vector import _limit_memory, selection_summary
    from eolab_app.vector.catalog import StacVectorCatalog
    from eolab_app.vector.selection_source import resolve_selection
    from eolab_app.vector.sources import MountedVectorResolver
    from eolab_app.vector_uploads import VectorUploadStore

    async with httpx2.AsyncClient(
        timeout=5, trust_env=False, follow_redirects=False
    ) as client:
        catalog = StacVectorCatalog(client, CATALOG_URL)
        resolver = MountedVectorResolver(SCAN_MOUNT)
        resolved = await resolve_selection(
            catalog,
            resolver,
            inputs.selection,
            VectorUploadStore(UPLOAD_MOUNT, max_bytes=None),
            inputs.uploadOwner,
        )
        if resolved.selection != inputs.selection:
            raise SelectionUnavailableError(
                "The selected vector identity changed; select it again."
            )
        with _limit_memory():
            measurements = FeatureMeasurements.model_validate(
                selection_summary(resolved)
            )
        return SelectionMeasurementResult(measurements=measurements)
