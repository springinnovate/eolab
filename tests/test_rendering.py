"""Test raster sampling contracts independently from the HTTP routes."""

import asyncio
from pathlib import Path

import pytest
from rasterio.windows import Window

from eolab_app.rendering import (
    CatalogPixelRequest,
    RasterPixel,
    _read_raster_pixel,
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
