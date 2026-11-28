"""Reuse unmasked Habitat input pixels across authorized Processing attempts."""

from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
import hashlib
import json
from math import frexp, isclose
import os
from pathlib import Path
import re
import shutil
from tempfile import TemporaryDirectory
import time
from uuid import UUID, uuid4

import numpy as np
import rasterio
from affine import Affine
from rasterio.enums import Resampling
from rasterio.transform import array_bounds

from eolab_app.processing.raster_preparation import (
    RasterGrid,
    open_warped_raster,
    read_warped_tile,
)
from eolab_app.raster.models import AuthorizedRaster, CatalogRasterRequest
from eolab_app.raster.source_models import RasterSourceReference, RunArtifactReference

_TILE_SIZE = 128


def manual_band_cache_directory(
    root: Path, reference: RasterSourceReference, source: AuthorizedRaster
) -> Path | None:
    """Name one authorized manual raster's cache independently of its input role.

    Args:
        root: Private Processing directory for aligned Habitat inputs.
        reference: Catalog selection or retained private input from this job.
        source: Already authorized original, with its admitted Catalog identity.

    Returns:
        Source namespace, or None for a Catalog source without a stored identity.
        Upload and run identifiers name immutable originals for their lifetimes.
    """
    if isinstance(reference, CatalogRasterRequest):
        if source.source_signature is None:
            return None
        identity = [
            reference.collection_id,
            reference.item_id,
            source.source_signature.to_catalog(),
        ]
        digest = hashlib.sha256(json.dumps(identity).encode()).hexdigest()
        return root / "catalog" / digest
    if isinstance(reference, RunArtifactReference):
        return root / "runs" / reference.job_id / reference.artifact_id
    return root / "uploads" / str(reference.upload_id)


@dataclass
class HabitatInputCacheCleanup:
    """Remove expired private or idle manual raster values during worker cleanup.

    Attributes:
        directory: Processing-owned aligned input cache.
        idle_seconds: Lifetime of a manual source namespace after its last use.
        upload_available: Source-owner lifetime check for an original uploaded raster.
        run_available: Source-owner lifetime check for an immutable result's run.
    """

    directory: Path
    idle_seconds: int
    upload_available: Callable[[UUID], bool]
    run_available: Callable[[str], bool]
    _next_sweep: float = field(default=0.0, init=False)

    def __call__(self) -> None:
        """Reconcile cache lifetimes once per minute on the existing cleanup cycle.

        Active calculations hold their own links to completed tiles. Removing a
        shared name withdraws it from later attempts while these links remain valid.

        Raises:
            OSError: If a scope cannot be inspected or reclaimed.
        """
        if time.monotonic() < self._next_sweep:
            return
        cutoff = time.time() - self.idle_seconds
        scope_names = {
            "uploads": r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}",
            "runs": r"[0-9a-f]{32}",
            "catalog": r"[0-9a-f]{64}",
        }
        for kind, expected in scope_names.items():
            parent = self.directory / kind
            if not parent.is_dir():
                continue
            for scope in parent.iterdir():
                if (
                    not re.fullmatch(expected, scope.name)
                    or scope.is_symlink()
                    or not scope.is_dir()
                ):
                    continue
                expired = scope.stat().st_mtime <= cutoff
                if not expired and kind == "uploads":
                    expired = not self.upload_available(UUID(scope.name))
                if not expired and kind == "runs":
                    expired = not self.run_available(scope.name)
                if expired:
                    # Withdraw the whole namespace before removing its contents.
                    retired = self.directory / f".retired-{uuid4().hex}"
                    scope.rename(retired)
                    shutil.rmtree(retired)
        for abandoned in self.directory.glob(".retired-*"):
            if abandoned.is_dir() and not abandoned.is_symlink():
                shutil.rmtree(abandoned)
        self._next_sweep = time.monotonic() + 60


def link_cached_band_tile(cached: Path, local: Path) -> bool:
    """Pin a completed cache tile in this attempt while its source is authorized.

    Args:
        cached: Private name of an atomically published, immutable tile.
        local: Unused path on the same Processing volume in this attempt.

    Returns:
        True when the existing values were linked, False for a cache miss.

    Raises:
        OSError: If the link fails for a reason other than a missing tile.
    """
    try:
        os.link(cached, local)
    except FileNotFoundError:
        return False
    return True


def publish_band_tile(local: Path, cached: Path) -> None:
    """Atomically offer a closed tile and keep this attempt's private copy.

    Args:
        local: Complete GeoTIFF in the private attempt.
        cached: Private cache filename on the same filesystem.

    Raises:
        OSError: If publication fails for a reason other than a concurrent
            winner or withdrawal of the destination namespace.
    """
    try:
        os.link(local, cached)
    except (FileExistsError, FileNotFoundError):
        # A concurrent winner or source expiry leaves our private file usable.
        pass


def write_band_mosaic(
    path: Path, sources: Sequence[Path], index: int, grid: RasterGrid | None = None
) -> None:
    """Expose one band from nonoverlapping tiles, with NoData in coverage gaps.

    Args:
        path: Attempt-private VRT filename.
        sources: Ordered original or derived tiles on one coordinate system.
        index: One-based source band to expose.
        grid: Exact requested extent and cell size, or the native source bounds.

    Raises:
        RuntimeError: If GDAL cannot build the view.
    """
    from osgeo import gdal

    options = (
        dict(
            outputBounds=array_bounds(grid.height, grid.width, grid.transform),
            xRes=grid.transform.a,
            yRes=-grid.transform.e,
        )
        if grid is not None
        else {}
    )
    with (
        gdal.ExceptionMgr(),
        gdal.BuildVRT(
            str(path),
            [str(p) for p in sources],
            bandList=[index],
            VRTNodata="nan",
            resampleAlg="nearest",
            **options,
        ),
    ):
        pass


def _same_lattice(source: rasterio.io.DatasetReader, grid: RasterGrid) -> bool:
    """Check whether a native pixel has the target CRS, axes and grid alignment.

    Args:
        source: Authorized manual raster opened for its native metadata.
        grid: Requested model grid.

    Returns:
        Whether a virtual crop can read original cell values directly.
    """
    axes = source.transform
    if (
        source.crs != grid.crs
        or axes[:2] != grid.transform[:2]
        or (axes.d, axes.e) != (grid.transform.d, grid.transform.e)
    ):
        return False
    column, row = ~axes * (grid.transform.c, grid.transform.f)
    return all(
        isclose(offset, round(offset), rel_tol=0, abs_tol=1e-8)
        for offset in (column, row)
    )


def _can_align_on_overlapping_tiles(
    source: rasterio.io.DatasetReader, grid: RasterGrid
) -> bool:
    """Identify affine grids whose interpolation support is independent of extent.

    GDAL estimates source sampling scales from the destination warp extent.
    Reprojection and fractional cell-size ratios can change interpolated
    values when the AOI changes. A common, axis-aligned binary lattice has
    exact pixel offsets and fixed scale on every geographic tile.

    Args:
        source: Authorized input raster.
        grid: Requested north-up model grid.

    Returns:
        Whether aligned values can be addressed by global tile coordinates.
    """
    axes = source.transform
    if source.crs != grid.crs or axes.b or axes.d or axes.a <= 0 or axes.e >= 0:
        return False
    ratios = (grid.transform.a / axes.a, grid.transform.e / axes.e)
    if any(frexp(ratio)[0] != 0.5 for ratio in ratios):
        return False
    offsets = (
        (grid.transform.c - axes.c) / min(grid.transform.a, axes.a),
        (grid.transform.f - axes.f) / min(-grid.transform.e, -axes.e),
    )
    return all(offset.is_integer() for offset in offsets)


def _write_aligned_band(
    path: Path, method: Resampling, grid: RasterGrid, local: Path
) -> None:
    """Materialize one unmasked, completely aligned input in this attempt.

    Args:
        path: Authorized original raster.
        method: Requested GDAL resampling method.
        grid: Exact geographic tile or whole calculation grid used for the warp.
        local: Private output filename, published only after this function returns.

    Raises:
        RasterioError: If reading, reprojection, or writing fails.
    """
    block_side = _TILE_SIZE if grid.width == grid.height == _TILE_SIZE else 512
    with (
        open_warped_raster(path, method, grid, local.parent / "source.vrt") as (
            original,
            warped,
        ),
        rasterio.open(
            local,
            "w",
            driver="GTiff",
            width=grid.width,
            height=grid.height,
            count=1,
            crs=grid.crs,
            transform=grid.transform,
            dtype="float64",
            nodata=np.nan,
            tiled=True,
            blockxsize=block_side,
            blockysize=block_side,
            BIGTIFF="IF_SAFER",
        ) as output,
    ):
        output.scales = original.scales
        output.offsets = original.offsets
        output.descriptions = original.descriptions
        output.units = original.units
        for _, window in output.block_windows(1):
            output.write(read_warped_tile(warped, window, None), 1, window=window)


def _manual_band_view(
    path: Path,
    method: Resampling,
    scope: Path | None,
    grid: RasterGrid,
    origin: tuple[float, float],
    scratch: Path,
) -> Path:
    """Return an unmasked manual band on this grid, reusing canonical warped tiles.

    Args:
        path: Authorized original single-band raster.
        method: Resampling selected for this variable.
        scope: Immutable source namespace, or None for an attempt-only read.
        grid: Exact target grid for the current run.
        origin: Model's fixed lattice anchor, independent of the AOI.
        scratch: Unique private directory for this variable's views and links.

    Returns:
        Attempt-owned view on the requested grid with invalid values represented by NaN.

    Raises:
        RasterioError: If a source cannot be read or a tile cannot be written.
        OSError: If the private or shared storage cannot be used.
    """
    scratch.mkdir()
    with rasterio.open(path) as source:
        direct = _same_lattice(source, grid)
        overlapping = _can_align_on_overlapping_tiles(source, grid)
    if direct or scope is None:
        with open_warped_raster(path, method, grid, scratch / "source.vrt") as (
            _,
            warped,
        ):
            return Path(warped.name)
    pixel_x, pixel_y = grid.transform.a, -grid.transform.e
    lattice = [grid.crs.to_wkt(), origin, pixel_x, pixel_y, method.name, _TILE_SIZE]
    if not overlapping:
        lattice.extend((tuple(grid.transform), grid.width, grid.height))
    digest = hashlib.sha256(json.dumps(lattice).encode()).hexdigest()
    # v1 identifies Float64 with GDAL mask, declared NoData and finite-value handling.
    destination = scope / "aligned-v1" / digest
    try:
        destination.mkdir(parents=True, exist_ok=True)
        # A run's immutable artifacts all expire with their source run.
        touched = scope.parent if scope.parent.parent.name == "runs" else scope
        os.utime(touched)
    except FileNotFoundError:
        # Cleanup may withdraw the shared namespace. Private reads still complete.
        pass
    if not overlapping:
        # GDAL's interpolation kernel can depend on the full destination extent.
        local = scratch / "grid.tif"
        cached = destination / local.name
        if not link_cached_band_tile(cached, local):
            _write_aligned_band(path, method, grid, local)
            publish_band_tile(local, cached)
        return local
    left = round((grid.transform.c - origin[0]) / pixel_x)
    top = round((origin[1] - grid.transform.f) / pixel_y)
    tiles = []
    for row in range(top // _TILE_SIZE, (top + grid.height - 1) // _TILE_SIZE + 1):
        for column in range(
            left // _TILE_SIZE, (left + grid.width - 1) // _TILE_SIZE + 1
        ):
            name = f"{column}_{row}.tif"
            local = scratch / name
            cached = destination / name
            if not link_cached_band_tile(cached, local):
                transform = Affine(
                    pixel_x,
                    0,
                    origin[0] + column * _TILE_SIZE * pixel_x,
                    0,
                    -pixel_y,
                    origin[1] - row * _TILE_SIZE * pixel_y,
                )
                tile = RasterGrid(grid.crs, transform, _TILE_SIZE, _TILE_SIZE)
                _write_aligned_band(path, method, tile, local)
                publish_band_tile(local, cached)
            tiles.append(local)
    result = scratch / "variable.vrt"
    write_band_mosaic(result, tiles, 1, grid)
    return result


@contextmanager
def prepare_manual_habitat_bands(
    inputs: Mapping[str, tuple[Path, Resampling]],
    scopes: Mapping[str, Path],
    grid: RasterGrid,
    origin: tuple[float, float],
    directory: Path,
    *,
    on_band: Callable[[int, int], None] | None = None,
) -> Iterator[dict[str, Path]]:
    """Expose authorized, unmasked manual predictor and response values for this run.

    Args:
        inputs: Selected predictor and response roles, source paths and resamplers.
        scopes: Shareable immutable source namespaces granted to this calculation.
        grid: Exact target extent for the current run.
        origin: Model lattice anchor for reusable tile addresses.
        directory: Private calculation attempt.
        on_band: Optional count of selected rasters ready to be read by this run.

    Yields:
        One single-band, target-sized raster keyed by selected input role.

    Raises:
        RasterioError: If a source cannot be read or aligned.
        OSError: If attempt or cache storage fails.
    """
    with TemporaryDirectory(prefix="habitat-inputs-", dir=directory) as temp:
        bands = {}
        if on_band is not None:
            on_band(0, len(inputs))
        for role, (path, method) in inputs.items():
            bands[role] = _manual_band_view(
                path, method, scopes.get(role), grid, origin, Path(temp) / role
            )
            if on_band is not None:
                on_band(len(bands), len(inputs))
        yield bands
