"""Test raster sampling contracts independently from the HTTP routes."""

import asyncio
import threading
from pathlib import Path

import numpy
import pytest
from fastapi import HTTPException
from rasterio.enums import Resampling
from rasterio.windows import Window

from eolab_app.rendering import (
    CatalogRasterRequest,
    CatalogPixelRequest,
    NoValidRasterSamplesError,
    PublishedRasterRegistry,
    RasterPixel,
    RasterHistogram,
    RasterPercentiles,
    RasterStatistics,
    RasterStatisticsService,
    RasterValueRange,
    _bounded_raster_sample_shape,
    _read_raster_pixel,
    _read_raster_statistics,
    _source_signature,
    _strict_raster_value_range,
    sample_catalog_raster_pixel,
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

    width = 4
    height = 2

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
        out_shape: tuple[int, int],
        masked: bool,
        resampling: Resampling,
    ) -> numpy.ma.MaskedArray:
        self.read_arguments = (band, out_shape, masked, resampling)
        return self.sample


def _statistics_result(value: float = 1) -> RasterStatistics:
    """Build one valid statistics response for service coordination tests."""
    return RasterStatistics(
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


def test_pixel_reader_requests_only_band_one_and_its_source_cell(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep hover I/O bounded to a one-cell window in band 1."""
    dataset = _RasterDataset()
    monkeypatch.setattr("eolab_app.rendering.rasterio.open", lambda _: dataset)
    monkeypatch.setattr(
        "eolab_app.rendering.transform",
        lambda *_: ([10], [20]),
    )

    pixel = _read_raster_pixel(Path("raster.tif"), -123, 48)

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
    monkeypatch.setattr("eolab_app.rendering.rasterio.open", lambda _: dataset)
    monkeypatch.setattr(
        "eolab_app.rendering.transform",
        lambda *_: ([float("inf")], [float("inf")]),
    )

    pixel = _read_raster_pixel(Path("raster.tif"), 180, 90)

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
    monkeypatch.setattr("eolab_app.rendering.rasterio.open", lambda _: dataset)

    statistics = _read_raster_statistics(Path("projected-raster.tif"))

    assert statistics.model_dump(by_alias=True) == {
        "band": 1,
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
        (2, 4),
        True,
        Resampling.nearest,
    )


def test_raster_statistics_sample_shape_never_exceeds_its_budget() -> None:
    """Bound global and extremely narrow rasters to a 512-pixel side."""
    for source_width, source_height in (
        (133_584, 66_792),
        (1_000_000_000, 1),
        (1, 1_000_000_000),
    ):
        sample_height, sample_width = _bounded_raster_sample_shape(
            source_width,
            source_height,
        )
        assert sample_width <= source_width
        assert sample_height <= source_height
        assert sample_width <= 512
        assert sample_height <= 512
        assert sample_width * sample_height <= 512 * 512

    assert _bounded_raster_sample_shape(256, 128) == (128, 256)
    assert _bounded_raster_sample_shape(133_584, 66_792) == (256, 512)


def test_raster_statistics_make_flat_and_repeated_ranges_renderable() -> None:
    """Keep suggested thresholds strict without rewriting raw percentiles."""
    flat_range = _strict_raster_value_range(
        0.0001,
        0.0001,
        0.0001,
        0.0001,
        0.0001,
    )
    repeated_percentile_range = _strict_raster_value_range(
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
    monkeypatch.setattr("eolab_app.rendering.rasterio.open", lambda _: dataset)

    with pytest.raises(NoValidRasterSamplesError):
        _read_raster_statistics(Path("empty.tif"))


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
        _registry: object,
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

    monkeypatch.setattr("eolab_app.rendering.asyncio.to_thread", to_thread)

    class Registry:
        pass

    async def sample_three_pixels() -> None:
        semaphore = asyncio.Semaphore(2)
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
            asyncio.create_task(
                sample_catalog_raster_pixel(request, Registry(), semaphore)
            )
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
        _registry: object,
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

    monkeypatch.setattr("eolab_app.rendering.asyncio.to_thread", to_thread)

    class Registry:
        pass

    async def cancel_during_read() -> None:
        semaphore = asyncio.Semaphore(1)
        request = CatalogPixelRequest.model_validate(
            {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": "geotiff-0123456789abcdef01234567",
                "longitude": 0,
                "latitude": 0,
            }
        )
        first_request = asyncio.create_task(
            sample_catalog_raster_pixel(request, Registry(), semaphore)
        )
        await first_read_started.wait()
        first_request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first_request

        second_request = asyncio.create_task(
            sample_catalog_raster_pixel(request, Registry(), semaphore)
        )
        await asyncio.sleep(0)
        assert semaphore.locked()
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
    registry.authorize(layer_name, source_path, _source_signature(source_path))
    service = RasterStatisticsService(registry)
    request = CatalogRasterRequest.model_validate(
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
        if function is _read_raster_statistics:
            read_count += 1
            read_started.set()
            await release_read.wait()
            return _statistics_result(float(read_count))
        return function(*args)

    monkeypatch.setattr("eolab_app.rendering.asyncio.to_thread", to_thread)

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
            _source_signature(source_path),
        )
        replacement_result = await service.get(request)
        assert replacement_result.sample_minimum == 2
        assert read_count == 2

    asyncio.run(exercise_cache())


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
    registry.authorize(layer_name, source_path, _source_signature(source_path))
    service = RasterStatisticsService(registry)
    request = CatalogRasterRequest.model_validate(
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": item_id,
        }
    )
    read_count = 0

    async def to_thread(function: object, *args: object) -> object:
        nonlocal read_count
        if function is _read_raster_statistics:
            read_count += 1
            if read_count == 1:
                source_path.write_bytes(b"source changed during statistics")
            return _statistics_result(float(read_count))
        return function(*args)

    monkeypatch.setattr("eolab_app.rendering.asyncio.to_thread", to_thread)

    async def change_during_read() -> None:
        with pytest.raises(HTTPException) as error:
            await service.get(request)
        assert error.value.status_code == 409
        assert error.value.detail == (
            "The visualized GeoTIFF changed; select it again"
        )
        assert not service._cache

        registry.authorize(
            layer_name,
            source_path,
            _source_signature(source_path),
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
            _source_signature(source_path),
        )
        requests.append(
            CatalogRasterRequest.model_validate(
                {
                    "collectionId": "eolab-mounted-geotiffs",
                    "itemId": item_id,
                }
            )
        )

    service = RasterStatisticsService(registry, read_concurrency=1)
    active_reads = 0
    maximum_active_reads = 0
    started_reads = 0
    first_read_started = asyncio.Event()
    release_reads = asyncio.Event()

    async def to_thread(function: object, *args: object) -> object:
        nonlocal active_reads, maximum_active_reads, started_reads
        if function is _read_raster_statistics:
            started_reads += 1
            active_reads += 1
            maximum_active_reads = max(maximum_active_reads, active_reads)
            first_read_started.set()
            await release_reads.wait()
            active_reads -= 1
            return _statistics_result(float(started_reads))
        return function(*args)

    monkeypatch.setattr("eolab_app.rendering.asyncio.to_thread", to_thread)

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
            _source_signature(source_path),
        )
        requests.append(
            CatalogRasterRequest.model_validate(
                {
                    "collectionId": "eolab-mounted-geotiffs",
                    "itemId": item_id,
                }
            )
        )

    service = RasterStatisticsService(registry, read_concurrency=1)
    read_order = []
    active_read_started = asyncio.Event()
    release_active_read = asyncio.Event()

    async def to_thread(function: object, *args: object) -> object:
        if function is _read_raster_statistics:
            source_name = Path(args[0]).stem
            read_order.append(source_name)
            if source_name == "active":
                active_read_started.set()
                await release_active_read.wait()
            return _statistics_result(float(len(read_order)))
        return function(*args)

    monkeypatch.setattr("eolab_app.rendering.asyncio.to_thread", to_thread)

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
    registry.authorize(layer_name, source_path, _source_signature(source_path))

    source_path.write_bytes(b"new source is larger")
    new_signature = _source_signature(source_path)
    stale_check_started = threading.Event()
    release_stale_check = threading.Event()
    real_source_signature = _source_signature

    def coordinated_source_signature(path: Path) -> tuple[int, int, int, int, int]:
        if threading.current_thread().name == "stale-signature-check":
            stale_check_started.set()
            assert release_stale_check.wait(timeout=1)
        return real_source_signature(path)

    monkeypatch.setattr(
        "eolab_app.rendering._source_signature",
        coordinated_source_signature,
    )
    stale_error = []

    def require_stale_authorization() -> None:
        try:
            registry.require_current(layer_name)
        except HTTPException as error:
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
    assert stale_error[0].status_code == 409
    assert registry.require_current(layer_name).source_signature == new_signature
