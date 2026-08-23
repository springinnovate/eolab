"""Test the synchronous raster pixel boundary."""

from pathlib import Path

import numpy
import pytest
from rasterio.enums import MaskFlags
from rasterio.windows import Window

from eolab_app.raster.pixel import read_raster_detail_pixel, read_raster_pixel


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


class _DetailDataset(_Dataset):
    """Expose one signed, tiled, nodata-owned detail-only raster."""

    count = 1
    block_shapes = ((4, 4),)
    mask_flag_enums = ((MaskFlags.nodata,),)
    nodatavals = (-9999.0,)
    dtypes = ("float32",)

    def __init__(self, source_path: Path) -> None:
        """Create a signed fake around one authoritative path.

        Args:
            source_path: Path reported as the only GDAL dependency.
        """
        super().__init__()
        self.files = [str(source_path)]
        self.sample_value = 42.5

    def block_window(
        self,
        band: int,
        block_row: int,
        block_column: int,
    ) -> Window:
        """Return the single native block containing the controlled pixel.

        Args:
            band: One-based band index.
            block_row: Native block row.
            block_column: Native block column.

        Returns:
            Four-by-four top-left native block.
        """
        assert (band, block_row, block_column) == (1, 0, 0)
        return Window(0, 0, 4, 4)

    def read(
        self,
        band: int,
        *,
        window: Window,
        masked: bool,
    ) -> numpy.ndarray:
        """Return one complete native block and record the bounded read.

        Args:
            band: One-based band index.
            window: Exact native block window.
            masked: Whether GDAL mask reading was requested.

        Returns:
            Controlled four-by-four source values.
        """
        self.read_arguments = (band, window, masked)
        values = numpy.zeros((4, 4), dtype=numpy.float32)
        values[2, 3] = self.sample_value
        return values


def test_detail_pixel_reader_opens_once_per_request_and_preserves_nodata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Match preview validity while avoiding publication authorization.

    Args:
        tmp_path: Temporary signed-source directory.
        monkeypatch: Rasterio and transform collaborator replacement fixture.
    """
    source_path = tmp_path / "detail.tif"
    source_path.write_bytes(b"controlled")
    dataset = _DetailDataset(source_path)
    open_count = 0

    def open_once(path: Path) -> _DetailDataset:
        """Return the controlled dataset and record one open.

        Args:
            path: Authorized source path.

        Returns:
            Controlled signed dataset.
        """
        nonlocal open_count
        assert path == source_path
        open_count += 1
        return dataset

    monkeypatch.setattr("eolab_app.raster.pixel.rasterio.open", open_once)
    monkeypatch.setattr(
        "eolab_app.raster.pixel.transform",
        lambda *_: ([10], [20]),
    )

    pixel = read_raster_detail_pixel(source_path, -123, 48)

    assert open_count == 1
    assert pixel.value == 42.5
    assert pixel.in_bounds is True
    assert (pixel.row, pixel.column) == (2, 3)
    assert dataset.read_arguments == (1, Window(0, 0, 4, 4), False)

    dataset.sample_value = -9999.0
    nodata_pixel = read_raster_detail_pixel(source_path, -123, 48)

    assert open_count == 2
    assert nodata_pixel.in_bounds is True
    assert nodata_pixel.value is None
