"""Test the synchronous raster pixel boundary."""

from pathlib import Path

import pytest
import numpy
from rasterio.enums import MaskFlags
from rasterio.transform import Affine
from rasterio.windows import Window

from eolab_app.raster.pixel import read_raster_pixel


class _Dataset:
    """Record the exact bounded pixel read."""

    crs = "EPSG:3857"
    width = 10
    height = 10
    count = 1
    dtypes = ("float32",)
    block_shapes = ((10, 10),)
    mask_flag_enums = ([MaskFlags.all_valid],)
    nodatavals = (None,)
    files = ("raster.tif",)
    transform = Affine.identity()

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

    def read(self, band: int, *, window: Window, masked: bool) -> numpy.ndarray:
        """Record and return one bounded source read.

        Args:
            band: One-based source band.
            window: Requested source cell.
            masked: Whether Rasterio should derive validity itself.

        Returns:
            Controlled original numeric value.
        """
        self.read_arguments = (band, window, masked)
        return numpy.array([[42.5]], dtype="float32")


def test_pixel_reader_reads_only_band_one_and_one_source_cell(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep each pixel probe bounded to one cell in band 1."""
    dataset = _Dataset()
    monkeypatch.setattr(
        "eolab_app.raster.pixel.rasterio.open",
        lambda _, **kwargs: dataset,
    )
    monkeypatch.setattr(
        "eolab_app.raster.pixel.transform",
        lambda *_: ([10], [20]),
    )

    pixel = read_raster_pixel(Path("raster.tif"), -123, 48)

    assert pixel.value == 42.5
    assert pixel.in_bounds is True
    assert (pixel.row, pixel.column) == (2, 3)
    assert dataset.read_arguments == (1, Window(3, 2, 1, 1), False)
