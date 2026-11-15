"""Create simplified vector-feature outlines in a Jobs worker."""

import asyncio
import json
from pathlib import Path

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    FiniteFloat,
    JsonValue,
    model_validator,
)

from eolab_app.catalog_selection import (
    ArtifactVectorSelection,
    VectorSelection,
    SelectionUnavailableError,
)
from eolab_app.source_files import SourceFileError, resolve_leased_source_path

# Fixed Compose service/mount contracts; job callers cannot redirect source access.
# Public hostnames do not affect the Catalog's internal DNS name. Deployments
# choose the host data directory with EOLAB_SCAN_MOUNT_PATH; Compose mounts it
# at /scan-source in both the application and Jobs containers.
CATALOG_URL = "http://stac-api:8080"
SCAN_MOUNT = Path("/scan-source")
UPLOAD_MOUNT = Path("/vector-uploads")
PROCESSING_MOUNT = Path("/processing-data")
SOURCE_FILES_URL = "http://app:8000/api/processing/source-files"
# Maximum compact UTF-8 GeoJSON bytes in a returned map outline. Kept at the
# display_geometry producer's MAX_DISPLAY_BYTES contract without importing its
# native GIS dependencies during operation discovery. A contract test ties them.
MAX_OUTLINE_GEOMETRY_BYTES = 256 * 1024


class OutlineInput(BaseModel):
    """Identify a vector selection and its private owner when outlining an upload."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    selection: VectorSelection
    uploadOwner: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    readLease: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")

    @model_validator(mode="after")
    def require_result_lease(self) -> "OutlineInput":
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


class OutlineResult(BaseModel):
    """A simplified GeoJSON map outline and its WGS 84 bounding box."""

    model_config = ConfigDict(extra="forbid")
    geometry: dict[str, JsonValue]
    bbox: tuple[FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat]

    @model_validator(mode="after")
    def check_display(self) -> "OutlineResult":
        """Require a FeatureCollection within the byte limit and ordered bounds.

        Returns:
            The validated display result.

        Raises:
            ValueError: If the output is not a bounded FeatureCollection.
        """
        if (
            self.geometry.get("type") != "FeatureCollection"
            or not isinstance(self.geometry.get("features"), list)
            or len(
                json.dumps(
                    self.geometry, allow_nan=False, separators=(",", ":")
                ).encode()
            )
            > MAX_OUTLINE_GEOMETRY_BYTES
            or self.bbox[0] > self.bbox[2]
            or self.bbox[1] > self.bbox[3]
        ):
            raise ValueError("Invalid bounded outline result")
        return self


def calculate_outline(inputs: OutlineInput) -> OutlineResult:
    """Read an authorized vector selection and build its outline in a Jobs child.

    GIS imports are lazy so service discovery and diagnostic jobs do not load
    native libraries. No scheduler or application service is constructed here.

    Args:
        inputs: Path-free immutable selection and private owner for uploads.

    Returns:
        A simplified GeoJSON FeatureCollection and its bounding box.

    Raises:
        SelectionUnavailableError: If the source identity is invalid.
        VectorUploadError: If the upload is unavailable to the submitted owner.
        ValueError: If source reading or display validation fails.
    """
    return asyncio.run(_calculate_outline(inputs))


async def _calculate_outline(inputs: OutlineInput) -> OutlineResult:
    """Authorize the vector selection and read its immutable native source.

    Args:
        inputs: Validated operation inputs.

    Returns:
        Validated display result.

    Raises:
        SelectionUnavailableError: If the source identity is invalid.
        VectorUploadError: If the upload is unavailable to the submitted owner.
        ValueError: For invalid polygons or exceeded work budgets.
    """
    # The registry imports this module to list operations and validate requests.
    # Load this dependency group only when executing an outline: geometry and
    # source resolution transitively load Fiona/GDAL, Rasterio and Shapely. This
    # keeps discovery and unrelated diagnostic jobs free of that native setup.
    import httpx2
    from eolab_app.vector.catalog import StacVectorCatalog
    from eolab_app.vector.geometry import build_outline
    from eolab_app.vector.selection_source import resolve_selection
    from eolab_app.vector.sources import MountedVectorResolver
    from eolab_app.vector_uploads import VectorUploadStore

    async with httpx2.AsyncClient(
        timeout=5, trust_env=False, follow_redirects=False
    ) as client:
        catalog = StacVectorCatalog(client, CATALOG_URL)
        resolver = MountedVectorResolver(SCAN_MOUNT)
        if isinstance(inputs.selection, ArtifactVectorSelection):
            from eolab_app.bounded_vector import resolve_vector_file_selection

            try:
                path = await resolve_leased_source_path(
                    client,
                    inputs.selection.jobId,
                    inputs.selection.artifactId,
                    inputs.readLease,
                    PROCESSING_MOUNT,
                    "application/geopackage+sqlite3",
                    source_url=SOURCE_FILES_URL,
                )
            except SourceFileError as error:
                raise SelectionUnavailableError(str(error)) from error
            resolved = resolve_vector_file_selection(path, inputs.selection)
        else:
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
        result = OutlineResult.model_validate_json(
            json.dumps(build_outline(resolved), allow_nan=False)
        )
        return result
