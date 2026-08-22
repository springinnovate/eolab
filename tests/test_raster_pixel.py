"""Test the synchronous raster pixel boundary."""

from pathlib import Path

import pytest
from rasterio.windows import Window

from eolab_app.raster.pixel import read_raster_pixel


class _Sample:
    """Minimal one-value masked sample."""

    def count(self) -> int:
        """Report one valid value."""
        return 1

    def __getitem__(self, _: tuple[int, int]) -> float:
        """Return the controlled sample value."""
        return 42.5


class _Dataset:
    """Record the exact bounded pixel read."""

    crs = "EPSG:3857"
    width = 10
    height = 10

    def __init__(self) -> None:
        """Create an unread fake dataset."""
        self.read_arguments = None

    def __enter__(self) -> "_Dataset":
        """Enter the Rasterio-style context."""
        return self

    def __exit__(self, *_: object) -> None:
        """Exit the Rasterio-style context."""
        return None

    def index(self, x: float, y: float) -> tuple[int, int]:
        """Map the controlled projected point to one source cell."""
        assert (x, y) == (10, 20)
        return 2, 3

    def read(self, band: int, *, window: Window, masked: bool) -> _Sample:
        """Record and return one bounded source read."""
        self.read_arguments = (band, window, masked)
        return _Sample()


def test_pixel_reader_reads_only_band_one_and_one_source_cell(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep each pixel probe bounded to one cell in band 1."""
    dataset = _Dataset()
    monkeypatch.setattr(
        "eolab_app.raster.pixel.rasterio.open",
        lambda _: dataset,
    )
    monkeypatch.setattr(
        "eolab_app.raster.pixel.transform",
        lambda *_: ([10], [20]),
    )

    pixel = read_raster_pixel(Path("raster.tif"), -123, 48)

    assert pixel.value == 42.5
    assert pixel.in_bounds is True
    assert (pixel.row, pixel.column) == (2, 3)
    assert dataset.read_arguments == (1, Window(3, 2, 1, 1), True)
