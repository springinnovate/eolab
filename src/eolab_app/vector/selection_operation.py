"""Count matching vector features in a Job service execution process."""

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING, Any

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    NonNegativeInt,
    model_validator,
)

from eolab_app.catalog_selection import (
    ArtifactVectorSelection,
    ResolvedCatalogSelection,
    VectorSelection,
    SelectionUnavailableError,
)
from eolab_app.source_files import SourceFileError, resolve_leased_source_path

if TYPE_CHECKING:
    import httpx2
    from eolab_app.feature_intersection import IntersectionLayer

# These are internal Compose endpoints, not caller-supplied source locations.
CATALOG_URL = "http://stac-api:8080"
SCAN_MOUNT = Path("/scan-source")
UPLOAD_MOUNT = Path("/vector-uploads")
PROCESSING_MOUNT = Path("/processing-data")
SOURCE_FILES_URL = "http://app:8000/api/processing/source-files"
COMPARISON_URL = "http://app:8000/api/vector-sampling/spatial-comparison"


class ComparisonInput(BaseModel):
    """A one-job credential for reading the authorized pair of original vector sources."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    spatialRead: str = Field(pattern=r"^[a-f0-9]{64}$")


class ComparisonResult(BaseModel):
    """An optional readable failure after matching IDs have been returned to their owner."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    error: str | None = Field(default=None, max_length=1024)


class SelectionMeasurementInput(BaseModel):
    """Identify a vector layer and filter, with server-only ownership for uploads."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    selection: VectorSelection
    uploadOwner: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    spatialRead: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    readLease: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")

    @model_validator(mode="after")
    def require_result_lease(self) -> "SelectionMeasurementInput":
        """Require a held read capability exactly when reading a generated result.

        Returns:
            This validated operation input.

        Raises:
            ValueError: If an artifact lacks a lease or another source supplies one.
        """
        if isinstance(self.selection, ArtifactVectorSelection) != (
            self.readLease is not None
        ):
            raise ValueError("Only run artifact selections require a read lease")
        return self


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
    from eolab_app.bounded_vector import _limit_memory, count_selected_features
    async with httpx2.AsyncClient(
        timeout=5, trust_env=False, follow_redirects=False
    ) as client:
        resolved = await _open_job_selection(client, inputs)
        with _limit_memory():
            measurements = FeatureMeasurements.model_validate(
                count_selected_features(resolved)
            )
        return SelectionMeasurementResult(measurements=measurements)


async def _open_job_selection(client: "httpx2.AsyncClient", inputs: SelectionMeasurementInput) -> ResolvedCatalogSelection:
    """Open a native job's authorized original and apply any bound spatial conditions.

    Args:
        client: Internal HTTP connection for catalog, result leases and spatial reads.
        inputs: Path-free source, predicate and appropriate upload owner or result lease.

    Returns:
        Original source on the worker's mounted volume, ready to read.

    Raises:
        SelectionUnavailableError: If the selection or its retained read credentials changed.
        VectorUploadError: If the worker cannot read the private upload.
    """
    from eolab_app.vector.catalog import StacVectorCatalog
    from eolab_app.vector.selection_source import resolve_selection
    from eolab_app.vector.sources import MountedVectorResolver
    from eolab_app.vector.spatial_read import load_spatial_read
    from eolab_app.vector_uploads import VectorUploadStore

    if isinstance(inputs.selection, ArtifactVectorSelection):
        from eolab_app.bounded_vector import resolve_vector_file_selection
        try:
            path = await resolve_leased_source_path(
                client, inputs.selection.jobId, inputs.selection.artifactId, inputs.readLease,
                PROCESSING_MOUNT, "application/geopackage+sqlite3", source_url=SOURCE_FILES_URL,
            )
        except SourceFileError as error:
            raise SelectionUnavailableError(str(error)) from error
        resolved = resolve_vector_file_selection(path, inputs.selection)
    else:
        resolved = await resolve_selection(
            StacVectorCatalog(client, CATALOG_URL), MountedVectorResolver(SCAN_MOUNT), inputs.selection,
            VectorUploadStore(UPLOAD_MOUNT, max_bytes=None), inputs.uploadOwner,
        )
    if resolved.selection != inputs.selection:
        raise SelectionUnavailableError("The selected vector identity changed. Choose the layer again.")
    return await load_spatial_read(client, resolved, inputs.spatialRead)


def compare_selected_features(inputs: ComparisonInput) -> ComparisonResult:
    """Compare original vector features inside the supervised Jobs worker.

    Args:
        inputs: Short-lived bearer credential issued for this source pair.

    Returns:
        Confirmation of delivery or a readable source error.
    """
    import httpx2
    from eolab_app.bounded_geometry import GeometryValidationError
    from eolab_app.vector.errors import VectorFeatureError
    from eolab_app.vector_uploads import VectorUploadError

    async def compare() -> None:
        """Return original feature IDs while the submitting request holds both sources."""
        async with httpx2.AsyncClient(timeout=10, trust_env=False, follow_redirects=False) as client:
            await return_intersecting_ids(client, inputs)

    try:
        asyncio.run(compare())
    except (GeometryValidationError, SelectionUnavailableError, VectorFeatureError, VectorUploadError) as error:
        return ComparisonResult(error=str(error))
    except httpx2.HTTPError:
        return ComparisonResult(error="The original layers are unavailable for this comparison.")
    return ComparisonResult()


async def return_intersecting_ids(client: "httpx2.AsyncClient", inputs: ComparisonInput) -> None:
    """Read the two original layers and send their matching IDs directly to the waiting request.

    Args:
        client: Internal connection to the application, catalog and leased-file authority.
        inputs: A single comparison's bearer credential.

    Raises:
        GeometryValidationError: If the native comparison exceeds its read limits or the polygon geometry is invalid.
        SelectionUnavailableError: If either original or its credentials expired.
        httpx2.HTTPError: If the submitting request or an upstream service is unavailable.
    """
    from eolab_app.bounded_vector import _limit_memory
    from eolab_app.feature_intersection import intersecting_feature_ids
    from eolab_app.polygon_areas import SummaryPolygon

    async def read_layer(layer: dict[str, Any]) -> "IntersectionLayer":
        """Open a bound file source or recover the committed drawings sent for this read."""
        if "polygons" in layer:
            return tuple(SummaryPolygon.model_validate(polygon) for polygon in layer["polygons"])
        return await _open_job_selection(client, SelectionMeasurementInput.model_validate(layer))

    headers = {"Authorization": f"Bearer {inputs.spatialRead}"}
    pair = await client.get(COMPARISON_URL, headers=headers)
    pair.raise_for_status()
    targets, polygons = pair.json()
    with _limit_memory():
        ids = intersecting_feature_ids(await read_layer(targets), await read_layer(polygons))
    delivered = await client.put(COMPARISON_URL, headers=headers, json=ids)
    delivered.raise_for_status()
