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
    CanonicalWgs84Bounds | None,
]
RasterDetailPreviewMode = Literal[
    "centerPixel",
    "samplingGrid",
    "representativePatch",
]
RasterDetailPreviewCacheKey = tuple[
    str,
    str,
    SourceSignature,
    tuple[float, float, float, float],
    str,
    RasterDetailPreviewMode,
    tuple[int, ...],
]


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
        projected_geometry: Selection polygon in the source raster CRS.
    """

    source_window: Window
    projected_geometry: dict[str, object]


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
    """Identify a published raster and an optional selected WGS 84 area."""

    selected_bounds: Wgs84Bounds | None = Field(
        default=None,
        alias="selectedBounds",
    )


class CatalogRasterDetailPreviewRequest(CatalogRasterRequest):
    """Select one fixed, bounded preview for an overview-limited raster.

    Attributes:
        mode: Explicit center, grid, or representative-patch choice.
    """

    mode: RasterDetailPreviewMode


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


class RasterDetailSample(BaseModel):
    """One georeferenced band-1 sample in a detail-only preview.

    Attributes:
        row: Zero-based source raster row.
        column: Zero-based source raster column.
        longitude: WGS 84 cell-center longitude.
        latitude: WGS 84 cell-center latitude.
        value: Finite band-1 value, or ``None`` for nodata/non-finite data.
    """

    row: int
    column: int
    longitude: FiniteFloat
    latitude: FiniteFloat
    value: FiniteFloat | None


class RasterDetailPreviewLimits(BaseModel):
    """Public resource bounds applied to one detail-only preview.

    Attributes:
        maximum_grid_samples: Maximum one-pixel reads in grid mode.
        maximum_patch_dimension: Maximum source/output patch edge.
        maximum_patch_candidates: Maximum candidate windows examined.
    """

    maximum_grid_samples: int = Field(alias="maximumGridSamples")
    maximum_patch_dimension: int = Field(alias="maximumPatchDimension")
    maximum_patch_candidates: int = Field(alias="maximumPatchCandidates")


class RasterDetailPreview(BaseModel):
    """Browser-safe, georeferenced approximate raster detail preview.

    Attributes:
        mode: Explicit preview mode that produced this document.
        policy_version: Algorithm and cache policy identity.
        approximate: Literal marker preventing full-render interpretation.
        label: User-facing approximation label.
        raster_extent: Cataloged WGS 84 raster extent, not a data footprint.
        samples: Georeferenced point samples for center/grid modes.
        detail_bounds: WGS 84 bounds of a representative patch.
        image_data_url: Fixed-size transparent PNG for patch mode.
        limits: Resource bounds used to produce the response.
    """

    mode: RasterDetailPreviewMode
    policy_version: str = Field(alias="policyVersion")
    approximate: Literal[True] = True
    label: str
    raster_extent: tuple[FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat] = (
        Field(alias="rasterExtent")
    )
    samples: list[RasterDetailSample]
    detail_bounds: (
        tuple[FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat] | None
    ) = Field(default=None, alias="detailBounds")
    image_data_url: str | None = Field(default=None, alias="imageDataUrl")
    limits: RasterDetailPreviewLimits

    @model_validator(mode="after")
    def require_mode_payload(self) -> "RasterDetailPreview":
        """Require samples or a bounded image according to preview mode.

        Returns:
            The validated detail preview.

        Raises:
            ValueError: If the payload does not match its declared mode.
        """
        is_patch = self.mode == "representativePatch"
        if is_patch != (
            self.detail_bounds is not None and self.image_data_url is not None
        ):
            raise ValueError(
                "Representative patches require one image and detail bounds"
            )
        if is_patch and self.samples:
            raise ValueError("Representative patches cannot include samples")
        if not is_patch and not self.samples:
            raise ValueError("Point previews require georeferenced samples")
        return self


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
    scope: Literal["wholeRaster", "selectedArea"]
    selected_bounds: Wgs84Bounds | None = Field(alias="selectedBounds")
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
        if self.scope == "wholeRaster" and self.selected_bounds is not None:
            raise ValueError("wholeRaster statistics cannot have selected bounds")
        if self.scope == "selectedArea" and self.selected_bounds is None:
            raise ValueError("selectedArea statistics require selected bounds")
        return self
