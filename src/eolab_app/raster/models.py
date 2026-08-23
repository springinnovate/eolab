"""Public requests, responses, and internal raster value objects."""

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_validator
from rasterio.windows import Window

from eolab_app.raster.eligibility import (
    MOUNTED_GEOTIFF_COLLECTION_ID,
    MOUNTED_GEOTIFF_ITEM_ID_PATTERN,
)


SourceSignature = tuple[int, int, int, int, int]
GEOSERVER_READER_CONTRACT = "geoserver-3.0.1-geotools-35.1-geotiff-v1"
CanonicalWgs84Bounds = tuple[float, float, float, float]
RasterStatisticsCacheKey = tuple[
    str,
    SourceSignature,
    str,
    tuple[object, ...],
]


def _exclude_none_from_response(value: object) -> bool:
    """Return whether an optional response field should be omitted.

    Args:
        value: Candidate serialized field value.

    Returns:
        True only when the value is absent.
    """
    return value is None


@dataclass(frozen=True)
class AuthorizedRaster:
    """Current mounted source approved for public rendering operations.

    Attributes:
        source_path: Canonical mounted GeoTIFF path.
        source_signature: Filesystem identity approved during publication.
    """

    source_path: Path
    source_signature: SourceSignature


@dataclass(frozen=True)
class SelectedRasterArea:
    """Projected selection geometry and clipped source-pixel envelope.

    Attributes:
        source_window: Integer source-pixel window containing the selection.
        projected_geometries: Polygonal selections in the source raster CRS.
    """

    source_window: Window
    projected_geometries: tuple[dict[str, object], ...]


class CatalogRasterRequest(BaseModel):
    """Identify one catalog Item without accepting browser-supplied paths."""

    model_config = ConfigDict(extra="forbid")

    collection_id: Literal[MOUNTED_GEOTIFF_COLLECTION_ID] = Field(
        alias="collectionId",
    )
    item_id: str = Field(
        alias="itemId",
        pattern=MOUNTED_GEOTIFF_ITEM_ID_PATTERN,
        strict=True,
    )


class RasterReaderAssessment(BaseModel):
    """Machine-readable result from the deployed GeoServer reader probe.

    Attributes:
        contract: Stable deployed-reader contract identifier.
        compatible: Whether GeoTools acquired the mounted GeoTIFF.
        reason_code: Stable incompatibility classification, or ``None`` for a
            compatible reader result.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    contract: Literal[GEOSERVER_READER_CONTRACT]
    compatible: bool
    reason_code: Literal[
        "geoserver_crs_metadata_incompatible",
        "geoserver_reader_incompatible",
    ] | None = Field(default=None, alias="reasonCode")

    @model_validator(mode="after")
    def require_reason_for_incompatibility(self) -> "RasterReaderAssessment":
        """Require exactly one reason for an incompatible reader result.

        Returns:
            The validated reader assessment.

        Raises:
            ValueError: If compatibility and reason presence disagree.
        """
        if self.compatible == (self.reason_code is not None):
            raise ValueError(
                "A reader incompatibility reason is required exactly when "
                "compatible is false"
            )
        return self


class Wgs84Bounds(BaseModel):
    """One non-wrapping longitude/latitude rectangle selected by the user."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    west: float = Field(strict=True, ge=-180, le=180, allow_inf_nan=False)
    south: float = Field(strict=True, ge=-90, le=90, allow_inf_nan=False)
    east: float = Field(strict=True, ge=-180, le=180, allow_inf_nan=False)
    north: float = Field(strict=True, ge=-90, le=90, allow_inf_nan=False)

    @model_validator(mode="after")
    def require_ordered_non_wrapping_bounds(self) -> "Wgs84Bounds":
        """Reject empty and antimeridian-crossing rectangles.

        Returns:
            The validated bounds model.

        Raises:
            ValueError: If either axis is empty, reversed, or wraps across the
                antimeridian.
        """
        if self.west >= self.east:
            raise ValueError(
                "west must be less than east; antimeridian-crossing bounds "
                "are not supported"
            )
        if self.south >= self.north:
            raise ValueError("south must be less than north")
        return self

    def canonical_tuple(self) -> CanonicalWgs84Bounds:
        """Return the stable tuple used for sampling and cache identity.

        Returns:
            West, south, east, and north in canonical order.
        """
        return (self.west, self.south, self.east, self.north)


class CatalogRasterStatisticsRequest(CatalogRasterRequest):
    """Identify a published raster and exactly one optional sampling area."""

    selected_bounds: Wgs84Bounds | None = Field(
        default=None,
        alias="selectedBounds",
    )
    temporary_aoi_id: str | None = Field(
        default=None,
        alias="temporaryAoiId",
        min_length=32,
        max_length=32,
        pattern=r"^[A-Za-z0-9_-]{32}$",
        strict=True,
    )

    @model_validator(mode="after")
    def require_strict_sampling_area_union(
        self,
    ) -> "CatalogRasterStatisticsRequest":
        """Reject requests containing both rectangular and AOI sampling.

        Returns:
            Validated request with whole-raster, bounds, or AOI sampling.

        Raises:
            ValueError: If selected bounds and an AOI reference coexist.
        """
        if self.selected_bounds is not None and self.temporary_aoi_id is not None:
            raise ValueError(
                "selectedBounds and temporaryAoiId are mutually exclusive"
            )
        return self


class PublishedRaster(BaseModel):
    """Browser-safe identity of one published WMS layer."""

    layer_name: str = Field(alias="layerName")
    bbox: tuple[float, float, float, float]


class CatalogPixelRequest(CatalogRasterRequest):
    """Identify one published raster and a WGS 84 position to sample."""

    longitude: float = Field(
        strict=True,
        ge=-180,
        le=180,
        allow_inf_nan=False,
    )
    latitude: float = Field(
        strict=True,
        ge=-90,
        le=90,
        allow_inf_nan=False,
    )


class RasterPixel(BaseModel):
    """One band-1 pixel sampled from a published catalog raster."""

    longitude: float
    latitude: float
    row: int | None
    column: int | None
    in_bounds: bool = Field(alias="inBounds")
    value: float | None


class RasterPercentiles(BaseModel):
    """Percentiles calculated from finite, non-nodata sample values."""

    p05: FiniteFloat
    p50: FiniteFloat
    p95: FiniteFloat


class RasterValueRange(BaseModel):
    """Three strictly ordered values accepted by the dynamic raster style."""

    minimum: FiniteFloat
    midpoint: FiniteFloat
    maximum: FiniteFloat


class RasterHistogram(BaseModel):
    """Fixed-bin histogram calculated from the bounded raster sample."""

    counts: list[int]
    edges: list[FiniteFloat]


class RasterStatistics(BaseModel):
    """Bounded raster sample used for display-range selection."""

    band: Literal[1] = 1
    scope: Literal["wholeRaster", "selectedArea", "temporaryAoi"]
    selected_bounds: Wgs84Bounds | None = Field(alias="selectedBounds")
    temporary_aoi_id: str | None = Field(
        default=None,
        alias="temporaryAoiId",
        exclude_if=_exclude_none_from_response,
    )
    source_width: int = Field(alias="sourceWidth")
    source_height: int = Field(alias="sourceHeight")
    source_pixel_count: int = Field(alias="sourcePixelCount")
    sample_width: int = Field(alias="sampleWidth")
    sample_height: int = Field(alias="sampleHeight")
    sampled_pixel_count: int = Field(alias="sampledPixelCount")
    valid_sample_count: int = Field(alias="validSampleCount")
    estimated: bool
    sample_minimum: FiniteFloat = Field(alias="sampleMinimum")
    sample_maximum: FiniteFloat = Field(alias="sampleMaximum")
    percentiles: RasterPercentiles
    histogram: RasterHistogram
    suggested_range: RasterValueRange = Field(alias="suggestedRange")

    @model_validator(mode="after")
    def require_scope_provenance(self) -> "RasterStatistics":
        """Keep whole-raster and selected-area provenance unambiguous.

        Returns:
            The validated statistics model.

        Raises:
            ValueError: If selected bounds do not match the declared scope.
        """
        has_bounds = self.selected_bounds is not None
        has_temporary_aoi = self.temporary_aoi_id is not None
        if self.scope == "wholeRaster" and (has_bounds or has_temporary_aoi):
            raise ValueError("wholeRaster statistics cannot identify a selected area")
        if self.scope == "selectedArea" and (not has_bounds or has_temporary_aoi):
            raise ValueError("selectedArea statistics require only selected bounds")
        if self.scope == "temporaryAoi" and (has_bounds or not has_temporary_aoi):
            raise ValueError("temporaryAoi statistics require only an AOI identity")
        return self
