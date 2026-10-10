"""Area-weighted numeric category distributions over bounded native samples."""

from pathlib import Path

import numpy
import rasterio
from numpy.typing import NDArray
from pyproj import Transformer
from pyproj.exceptions import ProjError
from rasterio.windows import Window, transform as window_transform

from eolab_app.bounded_vector import PolygonRasterizer, pixels_inside_area
from eolab_app.raster.exact_source import (
    plan_exact_source_window,
    read_exact_source_window,
)
from eolab_app.raster.models import RasterCategoricalDistribution, RasterStatistics
from eolab_app.raster.read_cancellation import (
    RasterReadCancellationCheck,
    require_active_raster_read,
)
from eolab_app.raster.sample_grid import (
    SAMPLE_GRID_MAX_DIMENSION,
    plan_source_window_sample_grid,
    read_planned_sample_grid,
    sample_grid_policy_parameters,
)
from eolab_app.raster.source_contract import (
    require_raster_analysis_georeferencing,
    require_signed_raster_dependencies,
)
from eolab_app.raster.statistics import (
    selected_raster_area_for_wgs84_bounds,
    selected_raster_area_for_catalog_selection,
    summarize_raster_sample,
)
from eolab_app.sampling_area import (
    RasterSamplingArea,
    SelectedBoundsSamplingArea,
    CatalogSelectionSamplingArea,
    WholeRasterSamplingArea,
)

CATEGORICAL_STATISTICS_ALGORITHM = "native-categorical-ground-area-v2"
CATEGORICAL_AREA_SUBDIVISIONS = 4
CATEGORICAL_AREA_MAX_COORDINATES = 500_000
CATEGORICAL_EQUAL_AREA_CRS = (
    "+proj=cea +lat_ts=0 +lon_0=0 +datum=WGS84 +units=m +no_defs"
)


def categorical_statistics_policy_parameters() -> tuple[int, ...]:
    """Return the fixed native-sampling and ground-area cache policy.

    Returns:
        Native-work, sample-grid, subcell-mask and coordinate limits.
    """
    return (
        *sample_grid_policy_parameters(),
        CATEGORICAL_AREA_SUBDIVISIONS,
        CATEGORICAL_AREA_MAX_COORDINATES,
    )


def sample_cell_ground_weights(
    dataset: rasterio.io.DatasetReader,
    source_window: Window,
    sample_shape: tuple[int, int],
    projected_geometries: tuple[dict[str, object], ...] | PolygonRasterizer | None,
    cancellation_requested: RasterReadCancellationCheck | None,
) -> NDArray[numpy.float64]:
    """Estimate selected ground hectares represented by each sample cell.

    Each cell is subdivided into a fixed four-by-four grid. Equal-area projected
    quadrilaterals weight the native footprint; selected subcell centers estimate
    fractional coverage. Union masks preserve holes and count overlaps once.
    This bounded quadrature is deliberately independent of Processing's exact
    per-native-pixel ground-area calculation.

    Args:
        dataset: Open georeferenced source with admitted native read structure.
        source_window: Clipped integral source envelope represented by the sample.
        sample_shape: Bounded grid height and width, at most 127 per edge.
        projected_geometries: Existing source-CRS selection or streamed rasterizer.
        cancellation_requested: Optional last-waiter cancellation predicate.

    Returns:
        Nonnegative selected hectares per representative sample cell.

    Raises:
        ValueError: If coordinate work, CRS transformation or longitude domain
            is unsupported, or no selected coverage is represented.
        RasterReadCancelled: If all request waiters have disconnected.
    """
    require_active_raster_read(cancellation_requested)
    height, width = sample_shape
    subdivisions = CATEGORICAL_AREA_SUBDIVISIONS
    fine_height, fine_width = height * subdivisions, width * subdivisions
    if (fine_height + 1) * (fine_width + 1) > CATEGORICAL_AREA_MAX_COORDINATES:
        raise ValueError("Categorical ground-area grid exceeds its coordinate limit")
    sample_transform = window_transform(
        source_window, dataset.transform
    ) * rasterio.Affine.scale(
        source_window.width / fine_width, source_window.height / fine_height
    )
    columns, rows = numpy.meshgrid(
        numpy.arange(fine_width + 1), numpy.arange(fine_height + 1)
    )
    native_x = (
        sample_transform.a * columns + sample_transform.b * rows + sample_transform.c
    )
    native_y = (
        sample_transform.d * columns + sample_transform.e * rows + sample_transform.f
    )
    try:
        geographic = Transformer.from_crs(
            dataset.crs,
            "EPSG:4326",
            always_xy=True,
            allow_ballpark=False,
            only_best=True,
            force_over=True,
        )
        longitudes, latitudes = geographic.transform(native_x, native_y, errcheck=True)
        if not (
            numpy.all(numpy.isfinite(longitudes))
            and numpy.all(numpy.isfinite(latitudes))
        ):
            raise ValueError("Categorical ground-area coordinates must be finite")
        if (
            numpy.any(longitudes < -180 - 1e-8)
            or numpy.any(longitudes > 180 + 1e-8)
            or numpy.any(numpy.abs(latitudes) > 90 + 1e-8)
        ):
            raise ValueError(
                "Categorical ground-area estimates require a continuous longitude domain from -180 to 180"
            )
        equal_area = Transformer.from_crs(
            "EPSG:4326",
            CATEGORICAL_EQUAL_AREA_CRS,
            always_xy=True,
            allow_ballpark=False,
            only_best=True,
            force_over=True,
        )
        x, y = equal_area.transform(longitudes, latitudes, errcheck=True)
    except ProjError as error:
        raise ValueError(
            "Raster coordinates cannot be transformed for categorical ground-area estimates"
        ) from error
    require_active_raster_read(cancellation_requested)
    # Relative vertex vectors avoid subtracting large absolute-coordinate products.
    ax, ay = x[:-1, :-1], y[:-1, :-1]
    bx, by = x[:-1, 1:] - ax, y[:-1, 1:] - ay
    cx, cy = x[1:, 1:] - ax, y[1:, 1:] - ay
    dx, dy = x[1:, :-1] - ax, y[1:, :-1] - ay
    areas = numpy.abs(bx * cy - by * cx + cx * dy - cy * dx) / 20_000
    if not numpy.all(numpy.isfinite(areas)):
        raise ValueError("Categorical ground-area weights must be finite")
    if projected_geometries is not None:
        inside = pixels_inside_area(
            projected_geometries,
            out_shape=(fine_height, fine_width),
            transform=sample_transform,
            all_touched=False,
        )
        areas = numpy.where(inside, areas, 0)
    weights = areas.reshape(height, subdivisions, width, subdivisions).sum(axis=(1, 3))
    if not numpy.any(weights > 0):
        raise ValueError(
            "No selected ground area was represented by the categorical sample. Use a smaller sampling area."
        )
    require_active_raster_read(cancellation_requested)
    return weights


def read_raster_categorical_statistics(
    source_path: Path,
    sampling_area: RasterSamplingArea,
    cancellation_requested: RasterReadCancellationCheck | None = None,
    *,
    category_values: tuple[int, ...],
) -> RasterStatistics:
    """Read native numeric categories and estimate selected ground coverage.

    Args:
        source_path: Catalog-authorized, signed mounted GeoTIFF.
        sampling_area: Validated whole, bounds or original Catalog selection.
        cancellation_requested: Optional last-waiter cancellation predicate.
        category_values: Boundary-validated, sorted distinct integer codes.

    Returns:
        Existing numeric statistics plus bounded area totals for supplied codes,
        Unmapped and NoData. Areas are explicitly approximate.

    Raises:
        NoRasterBoundsOverlapError: If the selected envelope misses the raster.
        NoValidRasterSamplesError: If no finite selected samples remain.
        RasterReadCancelled: If the request loses all active waiters.
        OSError: If the signed source cannot be opened.
        rasterio.errors.RasterioError: If a bounded native read fails.
        TypeError: If the sampling area is outside the strict union.
        ValueError: If source structure, area transformation or limits fail.
    """
    require_active_raster_read(cancellation_requested)
    selected_area = None
    with rasterio.open(source_path) as dataset:
        require_signed_raster_dependencies(dataset, source_path)
        require_raster_analysis_georeferencing(dataset)
        if isinstance(sampling_area, SelectedBoundsSamplingArea):
            selected_area = selected_raster_area_for_wgs84_bounds(
                dataset, sampling_area.bounds
            )
        elif isinstance(sampling_area, CatalogSelectionSamplingArea):
            selected_area = selected_raster_area_for_catalog_selection(
                dataset, sampling_area, cancellation_requested
            )
        elif not isinstance(sampling_area, WholeRasterSamplingArea):
            raise TypeError("Unsupported raster sampling area")
        source_window = (
            selected_area.source_window
            if selected_area
            else Window(0, 0, dataset.width, dataset.height)
        )
        try:
            exact_plan = (
                plan_exact_source_window(dataset, source_window)
                if max(source_window.width, source_window.height)
                <= SAMPLE_GRID_MAX_DIMENSION
                else None
            )
            if exact_plan is not None:
                sample = read_exact_source_window(
                    dataset, exact_plan, cancellation_requested
                )
                method = "exactSourceWindow"
            else:
                plan = plan_source_window_sample_grid(dataset, source_window)
                sample = read_planned_sample_grid(dataset, plan, cancellation_requested)
                method = "sampleGrid"
            weights = sample_cell_ground_weights(
                dataset,
                source_window,
                sample.shape,
                selected_area.projected_geometries if selected_area else None,
                cancellation_requested,
            )
        finally:
            if selected_area and isinstance(
                selected_area.projected_geometries, PolygonRasterizer
            ):
                selected_area.projected_geometries.close()
    values = numpy.asarray(numpy.ma.getdata(sample), dtype=numpy.float64)
    valid = ~numpy.ma.getmaskarray(sample) & numpy.isfinite(values)
    selected_valid = valid & (weights > 0)
    sample = numpy.ma.array(values, mask=~selected_valid)
    statistics = summarize_raster_sample(sample, source_window, sampling_area, method)
    valid_area = float(weights[selected_valid].sum())
    areas = [
        float(weights[selected_valid & (values == code)].sum())
        for code in category_values
    ]
    unmapped = float(
        weights[selected_valid & ~numpy.isin(values, category_values)].sum()
    )
    distribution = RasterCategoricalDistribution(
        categoryValues=category_values,
        areasHectares=areas,
        unmappedAreaHectares=unmapped,
        validAreaHectares=valid_area,
        nodataAreaHectares=float(weights[~valid].sum()),
    )
    require_active_raster_read(cancellation_requested)
    return statistics.model_copy(update={"categorical_distribution": distribution})
