"""Test rendering-independent native-block raster read planners."""

from pathlib import Path

import numpy
import pytest
import rasterio
from rasterio.enums import MaskFlags, Resampling
from rasterio.transform import from_origin
from rasterio.windows import Window

from eolab_app.raster import sample_grid
from eolab_app.raster.exact_source import (
    plan_exact_source_window,
    read_exact_source_window,
)
from eolab_app.raster.read_cancellation import RasterReadCancelled
from eolab_app.raster.sample_grid import (
    SAMPLE_GRID_MAX_DECODED_SOURCE_BYTES,
    SAMPLE_GRID_MAX_DIMENSION,
    SAMPLE_GRID_MAX_SOURCE_BLOCK_READS,
    plan_sample_grid_for_source_positions,
    plan_source_window_sample_grid,
    read_planned_sample_grid_from_overview,
    read_source_window_sample_grid,
)
from eolab_app.raster.source_contract import (
    BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES,
)


class _NativeBlockDataset:
    """Provide a minimal one-band Rasterio contract with recorded reads."""

    count = 1
    crs = "EPSG:4326"
    overview_factors: tuple[int, ...] = ()

    def __init__(
        self,
        values: numpy.ndarray,
        *,
        block_shape: tuple[int, int],
        nodata: float | None = None,
        source_path: Path = Path("raster.tif"),
    ) -> None:
        """Create a controlled native-block source.

        Args:
            values: Two-dimensional band-one source values.
            block_shape: Native block height and width.
            nodata: Optional signed band nodata value.
            source_path: Path represented by the dataset dependency list.
        """
        self.values = values
        self.height, self.width = values.shape
        self.transform = from_origin(0, self.height, 1, 1)
        self.block_shapes = (block_shape,)
        self.dtypes = (values.dtype.name,)
        self.nodatavals = (nodata,)
        self.mask_flag_enums = (
            [MaskFlags.nodata] if nodata is not None else [MaskFlags.all_valid],
        )
        self.files = (str(source_path.resolve()),)
        self.read_windows: list[Window] = []

    def overviews(self, band: int) -> list[int]:
        """Return controlled overview factors for band one.

        Args:
            band: One-based band index.

        Returns:
            Advertised overview factors.
        """
        assert band == 1
        return list(self.overview_factors)

    def block_window(
        self,
        band: int,
        block_row: int,
        block_column: int,
    ) -> Window:
        """Return one clipped native-block window.

        Args:
            band: One-based source band, which must be band one.
            block_row: Zero-based native block row.
            block_column: Zero-based native block column.

        Returns:
            Integral window for the requested block.
        """
        assert band == 1
        block_height, block_width = self.block_shapes[0]
        row_offset = block_row * block_height
        column_offset = block_column * block_width
        return Window(
            column_offset,
            row_offset,
            min(block_width, self.width - column_offset),
            min(block_height, self.height - row_offset),
        )

    def read(
        self,
        band: int,
        *,
        window: Window,
        masked: bool,
    ) -> numpy.ndarray:
        """Read exactly one requested native block.

        Args:
            band: One-based source band, which must be band one.
            window: Exact integral block window.
            masked: Rasterio-style mask request; the bounded reader owns masks.

        Returns:
            Copy of source values inside ``window``.
        """
        assert band == 1
        assert masked is False
        self.read_windows.append(window)
        row_start = int(window.row_off)
        column_start = int(window.col_off)
        return self.values[
            row_start:row_start + int(window.height),
            column_start:column_start + int(window.width),
        ].copy()


@pytest.fixture
def overview_path(tmp_path: Path) -> Path:
    """Create an integer raster whose pixel values identify their native positions.

    Args:
        tmp_path: Directory for the tiled GeoTIFF.

    Returns:
        Original raster with three embedded nearest-neighbor overviews.
    """
    path = tmp_path / "overview.tif"
    values = numpy.arange(1024 * 1024, dtype=numpy.int32).reshape(1024, 1024)
    with rasterio.open(
        path, "w", driver="GTiff", width=1024, height=1024, count=1,
        dtype=values.dtype, crs="EPSG:4326", transform=from_origin(-180, 90, 360 / 1024, 180 / 1024),
        tiled=True, blockxsize=128, blockysize=128, nodata=-9999,
    ) as destination:
        destination.write(values, 1)
        destination.build_overviews((2, 4, 8), Resampling.nearest)
    return path


class _PlanningDataset:
    """Expose huge raster metadata without allocating its source pixels."""

    count = 1
    crs = "EPSG:4326"
    dtypes = ("uint8",)
    nodatavals = (None,)
    mask_flag_enums = ([MaskFlags.all_valid],)
    transform = from_origin(0, 1_000_000, 1, 1)

    def __init__(
        self,
        width: int,
        height: int,
        block_shape: tuple[int, int] = (64, 64),
        data_type: str = "uint8",
    ) -> None:
        """Create source metadata at an arbitrary large shape.

        Args:
            width: Positive source width.
            height: Positive source height.
            block_shape: Native block height and width.
            data_type: Rasterio-compatible band-one datatype name.
        """
        self.width = width
        self.height = height
        self.block_shapes = (block_shape,)
        self.dtypes = (data_type,)

    def block_window(
        self,
        band: int,
        block_row: int,
        block_column: int,
    ) -> Window:
        """Return one clipped metadata-only native block.

        Args:
            band: One-based source band, which must be band one.
            block_row: Zero-based native block row.
            block_column: Zero-based native block column.

        Returns:
            Integral native-block window.
        """
        assert band == 1
        block_height, block_width = self.block_shapes[0]
        row_offset = block_row * block_height
        column_offset = block_column * block_width
        return Window(
            column_offset,
            row_offset,
            min(block_width, self.width - column_offset),
            min(block_height, self.height - row_offset),
        )


def test_exact_reader_reads_each_intersecting_native_block_once() -> None:
    """Assemble an exact window without resampling or repeated block I/O."""
    values = numpy.arange(48, dtype=numpy.float32).reshape((6, 8))
    values[2, 3] = -9999
    dataset = _NativeBlockDataset(
        values,
        block_shape=(3, 4),
        nodata=-9999,
    )
    source_window = Window(2, 1, 4, 3)

    plan = plan_exact_source_window(dataset, source_window)  # type: ignore[arg-type]

    assert plan is not None
    assert plan.block_indexes == ((0, 0), (0, 1), (1, 0), (1, 1))
    result = read_exact_source_window(dataset, plan)  # type: ignore[arg-type]
    assert dataset.read_windows == [
        Window(0, 0, 4, 3),
        Window(4, 0, 4, 3),
        Window(0, 3, 4, 3),
        Window(4, 3, 4, 3),
    ]
    assert result.shape == (3, 4)
    assert result.mask[1, 1]
    assert result.compressed().tolist() == [
        value
        for row in values[1:4, 2:6].tolist()
        for value in row
        if value != -9999
    ]


def test_sample_grid_is_deterministic_and_reads_only_proven_blocks() -> None:
    """Keep 127-longest-edge centers spatially stable and block bounded."""
    values = numpy.arange(600 * 1_000, dtype=numpy.int32).reshape((600, 1_000))
    source_window = Window(100, 100, 800, 400)
    dataset = _NativeBlockDataset(values, block_shape=(32, 32))

    plan = plan_source_window_sample_grid(
        dataset,  # type: ignore[arg-type]
        source_window,
    )
    repeated_plan = plan_source_window_sample_grid(
        dataset,  # type: ignore[arg-type]
        source_window,
    )

    assert plan == repeated_plan
    assert (plan.width, plan.height) == (127, 63)
    assert plan.cell_positions[0] == ((103, 103),)
    assert plan.cell_positions[-1] == ((496, 896),)

    sample = read_source_window_sample_grid(
        dataset,  # type: ignore[arg-type]
        source_window,
    )
    assert len(dataset.read_windows) == len(plan.block_indexes)
    assert len(set(dataset.read_windows)) == len(dataset.read_windows)
    assert sample.shape == (63, 127)
    for cell_index in (0, len(plan.cell_positions) // 2, len(plan.cell_positions) - 1):
        row, column = plan.cell_positions[cell_index][0]
        sample_row, sample_column = divmod(cell_index, plan.width)
        assert sample[sample_row, sample_column] == values[row, column]


def test_sample_grid_prefers_coarsest_suitable_embedded_overview(
    overview_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Admit a four-tile overview even when the native fallback exceeds its budget.

    Args:
        overview_path: Tiled raster with known native values and embedded levels.
        monkeypatch: Set a budget that admits four overview tiles.
    """
    from eolab_app.raster.statistics import read_raster_statistics
    from eolab_app.sampling_area import WholeRasterSamplingArea

    window = Window(96, 96, 800, 400)
    monkeypatch.setattr(sample_grid, "SAMPLE_GRID_MAX_SOURCE_BLOCK_READS", 4)
    with rasterio.open(overview_path) as source:
        with pytest.raises(ValueError, match="source-block limit"):
            plan_source_window_sample_grid(source, window)
        sample = read_source_window_sample_grid(source, window)
        # Factor four produces a 200 by 100 intermediate window. Factor eight
        # is too coarse for this box. The nearest pyramid selects native
        # indices divisible by the factor in this aligned fixture.
        edges_y = numpy.arange(64) * 100 // 63
        edges_x = numpy.arange(128) * 200 // 127
        rows = 96 + 4 * ((edges_y[1:] + edges_y[:-1]) // 2)
        cols = 96 + 4 * ((edges_x[1:] + edges_x[:-1]) // 2)
        numpy.testing.assert_array_equal(sample, rows[:, None] * 1024 + cols)
        with pytest.raises(RasterReadCancelled):
            read_source_window_sample_grid(source, window, lambda: True)

    result = read_raster_statistics(overview_path, WholeRasterSamplingArea())
    centers = numpy.arange(127) * 128 // 127
    centers += numpy.diff(numpy.arange(128) * 128 // 127) // 2
    expected = (centers[:, None] * 1024 + centers) * 8
    assert result.valid_sample_count == 127 ** 2
    assert (result.sample_minimum, result.sample_maximum) == (expected.min(), expected.max())
    counts, _ = numpy.histogram(expected, bins=result.histogram.edges)
    assert result.histogram.counts == counts.tolist()


def test_overview_and_native_fallback_both_exceed_tile_budget(
    overview_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Charge full decoded overview tiles even for a small output array.

    Args:
        overview_path: Source with 128-pixel tiles at the chosen level.
        monkeypatch: Lower the aggregate limit below a single decoded tile.
    """
    monkeypatch.setattr(sample_grid, "SAMPLE_GRID_MAX_DECODED_SOURCE_BYTES", 128 * 128 * 5 - 1)
    with rasterio.open(overview_path) as source, pytest.raises(ValueError, match="decoded source-work"):
        read_source_window_sample_grid(source, Window(0, 0, 1024, 1024))


def test_explicit_positions_are_mapped_through_one_bounded_overview(overview_path: Path) -> None:
    """Read paired positions from the chosen level, including an empty position.

    Args:
        overview_path: Source whose native values encode row and column.
    """
    window = Window(96, 96, 800, 400)
    with rasterio.open(overview_path) as source:
        plan = plan_sample_grid_for_source_positions(source, 2, 2, (
            ((103, 103),), ((300, 300),), (), ((491, 891),),
        ))
        sample = read_planned_sample_grid_from_overview(source, window, plan, None)
    assert sample is not None
    assert sample.mask.tolist() == [[False, False], [True, False]]
    assert sample.compressed().tolist() == [96 * 1024 + 96, 296 * 1024 + 296, 488 * 1024 + 888]


def test_huge_source_grid_is_planned_under_fixed_limits_without_source_reads() -> None:
    """Prove bounded work for huge overview-less metadata before any I/O."""
    dataset = _PlanningDataset(1_000_000_000, 500_000_000)

    plan = plan_source_window_sample_grid(
        dataset,  # type: ignore[arg-type]
        Window(0, 0, dataset.width, dataset.height),
    )

    assert (plan.width, plan.height) == (SAMPLE_GRID_MAX_DIMENSION, 63)
    assert len(plan.cell_positions) == 127 * 63
    assert len(plan.block_indexes) <= SAMPLE_GRID_MAX_SOURCE_BLOCK_READS
    assert plan.decoded_source_bytes <= SAMPLE_GRID_MAX_DECODED_SOURCE_BYTES
    assert plan.points_per_cell == 1


def test_planners_admit_safe_long_strips_by_decoded_work() -> None:
    """Admit the reported 4320-by-1 float32 strips in both bounded modes."""
    dataset = _PlanningDataset(
        4_320,
        2_160,
        block_shape=(1, 4_320),
        data_type="float32",
    )

    exact_plan = plan_exact_source_window(
        dataset,  # type: ignore[arg-type]
        Window(1_000, 700, 512, 512),
    )
    sample_plan = plan_source_window_sample_grid(
        dataset,  # type: ignore[arg-type]
        Window(0, 0, dataset.width, dataset.height),
    )

    assert exact_plan is not None
    assert len(exact_plan.block_indexes) == 512
    assert exact_plan.decoded_source_bytes == 512 * 4_320 * 5
    assert len(sample_plan.block_indexes) == 63
    assert sample_plan.decoded_source_bytes == 63 * 4_320 * 5


def test_planners_reject_one_unsafe_native_block_before_source_reads() -> None:
    """Reject a single excessive decoded allocation from metadata alone."""
    dataset = _PlanningDataset(
        4_096,
        4_096,
        block_shape=(4_096, 4_096),
        data_type="float32",
    )
    decoded_block_bytes = 4_096 * 4_096 * 5
    assert decoded_block_bytes > BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES

    with pytest.raises(
        ValueError,
        match=(
            "each native block to decode to no more than "
            f"{BOUNDED_RASTER_MAX_NATIVE_BLOCK_DECODED_BYTES} bytes"
        ),
    ):
        plan_source_window_sample_grid(
            dataset,  # type: ignore[arg-type]
            Window(0, 0, 100, 100),
        )


def test_over_budget_sample_grid_is_rejected_before_source_reads() -> None:
    """Reject decoded work from metadata alone before any pixel I/O."""
    dataset = _PlanningDataset(
        1_000_000_000,
        500_000_000,
        block_shape=(1024, 1024),
    )
    dataset.dtypes = ("float64",)

    with pytest.raises(ValueError, match="decoded source-work limit"):
        plan_source_window_sample_grid(
            dataset,  # type: ignore[arg-type]
            Window(0, 0, dataset.width, dataset.height),
        )


def test_sample_grid_preserves_nodata_instead_of_inventing_zero() -> None:
    """Keep a nodata center masked even when neighboring values are finite."""
    values = numpy.ones((600, 1_000), dtype=numpy.float32)
    source_window = Window(0, 0, 1_000, 600)
    dataset = _NativeBlockDataset(
        values,
        block_shape=(32, 32),
        nodata=-9999,
    )
    plan = plan_source_window_sample_grid(
        dataset,  # type: ignore[arg-type]
        source_window,
    )
    center_index = len(plan.cell_positions) // 2
    center_row, center_column = plan.cell_positions[center_index][0]
    values[center_row, center_column] = -9999

    sample = read_source_window_sample_grid(
        dataset,  # type: ignore[arg-type]
        source_window,
    )

    sample_row, sample_column = divmod(center_index, plan.width)
    assert sample.mask[sample_row, sample_column]
    assert 0 not in sample.compressed()


def test_sample_grid_stops_between_native_blocks_when_cancelled() -> None:
    """Honor cooperative cancellation before obsolete work reads more blocks."""
    values = numpy.ones((600, 1_000), dtype=numpy.uint8)
    dataset = _NativeBlockDataset(values, block_shape=(32, 32))

    with pytest.raises(RasterReadCancelled):
        read_source_window_sample_grid(
            dataset,  # type: ignore[arg-type]
            Window(0, 0, 1_000, 600),
            lambda: len(dataset.read_windows) >= 1,
        )

    assert len(dataset.read_windows) == 1


def test_planners_reject_unsafe_structure_and_unbounded_exact_windows() -> None:
    """Keep unsafe sources actionable and broad windows outside exact mode."""
    values = numpy.ones((600, 1_000), dtype=numpy.uint8)
    broad = _NativeBlockDataset(values, block_shape=(32, 32))
    assert plan_exact_source_window(  # type: ignore[arg-type]
        broad,
        Window(0, 0, broad.width, broad.height),
    ) is None

    unsupported_type = _NativeBlockDataset(
        values.astype(numpy.uint32),
        block_shape=(32, 32),
    )
    with pytest.raises(ValueError, match="do not support uint32"):
        plan_source_window_sample_grid(  # type: ignore[arg-type]
            unsupported_type,
            Window(0, 0, 100, 100),
        )

    multiple_bands = _NativeBlockDataset(values, block_shape=(32, 32))
    multiple_bands.count = 2
    with pytest.raises(ValueError, match="one non-empty band"):
        plan_source_window_sample_grid(  # type: ignore[arg-type]
            multiple_bands,
            Window(0, 0, 100, 100),
        )

    alpha_validity = _NativeBlockDataset(values, block_shape=(32, 32))
    alpha_validity.mask_flag_enums = ([MaskFlags.per_dataset, MaskFlags.alpha],)
    with pytest.raises(ValueError, match="alpha or unknown"):
        plan_source_window_sample_grid(  # type: ignore[arg-type]
            alpha_validity,
            Window(0, 0, 100, 100),
        )

    with pytest.raises(ValueError, match="outside the source"):
        plan_source_window_sample_grid(  # type: ignore[arg-type]
            broad,
            Window(-1, 0, 100, 100),
        )
