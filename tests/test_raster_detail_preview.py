"""Test sampled-raster detail previews and their authorization lifecycle."""

import asyncio
from pathlib import Path

from affine import Affine
import numpy
import pytest
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import transform as warp_transform

from eolab_app.raster.detail_preview import (
    DETAIL_PREVIEW_MAX_PATCH_CANDIDATES,
    DETAIL_PREVIEW_PATCH_DIMENSION,
    DETAIL_PREVIEW_POLICY_VERSION,
    NoUsefulDetailPatchError,
    _representative_patch,
    read_raster_detail_preview,
)
from eolab_app.raster.detail_preview_service import RasterDetailPreviewService
from eolab_app.raster.detail_proxy import (
    DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES,
    DETAIL_PROXY_MAX_DIMENSION,
    DETAIL_PROXY_MAX_SOURCE_BLOCK_READS,
    BoundedWindowSamples,
    read_detail_proxy,
)
from eolab_app.raster.eligibility import (
    RENDERING_POLICY,
    apply_reader_assessment,
    assess_raster_renderability,
    supports_detail_only_preview,
)
from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import (
    CatalogRasterDetailPreviewRequest,
    GEOSERVER_READER_CONTRACT,
    RasterDetailPreview,
    RasterDetailPreviewMode,
)
from eolab_app.raster.sources import source_signature


ITEM_ID = "geotiff-0123456789abcdef01234567"
RASTER_EXTENT = (-120.0, 30.0, -110.0, 40.0)
SQUARE_EXTENT = (-5.0, -5.0, 5.0, 5.0)
GLOBAL_EXTENT = (-180.0, -90.0, 180.0, 90.0)


def test_reader_and_crs_rejections_take_precedence_over_detail_preview() -> None:
    """Offer an overview-limited raster only after reader compatibility."""
    structural = {
        "policy": RENDERING_POLICY,
        "eligible": False,
        "reason_code": "internal_overviews_required",
        "reason": "Normal visualization needs internal overviews.",
        "bounded_blocks": True,
    }
    accepted = apply_reader_assessment(
        structural,
        reader_contract=GEOSERVER_READER_CONTRACT,
        reader_compatible=True,
        reader_reason_code=None,
    )
    assert supports_detail_only_preview(accepted) is True

    unsafe_blocks = {**accepted, "bounded_blocks": False}
    assert supports_detail_only_preview(unsafe_blocks) is False

    rejected = apply_reader_assessment(
        structural,
        reader_contract=GEOSERVER_READER_CONTRACT,
        reader_compatible=False,
        reader_reason_code="geoserver_crs_metadata_incompatible",
    )
    assert rejected["reason_code"] == "geoserver_crs_metadata_incompatible"
    assert supports_detail_only_preview(rejected) is False


def _write_raster(
    path: Path,
    width: int,
    height: int,
    *,
    crs: str = "EPSG:4326",
    transform: Affine | None = None,
) -> None:
    """Create one sparse, tiled, overview-less float raster.

    Args:
        path: Destination GeoTIFF.
        width: Raster width.
        height: Raster height.
        crs: Source coordinate reference system.
        transform: Optional source affine transform.
    """
    source_transform = transform or from_origin(
        RASTER_EXTENT[0],
        RASTER_EXTENT[3],
        (RASTER_EXTENT[2] - RASTER_EXTENT[0]) / width,
        (RASTER_EXTENT[3] - RASTER_EXTENT[1]) / height,
    )
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype="float32",
        crs=crs,
        transform=source_transform,
        nodata=-9999,
        tiled=True,
        blockxsize=128,
        blockysize=128,
        SPARSE_OK="TRUE",
        BIGTIFF="YES",
    ):
        pass


class _TrackingDataset:
    """Proxy one Rasterio dataset while recording every source read."""

    def __init__(self, dataset: rasterio.io.DatasetReader) -> None:
        """Store an open dataset.

        Args:
            dataset: Real Rasterio dataset delegated by the proxy.
        """
        self.dataset = dataset
        self.reads: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def __enter__(self) -> "_TrackingDataset":
        """Return the proxy for context-manager use.

        Returns:
            This tracking proxy.
        """
        return self

    def __exit__(self, *args: object) -> None:
        """Close the delegated dataset.

        Args:
            *args: Context-manager exception details.
        """
        self.dataset.close()

    def __getattr__(self, name: str) -> object:
        """Delegate dataset metadata.

        Args:
            name: Requested Rasterio attribute.

        Returns:
            Attribute from the real dataset.
        """
        return getattr(self.dataset, name)

    def read(self, *args: object, **kwargs: object) -> numpy.ndarray:
        """Record and delegate one bounded read.

        Args:
            *args: Positional Rasterio read arguments.
            **kwargs: Keyword Rasterio read arguments.

        Returns:
            Rasterio read result.
        """
        self.reads.append((args, dict(kwargs)))
        return self.dataset.read(*args, **kwargs)


@pytest.mark.parametrize("mode", ("centerSample", "representativeSample"))
def test_huge_full_extent_proxy_obeys_exact_source_work_limits(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mode: RasterDetailPreviewMode,
) -> None:
    """Bound a huge raster by native blocks and keep nodata transparent.

    Args:
        tmp_path: Temporary raster directory.
        monkeypatch: Rasterio-open replacement fixture.
        mode: Full-extent proxy sampling policy.
    """
    source_path = tmp_path / "huge.tif"
    _write_raster(
        source_path,
        10_000,
        10_000,
        transform=from_origin(-180, 90, 0.036, 0.018),
    )
    with rasterio.open(source_path) as dataset:
        assessment = assess_raster_renderability(dataset)
    assert assessment["reason_code"] == "internal_overviews_required"

    real_open = rasterio.open
    trackers: list[_TrackingDataset] = []

    def tracked_open(path: Path) -> _TrackingDataset:
        """Open one controlled raster and record its reads.

        Args:
            path: Controlled test path.

        Returns:
            Tracking Rasterio proxy.
        """
        tracker = _TrackingDataset(real_open(path))
        trackers.append(tracker)
        return tracker

    monkeypatch.setattr(
        "eolab_app.raster.detail_preview.rasterio.open",
        tracked_open,
    )
    preview = read_raster_detail_preview(
        source_path,
        mode,
        GLOBAL_EXTENT,
    )

    tracker = trackers[0]
    windows = [read[1]["window"] for read in tracker.reads]
    window_identities = [
        (
            int(window.row_off),
            int(window.col_off),
            int(window.height),
            int(window.width),
        )
        for window in windows
    ]
    decoded_bytes = sum(
        int(window.width)
        * int(window.height)
        * (numpy.dtype("float32").itemsize + 1)
        for window in windows
    )
    assert 1 < len(windows) <= DETAIL_PROXY_MAX_SOURCE_BLOCK_READS
    assert len(window_identities) == len(set(window_identities))
    assert len(windows) == preview.actual.source_block_read_count
    assert decoded_bytes <= DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES
    assert decoded_bytes == preview.actual.decoded_source_bytes
    assert all("out_shape" not in keyword_args for _, keyword_args in tracker.reads)
    assert all(window.width <= 128 and window.height <= 128 for window in windows)
    assert preview.policy_version == DETAIL_PREVIEW_POLICY_VERSION
    assert preview.raster_extent == GLOBAL_EXTENT
    assert preview.image_bounds[0] == pytest.approx(-180)
    assert preview.image_bounds[2] == pytest.approx(180)
    assert preview.image_width <= DETAIL_PROXY_MAX_DIMENSION
    assert preview.image_height <= DETAIL_PROXY_MAX_DIMENSION
    assert len(preview.pixel_values) == preview.image_width * preview.image_height
    assert set(preview.pixel_values) == {None}
    assert preview.suggested_range is None
    assert (
        preview.limits.maximum_decoded_source_bytes
        == DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES
    )


def test_expensive_native_blocks_force_deterministic_proxy_coarsening(
    tmp_path: Path,
) -> None:
    """Reduce the proxy until even float64 1024-pixel blocks fit 64 MiB.

    Args:
        tmp_path: Temporary raster directory.
    """
    source_path = tmp_path / "expensive-blocks.tif"
    with rasterio.open(
        source_path,
        "w",
        driver="GTiff",
        width=10_000,
        height=10_000,
        count=1,
        dtype="float64",
        crs="EPSG:4326",
        transform=from_origin(-180, 90, 0.036, 0.018),
        nodata=-9999,
        tiled=True,
        blockxsize=1024,
        blockysize=1024,
        SPARSE_OK="TRUE",
        BIGTIFF="YES",
    ):
        pass

    with rasterio.open(source_path) as dataset:
        first, first_plan = read_detail_proxy(dataset, "centerSample")
    with rasterio.open(source_path) as dataset:
        second, second_plan = read_detail_proxy(dataset, "centerSample")

    assert first_plan == second_plan
    assert (first_plan.height, first_plan.width) == (1, 1)
    assert len(first_plan.block_indexes) == 1
    assert (
        first_plan.decoded_source_bytes
        == 1024 * 1024 * (numpy.dtype("float64").itemsize + 1)
    )
    assert first_plan.decoded_source_bytes < DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES
    assert first.mask.item() is True
    assert second.mask.item() is True


def test_center_proxy_is_a_full_extent_multicell_numeric_raster(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Map every proxy cell to the center of its owned source subwindow.

    Args:
        tmp_path: Temporary raster directory.
        monkeypatch: Fixed three-by-three proxy-grid fixture.
    """
    source_path = tmp_path / "center-grid.tif"
    transform = from_origin(-5, 5, 10 / 9, 10 / 9)
    _write_raster(source_path, 9, 9, transform=transform)
    values = numpy.fromfunction(
        lambda row, column: row * 10 + column,
        (9, 9),
        dtype=numpy.float32,
    ).astype(numpy.float32)
    with rasterio.open(source_path, "r+") as dataset:
        dataset.write(values, 1)

    monkeypatch.setattr(
        "eolab_app.raster.detail_proxy.DETAIL_PROXY_MAX_DIMENSION",
        3,
    )
    with rasterio.open(source_path) as dataset:
        proxy, plan = read_detail_proxy(dataset, "centerSample")

    assert (plan.height, plan.width) == (3, 3)
    assert plan.cell_positions == (
        ((1, 1),),
        ((1, 4),),
        ((1, 7),),
        ((4, 1),),
        ((4, 4),),
        ((4, 7),),
        ((7, 1),),
        ((7, 4),),
        ((7, 7),),
    )
    assert proxy.tolist() == [
        [11.0, 14.0, 17.0],
        [41.0, 44.0, 47.0],
        [71.0, 74.0, 77.0],
    ]

    preview = read_raster_detail_preview(
        source_path,
        "centerSample",
        SQUARE_EXTENT,
    )
    assert (preview.image_height, preview.image_width) == (3, 3)
    assert preview.pixel_values == [
        11.0,
        14.0,
        17.0,
        41.0,
        44.0,
        47.0,
        71.0,
        74.0,
        77.0,
    ]
    assert preview.image_bounds == pytest.approx(SQUARE_EXTENT)
    assert preview.raster_extent == SQUARE_EXTENT
    assert preview.suggested_range is not None


def test_representative_proxy_deduplicates_points_and_uses_lower_median(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Choose an observed deterministic value without duplicate probes.

    Args:
        tmp_path: Temporary raster directory.
        monkeypatch: One-cell proxy-grid fixture.
    """
    source_path = tmp_path / "representative-grid.tif"
    _write_raster(source_path, 2, 2)
    with rasterio.open(source_path, "r+") as dataset:
        dataset.write(
            numpy.array([[10, -9999], [30, 40]], dtype=numpy.float32),
            1,
        )

    monkeypatch.setattr(
        "eolab_app.raster.detail_proxy.DETAIL_PROXY_MAX_DIMENSION",
        1,
    )
    with rasterio.open(source_path) as dataset:
        first, first_plan = read_detail_proxy(dataset, "representativeSample")
    with rasterio.open(source_path) as dataset:
        second, second_plan = read_detail_proxy(dataset, "representativeSample")

    assert first_plan == second_plan
    assert first_plan.cell_positions == (
        ((1, 1), (0, 0), (0, 1), (1, 0)),
    )
    assert len(set(first_plan.cell_positions[0])) == 4
    assert first.item() == second.item() == 30.0

    with rasterio.open(source_path, "r+") as dataset:
        dataset.write(numpy.full((2, 2), -9999, dtype=numpy.float32), 1)
    with rasterio.open(source_path) as dataset:
        nodata, _ = read_detail_proxy(dataset, "representativeSample")
    assert nodata.mask.item() is True


def test_representative_patch_returns_deterministic_bounded_numeric_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Rank fixed candidates and reuse one bounded window as numeric pixels.

    Args:
        tmp_path: Temporary raster directory.
        monkeypatch: Rasterio-open replacement fixture.
    """
    source_path = tmp_path / "patch.tif"
    _write_raster(source_path, 512, 512)
    values = numpy.arange(
        DETAIL_PREVIEW_PATCH_DIMENSION**2,
        dtype=numpy.float32,
    ).reshape(
        DETAIL_PREVIEW_PATCH_DIMENSION,
        DETAIL_PREVIEW_PATCH_DIMENSION,
    )
    with rasterio.open(source_path, "r+") as dataset:
        dataset.write(
            values,
            1,
            window=rasterio.windows.Window(
                192,
                192,
                DETAIL_PREVIEW_PATCH_DIMENSION,
                DETAIL_PREVIEW_PATCH_DIMENSION,
            ),
        )

    real_open = rasterio.open
    trackers: list[_TrackingDataset] = []

    def tracked_open(path: Path) -> _TrackingDataset:
        """Open one patch-selection run and record its reads.

        Args:
            path: Controlled test path.

        Returns:
            Tracking Rasterio proxy.
        """
        tracker = _TrackingDataset(real_open(path))
        trackers.append(tracker)
        return tracker

    monkeypatch.setattr(
        "eolab_app.raster.detail_preview.rasterio.open",
        tracked_open,
    )
    first = read_raster_detail_preview(
        source_path,
        "representativePatch",
        RASTER_EXTENT,
    )
    second = read_raster_detail_preview(
        source_path,
        "representativePatch",
        RASTER_EXTENT,
    )

    assert first.image_bounds == second.image_bounds
    assert first.pixel_values == second.pixel_values
    assert first.image_width <= DETAIL_PREVIEW_PATCH_DIMENSION
    assert first.image_height <= DETAIL_PREVIEW_PATCH_DIMENSION
    assert len(first.pixel_values) == first.image_width * first.image_height
    assert any(value is not None for value in first.pixel_values)
    assert first.suggested_range is not None
    assert first.suggested_range.minimum < first.suggested_range.midpoint
    assert first.suggested_range.midpoint < first.suggested_range.maximum
    assert RASTER_EXTENT[0] < first.image_bounds[0] < first.image_bounds[2]
    assert first.image_bounds[2] < RASTER_EXTENT[2]
    assert RASTER_EXTENT[1] < first.image_bounds[1] < first.image_bounds[3]
    assert first.image_bounds[3] < RASTER_EXTENT[3]
    assert (
        1 <= first.actual.candidate_window_count
        <= DETAIL_PREVIEW_MAX_PATCH_CANDIDATES
    )
    for tracker in trackers:
        assert len(tracker.reads) == first.actual.source_block_read_count
        assert len(tracker.reads) <= DETAIL_PROXY_MAX_SOURCE_BLOCK_READS
        window_identities = [
            (
                int(keyword_args["window"].row_off),
                int(keyword_args["window"].col_off),
                int(keyword_args["window"].height),
                int(keyword_args["window"].width),
            )
            for _, keyword_args in tracker.reads
        ]
        assert len(window_identities) == len(set(window_identities))
        assert first.actual.decoded_source_bytes == sum(
            identity[2]
            * identity[3]
            * (numpy.dtype("float32").itemsize + 1)
            for identity in window_identities
        )
        assert (
            first.actual.decoded_source_bytes
            <= DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES
        )
        assert all(
            "out_shape" not in keyword_args
            for _, keyword_args in tracker.reads
        )


def test_huge_representative_patch_reads_only_bounded_native_blocks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Select a local patch from a huge overview-less sparse raster.

    Args:
        tmp_path: Temporary raster directory.
        monkeypatch: Rasterio-open replacement fixture.
    """
    source_path = tmp_path / "huge-patch.tif"
    _write_raster(source_path, 10_000, 10_000)
    with rasterio.open(source_path, "r+") as dataset:
        dataset.write(
            numpy.arange(128 * 128, dtype=numpy.float32).reshape(128, 128),
            1,
            window=rasterio.windows.Window(4936, 4936, 128, 128),
        )

    real_open = rasterio.open
    trackers: list[_TrackingDataset] = []

    def tracked_open(path: Path) -> _TrackingDataset:
        """Open the huge controlled raster while recording bounded reads.

        Args:
            path: Controlled test path.

        Returns:
            Tracking Rasterio proxy.
        """
        tracker = _TrackingDataset(real_open(path))
        trackers.append(tracker)
        return tracker

    monkeypatch.setattr(
        "eolab_app.raster.detail_preview.rasterio.open",
        tracked_open,
    )
    preview = read_raster_detail_preview(
        source_path,
        "representativePatch",
        RASTER_EXTENT,
    )

    tracker = trackers[0]
    assert preview.mode == "representativePatch"
    assert preview.image_width == preview.actual.sample_grid_width == 128
    assert preview.image_height == preview.actual.sample_grid_height == 128
    assert preview.image_bounds != RASTER_EXTENT
    assert 1 <= len(tracker.reads) <= DETAIL_PROXY_MAX_SOURCE_BLOCK_READS
    assert all(
        "out_shape" not in keyword_args
        for _, keyword_args in tracker.reads
    )
    assert preview.actual.decoded_source_bytes <= (
        DETAIL_PROXY_MAX_DECODED_SOURCE_BYTES
    )


def test_representative_patch_ranking_uses_coverage_variability_then_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Enforce every documented deterministic patch-ranking dimension.

    Args:
        monkeypatch: Bounded candidate-reader replacement fixture.
    """
    class CandidateDataset:
        """Expose only dimensions owned by candidate generation."""

        width = 512
        height = 512

    windows = (
        rasterio.windows.Window(0, 0, 2, 2),
        rasterio.windows.Window(10, 0, 2, 2),
    )

    def choose(
        first: numpy.ma.MaskedArray,
        second: numpy.ma.MaskedArray,
    ) -> rasterio.windows.Window:
        """Run ranking over two controlled already-bounded candidates.

        Args:
            first: Earlier row-major candidate values.
            second: Later row-major candidate values.

        Returns:
            Window selected by the representative-patch policy.
        """
        bounded = BoundedWindowSamples(
            samples=((windows[0], first), (windows[1], second)),
            block_indexes=((0, 0),),
            decoded_source_bytes=20,
        )
        monkeypatch.setattr(
            "eolab_app.raster.detail_preview.read_bounded_candidate_windows",
            lambda _dataset, _windows: bounded,
        )
        selected, _, _ = _representative_patch(CandidateDataset())
        return selected

    half_valid = numpy.ma.array(
        [[1.0, 2.0], [3.0, 4.0]],
        mask=[[False, False], [True, True]],
    )
    three_quarters_valid = numpy.ma.array(
        [[1.0, 2.0], [3.0, 4.0]],
        mask=[[False, False], [False, True]],
    )
    assert choose(half_valid, three_quarters_valid) == windows[1]

    constant = numpy.ma.array([[5.0, 5.0], [5.0, 5.0]])
    variable = numpy.ma.array([[0.0, 0.0], [10.0, 10.0]])
    assert choose(constant, variable) == windows[1]
    assert choose(variable, variable.copy()) == windows[0]


def test_preview_rejects_unsigned_external_gdal_sidecars(tmp_path: Path) -> None:
    """Keep mask/georeferencing dependencies inside source authorization.

    Args:
        tmp_path: Temporary raster directory.
    """
    source_path = tmp_path / "external-mask.tif"
    _write_raster(source_path, 256, 256)
    with rasterio.Env(GDAL_TIFF_INTERNAL_MASK="NO"):
        with rasterio.open(source_path, "r+") as dataset:
            dataset.write(
                numpy.ones((256, 256), dtype=numpy.float32),
                1,
            )
            dataset.write_mask(numpy.full((256, 256), 255, dtype=numpy.uint8))
    assert source_path.with_suffix(".tif.msk").is_file()

    with pytest.raises(ValueError, match="external GDAL sidecars"):
        read_raster_detail_preview(
            source_path,
            "centerSample",
            RASTER_EXTENT,
        )


def test_representative_patch_reports_bounded_nodata_search(
    tmp_path: Path,
) -> None:
    """Report when the fixed candidate set contains no useful pixels.

    Args:
        tmp_path: Temporary raster directory.
    """
    source_path = tmp_path / "nodata-patch.tif"
    _write_raster(source_path, 512, 512)

    with pytest.raises(NoUsefulDetailPatchError):
        read_raster_detail_preview(
            source_path,
            "representativePatch",
            RASTER_EXTENT,
        )


def test_rotated_non_wgs84_proxy_retains_geographic_image_placement(
    tmp_path: Path,
) -> None:
    """Warp a rotated projected proxy without reading a full source extent.

    Args:
        tmp_path: Temporary raster directory.
    """
    source_path = tmp_path / "rotated-mercator.tif"
    source_transform = (
        Affine.translation(-1_000_000, 1_000_000)
        * Affine.rotation(15)
        * Affine.scale(2_000, -2_000)
    )
    _write_raster(
        source_path,
        20,
        10,
        crs="EPSG:3857",
        transform=source_transform,
    )
    with rasterio.open(source_path, "r+") as dataset:
        dataset.write(numpy.full((10, 20), 7, dtype=numpy.float32), 1)

    source_corners = [
        source_transform * position
        for position in ((0, 0), (20, 0), (20, 10), (0, 10))
    ]
    longitudes, latitudes = warp_transform(
        "EPSG:3857",
        "EPSG:4326",
        [position[0] for position in source_corners],
        [position[1] for position in source_corners],
    )
    expected_bounds = (
        min(longitudes),
        min(latitudes),
        max(longitudes),
        max(latitudes),
    )
    preview = read_raster_detail_preview(
        source_path,
        "centerSample",
        expected_bounds,
    )

    assert preview.image_bounds == pytest.approx(expected_bounds, abs=1e-7)
    assert preview.raster_extent == pytest.approx(expected_bounds)
    assert any(value == 7.0 for value in preview.pixel_values)
    assert any(value is None for value in preview.pixel_values)
    assert preview.image_width <= DETAIL_PROXY_MAX_DIMENSION
    assert preview.image_height <= DETAIL_PROXY_MAX_DIMENSION


class _Catalog:
    """Return one mutable authoritative detail-preview Item."""

    def __init__(self, item: dict[str, object]) -> None:
        """Store the controlled Item.

        Args:
            item: Authoritative Item returned by reads.
        """
        self.item = item

    async def get_item(self, _: object) -> dict[str, object]:
        """Return the controlled Item.

        Args:
            _: Unused validated request.

        Returns:
            Controlled Item.
        """
        return self.item


class _Resolver:
    """Resolve every controlled Item to one source path."""

    def __init__(self, path: Path) -> None:
        """Store the source.

        Args:
            path: Controlled mounted source.
        """
        self.path = path

    def resolve(self, _: object) -> Path:
        """Return the source.

        Args:
            _: Unused authoritative Item.

        Returns:
            Controlled source path.
        """
        return self.path


def _detail_item(
    signature: tuple[int, int, int, int, int],
) -> tuple[dict[str, object], dict[str, object]]:
    """Build one mutable overview-rejected catalog Item.

    Args:
        signature: Assessed source signature.

    Returns:
        Catalog Item and its mutable rendering metadata mapping.
    """
    rendering: dict[str, object] = {
        "policy": RENDERING_POLICY,
        "eligible": False,
        "reason_code": "internal_overviews_required",
        "reason": "Normal visualization needs internal overviews.",
        "reader_contract": GEOSERVER_READER_CONTRACT,
        "reader_compatible": True,
        "bounded_blocks": True,
        "source_signature": list(signature),
    }
    return (
        {
            "id": ITEM_ID,
            "collection": "eolab-mounted-geotiffs",
            "bbox": list(RASTER_EXTENT),
            "assets": {"data": {"eolab:rendering": rendering}},
        },
        rendering,
    )


def test_service_coalesces_by_source_mode_parameters_and_rejects_unsafe_reason(
    tmp_path: Path,
) -> None:
    """Cache applicable modes while preserving non-overview failures.

    Args:
        tmp_path: Temporary source directory.
    """
    source_path = tmp_path / "source.tif"
    source_path.write_bytes(b"source")
    signature = source_signature(source_path)
    item, rendering = _detail_item(signature)
    read_modes: list[RasterDetailPreviewMode] = []
    tiny_raster = tmp_path / "tiny.tif"
    _write_raster(tiny_raster, 2, 2)

    def reader(
        _: Path,
        mode: RasterDetailPreviewMode,
        extent: tuple[float, float, float, float],
    ) -> RasterDetailPreview:
        """Return a controlled valid numeric preview.

        Args:
            _: Unused path.
            mode: Requested preview mode.
            extent: Requested raster extent.

        Returns:
            Valid preview model produced by the real bounded reader fixture.
        """
        read_modes.append(mode)
        return read_raster_detail_preview(tiny_raster, mode, extent)

    service = RasterDetailPreviewService(
        _Catalog(item),
        _Resolver(source_path),
        read_concurrency=1,
        cache_entries=4,
        preview_reader=reader,
    )
    center_request = CatalogRasterDetailPreviewRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
        "mode": "centerSample",
    })
    representative_request = CatalogRasterDetailPreviewRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
        "mode": "representativeSample",
    })

    async def exercise() -> None:
        """Exercise coalescing, mode identity, and rejection precedence."""
        first, second = await asyncio.gather(
            service.get(center_request),
            service.get(center_request),
        )
        assert first is second
        await service.get(representative_request)
        item["bbox"] = [-119.0, 31.0, -109.0, 41.0]
        await service.get(center_request)
        item["bbox"] = [-181.0, 31.0, -109.0, 41.0]
        with pytest.raises(RasterConflictError, match="extent is invalid"):
            await service.get(center_request)
        item["bbox"] = list(RASTER_EXTENT)
        rendering["bounded_blocks"] = False
        with pytest.raises(RasterConflictError, match="bounded source blocks"):
            await service.get(center_request)
        rendering["bounded_blocks"] = True
        rendering["reason_code"] = "blocks_too_large"
        rendering["reason"] = "Visualization unavailable: unsafe blocks."
        with pytest.raises(RasterConflictError, match="unsafe blocks"):
            await service.get(center_request)

    asyncio.run(exercise())
    assert read_modes == [
        "centerSample",
        "representativeSample",
        "centerSample",
    ]


def test_service_rechecks_source_signature_after_bounded_read(
    tmp_path: Path,
) -> None:
    """Never return or cache preview work completed from a changed source.

    Args:
        tmp_path: Temporary source directory.
    """
    source_path = tmp_path / "source.tif"
    source_path.write_bytes(b"source")
    approved_signature = (1, 2, 3, 4, 5)
    changed_signature = (1, 2, 3, 4, 6)
    item, _ = _detail_item(approved_signature)
    tiny_raster = tmp_path / "tiny.tif"
    _write_raster(tiny_raster, 2, 2)
    signature_reads = 0

    def changing_signature(_: Path) -> tuple[int, int, int, int, int]:
        """Change identity only after authorization and the pre-read check.

        Args:
            _: Unused controlled path.

        Returns:
            Approved identity twice, then the changed identity.
        """
        nonlocal signature_reads
        signature_reads += 1
        return approved_signature if signature_reads < 3 else changed_signature

    service = RasterDetailPreviewService(
        _Catalog(item),
        _Resolver(source_path),
        read_concurrency=1,
        cache_entries=4,
        preview_reader=lambda _path, mode, extent: read_raster_detail_preview(
            tiny_raster,
            mode,
            extent,
        ),
        signature_reader=changing_signature,
    )
    request = CatalogRasterDetailPreviewRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
        "mode": "centerSample",
    })

    with pytest.raises(RasterConflictError, match="changed while"):
        asyncio.run(service.get(request))
