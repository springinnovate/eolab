"""Count matching vector features in a Job service execution process."""

import asyncio
from pathlib import Path

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
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
    """Exact matching and total feature counts; contains no geometry."""

    model_config = ConfigDict(extra="forbid")
    matched: NonNegativeInt
    total: NonNegativeInt

    @model_validator(mode="after")
    def check_counts(self) -> "FeatureMeasurements":
        """Reject empty or inconsistent counts returned across the Jobs boundary.

        Returns:
            The measured feature counts.

        Raises:
            ValueError: If no feature matched or the count exceeds the total.
        """
        if not 0 < self.matched <= self.total:
            raise ValueError("Invalid selected-feature measurements")
        return self


class SelectionMeasurementResult(BaseModel):
    """Feature counts or an expected selection error safe to show the user.

    Selections with no matches and unavailable sources complete with an error.
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
    """Count features using their attributes without reading polygon coordinates.

    Args:
        inputs: Source identity, immutable filter and private upload owner if needed.

    Returns:
        Exact counts, or a safe explanation of empty or unreadable inputs.

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
    """Count matching features by their attributes within the native read limits.

    Args:
        inputs: Path-free source descriptor established by Vector selection.

    Returns:
        Matching and total feature counts for the requested source.

    Raises:
        SelectionUnavailableError: The requested source identity is invalid.
        VectorUploadError: The upload is unavailable to the submitted owner.
        GeometryValidationError: No features match or the read exceeds its budget.
        VectorFeatureError: Catalog cannot authorize the requested layer/filter.
        OSError: A source file or the process memory limit cannot be inspected.
        ValueError: Native measurements do not match the result schema.
    """
    # Discovery must not import native GIS libraries into the Jobs HTTP process.
    import httpx2
    from eolab_app.bounded_vector import _limit_memory, selection_counts
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
                selection_counts(resolved)
            )
        return SelectionMeasurementResult(measurements=measurements)
