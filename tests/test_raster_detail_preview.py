"""Test bounded detail-preview algorithms and authorization lifecycle."""

import asyncio
from pathlib import Path

import numpy
import pytest
import rasterio
from rasterio.transform import from_origin

from eolab_app.raster.detail_preview import (
    DETAIL_PREVIEW_MAX_GRID_SAMPLES,
    DETAIL_PREVIEW_MAX_PATCH_CANDIDATES,
    DETAIL_PREVIEW_PATCH_DIMENSION,
    NoUsefulDetailPatchError,
    read_raster_detail_preview,
)
from eolab_app.raster.detail_preview_service import RasterDetailPreviewService
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
)
from eolab_app.raster.sources import source_signature


ITEM_ID = "geotiff-0123456789abcdef01234567"
RASTER_EXTENT = (-120.0, 30.0, -110.0, 40.0)


def test_reader_and_crs_rejections_take_precedence_over_detail_preview() -> None:
    """Offer an overview-limited raster only after reader compatibility."""
    structural = {
        "policy": RENDERING_POLICY,
        "eligible": False,
        "reason_code": "internal_overviews_required",
        "reason": "Normal visualization needs internal overviews.",
    }
    accepted = apply_reader_assessment(
        structural,
        reader_contract=GEOSERVER_READER_CONTRACT,
        reader_compatible=True,
        reader_reason_code=None,
    )
    assert supports_detail_only_preview(accepted) is True

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
) -> None:
    """Create one sparse, tiled, overview-less test raster.

    Args:
        path: Destination GeoTIFF.
        width: Raster width.
        height: Raster height.
    """
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(-120, 40, 10 / width, 10 / height),
        nodata=-9999,
        tiled=True,
        blockxsize=128,
        blockysize=128,
        SPARSE_OK="TRUE",
        BIGTIFF="YES",
    ):
        pass


class _TrackingDataset:
    """Proxy one Rasterio dataset while recording every pixel read."""

    def __init__(self, dataset: rasterio.io.DatasetReader) -> None:
        """Store an open dataset.

        Args:
            dataset: Real Rasterio dataset delegated by the proxy.
        """
        self.dataset = dataset
        self.windows = []

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
        self.windows.append(kwargs.get("window"))
        return self.dataset.read(*args, **kwargs)


def test_huge_no_overview_center_reports_nodata_with_one_pixel_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep a huge rejected raster bounded and never turn nodata into zero.

    Args:
        tmp_path: Temporary raster directory.
        monkeypatch: Rasterio-open replacement fixture.
    """
    source_path = tmp_path / "huge.tif"
    _write_raster(source_path, 10_000, 10_000)
    with rasterio.open(source_path) as dataset:
        assessment = assess_raster_renderability(dataset)
    assert assessment["reason_code"] == "internal_overviews_required"

    real_open = rasterio.open
    trackers = []

    def tracked_open(path: Path) -> _TrackingDataset:
        """Open and record one dataset.

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
        "centerPixel",
        RASTER_EXTENT,
    )

    assert preview.samples[0].value is None
    assert preview.samples[0].row == 5000
    assert preview.samples[0].column == 5000
    assert len(trackers[0].windows) == 1
    center_window = trackers[0].windows[0]
    assert (
        center_window.col_off,
        center_window.row_off,
        center_window.width,
        center_window.height,
    ) == (5000, 5000, 1, 1)


def test_sampling_grid_has_fixed_maximum_and_georeferenced_placement(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Read deterministic one-pixel grid cells without a full-raster read.

    Args:
        tmp_path: Temporary raster directory.
        monkeypatch: Rasterio-open replacement fixture.
    """
    source_path = tmp_path / "grid.tif"
    _write_raster(source_path, 517, 389)
    real_open = rasterio.open
    tracker = _TrackingDataset(real_open(source_path))
    monkeypatch.setattr(
        "eolab_app.raster.detail_preview.rasterio.open",
        lambda _: tracker,
    )

    preview = read_raster_detail_preview(
        source_path,
        "samplingGrid",
        RASTER_EXTENT,
    )

    assert len(preview.samples) == DETAIL_PREVIEW_MAX_GRID_SAMPLES
    assert [(sample.row, sample.column) for sample in preview.samples[:5]] == [
        (0, 0),
        (0, 129),
        (0, 258),
        (0, 387),
        (0, 516),
    ]
    assert len(tracker.windows) == DETAIL_PREVIEW_MAX_GRID_SAMPLES
    assert all(window.width == window.height == 1 for window in tracker.windows)
    assert preview.samples[0].longitude < preview.samples[-1].longitude
    assert preview.samples[0].latitude > preview.samples[-1].latitude


def test_representative_patch_is_deterministic_and_strictly_bounded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Rank fixed candidates and reuse the selected bounded window for PNG.

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
    trackers = []

    def tracked_open(path: Path) -> _TrackingDataset:
        """Open and record one patch selection.

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

    assert first.detail_bounds == second.detail_bounds
    assert first.image_data_url == second.image_data_url
    assert first.image_data_url.startswith("data:image/png;base64,iVBOR")
    for tracker in trackers:
        assert len(tracker.windows) <= DETAIL_PREVIEW_MAX_PATCH_CANDIDATES
        assert all(
            window.width <= DETAIL_PREVIEW_PATCH_DIMENSION
            and window.height <= DETAIL_PREVIEW_PATCH_DIMENSION
            for window in tracker.windows
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
    rendering = {
        "policy": RENDERING_POLICY,
        "eligible": False,
        "reason_code": "internal_overviews_required",
        "reason": "Normal visualization needs internal overviews.",
        "reader_contract": GEOSERVER_READER_CONTRACT,
        "reader_compatible": True,
        "source_signature": list(signature),
    }
    item = {
        "id": ITEM_ID,
        "collection": "eolab-mounted-geotiffs",
        "bbox": list(RASTER_EXTENT),
        "assets": {"data": {"eolab:rendering": rendering}},
    }
    read_modes = []

    def reader(
        _: Path,
        mode: str,
        extent: tuple[float, float, float, float],
    ) -> object:
        """Return a controlled valid point preview.

        Args:
            _: Unused path.
            mode: Requested preview mode.
            extent: Requested raster extent.

        Returns:
            Valid preview model produced by the real bounded reader fixture.
        """
        read_modes.append(mode)
        test_raster = tmp_path / "tiny.tif"
        if not test_raster.exists():
            _write_raster(test_raster, 2, 2)
        return read_raster_detail_preview(test_raster, mode, extent)

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
        "mode": "centerPixel",
    })
    grid_request = CatalogRasterDetailPreviewRequest.model_validate({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
        "mode": "samplingGrid",
    })

    async def exercise() -> None:
        """Exercise coalescing, mode identity, and rejection precedence."""
        first, second = await asyncio.gather(
            service.get(center_request),
            service.get(center_request),
        )
        assert first is second
        await service.get(grid_request)
        item["bbox"] = [-119.0, 31.0, -109.0, 41.0]
        await service.get(center_request)
        rendering["reason_code"] = "blocks_too_large"
        rendering["reason"] = "Visualization unavailable: unsafe blocks."
        with pytest.raises(RasterConflictError, match="unsafe blocks"):
            await service.get(center_request)

    asyncio.run(exercise())
    assert read_modes == ["centerPixel", "samplingGrid", "centerPixel"]


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
    item = {
        "id": ITEM_ID,
        "collection": "eolab-mounted-geotiffs",
        "bbox": list(RASTER_EXTENT),
        "assets": {
            "data": {
                "eolab:rendering": {
                    "policy": RENDERING_POLICY,
                    "eligible": False,
                    "reason_code": "internal_overviews_required",
                    "reason": "Normal visualization needs internal overviews.",
                    "reader_contract": GEOSERVER_READER_CONTRACT,
                    "reader_compatible": True,
                    "source_signature": list(approved_signature),
                }
            }
        },
    }
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
        "mode": "centerPixel",
    })

    with pytest.raises(RasterConflictError, match="changed while"):
        asyncio.run(service.get(request))
