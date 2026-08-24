"""Regression tests for the fixed overview-limited raster preview policy."""

import asyncio
from pathlib import Path
import threading

import numpy
import pytest
import rasterio
from rasterio.transform import from_origin

import eolab_app.raster.sample_grid as sample_grid_module
from eolab_app.raster.detail_preview import (
    DETAIL_PREVIEW_POLICY_VERSION,
    _projected_sampling_bounds,
    read_raster_detail_preview,
)
from eolab_app.raster.detail_preview_service import RasterDetailPreviewService
from eolab_app.raster.sample_grid import (
    SAMPLE_GRID_MAX_DIMENSION,
    SAMPLE_GRID_MAX_SOURCE_BLOCK_READS,
    SAMPLE_GRID_MAX_TRANSFORMED_POSITIONS,
    plan_sample_grid,
    read_sample_grid,
)
from eolab_app.raster.eligibility import (
    RENDERING_METADATA_KEY,
    RENDERING_POLICY,
    apply_reader_assessment,
    supports_detail_only_preview,
)
from eolab_app.raster.models import (
    CatalogRasterDetailPreviewRequest,
    GEOSERVER_READER_CONTRACT,
    RasterDetailPreview,
)
from eolab_app.raster.read_cancellation import RasterReadCancelled
from eolab_app.raster.sources import source_signature


ITEM_ID = "geotiff-0123456789abcdef01234567"
RASTER_EXTENT = (-120.0, 30.0, -110.0, 40.0)


def _write_raster(
    path: Path,
    values: numpy.ndarray,
    *,
    nodata: float | int | None = None,
) -> None:
    """Write one internally tiled WGS 84 test GeoTIFF.

    Args:
        path: Destination test path.
        values: Two-dimensional band-one values.
        nodata: Optional band nodata marker.

    Returns:
        None after closing the dataset.
    """
    height, width = values.shape
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        dtype=values.dtype,
        crs="EPSG:4326",
        transform=from_origin(-120, 40, 10 / width, 10 / height),
        tiled=True,
        blockxsize=16,
        blockysize=16,
        nodata=nodata,
    ) as dataset:
        dataset.write(values, 1)


def _preview_document(
    *,
    scope: str = "rasterExtent",
    rendering: str = "sampleGrid",
) -> RasterDetailPreview:
    """Build one valid fixed-policy response for service-boundary tests.

    Args:
        scope: Raster extent or current-view provenance.
        rendering: Sample grid or exact source-window representation.

    Returns:
        Validated immutable preview response.
    """
    if rendering == "exactSourceWindow":
        width, height = 4, 3
        limits = {
            "maximumSampleGridDimension": 127,
            "maximumExactDetailDimension": 512,
            "maximumSourceBlockReads": 1_024,
            "maximumDecodedSourceBytes": 67_108_864,
            "maximumTransformedPositions": 16_129,
            "maximumPointsPerCell": 1,
        }
        actual = {
            "sampleGridWidth": width,
            "sampleGridHeight": height,
            "sourceBlockReadCount": 1,
            "decodedSourceBytes": 1_280,
            "pointsPerCell": 0,
            "sourceWindow": {
                "columnOffset": 2,
                "rowOffset": 3,
                "width": width,
                "height": height,
            },
        }
    else:
        width, height = 127, 64
        limits = {
            "maximumSampleGridDimension": 127,
            "maximumExactDetailDimension": 512,
            "maximumSourceBlockReads": 16_129,
            "maximumDecodedSourceBytes": 9_663_676_416,
            "maximumTransformedPositions": 16_129,
            "maximumPointsPerCell": 1,
        }
        actual = {
            "sampleGridWidth": width,
            "sampleGridHeight": height,
            "sourceBlockReadCount": 8,
            "decodedSourceBytes": 10_240,
            "pointsPerCell": 1,
        }
    return RasterDetailPreview.model_validate({
        "scope": scope,
        "rendering": rendering,
        "policyVersion": DETAIL_PREVIEW_POLICY_VERSION,
        "approximate": True,
        "label": "Fixed center-sampled detail-only preview",
        "rasterExtent": RASTER_EXTENT,
        "imageBounds": RASTER_EXTENT,
        "imageWidth": width,
        "imageHeight": height,
        "pixelValues": [1.0] * (width * height),
        "suggestedRange": {"minimum": 0.0, "midpoint": 1.0, "maximum": 2.0},
        "limits": limits,
        "actual": actual,
    })


def test_reader_and_crs_rejections_take_precedence_over_detail_preview() -> None:
    """Offer detail preview only for a reader-approved overview rejection."""
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
    assert supports_detail_only_preview({**accepted, "bounded_blocks": False}) is False

    rejected = apply_reader_assessment(
        structural,
        reader_contract=GEOSERVER_READER_CONTRACT,
        reader_compatible=False,
        reader_reason_code="geoserver_crs_metadata_incompatible",
    )
    assert rejected["reason_code"] == "geoserver_crs_metadata_incompatible"
    assert supports_detail_only_preview(rejected) is False


def test_request_contract_owns_the_fixed_policy() -> None:
    """Accept only identity and an optional canonical current-view rectangle."""
    identity = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": ITEM_ID,
    }
    assert CatalogRasterDetailPreviewRequest.model_validate(identity).view_bounds is None
    request = CatalogRasterDetailPreviewRequest.model_validate({
        **identity,
        "viewBounds": {"west": -119, "south": 31, "east": -111, "north": 39},
    })
    assert request.view_bounds is not None
    for extra in (
        {"mode": "centerSample"},
        {"density": "fine"},
        {"width": 127},
        {"sourcePath": "C:/untrusted.tif"},
    ):
        with pytest.raises(ValueError):
            CatalogRasterDetailPreviewRequest.model_validate({**identity, **extra})


def test_response_requires_127_longest_edge_and_one_center_probe() -> None:
    """Publish the fixed grid and transformed-coordinate ceilings."""
    preview = _preview_document()
    assert max(preview.image_width, preview.image_height) == 127
    assert preview.actual.points_per_cell == 1
    assert preview.limits.maximum_transformed_positions == 127 * 127
    serialized = preview.model_dump(by_alias=True, exclude_none=True)
    assert "mode" not in serialized
    assert "density" not in serialized
    assert "maximumPatchDimension" not in serialized["limits"]

    invalid = serialized | {"imageWidth": 126}
    invalid["pixelValues"] = [1.0] * (126 * preview.image_height)
    invalid["actual"] = serialized["actual"] | {"sampleGridWidth": 126}
    with pytest.raises(ValueError, match="longest edge"):
        RasterDetailPreview.model_validate(invalid)


def test_fixed_grid_preserves_projected_aspect_ratio(tmp_path: Path) -> None:
    """Use 127 on the longest map edge and preserve the shorter-map ratio."""
    source_path = tmp_path / "aspect.tif"
    _write_raster(source_path, numpy.ones((128, 256), dtype=numpy.uint16))
    projected_bounds, _ = _projected_sampling_bounds(RASTER_EXTENT)
    with rasterio.open(source_path) as dataset:
        plan = plan_sample_grid(dataset, projected_bounds)
    assert max(plan.width, plan.height) == SAMPLE_GRID_MAX_DIMENSION
    projected_ratio = (
        (projected_bounds[2] - projected_bounds[0])
        / (projected_bounds[3] - projected_bounds[1])
    )
    assert plan.width / plan.height == pytest.approx(projected_ratio, rel=0.02)
    assert plan.points_per_cell == 1
    assert sum(len(cell) for cell in plan.cell_positions) <= (
        SAMPLE_GRID_MAX_TRANSFORMED_POSITIONS
    )


def test_center_nodata_remains_transparent(tmp_path: Path) -> None:
    """Keep an honestly masked center cell instead of converting nodata to zero."""
    source_path = tmp_path / "center-nodata.tif"
    values = numpy.ones((127, 127), dtype=numpy.uint8)
    values[63, 63] = 255
    _write_raster(source_path, values, nodata=255)
    with rasterio.open(source_path) as dataset:
        sample_grid, plan = read_sample_grid(dataset)
    assert plan.width == plan.height == 127
    assert bool(sample_grid.mask[63, 63]) is True
    assert sample_grid[63, 63] is numpy.ma.masked
    assert float(sample_grid[0, 0]) == 1.0


def test_sample_grid_reads_each_required_native_block_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Bound reads by the proven unique native-block plan without open-per-cell."""
    source_path = tmp_path / "bounded-blocks.tif"
    _write_raster(
        source_path,
        numpy.arange(256 * 256, dtype=numpy.uint32).reshape(256, 256),
    )
    calls: list[object] = []
    original = sample_grid_module._read_native_block

    def tracked_read(dataset: rasterio.io.DatasetReader, window: object):
        """Record and delegate one native-block read.

        Args:
            dataset: Open source raster.
            window: Exact native block window.

        Returns:
            Original masked native-block payload.
        """
        calls.append(window)
        return original(dataset, window)

    monkeypatch.setattr(sample_grid_module, "_read_native_block", tracked_read)
    with rasterio.open(source_path) as dataset:
        expected = plan_sample_grid(dataset)
        read_sample_grid(dataset)
        expected_windows = [
            dataset.block_window(1, row, column)
            for row, column in expected.block_indexes
        ]
    assert calls == expected_windows
    assert len(calls) == len(set(calls))
    assert len(calls) <= SAMPLE_GRID_MAX_SOURCE_BLOCK_READS


def test_sample_grid_cooperatively_cancels_between_native_blocks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Stop obsolete work after a completed block rather than finishing the grid."""
    source_path = tmp_path / "cancel.tif"
    _write_raster(source_path, numpy.ones((256, 256), dtype=numpy.uint16))
    reads = 0
    cancelled = threading.Event()
    original = sample_grid_module._read_native_block

    def tracked_read(dataset: rasterio.io.DatasetReader, block_index: tuple[int, int]):
        """Cancel the request after its first complete native-block read.

        Args:
            dataset: Open source raster.
            block_index: Native block row and column.

        Returns:
            Original masked native-block payload.
        """
        nonlocal reads
        values = original(dataset, block_index)
        reads += 1
        cancelled.set()
        return values

    monkeypatch.setattr(sample_grid_module, "_read_native_block", tracked_read)
    with rasterio.open(source_path) as dataset:
        with pytest.raises(RasterReadCancelled):
            read_sample_grid(dataset, cancellation_requested=cancelled.is_set)
    assert reads == 1


def test_base_and_close_view_use_sampled_then_exact_detail(tmp_path: Path) -> None:
    """Retain the fixed sample grid until a complete bounded source window is safe."""
    source_path = tmp_path / "adaptive.tif"
    _write_raster(
        source_path,
        numpy.arange(256 * 256, dtype=numpy.float32).reshape(256, 256),
    )
    base = read_raster_detail_preview(source_path, RASTER_EXTENT)
    assert base.rendering == "sampleGrid"
    assert max(base.image_width, base.image_height) == 127
    assert base.actual.source_window is None

    exact = read_raster_detail_preview(
        source_path,
        RASTER_EXTENT,
        (-115.1, 34.9, -114.9, 35.1),
    )
    assert exact.scope == "currentView"
    assert exact.rendering == "exactSourceWindow"
    assert exact.actual.source_window is not None
    assert exact.actual.points_per_cell == 0


class _Catalog:
    """Return one authoritative test Item."""

    def __init__(self, item: dict[str, object]) -> None:
        """Store the Item.

        Args:
            item: Authoritative catalog document.
        """
        self.item = item

    async def get_item(self, request: object) -> dict[str, object]:
        """Return the stored Item.

        Args:
            request: Validated catalog identity.

        Returns:
            Stored Item document.
        """
        return self.item


class _Resolver:
    """Resolve every authorized test Item to one known source."""

    def __init__(self, source_path: Path) -> None:
        """Store the known source.

        Args:
            source_path: Test raster path.
        """
        self.source_path = source_path

    def resolve(self, item: dict[str, object]) -> Path:
        """Return the known source without accepting browser paths.

        Args:
            item: Catalog-owned Item.

        Returns:
            Known test raster path.
        """
        return self.source_path


def test_service_coalesces_fixed_policy_and_separates_view_cache(
    tmp_path: Path,
) -> None:
    """Share identical reads while keeping distinct current views independent."""
    source_path = tmp_path / "service.tif"
    _write_raster(source_path, numpy.ones((128, 128), dtype=numpy.uint16))
    signature = source_signature(source_path)
    rendering = {
        "policy": RENDERING_POLICY,
        "eligible": False,
        "reason_code": "internal_overviews_required",
        "reason": "Normal visualization needs internal overviews.",
        "bounded_blocks": True,
        "reader_compatible": True,
        "reader_contract": GEOSERVER_READER_CONTRACT,
        "source_signature": list(signature),
    }
    item = {
        "bbox": list(RASTER_EXTENT),
        "assets": {"data": {RENDERING_METADATA_KEY: rendering}},
    }
    calls: list[tuple[float, float, float, float] | None] = []

    def reader(
        path: Path,
        extent: tuple[float, float, float, float],
        view: tuple[float, float, float, float] | None,
        cancellation_requested: object,
    ) -> RasterDetailPreview:
        """Record fixed request parameters and return a valid response.

        Args:
            path: Authorized source path.
            extent: Cataloged raster extent.
            view: Effective optional current view.
            cancellation_requested: Cooperative cancellation predicate.

        Returns:
            Valid sampled response for the requested scope.
        """
        assert path == source_path
        assert extent == RASTER_EXTENT
        calls.append(view)
        return _preview_document(
            scope="rasterExtent" if view is None else "currentView",
        )

    service = RasterDetailPreviewService(
        _Catalog(item),
        _Resolver(source_path),
        read_concurrency=2,
        cache_entries=4,
        preview_reader=reader,
    )
    base_request = CatalogRasterDetailPreviewRequest(
        collectionId="eolab-mounted-geotiffs",
        itemId=ITEM_ID,
    )
    async def exercise() -> tuple[RasterDetailPreview, RasterDetailPreview]:
        """Run coalesced base reads followed by one distinct view.

        Returns:
            The two responses sharing the base cache identity.
        """
        first, second = await asyncio.gather(
            service.get(base_request),
            service.get(base_request),
        )
        view_request = CatalogRasterDetailPreviewRequest.model_validate({
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": ITEM_ID,
            "viewBounds": {
                "west": -119,
                "south": 31,
                "east": -111,
                "north": 39,
            },
        })
        await service.get(view_request)
        return first, second

    first, second = asyncio.run(exercise())
    assert first == second
    assert calls == [None, (-119.0, 31.0, -111.0, 39.0)]
