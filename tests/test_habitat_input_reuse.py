"""Check source identity, geographic overlap and publication of Habitat input tiles."""

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
from threading import Barrier
from uuid import UUID

import numpy as np
import pytest
import rasterio
from numpy.typing import NDArray
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import array_bounds, from_bounds, from_origin
from rasterio.warp import transform_bounds

from eolab_app.processing import habitat_raster_cache
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.habitat_raster_cache import (
    HabitatInputCacheCleanup,
    manual_band_cache_directory,
    prepare_manual_habitat_bands,
)
from eolab_app.processing.raster_preparation import RasterGrid, prepare_raster_stack
from eolab_app.raster.models import AuthorizedRaster, CatalogRasterRequest
from eolab_app.raster.source_identity import RasterSourceIdentity


def _source(path: Path, shift: float = 0) -> AuthorizedRaster:
    """Write a 250 m source with valid zero, masks, NoData and nonfinite values.

    Args:
        path: New, immutable source's filename.
        shift: Distinguish a separately admitted replacement's values.

    Returns:
        Authorized fixture metadata captured at admission.
    """
    rows, columns = np.indices((256, 600))
    values = (rows + columns / 7 + shift).astype("float32")
    values[15:20, 25:30] = -9999
    values[22:26, 15:20] = np.inf
    values[:4, :4] = 0
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        count=1,
        width=600,
        height=256,
        dtype="float32",
        crs="EPSG:6933",
        transform=from_origin(0, 64000, 250, 250),
        nodata=-9999,
    ) as dataset:
        dataset.write(values, 1)
        mask = np.full(values.shape, 255, dtype="uint8")
        mask[30:34, 40:46] = 0
        dataset.write_mask(mask)
    return AuthorizedRaster(path, RasterSourceIdentity.read(path))


def _grid(left: int = 0, spacing: int = 500) -> RasterGrid:
    """Return a one-tile assessment grid, optionally shifted to overlap two tiles.

    Args:
        left: West edge in metres.
        spacing: Requested target cell size in metres.

    Returns:
        A 128 by 128 cell equal-area calculation grid.
    """
    return RasterGrid(
        CRS.from_epsg(6933), from_origin(left, 64000, spacing, spacing), 128, 128
    )


def test_manual_alignment_reuses_overlapping_tiles_and_invalidates_inputs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Compare fresh GDAL alignment with changed grid, source and resampling.

    Args:
        tmp_path: Private datasets, shared cache and individual calculations.
        monkeypatch: Count actual publications of completely written manual tiles.
    """
    source = _source(tmp_path / "original.tif")
    replacement = _source(tmp_path / "replacement.tif", 100)
    catalog = CatalogRasterRequest(
        collectionId="eolab-mounted-geotiffs", itemId="geotiff-" + "a" * 24
    )
    root = tmp_path / "cache"
    writes = []
    publish = habitat_raster_cache.publish_band_tile

    def record(local: Path, cached: Path) -> None:
        """Record the identity of a completed alignment write before publication.

        Args:
            local: Completed attempt-local GeoTIFF.
            cached: Destination under the primary or independent input cache.
        """
        if cached.is_relative_to(root):
            writes.append(cached)
        publish(local, cached)

    monkeypatch.setattr(habitat_raster_cache, "publish_band_tile", record)
    cases = (
        (source, _grid(), Resampling.bilinear, 1),
        (source, _grid(), Resampling.bilinear, 0),
        (source, _grid(500), Resampling.bilinear, 1),
        (source, _grid(), Resampling.nearest, 1),
        (source, _grid(), Resampling.bilinear, 0),
        (replacement, _grid(), Resampling.bilinear, 1),
        (source, _grid(spacing=400), Resampling.bilinear, 1),
        (source, _grid(500), Resampling.nearest, 1),
        (source, _grid(500), Resampling.nearest, 0),
    )
    for case, (raster, grid, method, expected_writes) in enumerate(cases):
        attempt = tmp_path / f"run-{case}"
        attempt.mkdir()
        role = "response_0" if case == 4 else "predictor_0"
        inputs = {role: (raster.source_path, method)}
        scope = manual_band_cache_directory(root, catalog, raster)
        assert scope is not None
        before = len(writes)
        with (
            prepare_manual_habitat_bands(
                inputs, {role: scope}, grid, (0, 0), attempt
            ) as reused,
            prepare_manual_habitat_bands(
                inputs, {role: tmp_path / f"fresh-{case}"}, grid, (0, 0), attempt
            ) as independent,
            rasterio.open(independent[role]) as cold,
            prepare_raster_stack(
                inputs,
                grid,
                (),
                attempt,
                RasterAggregateLimits(),
                all_touched=False,
            ) as fresh,
            rasterio.open(reused[role]) as candidate,
            rasterio.open(fresh[role]) as reference,
        ):
            assert candidate.transform == reference.transform
            np.testing.assert_array_equal(
                candidate.read_masks(), reference.read_masks()
            )
            np.testing.assert_array_equal(candidate.read(), cold.read())
            np.testing.assert_array_equal(candidate.read(), reference.read())
        assert len(writes) - before == expected_writes


@pytest.mark.parametrize(
    "method",
    [
        Resampling.nearest,
        Resampling.bilinear,
        Resampling.cubic,
        Resampling.average,
        Resampling.mode,
    ],
)
@pytest.mark.parametrize("source_crs", ["EPSG:4326", "EPSG:6933"])
def test_resampled_band_keeps_full_gdal_kernel_after_area_moves(
    tmp_path: Path,
    method: Resampling,
    source_crs: str,
) -> None:
    """Compare cold, reused and cropped geographic or projected resampling to GDAL.

    Args:
        tmp_path: Separate attempts and a shared immutable source namespace.
        method: Each resampling method exposed by the Habitat model.
        source_crs: Geographic reprojection or a binary projected lattice with a partial edge tile.
    """
    original = tmp_path / "geographic.tif"
    study = RasterGrid(
        CRS.from_epsg(6933), from_origin(-8830000, 5340000, 500, 500), 201, 215
    )
    bounds = array_bounds(study.height, study.width, study.transform)
    if source_crs == "EPSG:4326":
        bounds = transform_bounds(study.crs, source_crs, *bounds)
        height, width = 411, 521
    else:
        height, width = study.height * 2, study.width * 2
    pixels = np.random.default_rng(32).normal(size=(height, width)).astype("float32")
    pixels[83:99, 188:200] = np.nan
    with rasterio.open(
        original,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=1,
        crs=source_crs,
        transform=from_bounds(*bounds, width, height),
        dtype="float32",
        nodata=np.nan,
    ) as destination:
        destination.write(pixels, 1)
    changed = RasterGrid(
        study.crs, study.transform, study.width - 36, study.height - 22
    )
    inputs = {"predictor_0": (original, method)}
    scopes = {"predictor_0": tmp_path / "cache" / "catalog" / ("a" * 64)}
    for index, grid in enumerate((study, study, changed)):
        with (
            prepare_manual_habitat_bands(
                inputs, scopes, grid, (0, 0), tmp_path
            ) as cached,
            prepare_raster_stack(
                inputs,
                grid,
                (),
                tmp_path,
                RasterAggregateLimits(),
                all_touched=False,
            ) as independent,
            rasterio.open(cached["predictor_0"]) as actual,
            rasterio.open(independent["predictor_0"]) as expected,
        ):
            np.testing.assert_array_equal(actual.read_masks(), expected.read_masks())
            np.testing.assert_array_equal(actual.read(), expected.read())
        if source_crs == "EPSG:4326" or method != Resampling.nearest:
            assert len(list(scopes["predictor_0"].rglob("grid.tif"))) == (
                2 if index == 2 else 1
            )


def test_private_expiry_preserves_active_links_and_reclaims_cached_values(
    tmp_path: Path,
) -> None:
    """Withdraw expired private sources while preserving their running job's input.

    Args:
        tmp_path: Process cache and an independent authorized attempt directory.
    """
    path = _source(tmp_path / "uploaded.tif").source_path
    cache = tmp_path / "cache"
    upload = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
    run = "b" * 32
    scopes = {
        "predictor_0": cache / "uploads" / str(upload),
        "response_0": cache / "runs" / run / ("c" * 32),
    }
    inputs = {role: (path, Resampling.bilinear) for role in scopes}
    checked_uploads = []
    checked_runs = []

    def upload_available(identifier: UUID) -> bool:
        """Report an expired upload to the cache's cleanup-only lifetime check.

        Args:
            identifier: Upload UUID queried by worker cleanup.

        Returns:
            False to represent expiry.
        """
        checked_uploads.append(identifier)
        return False

    def run_available(identifier: str) -> bool:
        """Report a withdrawn published run to the cache's cleanup-only lifetime check.

        Args:
            identifier: Source run queried by worker cleanup.

        Returns:
            False to represent deletion.
        """
        checked_runs.append(identifier)
        return False

    with prepare_manual_habitat_bands(
        inputs, scopes, _grid(), (0, 0), tmp_path
    ) as active:
        assert all(tuple(scope.rglob("*.tif")) for scope in scopes.values())
        HabitatInputCacheCleanup(cache, 86400, upload_available, run_available)()
        assert checked_uploads == [upload] and checked_runs == [run]
        assert all(not scope.exists() for scope in scopes.values())
        with (
            rasterio.open(active["predictor_0"]) as predictor,
            rasterio.open(active["response_0"]) as response,
        ):
            assert np.isfinite(predictor.read(1)).any()
            np.testing.assert_array_equal(predictor.read(), response.read())
    assert all(not path.exists() for path in active.values())


def test_competing_and_cancelled_alignment_never_publish_partial_tiles(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Interrupt one cold writer and synchronize two independent successful writers.

    Args:
        tmp_path: Private source, attempts and shared destination on one volume.
        monkeypatch: Stop at the read or publication boundary under test.
    """
    source = _source(tmp_path / "source.tif")
    scopes = {"predictor_0": tmp_path / "cache" / "catalog" / ("d" * 64)}
    inputs = {"predictor_0": (source.source_path, Resampling.bilinear)}

    def calculate(label: str) -> NDArray[np.float64]:
        """Open one independent attempt's final aligned band and read its pixels.

        Args:
            label: Unique private attempt directory.

        Returns:
            Unmasked source values on the target grid.
        """
        attempt = tmp_path / label
        attempt.mkdir()
        with (
            prepare_manual_habitat_bands(
                inputs, scopes, _grid(), (0, 0), attempt
            ) as prepared,
            rasterio.open(prepared["predictor_0"]) as dataset,
        ):
            return dataset.read(1)

    with monkeypatch.context() as interrupted:

        def cancel(*args: object) -> None:
            """Interrupt the calculation with the private TIFF still open.

            Args:
                *args: Read issued by the calculation.

            Raises:
                InterruptedError: Simulated native interruption.
            """
            raise InterruptedError("worker stopped")

        interrupted.setattr(habitat_raster_cache, "read_warped_tile", cancel)
        with pytest.raises(InterruptedError, match="worker stopped"):
            calculate("cancelled")
    assert not list(scopes["predictor_0"].rglob("*.tif"))
    assert not list((tmp_path / "cancelled").iterdir())
    # Cancellation after the atomic link can expose only a completed raster.
    previous = scopes["predictor_0"]
    scopes["predictor_0"] = previous.parent / ("e" * 64)
    publish_completed = habitat_raster_cache.publish_band_tile

    def interrupt_after_publish(local: Path, published: Path) -> None:
        """Interrupt an attempt after its complete TIFF has become reusable.

        Args:
            local: Closed private TIFF.
            published: Destination of its atomic hard link.

        Raises:
            InterruptedError: Simulated cancellation at the publication boundary.
        """
        publish_completed(local, published)
        raise InterruptedError("cancelled after publication")

    with monkeypatch.context() as interrupted:
        interrupted.setattr(
            habitat_raster_cache, "publish_band_tile", interrupt_after_publish
        )
        with pytest.raises(InterruptedError, match="after publication"):
            calculate("cancelled-after-publication")
    assert not list((tmp_path / "cancelled-after-publication").iterdir())
    with rasterio.open(next(scopes["predictor_0"].rglob("*.tif"))) as complete:
        np.testing.assert_array_equal(complete.read(1), calculate("reuse-complete"))
    scopes["predictor_0"] = previous
    ready = Barrier(2)
    publish = habitat_raster_cache.publish_band_tile

    def compete(local: Path, shared: Path) -> None:
        """Let both closed tiles contend for the same immutable shared name.

        Args:
            local: Completed attempt-local GeoTIFF.
            shared: Common immutable name for both concurrent writers.
        """
        ready.wait(timeout=15)
        publish(local, shared)

    with monkeypatch.context() as racing, ThreadPoolExecutor(max_workers=2) as workers:
        racing.setattr(habitat_raster_cache, "publish_band_tile", compete)
        first, second = workers.map(calculate, ("first", "second"))
    assert len(list(scopes["predictor_0"].rglob("*.tif"))) == 1
    np.testing.assert_array_equal(first, second)
    np.testing.assert_array_equal(first, calculate("rerun"))


def test_empty_or_idle_manual_source_namespaces_expire_on_worker_cleanup(
    tmp_path: Path,
) -> None:
    """Retire idle Catalog data and retain recently used admitted data.

    Args:
        tmp_path: Worker-owned manual cache.
    """
    old = tmp_path / "catalog" / ("a" * 64)
    current = tmp_path / "catalog" / ("b" * 64)
    for scope in (old, current):
        scope.mkdir(parents=True)
    os.utime(old, (1, 1))
    HabitatInputCacheCleanup(tmp_path, 86400, lambda _: True, lambda _: True)()
    assert not old.exists() and current.is_dir()
