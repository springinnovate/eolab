"""Test raster sampling contracts independently from the HTTP routes."""

import asyncio
import threading
from datetime import datetime, timezone
from pathlib import Path

import numpy
import pytest
import rasterio
from pydantic import ValidationError
from rasterio.coords import BoundingBox
from rasterio.enums import Resampling
from rasterio.features import geometry_mask
from rasterio.transform import Affine, from_bounds, from_origin
from rasterio.warp import transform as transform_coordinates
from rasterio.windows import Window

from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import (
    CatalogPixelRequest,
    CatalogRasterStatisticsRequest,
    RasterPixel,
    RasterHistogram,
    RasterPercentiles,
    RasterStatistics,
    RasterValueRange,
    Wgs84Bounds,
)
from eolab_app.raster.pixel import read_raster_pixel
from eolab_app.raster.pixel_service import RasterPixelService
from eolab_app.raster.sources import PublishedRasterRegistry, source_signature
from eolab_app.raster.statistics import (
    NoRasterBoundsOverlapError,
    NoValidRasterSamplesError,
    bounded_raster_sample_shape,
    read_raster_statistics,
    strict_raster_value_range,
)
from eolab_app.raster.statistics_service import RasterStatisticsService
from eolab_app.sampling_area import (
    PolygonalWgs84Geometry,
    ResolvedTemporaryAoi,
    SamplingAreaUnavailableError,
    TemporaryAoiLifecycleIdentity,
    TemporaryAoiSamplingArea,
    freeze_coordinates,
)


class _RasterSample:
    """Minimal masked-array contract returned by a fake Rasterio dataset."""

    def count(self) -> int:
        return 1

    def __getitem__(self, _: tuple[int, int]) -> float:
        return 42.5


class _RasterDataset:
    """Record the exact band and window requested by the pixel reader."""

    crs = "EPSG:3857"
    width = 10
    height = 10

    def __init__(self) -> None:
        self.read_arguments = None

    def __enter__(self) -> "_RasterDataset":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def index(self, x: float, y: float) -> tuple[int, int]:
        assert (x, y) == (10, 20)
        return 2, 3

    def read(self, band: int, *, window: Window, masked: bool) -> _RasterSample:
        self.read_arguments = (band, window, masked)
        return _RasterSample()


class _StatisticsDataset:
    """Return a controlled masked sample and record its bounded read."""

    crs = "EPSG:3857"
    width = 4
    height = 2
    transform = from_origin(0, 2, 1, 1)
    bounds = BoundingBox(0, 0, 4, 2)

    def __init__(self, sample: numpy.ma.MaskedArray) -> None:
        self.sample = sample
        self.read_arguments = None

    def __enter__(self) -> "_StatisticsDataset":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(
        self,
        band: int,
        *,
        window: Window | None = None,
        out_shape: tuple[int, int],
        masked: bool,
        resampling: Resampling,
    ) -> numpy.ma.MaskedArray:
        self.read_arguments = (band, window, out_shape, masked, resampling)
        return self.sample


def _statistics_result(
    value: float = 1,
    selected_bounds: tuple[float, float, float, float] | None = None,
    temporary_aoi_id: str | None = None,
) -> RasterStatistics:
    """Build one valid statistics response for service coordination tests.

    Args:
        value: Single valid sample value represented by the response.
        selected_bounds: Optional canonical rectangular sampling area.
        temporary_aoi_id: Optional opaque temporary-AOI lifecycle reference.

    Returns:
        Valid bounded statistics for exactly one requested sampling scope.

    Raises:
        ValueError: If both selected bounds and an AOI identity are supplied.
    """
    if selected_bounds is not None and temporary_aoi_id is not None:
        raise ValueError("Test statistics scope must be exclusive")
    return RasterStatistics(
        scope=(
            "temporaryAoi"
            if temporary_aoi_id is not None
            else "selectedArea" if selected_bounds is not None else "wholeRaster"
        ),
        selectedBounds=(
            Wgs84Bounds(
                west=selected_bounds[0],
                south=selected_bounds[1],
                east=selected_bounds[2],
                north=selected_bounds[3],
            )
            if selected_bounds is not None
            else None
        ),
        temporaryAoiId=temporary_aoi_id,
        sourceWidth=1,
        sourceHeight=1,
        sourcePixelCount=1,
        sampleWidth=1,
        sampleHeight=1,
        sampledPixelCount=1,
        validSampleCount=1,
        estimated=False,
        sampleMinimum=value,
        sampleMaximum=value,
        percentiles=RasterPercentiles(p05=value, p50=value, p95=value),
        histogram=RasterHistogram(
            counts=[1, *([0] * 63)],
            edges=[float(index) for index in range(65)],
        ),
        suggestedRange=RasterValueRange(
            minimum=value - 1,
            midpoint=value,
            maximum=value + 1,
        ),
    )


def _resolved_temporary_aoi(
    temporary_aoi_id: str,
    geometries: tuple[dict[str, object], ...],
    *,
    expires_at: datetime | None = None,
) -> ResolvedTemporaryAoi:
    """Build immutable lifecycle geometry for raster sampling tests.

    Args:
        temporary_aoi_id: Opaque 32-character lifecycle reference.
        geometries: Polygon or MultiPolygon GeoJSON mappings.
        expires_at: Optional fixed lifecycle expiration timestamp.

    Returns:
        Resolved immutable temporary-AOI sampling value.
    """
    immutable_geometries = tuple(
        PolygonalWgs84Geometry(
            geometry["type"],
            freeze_coordinates(geometry["coordinates"]),
        )
        for geometry in geometries
    )
    positions = [
        position
        for geometry in geometries
        for polygon in (
            [geometry["coordinates"]]
            if geometry["type"] == "Polygon"
            else geometry["coordinates"]
        )
        for ring in polygon
        for position in ring
    ]
    return ResolvedTemporaryAoi(
        identity=TemporaryAoiLifecycleIdentity(
            reference=temporary_aoi_id,
            expires_at=expires_at or datetime(2030, 1, 1, tzinfo=timezone.utc),
        ),
        bounds=(
            min(position[0] for position in positions),
            min(position[1] for position in positions),
            max(position[0] for position in positions),
            max(position[1] for position in positions),
        ),
        geometries=immutable_geometries,
    )


def test_pixel_reader_requests_only_band_one_and_its_source_cell(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep hover I/O bounded to a one-cell window in band 1."""
    dataset = _RasterDataset()
    monkeypatch.setattr("eolab_app.raster.pixel.rasterio.open", lambda _: dataset)
    monkeypatch.setattr(
        "eolab_app.raster.pixel.transform",
        lambda *_: ([10], [20]),
    )

    pixel = read_raster_pixel(Path("raster.tif"), -123, 48)

    assert pixel.model_dump(by_alias=True) == {
        "longitude": -123.0,
        "latitude": 48.0,
        "row": 2,
        "column": 3,
        "inBounds": True,
        "value": 42.5,
    }
    assert dataset.read_arguments == (1, Window(3, 2, 1, 1), True)


def test_pixel_reader_treats_an_unprojectable_position_as_outside(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Do not pass infinite projected coordinates to Rasterio indexing."""
    dataset = _RasterDataset()
    monkeypatch.setattr("eolab_app.raster.pixel.rasterio.open", lambda _: dataset)
    monkeypatch.setattr(
        "eolab_app.raster.pixel.transform",
        lambda *_: ([float("inf")], [float("inf")]),
    )

    pixel = read_raster_pixel(Path("raster.tif"), 180, 90)

    assert pixel.in_bounds is False
    assert pixel.row is None
    assert pixel.column is None
    assert dataset.read_arguments is None


def test_raster_statistics_filter_nodata_and_nonfinite_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Summarize one exact native-grid sample without projecting its bounds."""
    dataset = _StatisticsDataset(
        numpy.ma.array(
            [[0.0, 1.0, 2.0, numpy.nan], [99.0, 3.0, 4.0, 5.0]],
            mask=[[False, False, False, False], [True, False, False, False]],
        )
    )
    monkeypatch.setattr(
        "eolab_app.raster.statistics.rasterio.open",
        lambda _: dataset,
    )

    statistics = read_raster_statistics(Path("projected-raster.tif"))

    assert statistics.model_dump(by_alias=True) == {
        "band": 1,
        "scope": "wholeRaster",
        "selectedBounds": None,
        "sourceWidth": 4,
        "sourceHeight": 2,
        "sourcePixelCount": 8,
        "sampleWidth": 4,
        "sampleHeight": 2,
        "sampledPixelCount": 8,
        "validSampleCount": 6,
        "estimated": False,
        "sampleMinimum": 0.0,
        "sampleMaximum": 5.0,
        "percentiles": {"p05": 0.25, "p50": 2.5, "p95": 4.75},
        "histogram": {
            "counts": statistics.histogram.counts,
            "edges": statistics.histogram.edges,
        },
        "suggestedRange": {
            "minimum": 0.25,
            "midpoint": 2.5,
            "maximum": 4.75,
        },
    }
    assert sum(statistics.histogram.counts) == 6
    assert len(statistics.histogram.counts) == 64
    assert len(statistics.histogram.edges) == 65
    assert dataset.read_arguments == (
        1,
        None,
        (2, 4),
        True,
        Resampling.nearest,
    )


@pytest.mark.parametrize(
    "selected_bounds",
    (
        {"west": 10, "south": -1, "east": 10, "north": 1},
        {"west": 10, "south": -1, "east": -10, "north": 1},
        {"west": -1, "south": 10, "east": 1, "north": 10},
        {"west": -1, "south": 10, "east": 1, "north": -10},
        {"west": -181, "south": -1, "east": 1, "north": 1},
        {"west": "-1", "south": -1, "east": 1, "north": 1},
        {
            "west": -1,
            "south": -1,
            "east": 1,
            "north": 1,
            "path": "/scan-source/raster.tif",
        },
    ),
)
def test_raster_statistics_request_rejects_invalid_selected_bounds(
    selected_bounds: dict[str, object],
) -> None:
    """Accept only finite, ordered, non-wrapping WGS 84 rectangles."""
    with pytest.raises(ValidationError):
        CatalogRasterStatisticsRequest.model_validate(
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": "geotiff-0123456789abcdef01234567",
                "selectedBounds": selected_bounds,
            }
        )


def test_raster_statistics_request_enforces_the_strict_sampling_area_union() -> None:
    """Accept only whole raster, bounds, or one opaque AOI reference."""
    identity = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": "geotiff-0123456789abcdef01234567",
    }
    temporary_aoi_id = "A" * 32

    aoi_request = CatalogRasterStatisticsRequest.model_validate({
        **identity,
        "temporaryAoiId": temporary_aoi_id,
    })

    assert aoi_request.temporary_aoi_id == temporary_aoi_id
    assert aoi_request.selected_bounds is None
    for invalid_document in (
        {**identity, "temporaryAoiId": "../server/path"},
        {
            **identity,
            "temporaryAoiId": temporary_aoi_id,
            "selectedBounds": {
                "west": -1,
                "south": -1,
                "east": 1,
                "north": 1,
            },
        },
        {**identity, "temporaryAoiId": temporary_aoi_id, "geometry": {}},
    ):
        with pytest.raises(ValidationError):
            CatalogRasterStatisticsRequest.model_validate(invalid_document)


def test_temporary_aoi_statistics_union_overlapping_polygon_masks(
    tmp_path: Path,
) -> None:
    """Count each finite raster cell once across overlapping AOI polygons."""
    source_path = tmp_path / "aoi-mask.tif"
    raster_values = numpy.arange(1, 25, dtype="float32").reshape((4, 6))
    raster_transform = from_origin(0, 4, 1, 1)
    with rasterio.open(
        source_path,
        "w",
        driver="GTiff",
        width=6,
        height=4,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=raster_transform,
    ) as dataset:
        dataset.write(raster_values, 1)
    polygon_one = {
        "type": "Polygon",
        "coordinates": [[(0, 0), (3, 0), (3, 4), (0, 4), (0, 0)]],
    }
    polygon_two = {
        "type": "MultiPolygon",
        "coordinates": [[[(2, 0), (5, 0), (5, 4), (2, 4), (2, 0)]]],
    }
    temporary_aoi_id = "B" * 32
    sampling_area = TemporaryAoiSamplingArea(
        _resolved_temporary_aoi(
            temporary_aoi_id,
            (polygon_one, polygon_two),
        )
    )

    statistics = read_raster_statistics(source_path, sampling_area)

    assert statistics.scope == "temporaryAoi"
    assert statistics.temporary_aoi_id == temporary_aoi_id
    assert statistics.selected_bounds is None
    assert statistics.source_width == 5
    assert statistics.source_height == 4
    assert statistics.valid_sample_count == 20
    assert sum(statistics.histogram.counts) == 20
    assert statistics.valid_sample_count < 24


def test_temporary_aoi_statistics_distinguish_overlap_and_valid_sample_errors(
    tmp_path: Path,
) -> None:
    """Keep out-of-raster AOIs distinct from all-nodata AOI intersections."""
    source_path = tmp_path / "empty-aoi-mask.tif"
    with rasterio.open(
        source_path,
        "w",
        driver="GTiff",
        width=2,
        height=2,
        count=1,
        dtype="float32",
        nodata=-9999,
        crs="EPSG:4326",
        transform=from_origin(0, 2, 1, 1),
    ) as dataset:
        dataset.write(numpy.full((2, 2), -9999, dtype="float32"), 1)
    inside = TemporaryAoiSamplingArea(_resolved_temporary_aoi(
        "C" * 32,
        ({
            "type": "Polygon",
            "coordinates": [[(0, 0), (2, 0), (2, 2), (0, 2), (0, 0)]],
        },),
    ))
    outside = TemporaryAoiSamplingArea(_resolved_temporary_aoi(
        "D" * 32,
        ({
            "type": "Polygon",
            "coordinates": [[(10, 10), (11, 10), (11, 11), (10, 11), (10, 10)]],
        },),
    ))

    with pytest.raises(NoValidRasterSamplesError):
        read_raster_statistics(source_path, inside)
    with pytest.raises(NoRasterBoundsOverlapError):
        read_raster_statistics(source_path, outside)


def test_selected_area_statistics_transform_clip_and_bound_the_source_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Read only the projected raster intersection through the 512px budget."""
    dataset = _StatisticsDataset(
        numpy.ma.zeros((512, 341), dtype="float32")
    )
    dataset.width = 1_000
    dataset.height = 800
    dataset.transform = (
        Affine.translation(2_000, 8_000)
        * Affine.rotation(25)
        * Affine.scale(10, -10)
    )
    selected_bounds = Wgs84Bounds(
        west=-2,
        south=-1,
        east=3,
        north=4,
    )
    transform_call = None

    def project_ring(
        source_crs: object,
        target_crs: object,
        longitudes: list[float],
        latitudes: list[float],
    ) -> tuple[list[float], list[float]]:
        nonlocal transform_call
        transform_call = (
            source_crs,
            target_crs,
            longitudes,
            latitudes,
        )
        pixel_coordinates = [
            (
                (longitude + 1) * 100 - 0.25,
                460 - latitude * 140 - 0.25,
            )
            for longitude, latitude in zip(
                longitudes,
                latitudes,
                strict=True,
            )
        ]
        projected_coordinates = [
            dataset.transform * pixel_coordinate
            for pixel_coordinate in pixel_coordinates
        ]
        return (
            [coordinate[0] for coordinate in projected_coordinates],
            [coordinate[1] for coordinate in projected_coordinates],
        )

    monkeypatch.setattr(
        "eolab_app.raster.statistics.rasterio.open",
        lambda _: dataset,
    )
    monkeypatch.setattr(
        "eolab_app.raster.statistics.transform",
        project_ring,
    )

    statistics = read_raster_statistics(
        Path("projected-raster.tif"),
        selected_bounds.canonical_tuple(),
    )

    assert transform_call is not None
    assert transform_call[:2] == ("EPSG:4326", "EPSG:3857")
    transformed_ring = tuple(zip(*transform_call[2:], strict=True))
    assert len(transformed_ring) == 89
    assert transformed_ring[0] == (-2.0, -1.0)
    assert transformed_ring[-1] == (-2.0, -1.0)
    assert (-2.0, 4.0) in transformed_ring
    assert (3.0, -1.0) in transformed_ring
    assert (3.0, 4.0) in transformed_ring
    assert dataset.read_arguments == (
        1,
        Window(0, 0, 400, 600),
        (512, 341),
        True,
        Resampling.nearest,
    )
    assert statistics.scope == "selectedArea"
    assert statistics.selected_bounds == selected_bounds
    assert statistics.source_width == 400
    assert statistics.source_height == 600
    assert statistics.source_pixel_count == 240_000
    assert statistics.sample_width == 341
    assert statistics.sample_height == 512
    assert statistics.sampled_pixel_count <= 512 * 512
    assert statistics.estimated is True


def test_selected_area_statistics_mask_a_non_axis_aligned_projected_polygon(
    tmp_path: Path,
) -> None:
    """Exclude distinctive pixels that fall only in a projected envelope."""
    selected_bounds = (-130.0, 45.0, -60.0, 75.0)
    west, south, east, north = selected_bounds
    denominator = 22
    wgs84_ring: list[tuple[float, float]] = []
    edge_endpoints = (
        ((west, south), (east, south)),
        ((east, south), (east, north)),
        ((east, north), (west, north)),
        ((west, north), (west, south)),
    )
    for edge_index, (start, end) in enumerate(edge_endpoints):
        for step in range(0 if edge_index == 0 else 1, denominator + 1):
            fraction = step / denominator
            wgs84_ring.append(
                (
                    start[0] + (end[0] - start[0]) * fraction,
                    start[1] + (end[1] - start[1]) * fraction,
                )
            )

    projected_x, projected_y = transform_coordinates(
        "EPSG:4326",
        "EPSG:3347",
        [coordinate[0] for coordinate in wgs84_ring],
        [coordinate[1] for coordinate in wgs84_ring],
    )
    projected_ring = tuple(zip(projected_x, projected_y, strict=True))
    width = 200
    height = 160
    raster_transform = from_bounds(
        min(projected_x),
        min(projected_y),
        max(projected_x),
        max(projected_y),
        width,
        height,
    )
    inside_selection = geometry_mask(
        [{"type": "Polygon", "coordinates": [projected_ring]}],
        out_shape=(height, width),
        transform=raster_transform,
        all_touched=True,
        invert=True,
    )
    assert 0 < int(inside_selection.sum()) < width * height
    raster_values = numpy.where(inside_selection, 7, 997).astype("float32")
    source_path = tmp_path / "non-axis-aligned-selection.tif"
    with rasterio.open(
        source_path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype="float32",
        crs="EPSG:3347",
        transform=raster_transform,
    ) as dataset:
        dataset.write(raster_values, 1)

    statistics = read_raster_statistics(source_path, selected_bounds)

    assert statistics.source_width == width
    assert statistics.source_height == height
    assert statistics.valid_sample_count == int(inside_selection.sum())
    assert statistics.sample_minimum == 7
    assert statistics.sample_maximum == 7


def test_selected_area_statistics_reject_an_empty_raster_intersection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Give an empty projected intersection its own stable failure type."""
    dataset = _StatisticsDataset(numpy.ma.zeros((1, 1), dtype="float32"))
    monkeypatch.setattr(
        "eolab_app.raster.statistics.rasterio.open",
        lambda _: dataset,
    )
    monkeypatch.setattr(
        "eolab_app.raster.statistics.transform",
        lambda _source, _target, x_values, y_values: (
            [100 + value for value in x_values],
            [100 + value for value in y_values],
        ),
    )

    with pytest.raises(NoRasterBoundsOverlapError):
        read_raster_statistics(
            Path("projected-raster.tif"),
            (-1, -1, 1, 1),
        )


def test_raster_statistics_sample_shape_never_exceeds_its_budget() -> None:
    """Bound global and extremely narrow rasters to a 512-pixel side."""
    for source_width, source_height in (
        (133_584, 66_792),
        (1_000_000_000, 1),
        (1, 1_000_000_000),
    ):
        sample_height, sample_width = bounded_raster_sample_shape(
            source_width,
            source_height,
        )
        assert sample_width <= source_width
        assert sample_height <= source_height
        assert sample_width <= 512
        assert sample_height <= 512
        assert sample_width * sample_height <= 512 * 512

    assert bounded_raster_sample_shape(256, 128) == (128, 256)
    assert bounded_raster_sample_shape(133_584, 66_792) == (256, 512)


def test_raster_statistics_make_flat_and_repeated_ranges_renderable() -> None:
    """Keep suggested thresholds strict without rewriting raw percentiles."""
    flat_range = strict_raster_value_range(
        0.0001,
        0.0001,
        0.0001,
        0.0001,
        0.0001,
    )
    repeated_percentile_range = strict_raster_value_range(
        0,
        100,
        0,
        0,
        90,
    )

    assert (
        flat_range.minimum
        < flat_range.midpoint
        < flat_range.maximum
    )
    assert flat_range.midpoint == 0.0001
    assert repeated_percentile_range.minimum == pytest.approx(-0.00009)
    assert repeated_percentile_range.midpoint == 0
    assert repeated_percentile_range.maximum == 90


def test_raster_statistics_reject_an_empty_bounded_sample(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Do not invent a display range when every sampled cell is invalid."""
    dataset = _StatisticsDataset(
        numpy.ma.masked_all((2, 4), dtype="float32")
    )
    monkeypatch.setattr(
        "eolab_app.raster.statistics.rasterio.open",
        lambda _: dataset,
    )

    with pytest.raises(NoValidRasterSamplesError):
        read_raster_statistics(Path("empty.tif"))


@pytest.mark.parametrize(
    ("read_error", "expected_detail"),
    (
        (
            NoRasterBoundsOverlapError(),
            "The selected area does not overlap the raster",
        ),
        (
            NoValidRasterSamplesError(),
            (
                "No finite, non-nodata pixels were found in the bounded "
                "raster sample"
            ),
        ),
    ),
)
def test_statistics_service_returns_stable_selection_conflicts(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    read_error: ValueError,
    expected_detail: str,
) -> None:
    """Expose empty overlap and empty samples as deliberate 409 contracts."""
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"source")
    item_id = "geotiff-0123456789abcdef01234567"
    registry = PublishedRasterRegistry()
    registry.authorize(
        f"eolab:{item_id}",
        source_path,
        source_signature(source_path),
    )
    service = RasterStatisticsService(registry, 1, 32)
    request = CatalogRasterStatisticsRequest.model_validate(
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": item_id,
            "selectedBounds": {
                "west": -1,
                "south": -1,
                "east": 1,
                "north": 1,
            },
        }
    )

    async def to_thread(function: object, *args: object) -> object:
        if function is read_raster_statistics:
            raise read_error
        return function(*args)

    monkeypatch.setattr(
        "eolab_app.raster.statistics_service.asyncio.to_thread",
        to_thread,
    )

    async def request_statistics() -> None:
        with pytest.raises(RasterConflictError) as error:
            await service.get(request)
        assert error.value.detail == expected_detail

    asyncio.run(request_statistics())


def test_pixel_sampler_limits_concurrent_raster_reads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep concurrent hover reads within the supplied process limit."""
    active_reads = 0
    maximum_active_reads = 0
    two_reads_started = asyncio.Event()
    release_reads = asyncio.Event()

    async def to_thread(
        _: object,
        request: CatalogPixelRequest,
    ) -> RasterPixel:
        nonlocal active_reads, maximum_active_reads
        active_reads += 1
        maximum_active_reads = max(maximum_active_reads, active_reads)
        if active_reads == 2:
            two_reads_started.set()
        await release_reads.wait()
        active_reads -= 1
        return RasterPixel(
            longitude=request.longitude,
            latitude=request.latitude,
            row=0,
            column=0,
            inBounds=True,
            value=1,
        )

    monkeypatch.setattr(
        "eolab_app.raster.pixel_service.asyncio.to_thread",
        to_thread,
    )

    class Registry:
        pass

    async def sample_three_pixels() -> None:
        service = RasterPixelService(Registry(), read_concurrency=2)
        requests = [
            CatalogPixelRequest.model_validate(
                {
                    "collectionId": "eolab-mounted-geotiffs",
                    "itemId": "geotiff-0123456789abcdef01234567",
                    "longitude": longitude,
                    "latitude": 0,
                }
            )
            for longitude in (1, 2, 3)
        ]
        tasks = [
            asyncio.create_task(service.get(request))
            for request in requests
        ]
        await asyncio.wait_for(two_reads_started.wait(), timeout=1)
        await asyncio.sleep(0)
        assert maximum_active_reads == 2
        release_reads.set()
        await asyncio.gather(*tasks)

    asyncio.run(sample_three_pixels())
    assert maximum_active_reads == 2


def test_cancelled_pixel_request_keeps_its_slot_until_gdal_finishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Do not release raster capacity while a canceled request still reads."""
    started_reads = 0
    first_read_started = asyncio.Event()
    release_reads = asyncio.Event()

    async def to_thread(
        _: object,
        request: CatalogPixelRequest,
    ) -> RasterPixel:
        nonlocal started_reads
        started_reads += 1
        first_read_started.set()
        await release_reads.wait()
        return RasterPixel(
            longitude=request.longitude,
            latitude=request.latitude,
            row=0,
            column=0,
            inBounds=True,
            value=1,
        )

    monkeypatch.setattr(
        "eolab_app.raster.pixel_service.asyncio.to_thread",
        to_thread,
    )

    class Registry:
        pass

    async def cancel_during_read() -> None:
        service = RasterPixelService(Registry(), read_concurrency=1)
        request = CatalogPixelRequest.model_validate(
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": "geotiff-0123456789abcdef01234567",
                "longitude": 0,
                "latitude": 0,
            }
        )
        first_request = asyncio.create_task(service.get(request))
        await first_read_started.wait()
        first_request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first_request

        second_request = asyncio.create_task(service.get(request))
        await asyncio.sleep(0)
        assert service._read_semaphore.locked()
        assert started_reads == 1

        release_reads.set()
        await second_request
        assert started_reads == 2

    asyncio.run(cancel_during_read())


def test_statistics_service_coalesces_caches_and_invalidates_by_signature(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Read one source version once and never reuse it after replacement."""
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"first source")
    layer_name = "eolab:geotiff-0123456789abcdef01234567"
    registry = PublishedRasterRegistry()
    registry.authorize(layer_name, source_path, source_signature(source_path))
    service = RasterStatisticsService(registry, 1, 32)
    request = CatalogRasterStatisticsRequest.model_validate(
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        }
    )
    read_count = 0
    read_started = asyncio.Event()
    release_read = asyncio.Event()

    async def to_thread(function: object, *args: object) -> object:
        nonlocal read_count
        if function is read_raster_statistics:
            read_count += 1
            read_started.set()
            await release_read.wait()
            return _statistics_result(float(read_count))
        return function(*args)

    monkeypatch.setattr(
        "eolab_app.raster.statistics_service.asyncio.to_thread",
        to_thread,
    )

    async def exercise_cache() -> None:
        first_request = asyncio.create_task(service.get(request))
        second_request = asyncio.create_task(service.get(request))
        await read_started.wait()
        release_read.set()
        first_result, second_result = await asyncio.gather(
            first_request,
            second_request,
        )
        assert first_result is second_result
        assert read_count == 1

        assert await service.get(request) is first_result
        assert read_count == 1

        source_path.write_bytes(b"replacement source is larger")
        registry.authorize(
            layer_name,
            source_path,
            source_signature(source_path),
        )
        replacement_result = await service.get(request)
        assert replacement_result.sample_minimum == 2
        assert read_count == 2

    asyncio.run(exercise_cache())


def test_statistics_service_caches_each_canonical_selected_area_separately(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Include selected bounds in cache and in-flight work identity."""
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"source")
    item_id = "geotiff-0123456789abcdef01234567"
    registry = PublishedRasterRegistry()
    registry.authorize(
        f"eolab:{item_id}",
        source_path,
        source_signature(source_path),
    )
    service = RasterStatisticsService(registry, 1, 32)
    identity = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": item_id,
    }
    whole_request = CatalogRasterStatisticsRequest.model_validate(identity)
    west_request = CatalogRasterStatisticsRequest.model_validate(
        {
            **identity,
            "selectedBounds": {
                "west": -2,
                "south": -1,
                "east": 0,
                "north": 1,
            },
        }
    )
    equivalent_west_request = CatalogRasterStatisticsRequest.model_validate(
        {
            **identity,
            "selectedBounds": {
                "west": -2.0,
                "south": -1.0,
                "east": 0.0,
                "north": 1.0,
            },
        }
    )
    east_request = CatalogRasterStatisticsRequest.model_validate(
        {
            **identity,
            "selectedBounds": {
                "west": 0,
                "south": -1,
                "east": 2,
                "north": 1,
            },
        }
    )
    read_bounds = []

    async def to_thread(function: object, *args: object) -> object:
        if function is read_raster_statistics:
            bounds = args[1]
            read_bounds.append(bounds)
            return _statistics_result(float(len(read_bounds)), bounds)
        return function(*args)

    monkeypatch.setattr(
        "eolab_app.raster.statistics_service.asyncio.to_thread",
        to_thread,
    )

    async def exercise_cache() -> None:
        whole = await service.get(whole_request)
        west = await service.get(west_request)
        assert await service.get(equivalent_west_request) is west
        east = await service.get(east_request)

        assert whole.scope == "wholeRaster"
        assert west.scope == "selectedArea"
        assert east.scope == "selectedArea"

    asyncio.run(exercise_cache())
    assert read_bounds == [
        None,
        (-2.0, -1.0, 0.0, 1.0),
        (0.0, -1.0, 2.0, 1.0),
    ]


def test_statistics_service_keys_and_rechecks_temporary_aoi_lifecycle(
    tmp_path: Path,
) -> None:
    """Coalesce by AOI identity and reject lifecycle changes around reads."""
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"source")
    item_id = "geotiff-0123456789abcdef01234567"
    temporary_aoi_id = "E" * 32
    registry = PublishedRasterRegistry()
    registry.authorize(
        f"eolab:{item_id}",
        source_path,
        source_signature(source_path),
    )
    first_aoi = _resolved_temporary_aoi(
        temporary_aoi_id,
        ({
            "type": "Polygon",
            "coordinates": [[(-1, -1), (1, -1), (1, 1), (-1, 1), (-1, -1)]],
        },),
    )
    changed_aoi = _resolved_temporary_aoi(
        temporary_aoi_id,
        ({
            "type": "Polygon",
            "coordinates": [[(-2, -2), (2, -2), (2, 2), (-2, 2), (-2, -2)]],
        },),
        expires_at=datetime(2030, 1, 2, tzinfo=timezone.utc),
    )
    newer_aoi = _resolved_temporary_aoi(
        temporary_aoi_id,
        ({
            "type": "Polygon",
            "coordinates": [[(-3, -3), (3, -3), (3, 3), (-3, 3), (-3, -3)]],
        },),
        expires_at=datetime(2030, 1, 3, tzinfo=timezone.utc),
    )

    class AoiReader:
        """Return mutable test ownership through an immutable read contract."""

        def __init__(self) -> None:
            """Start with the first ready AOI lifecycle."""
            self.current = first_aoi
            self.calls = 0

        async def resolve_for_sampling(
            self,
            requested_id: str,
        ) -> ResolvedTemporaryAoi:
            """Return the current lifecycle for the expected opaque reference.

            Args:
                requested_id: Opaque reference requested by the service.

            Returns:
                Current immutable resolved test AOI.

            Raises:
                SamplingAreaUnavailableError: If the reference is no longer
                    owned by the fake lifecycle.
            """
            self.calls += 1
            if requested_id != temporary_aoi_id:
                raise SamplingAreaUnavailableError("AOI is unavailable")
            return self.current

    aoi_reader = AoiReader()
    read_areas: list[TemporaryAoiSamplingArea] = []

    def statistics_reader(
        _source_path: Path,
        sampling_area: TemporaryAoiSamplingArea,
    ) -> RasterStatistics:
        """Record the resolved AOI and simulate a mid-read lifecycle change.

        Args:
            _source_path: Authorized raster path unused by this fake.
            sampling_area: Immutable AOI supplied to the synchronous reader.

        Returns:
            Valid temporary-AOI statistics for the supplied lifecycle.
        """
        read_areas.append(sampling_area)
        if len(read_areas) == 2:
            aoi_reader.current = newer_aoi
        return _statistics_result(
            float(len(read_areas)),
            temporary_aoi_id=temporary_aoi_id,
        )

    service = RasterStatisticsService(
        registry,
        1,
        32,
        temporary_aoi_reader=aoi_reader,
        statistics_reader=statistics_reader,
    )
    request = CatalogRasterStatisticsRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": item_id,
        "temporaryAoiId": temporary_aoi_id,
    })

    async def exercise_lifecycle() -> None:
        """Verify cached reads re-resolve and changed reads never cache.

        Returns:
            None.
        """
        first = await service.get(request)
        assert await service.get(request) is first
        aoi_reader.current = changed_aoi
        with pytest.raises(RasterConflictError) as error:
            await service.get(request)
        assert "changed while it was being sampled" in error.value.detail

    asyncio.run(exercise_lifecycle())

    assert len(read_areas) == 2
    assert read_areas[0].resolved_aoi.identity == first_aoi.identity
    assert read_areas[1].resolved_aoi.identity == changed_aoi.identity
    assert aoi_reader.calls >= 7


def test_statistics_service_rejects_a_source_changed_during_read(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Never return or cache statistics read across two source versions."""
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"source before statistics")
    item_id = "geotiff-0123456789abcdef01234567"
    layer_name = f"eolab:{item_id}"
    registry = PublishedRasterRegistry()
    registry.authorize(layer_name, source_path, source_signature(source_path))
    service = RasterStatisticsService(registry, 1, 32)
    request = CatalogRasterStatisticsRequest.model_validate(
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": item_id,
        }
    )
    read_count = 0

    async def to_thread(function: object, *args: object) -> object:
        nonlocal read_count
        if function is read_raster_statistics:
            read_count += 1
            if read_count == 1:
                source_path.write_bytes(b"source changed during statistics")
            return _statistics_result(float(read_count))
        return function(*args)

    monkeypatch.setattr(
        "eolab_app.raster.statistics_service.asyncio.to_thread",
        to_thread,
    )

    async def change_during_read() -> None:
        with pytest.raises(RasterConflictError) as error:
            await service.get(request)
        assert error.value.detail == (
            "The visualized GeoTIFF changed; select it again"
        )
        assert not service._cache

        registry.authorize(
            layer_name,
            source_path,
            source_signature(source_path),
        )
        statistics = await service.get(request)
        assert statistics.sample_minimum == 2
        assert read_count == 2

    asyncio.run(change_during_read())


def test_cancelled_statistics_request_retains_its_capacity_slot(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Do not overlap a second GDAL read with canceled work still running."""
    registry = PublishedRasterRegistry()
    requests = []
    for item_suffix in ("67", "68"):
        item_id = f"geotiff-0123456789abcdef012345{item_suffix}"
        layer_name = f"eolab:{item_id}"
        source_path = tmp_path / f"{item_suffix}.tif"
        source_path.write_bytes(item_suffix.encode())
        registry.authorize(
            layer_name,
            source_path,
            source_signature(source_path),
        )
        requests.append(
            CatalogRasterStatisticsRequest.model_validate(
                {
                    "collectionId": "eolab-mounted-geotiffs",
                    "itemId": item_id,
                }
            )
        )

    service = RasterStatisticsService(
        registry,
        read_concurrency=1,
        cache_entries=32,
    )
    active_reads = 0
    maximum_active_reads = 0
    started_reads = 0
    first_read_started = asyncio.Event()
    release_reads = asyncio.Event()

    async def to_thread(function: object, *args: object) -> object:
        nonlocal active_reads, maximum_active_reads, started_reads
        if function is read_raster_statistics:
            started_reads += 1
            active_reads += 1
            maximum_active_reads = max(maximum_active_reads, active_reads)
            first_read_started.set()
            await release_reads.wait()
            active_reads -= 1
            return _statistics_result(float(started_reads))
        return function(*args)

    monkeypatch.setattr(
        "eolab_app.raster.statistics_service.asyncio.to_thread",
        to_thread,
    )

    async def cancel_during_read() -> None:
        first_request = asyncio.create_task(service.get(requests[0]))
        await first_read_started.wait()
        first_request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first_request

        second_request = asyncio.create_task(service.get(requests[1]))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert started_reads == 1

        release_reads.set()
        await second_request
        assert started_reads == 2
        assert maximum_active_reads == 1

    asyncio.run(cancel_during_read())


def test_cancelled_queued_statistics_do_not_delay_the_current_request(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Discard stale work that has not started its bounded GDAL read."""
    registry = PublishedRasterRegistry()
    requests = []
    source_names = ("active", "stale", "current")
    for index, source_name in enumerate(source_names):
        item_id = f"geotiff-0123456789abcdef012345{index:02d}"
        source_path = tmp_path / f"{source_name}.tif"
        source_path.write_bytes(source_name.encode())
        registry.authorize(
            f"eolab:{item_id}",
            source_path,
            source_signature(source_path),
        )
        requests.append(
            CatalogRasterStatisticsRequest.model_validate(
                {
                    "collectionId": "eolab-mounted-geotiffs",
                    "itemId": item_id,
                }
            )
        )

    service = RasterStatisticsService(
        registry,
        read_concurrency=1,
        cache_entries=32,
    )
    read_order = []
    active_read_started = asyncio.Event()
    release_active_read = asyncio.Event()

    async def to_thread(function: object, *args: object) -> object:
        if function is read_raster_statistics:
            source_name = Path(args[0]).stem
            read_order.append(source_name)
            if source_name == "active":
                active_read_started.set()
                await release_active_read.wait()
            return _statistics_result(float(len(read_order)))
        return function(*args)

    monkeypatch.setattr(
        "eolab_app.raster.statistics_service.asyncio.to_thread",
        to_thread,
    )

    async def cancel_queued_work() -> None:
        active_request = asyncio.create_task(service.get(requests[0]))
        await active_read_started.wait()

        stale_request = asyncio.create_task(service.get(requests[1]))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        stale_request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await stale_request

        current_request = asyncio.create_task(service.get(requests[2]))
        release_active_read.set()
        await asyncio.gather(active_request, current_request)

    asyncio.run(cancel_queued_work())
    assert read_order == ["active", "current"]


def test_stale_signature_check_does_not_remove_a_new_authorization(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A stale checker must not mutate a concurrently republished layer."""
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"old source")
    layer_name = "eolab:geotiff-0123456789abcdef01234567"
    registry = PublishedRasterRegistry()
    registry.authorize(layer_name, source_path, source_signature(source_path))

    source_path.write_bytes(b"new source is larger")
    new_signature = source_signature(source_path)
    stale_check_started = threading.Event()
    release_stale_check = threading.Event()
    real_source_signature = source_signature

    def coordinated_source_signature(path: Path) -> tuple[int, int, int, int, int]:
        if threading.current_thread().name == "stale-signature-check":
            stale_check_started.set()
            assert release_stale_check.wait(timeout=1)
        return real_source_signature(path)

    monkeypatch.setattr(
        "eolab_app.raster.sources.source_signature",
        coordinated_source_signature,
    )
    stale_error = []

    def require_stale_authorization() -> None:
        try:
            registry.require_current(layer_name)
        except RasterConflictError as error:
            stale_error.append(error)

    stale_thread = threading.Thread(
        target=require_stale_authorization,
        name="stale-signature-check",
    )
    stale_thread.start()
    assert stale_check_started.wait(timeout=1)

    registry.authorize(layer_name, source_path, new_signature)
    release_stale_check.set()
    stale_thread.join(timeout=1)

    assert not stale_thread.is_alive()
    assert len(stale_error) == 1
    assert registry.require_current(layer_name).source_signature == new_signature
