"""Public requests, responses, and internal raster value objects."""

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_validator
from rasterio.windows import Window

from eolab_app.raster.catalog_contract import (
    MOUNTED_GEOTIFF_COLLECTION_ID,
    MOUNTED_GEOTIFF_ITEM_ID_PATTERN,
)
from eolab_app.raster.source_identity import RasterSourceIdentity


GEOSERVER_READER_CONTRACT = "geoserver-3.0.1-geotools-35.1-geotiff-v1"
CanonicalWgs84Bounds = tuple[float, float, float, float]
RasterStatisticsCacheKey = tuple[
    str,
    str,
    RasterSourceIdentity,
    str,
    tuple[object, ...],
    tuple[int, ...],
]
RasterDetailPreviewScope = Literal[
    "rasterExtent",
    "currentView",
]
RasterDetailPreviewRendering = Literal[
    "sampleGrid",
    "exactSourceWindow",
]
# Projection roundoff allowance; far below a displayable map distance.
RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE = 1e-9
# Fixed representation limits repeated in the public response contract. These
# names keep model validation readable without importing reader modules into
# the transport model boundary.
EXACT_DETAIL_MAX_SOURCE_BLOCK_READS = 1_024
EXACT_DETAIL_MAX_DECODED_SOURCE_BYTES = 64 * 1024 * 1024
SAMPLE_GRID_MAX_SOURCE_BLOCK_READS = 127 * 127
SAMPLE_GRID_MAX_DECODED_SOURCE_BYTES = 9 * 1024 * 1024 * 1024
RASTER_STATISTICS_BIN_COUNT = 64
RASTER_STATISTICS_SAMPLE_GRID_MAX_DIMENSION = 127
RASTER_PAIRED_STATISTICS_BIN_COUNT = 32
RASTER_PAIRED_STATISTICS_SAMPLE_GRID_MAX_DIMENSION = 127
RasterDetailPreviewCacheKey = tuple[
    str,
    str,
    RasterSourceIdentity,
    tuple[float, float, float, float],
    str,
    CanonicalWgs84Bounds | None,
    tuple[int, ...],
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
    """Current mounted source approved for one public raster operation.

    Authorization here establishes only scanner-owned catalog identity, a path
    confined to the raster mount, and an unchanged filesystem signature. It
    does not select or approve WMS, sample-grid, statistics, or pixel rendering.

    Attributes:
        source_path: Canonical mounted GeoTIFF path.
        source_signature: Filesystem identity approved at the source boundary.
    """

    source_path: Path
    source_signature: RasterSourceIdentity


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
    """Identify a catalog raster and at most one optional sampling area.

    Attributes:
        selected_bounds: Optional canonical WGS 84 rectangle; absence selects
            the whole raster unless ``temporary_aoi_id`` is present.
        temporary_aoi_id: Optional opaque ready-AOI lifecycle reference;
            absence selects bounds or the whole raster.
    """

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


class CatalogRasterPairRequest(BaseModel):
    """Identify two ordered catalog rasters and optional selected bounds.

    The X and Y identities are intentionally nested catalog requests so the
    public contract cannot accept paths, publication names, or renderer state.

    Attributes:
        x_raster: Catalog identity assigned to the reference X grid.
        y_raster: Distinct catalog identity aligned to X with nearest-neighbor
            resampling.
        selected_bounds: Optional canonical WGS 84 rectangle intersected with
            the rasters' geographic overlap.
    """

    model_config = ConfigDict(extra="forbid")

    x_raster: CatalogRasterRequest = Field(alias="xRaster")
    y_raster: CatalogRasterRequest = Field(alias="yRaster")
    selected_bounds: Wgs84Bounds | None = Field(
        default=None,
        alias="selectedBounds",
    )

    @model_validator(mode="after")
    def require_distinct_rasters(self) -> "CatalogRasterPairRequest":
        """Require two different catalog identities for bivariate analysis.

        Returns:
            Validated ordered pair request.

        Raises:
            ValueError: If X and Y identify the same catalog Item.
        """
        if (
            self.x_raster.collection_id == self.y_raster.collection_id
            and self.x_raster.item_id == self.y_raster.item_id
        ):
            raise ValueError("xRaster and yRaster must identify different Items")
        return self


class CatalogRasterDetailPreviewRequest(CatalogRasterRequest):
    """Request the fixed bounded preview for an overview-limited raster.

    Attributes:
        view_bounds: Optional current map rectangle for a refined sample grid.
    """

    view_bounds: Wgs84Bounds | None = Field(default=None, alias="viewBounds")


class PublishedRaster(BaseModel):
    """Browser-safe identity of one published WMS layer."""

    layer_name: str = Field(alias="layerName")
    bbox: tuple[float, float, float, float]


class CatalogPixelRequest(CatalogRasterRequest):
    """Identify one catalog raster and a WGS 84 position to sample."""

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
    """One band-1 pixel sampled from an authorized catalog raster."""

    longitude: float
    latitude: float
    row: int | None
    column: int | None
    in_bounds: bool = Field(alias="inBounds")
    value: float | None


class RasterValueRange(BaseModel):
    """Three values accepted by the shared dynamic raster style.

    Ordering is enforced by the owning response or style contract.

    Attributes:
        minimum: Low color-stop value.
        midpoint: Middle color-stop value.
        maximum: High color-stop value.
    """

    minimum: FiniteFloat
    midpoint: FiniteFloat
    maximum: FiniteFloat


class RasterDetailPreviewLimits(BaseModel):
    """Public resource bounds applied to one detail-only preview.

    Attributes:
        maximum_sample_grid_dimension: Maximum sampled-grid edge.
        maximum_exact_detail_dimension: Maximum native source/output edge for
            an automatically admitted exact current-view window.
        maximum_source_block_reads: Representation-specific maximum unique
            native blocks read.
        maximum_decoded_source_bytes: Representation-specific cumulative decoded
            band-one values plus their validity bytes. Sampled blocks are
            streamed rather than retained simultaneously.
        maximum_transformed_positions: Maximum target probes transformed for
            the fixed center-sampled grid.
        maximum_points_per_cell: Fixed center probes in each sample-grid cell.
    """

    maximum_sample_grid_dimension: Literal[127] = Field(alias="maximumSampleGridDimension")
    maximum_exact_detail_dimension: Literal[512] = Field(
        alias="maximumExactDetailDimension"
    )
    maximum_source_block_reads: Literal[1_024, 16_129] = Field(
        alias="maximumSourceBlockReads"
    )
    maximum_decoded_source_bytes: Literal[67_108_864, 9_663_676_416] = Field(
        alias="maximumDecodedSourceBytes"
    )
    maximum_transformed_positions: Literal[16_129] = Field(
        alias="maximumTransformedPositions"
    )
    maximum_points_per_cell: Literal[1] = Field(alias="maximumPointsPerCell")


class RasterDetailPreviewWork(BaseModel):
    """Actual bounded work and source-grid resolution for one preview.

    Attributes:
        sample_grid_width: Width of the bounded source numeric grid.
        sample_grid_height: Height of the bounded source numeric grid.
        source_block_read_count: Unique native source blocks read once; zero
            when every transformed probe lies outside a rotated source.
        decoded_source_bytes: Conservative band-plus-validity decoded bytes,
            also zero exactly when no block is required.
        points_per_cell: Center positions inspected for each sample-grid cell, or zero
            for exact bounded source detail.
        source_window: Exact integral source window for native detail; absent
            for spatially dispersed sample-grid probes.
    """

    sample_grid_width: int = Field(alias="sampleGridWidth", ge=1)
    sample_grid_height: int = Field(alias="sampleGridHeight", ge=1)
    source_block_read_count: int = Field(alias="sourceBlockReadCount", ge=0)
    decoded_source_bytes: int = Field(alias="decodedSourceBytes", ge=0)
    points_per_cell: int = Field(alias="pointsPerCell", ge=0)
    source_window: "RasterDetailSourceWindow | None" = Field(
        default=None,
        alias="sourceWindow",
    )


class RasterDetailSourceWindow(BaseModel):
    """Browser-safe integral source-pixel window provenance.

    Attributes:
        column_offset: Zero-based first source column.
        row_offset: Zero-based first source row.
        width: Positive number of complete source columns read.
        height: Positive number of complete source rows read.
    """

    column_offset: int = Field(alias="columnOffset", ge=0)
    row_offset: int = Field(alias="rowOffset", ge=0)
    width: int = Field(ge=1)
    height: int = Field(ge=1)


class RasterDetailPreview(BaseModel):
    """Browser-safe, georeferenced bounded raster representation.

    Attributes:
        scope: Raster extent or current map view.
        rendering: Fixed center-sample grid or exact bounded source window.
        policy_version: Algorithm and cache policy identity.
        approximate: Detail-only marker preventing whole-raster interpretation;
            an exact result is produced from a complete read of its bounded
            native source window before same-dimension map reprojection.
        label: User-facing representation label.
        raster_extent: Cataloged WGS 84 raster extent, not a data footprint.
        image_bounds: WGS 84 placement of the sampled image in Leaflet.
        image_width: Width of the numeric image in pixels.
        image_height: Height of the numeric image in pixels.
        pixel_values: Row-major finite band-one values or honest nodata.
        suggested_range: Approximate shared color-ramp thresholds, or ``None``
            when every bounded sampled position is nodata/non-finite.
        limits: Resource bounds used to produce the response.
        actual: Source-grid resolution and actual bounded source work.
    """

    scope: RasterDetailPreviewScope
    rendering: RasterDetailPreviewRendering
    policy_version: Literal["bounded-adaptive-raster-v8"] = Field(
        alias="policyVersion"
    )
    approximate: Literal[True] = True
    label: str
    raster_extent: tuple[FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat] = (
        Field(alias="rasterExtent")
    )
    image_bounds: tuple[FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat] = (
        Field(alias="imageBounds")
    )
    image_width: int = Field(alias="imageWidth", ge=1)
    image_height: int = Field(alias="imageHeight", ge=1)
    pixel_values: list[FiniteFloat | None] = Field(alias="pixelValues")
    suggested_range: RasterValueRange | None = Field(alias="suggestedRange")
    limits: RasterDetailPreviewLimits
    actual: RasterDetailPreviewWork

    @model_validator(mode="after")
    def require_numeric_image_payload(self) -> "RasterDetailPreview":
        """Require one bounded row-major numeric image and ordered bounds.

        Returns:
            The validated detail preview.

        Raises:
            ValueError: If dimensions, values, bounds, or range are inconsistent.
        """
        if len(self.pixel_values) != self.image_width * self.image_height:
            raise ValueError("Detail preview values must fill its numeric image")
        if not self.label.strip():
            raise ValueError("Detail preview label must not be blank")
        if self.scope not in {"rasterExtent", "currentView"}:
            raise ValueError("Sample grid provenance is inconsistent")
        if self.rendering == "exactSourceWindow":
            if self.scope != "currentView":
                raise ValueError("Exact detail requires current-view provenance")
            if (
                self.image_width > self.limits.maximum_exact_detail_dimension
                or self.image_height > self.limits.maximum_exact_detail_dimension
            ):
                raise ValueError("Exact detail dimensions exceed fixed limits")
            expected_decoded_limit = EXACT_DETAIL_MAX_DECODED_SOURCE_BYTES
            expected_block_limit = EXACT_DETAIL_MAX_SOURCE_BLOCK_READS
            source_window = self.actual.source_window
            if (
                source_window is None
                or source_window.width != self.image_width
                or source_window.height != self.image_height
                or self.actual.points_per_cell != 0
            ):
                raise ValueError("Exact detail source-window provenance is invalid")
        else:
            if max(self.image_width, self.image_height) != (
                self.limits.maximum_sample_grid_dimension
            ):
                raise ValueError(
                    "Sampled preview longest edge must match the fixed grid"
                )
            expected_decoded_limit = SAMPLE_GRID_MAX_DECODED_SOURCE_BYTES
            expected_block_limit = SAMPLE_GRID_MAX_SOURCE_BLOCK_READS
            if self.actual.source_window is not None:
                raise ValueError("Sample grids cannot claim a source window")
        if (
            self.actual.sample_grid_width != self.image_width
            or self.actual.sample_grid_height != self.image_height
        ):
            raise ValueError("Detail preview dimensions exceed fixed limits")
        if self.limits.maximum_decoded_source_bytes != expected_decoded_limit:
            raise ValueError("Detail preview decoded-work limit is inconsistent")
        if self.limits.maximum_source_block_reads != expected_block_limit:
            raise ValueError("Detail preview block-read limit is inconsistent")
        if (
            self.actual.source_block_read_count
            > self.limits.maximum_source_block_reads
            or self.actual.decoded_source_bytes
            > self.limits.maximum_decoded_source_bytes
            or self.actual.points_per_cell
            > self.limits.maximum_points_per_cell
        ):
            raise ValueError("Detail preview work exceeds fixed limits")
        if (self.actual.source_block_read_count == 0) != (
            self.actual.decoded_source_bytes == 0
        ):
            raise ValueError("Detail preview block and byte work disagree")
        expected_points_per_cell = (
            0
            if self.rendering == "exactSourceWindow"
            else self.limits.maximum_points_per_cell
        )
        if self.actual.points_per_cell != expected_points_per_cell:
            raise ValueError("Detail preview cell-probe count is inconsistent")
        if not (
            self.raster_extent[0] < self.raster_extent[2]
            and self.raster_extent[1] < self.raster_extent[3]
            and self.image_bounds[0] < self.image_bounds[2]
            and self.image_bounds[1] < self.image_bounds[3]
        ):
            raise ValueError("Detail preview bounds must be strictly ordered")
        # The browser/map protocol is canonical WGS 84 even when the source
        # raster uses another CRS; readers transform before this boundary.
        if any(
            bounds[0] < -180
            or bounds[2] > 180
            or bounds[1] < -90
            or bounds[3] > 90
            for bounds in (self.raster_extent, self.image_bounds)
        ):
            raise ValueError("Detail preview bounds must be canonical WGS 84")
        if not (
            self.raster_extent[0] - RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE
            <= self.image_bounds[0]
            and self.raster_extent[1] - RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE
            <= self.image_bounds[1]
            and self.raster_extent[2] + RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE
            >= self.image_bounds[2]
            and self.raster_extent[3] + RASTER_DETAIL_PREVIEW_BOUNDS_TOLERANCE
            >= self.image_bounds[3]
        ):
            raise ValueError("Detail preview image must stay in the raster extent")
        has_finite_value = any(value is not None for value in self.pixel_values)
        if self.actual.source_block_read_count == 0 and (
            has_finite_value or self.suggested_range is not None
        ):
            raise ValueError(
                "A preview without source reads cannot contain finite values "
                "or a suggested range"
            )
        if self.suggested_range is None and has_finite_value:
            raise ValueError("Finite preview values require a suggested range")
        if self.suggested_range is not None and not has_finite_value:
            raise ValueError("An empty preview cannot declare a suggested range")
        if self.suggested_range is not None and not (
            self.suggested_range.minimum < self.suggested_range.midpoint
            < self.suggested_range.maximum
        ):
            raise ValueError("Detail preview range must be strictly ordered")
        return self


class RasterPercentiles(BaseModel):
    """Percentiles calculated from finite, non-nodata sample values.

    Attributes:
        p05: Fifth percentile of valid sampled values.
        p50: Median of valid sampled values.
        p95: Ninety-fifth percentile of valid sampled values.
    """

    p05: FiniteFloat
    p50: FiniteFloat
    p95: FiniteFloat


class RasterHistogram(BaseModel):
    """Fixed-bin histogram calculated from the bounded raster sample.

    Attributes:
        counts: Valid-sample counts for the fixed 64 bins.
        edges: Strictly increasing 65 bin-edge values.
    """

    counts: list[int]
    edges: list[FiniteFloat]


class RasterPairedHistogram(BaseModel):
    """Fixed two-dimensional histogram and its marginal distributions.

    Matrix rows increase along Y and columns increase along X. This explicit
    orientation lets the browser render the lowest Y bin at the visual bottom
    without inferring array semantics.

    Attributes:
        x_edges: Strictly increasing X bin edges.
        y_edges: Strictly increasing Y bin edges.
        counts: Y-major rows containing X-bin paired counts.
        x_marginal_counts: Counts collapsed across every Y row.
        y_marginal_counts: Counts collapsed across every X column.
    """

    x_edges: list[FiniteFloat] = Field(alias="xEdges")
    y_edges: list[FiniteFloat] = Field(alias="yEdges")
    counts: list[list[int]]
    x_marginal_counts: list[int] = Field(alias="xMarginalCounts")
    y_marginal_counts: list[int] = Field(alias="yMarginalCounts")


class RasterPairedStatistics(BaseModel):
    """Bounded paired-raster distribution on the documented X reference grid.

    Attributes:
        scope: Whole geographic overlap or a selected WGS 84 rectangle.
        selected_bounds: Requested rectangle for ``selectedArea`` only.
        reference_grid: Fixed declaration that X owns cell locations.
        resampling: Fixed nearest-neighbor alignment applied to Y.
        source_width: Width of the bounded X reference envelope.
        source_height: Height of the bounded X reference envelope.
        source_pixel_count: Cell count of that X envelope.
        sample_width: Width of the admitted paired grid.
        sample_height: Height of the admitted paired grid.
        sampled_cell_count: Total admitted grid cells before validity masks.
        paired_sample_count: Cells finite and non-nodata in both rasters.
        sampling_method: Exact small X grid or bounded center-sample grid.
        approximate: Whether the X envelope was downsampled.
        x_minimum: Minimum valid paired X value.
        x_maximum: Maximum valid paired X value.
        y_minimum: Minimum valid paired Y value.
        y_maximum: Maximum valid paired Y value.
        histogram: Fixed 32-by-32 paired histogram with marginals.
    """

    scope: Literal["wholeOverlap", "selectedArea"]
    selected_bounds: Wgs84Bounds | None = Field(alias="selectedBounds")
    reference_grid: Literal["x"] = Field(default="x", alias="referenceGrid")
    resampling: Literal["nearest"] = "nearest"
    source_width: int = Field(alias="sourceWidth", gt=0)
    source_height: int = Field(alias="sourceHeight", gt=0)
    source_pixel_count: int = Field(alias="sourcePixelCount", gt=0)
    sample_width: int = Field(alias="sampleWidth", gt=0)
    sample_height: int = Field(alias="sampleHeight", gt=0)
    sampled_cell_count: int = Field(alias="sampledCellCount", gt=0)
    paired_sample_count: int = Field(alias="pairedSampleCount", gt=0)
    sampling_method: Literal["sampleGrid", "exactReferenceGrid"] = Field(
        alias="samplingMethod"
    )
    approximate: bool
    x_minimum: FiniteFloat = Field(alias="xMinimum")
    x_maximum: FiniteFloat = Field(alias="xMaximum")
    y_minimum: FiniteFloat = Field(alias="yMinimum")
    y_maximum: FiniteFloat = Field(alias="yMaximum")
    histogram: RasterPairedHistogram

    @model_validator(mode="after")
    def require_paired_provenance(self) -> "RasterPairedStatistics":
        """Keep grid, validity, orientation, and histogram totals coherent.

        Returns:
            Validated paired statistics response.

        Raises:
            ValueError: If provenance, dimensions, edges, matrix, or marginals
                violate the bounded public response contract.
        """
        if (self.scope == "selectedArea") != (self.selected_bounds is not None):
            raise ValueError("paired statistics scope and bounds disagree")
        if self.source_pixel_count != self.source_width * self.source_height:
            raise ValueError("paired source pixel count is inconsistent")
        if self.sampled_cell_count != self.sample_width * self.sample_height:
            raise ValueError("paired sampled cell count is inconsistent")
        if (
            self.sample_width > RASTER_PAIRED_STATISTICS_SAMPLE_GRID_MAX_DIMENSION
            or self.sample_height
            > RASTER_PAIRED_STATISTICS_SAMPLE_GRID_MAX_DIMENSION
            or self.sample_width > self.source_width
            or self.sample_height > self.source_height
            or self.paired_sample_count > self.sampled_cell_count
        ):
            raise ValueError("paired sample dimensions exceed fixed limits")
        expected_approximate = self.sampling_method == "sampleGrid"
        if self.approximate != expected_approximate:
            raise ValueError("paired sampling provenance is inconsistent")
        if self.sampling_method == "exactReferenceGrid" and (
            self.sample_width != self.source_width
            or self.sample_height != self.source_height
        ):
            raise ValueError("exact paired sampling must cover the X envelope")
        if self.x_minimum > self.x_maximum or self.y_minimum > self.y_maximum:
            raise ValueError("paired sample ranges are reversed")

        bin_count = RASTER_PAIRED_STATISTICS_BIN_COUNT
        histogram = self.histogram
        if (
            len(histogram.x_edges) != bin_count + 1
            or len(histogram.y_edges) != bin_count + 1
            or len(histogram.counts) != bin_count
            or any(len(row) != bin_count for row in histogram.counts)
            or len(histogram.x_marginal_counts) != bin_count
            or len(histogram.y_marginal_counts) != bin_count
        ):
            raise ValueError("paired histogram dimensions are inconsistent")
        if not all(
            left < right
            for edges in (histogram.x_edges, histogram.y_edges)
            for left, right in zip(edges, edges[1:])
        ):
            raise ValueError("paired histogram edges are not increasing")
        if (
            histogram.x_edges[0] > self.x_minimum
            or histogram.x_edges[-1] < self.x_maximum
            or histogram.y_edges[0] > self.y_minimum
            or histogram.y_edges[-1] < self.y_maximum
        ):
            raise ValueError("paired histogram edges exclude sample values")
        if any(count < 0 for row in histogram.counts for count in row):
            raise ValueError("paired histogram counts cannot be negative")
        x_marginals = [
            sum(row[column] for row in histogram.counts)
            for column in range(bin_count)
        ]
        y_marginals = [sum(row) for row in histogram.counts]
        if (
            x_marginals != histogram.x_marginal_counts
            or y_marginals != histogram.y_marginal_counts
            or sum(x_marginals) != self.paired_sample_count
        ):
            raise ValueError("paired histogram marginals are inconsistent")
        return self


class RasterStatistics(BaseModel):
    """Bounded raster distribution with explicit area and sampling provenance.

    Attributes:
        band: Fixed source band summarized by this response.
        scope: Whole-raster, rectangle, or temporary-AOI area discriminator.
        selected_bounds: Canonical WGS 84 rectangle for ``selectedArea`` only.
        temporary_aoi_id: Opaque lifecycle identity for ``temporaryAoi`` only.
        source_width: Width of the integral source envelope in pixels.
        source_height: Height of the integral source envelope in pixels.
        source_pixel_count: Pixel count of the integral source envelope.
        sample_width: Width of the exact or sampled numeric grid.
        sample_height: Height of the exact or sampled numeric grid.
        sampled_pixel_count: Number of cells in the numeric grid.
        valid_sample_count: Finite, non-nodata cells retained by the area mask.
        sampling_method: Exact bounded window or approximate center-sample grid.
        estimated: Whether distribution values come from the sample grid.
        sample_minimum: Minimum valid sampled value.
        sample_maximum: Maximum valid sampled value.
        percentiles: Fixed percentiles of valid sampled values.
        histogram: Fixed 64-bin distribution of valid sampled values.
        suggested_range: Strict range suggested for downstream color controls.
    """

    band: Literal[1] = 1
    scope: Literal["wholeRaster", "selectedArea", "temporaryAoi"]
    selected_bounds: Wgs84Bounds | None = Field(alias="selectedBounds")
    temporary_aoi_id: str | None = Field(
        default=None,
        alias="temporaryAoiId",
        exclude_if=_exclude_none_from_response,
    )
    source_width: int = Field(alias="sourceWidth", gt=0)
    source_height: int = Field(alias="sourceHeight", gt=0)
    source_pixel_count: int = Field(alias="sourcePixelCount", gt=0)
    sample_width: int = Field(alias="sampleWidth", gt=0)
    sample_height: int = Field(alias="sampleHeight", gt=0)
    sampled_pixel_count: int = Field(alias="sampledPixelCount", gt=0)
    valid_sample_count: int = Field(alias="validSampleCount", gt=0)
    sampling_method: Literal["sampleGrid", "exactSourceWindow"] = Field(
        alias="samplingMethod"
    )
    estimated: bool
    sample_minimum: FiniteFloat = Field(alias="sampleMinimum")
    sample_maximum: FiniteFloat = Field(alias="sampleMaximum")
    percentiles: RasterPercentiles
    histogram: RasterHistogram
    suggested_range: RasterValueRange = Field(alias="suggestedRange")

    @model_validator(mode="after")
    def require_scope_provenance(self) -> "RasterStatistics":
        """Keep area, sampling, and distribution provenance self-consistent.

        Returns:
            The validated statistics model.

        Raises:
            ValueError: If scope fields, counts, sampling method, percentiles,
                histogram, or suggested range violate the response contract.
        """
        has_bounds = self.selected_bounds is not None
        has_temporary_aoi = self.temporary_aoi_id is not None
        if self.scope == "wholeRaster" and (has_bounds or has_temporary_aoi):
            raise ValueError("wholeRaster statistics cannot identify a selected area")
        if self.scope == "selectedArea" and (not has_bounds or has_temporary_aoi):
            raise ValueError("selectedArea statistics require only selected bounds")
        if self.scope == "temporaryAoi" and (has_bounds or not has_temporary_aoi):
            raise ValueError("temporaryAoi statistics require only an AOI identity")
        if self.estimated != (self.sampling_method == "sampleGrid"):
            raise ValueError(
                "statistics estimate metadata must match its sampling method"
            )
        if self.source_pixel_count != self.source_width * self.source_height:
            raise ValueError("statistics source pixel count is inconsistent")
        if self.sampled_pixel_count != self.sample_width * self.sample_height:
            raise ValueError("statistics sampled pixel count is inconsistent")
        if self.valid_sample_count > self.sampled_pixel_count:
            raise ValueError("statistics valid sample count exceeds the sample")
        if (
            self.sample_width > self.source_width
            or self.sample_height > self.source_height
        ):
            raise ValueError("statistics sample dimensions exceed the source")
        if self.sampling_method == "sampleGrid" and max(
            self.sample_width,
            self.sample_height,
        ) > RASTER_STATISTICS_SAMPLE_GRID_MAX_DIMENSION:
            raise ValueError("statistics sample grid exceeds its fixed dimension")
        if self.sampling_method == "exactSourceWindow" and (
            self.sample_width != self.source_width
            or self.sample_height != self.source_height
        ):
            raise ValueError("exact statistics must cover the source window")
        if not (
            self.sample_minimum
            <= self.percentiles.p05
            <= self.percentiles.p50
            <= self.percentiles.p95
            <= self.sample_maximum
        ):
            raise ValueError("statistics percentiles are not ordered")
        if (
            len(self.histogram.counts) != RASTER_STATISTICS_BIN_COUNT
            or len(self.histogram.edges) != RASTER_STATISTICS_BIN_COUNT + 1
            or any(count < 0 for count in self.histogram.counts)
            or sum(self.histogram.counts) != self.valid_sample_count
        ):
            raise ValueError("statistics histogram counts are inconsistent")
        if not all(
            left < right
            for left, right in zip(
                self.histogram.edges,
                self.histogram.edges[1:],
            )
        ) or (
            self.histogram.edges[0] > self.sample_minimum
            or self.histogram.edges[-1] < self.sample_maximum
        ):
            raise ValueError("statistics histogram edges are inconsistent")
        if not (
            self.suggested_range.minimum
            < self.suggested_range.midpoint
            < self.suggested_range.maximum
        ):
            raise ValueError("statistics suggested range is not ordered")
        return self
