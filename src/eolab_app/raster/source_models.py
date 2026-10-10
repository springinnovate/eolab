"""Path-free raster references and requests shared by catalog and private sources."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from eolab_app.raster.models import (
    CatalogRasterPairRequest,
    CatalogRasterRequest,
    RasterStatisticsArea,
)


class RunArtifactReference(BaseModel):
    """Identify an immutable run file whose access belongs to the requesting session."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["runArtifact"]
    job_id: str = Field(alias="jobId", strict=True, pattern=r"^[a-f0-9]{32}$")
    artifact_id: str = Field(alias="artifactId", strict=True, pattern=r"^[a-f0-9]{32}$")


RasterSourceReference = CatalogRasterRequest | RunArtifactReference


class RasterSourceRequest(BaseModel):
    """Request access to a catalog raster or an owned run file without a storage path."""

    model_config = ConfigDict(extra="forbid")
    source: RasterSourceReference


class RasterPixelSourceRequest(RasterSourceRequest):
    """Read an original raster cell at a longitude and latitude."""

    longitude: float = Field(strict=True, ge=-180, le=180, allow_inf_nan=False)
    latitude: float = Field(strict=True, ge=-90, le=90, allow_inf_nan=False)


class RasterStatisticsSourceRequest(RasterSourceRequest, RasterStatisticsArea):
    """Summarize an authorized raster over the chosen sampling area."""


class RasterPairSourceRequest(CatalogRasterPairRequest):
    """Compare two different catalog or private rasters on the original X reference grid."""

    x_raster: RasterSourceReference = Field(alias="xRaster")
    y_raster: RasterSourceReference = Field(alias="yRaster")


class RasterReadCapability(BaseModel):
    """Whether a reader supports this source's format, with an explanation when unavailable."""

    supported: bool
    reason: str | None


class RasterSourceCapabilities(BaseModel):
    """Format support for original-cell reading and bounded raster distributions."""

    pixels: RasterReadCapability
    statistics: RasterReadCapability


class RasterSourceDescription(RasterSourceRequest):
    """Original raster metadata and current format support without private storage details."""

    version: str
    bounds: tuple[float, float, float, float] | None = None
    width: int
    height: int
    bands: int
    dtype: str
    crs: str
    transform: tuple[float, float, float, float, float, float]
    nodata: float | None
    capabilities: RasterSourceCapabilities


def raster_source_reference(
    request: CatalogRasterRequest | RasterSourceRequest,
) -> RasterSourceReference:
    """Read the source identity from either the existing or extended analysis request.

    Args:
        request: Validated flat catalog request or explicit source request.

    Returns:
        Only the source identity, excluding sampling fields.
    """
    if isinstance(request, RasterSourceRequest):
        return request.source
    return CatalogRasterRequest(
        collectionId=request.collection_id, itemId=request.item_id
    )
