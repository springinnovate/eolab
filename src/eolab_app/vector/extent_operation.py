"""Measure filtered original-source bounds in a Jobs execution process."""

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING, Annotated, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, NonNegativeInt, model_validator

from eolab_app.attribute_filter import VectorFilter
from eolab_app.catalog_selection import (
    ArtifactVectorSelection,
    SelectionUnavailableError,
    VectorSelection,
)
from eolab_app.calculated_fields import CalculatedField
from eolab_app.source_files import SourceFileError, resolve_leased_source_path

if TYPE_CHECKING:
    import httpx2

CATALOG_URL = "http://stac-api:8080"
SCAN_MOUNT = Path("/scan-source")
UPLOAD_MOUNT = Path("/vector-uploads")
PROCESSING_MOUNT = Path("/processing-data")
SOURCE_FILES_URL = "http://app:8000/api/processing/source-files"

Longitude = Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False)]
Latitude = Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)]
OpaqueId = Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]


class ArtifactExtentSelection(BaseModel):
    """Identify an immutable run file and filter without exposing its storage path.

    Attributes:
        kind: The literal string "runArtifact", distinguishing this source identity.
        jobId: Opaque run identity, verified by the file's source authority.
        artifactId: Immutable file identity within that run's published inventory.
        filter: Exact attribute predicate to apply to the original file.
        calculated_fields: View definitions evaluated from original attributes.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["runArtifact"]
    jobId: OpaqueId
    artifactId: OpaqueId
    filter: VectorFilter
    calculated_fields: tuple[CalculatedField, ...] = Field(
        default=(), alias="calculatedFields", exclude_if=lambda value: not value
    )


class ExtentInput(BaseModel):
    """Capture a vector source with the private credential needed to read it.

    Attributes:
        selection: Catalog, uploaded or completed-run source and exact predicate.
        uploadOwner: Server-derived browser identity used only for uploaded files.
        readLease: Existing transfer capability required only for a run artifact.
            The submitting application retains it until Jobs confirms native exit.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    selection: VectorSelection | ArtifactExtentSelection
    uploadOwner: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    readLease: OpaqueId | None = None

    @model_validator(mode="after")
    def check_artifact_lease(self) -> "ExtentInput":
        """Require a read lease exactly when the selection names a run artifact.

        Returns:
            This validated operation input.

        Raises:
            ValueError: If an artifact lacks a lease or another source supplies one.
        """
        if isinstance(
            self.selection, (ArtifactExtentSelection, ArtifactVectorSelection)
        ) != (self.readLease is not None):
            raise ValueError("Only run artifact extents require a read lease")
        return self


class FeatureExtent(BaseModel):
    """Exact matching-feature count and combined projected source-feature envelopes.

    Bounds are WGS84 envelopes with densified native edges, not simplified
    display outlines. Null bounds mean no matching feature contains coordinates. Point and other
    zero-area extents are valid; display padding belongs to the map consumer.
    """

    model_config = ConfigDict(extra="forbid")
    matched: NonNegativeInt
    bbox: tuple[Longitude, Latitude, Longitude, Latitude] | None

    @model_validator(mode="after")
    def check_bounds(self) -> "FeatureExtent":
        """Reject unordered bounds or coordinates for an empty selection.

        Returns:
            The validated measurement.

        Raises:
            ValueError: If the completed read returned inconsistent bounds.
        """
        if self.bbox is not None:
            west, south, east, north = self.bbox
            if self.matched == 0 or west > east or south > north:
                raise ValueError("Invalid selected-feature extent")
        return self


class SelectionExtentResult(BaseModel):
    """Completed original-source extent or a readable expected read failure."""

    model_config = ConfigDict(extra="forbid")
    extent: FeatureExtent | None = None
    error: str | None = Field(default=None, min_length=1, max_length=1024)

    @model_validator(mode="after")
    def require_extent_or_error(self) -> "SelectionExtentResult":
        """Require exactly one completed extent or readable error.

        Returns:
            The validated operation result.

        Raises:
            ValueError: If both alternatives are present or both are absent.
        """
        if (self.extent is None) == (self.error is None):
            raise ValueError("Expected an extent or a vector read error")
        return self


def measure_selected_extent(inputs: ExtentInput) -> SelectionExtentResult:
    """Read all matching original coordinates in an isolated, bounded worker.

    Args:
        inputs: Path-free selection and its upload owner or artifact read lease.

    Returns:
        Combined source-feature envelopes, including empty success, or a safe
        expected read failure.

    Raises:
        VectorFeatureError: Catalog cannot authorize the layer or predicate.
        OSError: A source or process memory limit cannot be inspected.
        ValueError: Native results do not match the operation contract.
    """
    from eolab_app.bounded_geometry import GeometryValidationError
    from eolab_app.vector_uploads import VectorUploadError

    try:
        return asyncio.run(_measure_selected_extent(inputs))
    except (
        GeometryValidationError,
        SelectionUnavailableError,
        VectorUploadError,
    ) as error:
        return SelectionExtentResult(error=str(error))


async def _measure_selected_extent(
    inputs: ExtentInput,
) -> SelectionExtentResult:
    """Reauthorize source identity before reading its original filtered extent.

    Args:
        inputs: Immutable source descriptor established at the vector boundary.

    Returns:
        Completed original-source extent with no retained geometry.

    Raises:
        SelectionUnavailableError: Source identity changed or reading failed.
        VectorUploadError: The upload is unavailable to the submitted owner.
        GeometryValidationError: Actual native read work exceeds its budget.
        VectorFeatureError: Catalog cannot authorize the source or predicate.
        OSError: A source or process memory limit cannot be inspected.
        ValueError: Native results do not match the operation contract.
    """
    # Keep GIS libraries out of operation discovery in the Jobs HTTP process.
    import httpx2
    from eolab_app.bounded_vector import _limit_memory
    from eolab_app.vector.catalog import StacVectorCatalog
    from eolab_app.vector.extents import read_selected_extent
    from eolab_app.vector.selection_source import resolve_selection
    from eolab_app.vector.sources import MountedVectorResolver
    from eolab_app.vector_uploads import VectorUploadStore

    async with httpx2.AsyncClient(
        timeout=5, trust_env=False, follow_redirects=False
    ) as client:
        if isinstance(
            inputs.selection, (ArtifactExtentSelection, ArtifactVectorSelection)
        ):
            return await _measure_artifact_extent(
                client, inputs.selection, cast(str, inputs.readLease)
            )
        resolved = await resolve_selection(
            StacVectorCatalog(client, CATALOG_URL),
            MountedVectorResolver(SCAN_MOUNT),
            inputs.selection,
            VectorUploadStore(UPLOAD_MOUNT, max_bytes=None),
            inputs.uploadOwner,
        )
        if resolved.selection != inputs.selection:
            raise SelectionUnavailableError(
                "The selected vector identity changed; select it again."
            )
        with _limit_memory():
            extent = FeatureExtent.model_validate(read_selected_extent(resolved))
        return SelectionExtentResult(extent=extent)


async def _measure_artifact_extent(
    client: "httpx2.AsyncClient",
    selection: ArtifactExtentSelection | ArtifactVectorSelection,
    read_lease: str,
) -> SelectionExtentResult:
    """Resolve a leased result through its authority and read the original GeoPackage.

    Args:
        client: Internal HTTP client with fixed endpoint and bounded request timeout.
        selection: Opaque artifact identity and exact source predicate.
        read_lease: Existing transfer capability, held by the caller until native exit.

    Returns:
        Original filtered feature count and bounds without retaining geometry.

    Raises:
        SelectionUnavailableError: If source authorization, confinement or opening fails.
        GeometryValidationError: If native extent work exceeds the interactive budget.
        OSError: If the process memory limit cannot be applied.
    """
    import fiona
    from eolab_app.bounded_geometry import GeometryValidationError
    from eolab_app.bounded_vector import _limit_memory
    from eolab_app.vector.extents import read_file_extent

    try:
        path = await resolve_leased_source_path(
            client,
            selection.jobId,
            selection.artifactId,
            read_lease,
            PROCESSING_MOUNT,
            "application/geopackage+sqlite3",
            source_url=SOURCE_FILES_URL,
        )
    except SourceFileError as error:
        raise SelectionUnavailableError(
            "The selected vector result is unavailable."
        ) from error
    with _limit_memory():
        try:
            extent = FeatureExtent.model_validate(
                read_file_extent(path, selection.filter, selection.calculated_fields)
            )
        except GeometryValidationError:
            raise
        except (OSError, ValueError, fiona.errors.FionaError) as error:
            raise SelectionUnavailableError(
                "The selected vector result could not be read."
            ) from error
    return SelectionExtentResult(extent=extent)
