"""Read small map previews from leased, immutable model-run files."""

import asyncio
from collections.abc import Awaitable, Callable
import hashlib
import json
import math
from pathlib import Path
import sys
from typing import Any, Protocol

from eolab_app.execution.bounded_process import (
    run_bounded_process,
    ProcessDeadlineError,
)
from eolab_app.raster.source_contract import require_signed_raster_dependencies

MAX_PREVIEW_BYTES = 8 * 1024 * 1024
MAX_PREVIEW_SIDE = 512
MAX_VECTOR_FEATURES = 5000
MAX_VECTOR_POSITIONS = 100_000
PREVIEW_SECONDS = 30
PREVIEW_MEDIA_TYPES = frozenset({"image/tiff", "application/geo+json"})


class LeasedPreviewFile(Protocol):
    """A confined immutable file held available by its delivery owner's lease."""

    path: Path
    size: int
    sha256: str
    media_type: str
    lease_id: str


class ArtifactPreviewError(Exception):
    """A map preview cannot be delivered; the original download is unaffected."""

    def __init__(self, message: str, status: int = 422) -> None:
        """Keep a path-free explanation and its HTTP status.

        Args:
            message: Explanation suitable for the person requesting the preview.
            status: HTTP failure status, defaulting to unsupported source content.
        """
        super().__init__(message)
        self.status = status


def read_raster_preview(path: Path) -> dict[str, Any]:
    """Sample a GeoTIFF into a masked Web Mercator grid of at most 512 × 512 cells.

    Args:
        path: Confined, checksum-verified file held under a delivery lease.

    Returns:
        WGS84 image bounds, grid dimensions and row-major values with null NoData.

    Raises:
        ValueError: If the raster cannot safely provide this display preview.
        RasterioError: If the native reader cannot open or project the file.
    """
    import numpy as np
    import rasterio
    from rasterio.enums import MaskFlags, Resampling
    from rasterio.transform import from_bounds
    from rasterio.vrt import WarpedVRT
    from rasterio.warp import transform_bounds

    with (
        rasterio.Env(GDAL_CACHEMAX=32 * 1024 * 1024, GDAL_NUM_THREADS="1"),
        rasterio.open(path, driver="GTiff") as source,
    ):
        require_signed_raster_dependencies(source, path)
        if (
            source.count != 1
            or source.crs is None
            or source.dtypes[0]
            not in {"uint8", "uint16", "int16", "uint32", "int32", "float32", "float64"}
        ):
            raise ValueError(
                "Preview requires a georeferenced, single-band numeric GeoTIFF."
            )
        if any(
            height * width * (np.dtype(source.dtypes[0]).itemsize + 1) > 64 * 1024**2
            for height, width in source.block_shapes
        ):
            raise ValueError(
                "Raster blocks are too large for a map preview. Download the file instead."
            )
        west, south, east, north = transform_bounds(
            source.crs, "EPSG:4326", *source.bounds, densify_pts=21
        )
        if (
            not all(math.isfinite(value) for value in (west, south, east, north))
            or west >= east
        ):
            raise ValueError(
                "This raster crosses unsupported map bounds. Download the file instead."
            )
        west, east = max(-180, west), min(180, east)
        south, north = max(-85.05112878, south), min(85.05112878, north)
        if west >= east or south >= north:
            raise ValueError(
                "This raster is outside the map's supported latitude range."
            )
        bounds = (west, south, east, north)
        projected = transform_bounds("EPSG:4326", "EPSG:3857", *bounds)
        x_span, y_span = projected[2] - projected[0], projected[3] - projected[1]
        scale = min(MAX_PREVIEW_SIDE, max(source.width, source.height)) / max(
            x_span, y_span
        )
        width, height = min(512, max(1, math.ceil(x_span * scale))), min(
            512, max(1, math.ceil(y_span * scale))
        )
        with WarpedVRT(
            source,
            crs="EPSG:3857",
            transform=from_bounds(*projected, width, height),
            width=width,
            height=height,
            resampling=Resampling.nearest,
            dtype="float64",
            src_nodata=(
                None
                if MaskFlags.per_dataset in source.mask_flag_enums[0]
                else source.nodata
            ),
            add_alpha=True,
            init_dest_nodata=False,
            warp_mem_limit=32,
        ) as preview:
            values = preview.read(1, masked=True)
            valid = (preview.read(preview.count) > 0) & np.isfinite(values.data)
            if source.nodata is not None:
                valid &= values.data != source.nodata
            cells = values.data.astype(object)
            cells[~valid] = None
            return {
                "kind": "raster",
                "bounds": list(bounds),
                "width": width,
                "height": height,
                "values": cells.ravel().tolist(),
            }


def read_vector_preview(path: Path) -> dict[str, Any]:
    """Validate a small WGS84 GeoJSON file for display without creating an analysis source.

    Args:
        path: Checksum-verified file of at most 8 MiB, held under a delivery lease.

    Returns:
        A feature collection, its bounds and common point, line or polygon symbol kind.

    Raises:
        ValueError: If JSON, geometry, coordinate counts or geographic bounds are unsupported.
    """
    with path.open("rb") as stream:
        data = stream.read(MAX_PREVIEW_BYTES + 1)
    if len(data) > MAX_PREVIEW_BYTES:
        raise ValueError(
            "This vector file is too large for a preview. Download it instead."
        )
    collection = json.loads(data)
    if (
        not isinstance(collection, dict)
        or collection.get("type") != "FeatureCollection"
        or "crs" in collection
    ):
        raise ValueError("Vector previews require a WGS84 GeoJSON FeatureCollection.")
    features = collection.get("features")
    if not isinstance(features, list) or not 1 <= len(features) <= MAX_VECTOR_FEATURES:
        raise ValueError("Vector previews support 1 to 5,000 features.")
    layouts = {
        "Point": (0, "point"),
        "MultiPoint": (1, "point"),
        "LineString": (1, "line"),
        "MultiLineString": (2, "line"),
        "Polygon": (2, "polygon"),
        "MultiPolygon": (3, "polygon"),
    }
    positions: list[tuple[float, float]] = []
    kinds: set[str] = set()

    def check_coordinates(coordinates: Any, depth: int) -> None:
        """Check GeoJSON nesting and count finite WGS84 positions before map delivery.

        Args:
            coordinates: Untrusted position or nested coordinate arrays.
            depth: Remaining array nesting required by the geometry type.

        Raises:
            ValueError: If nesting, coordinates or the total position limit is invalid.
        """
        if not isinstance(coordinates, list) or not coordinates:
            raise ValueError("Vector coordinates are invalid.")
        if depth:
            for child in coordinates:
                check_coordinates(child, depth - 1)
            return
        if len(coordinates) not in {2, 3} or any(
            type(value) not in {float, int} or not math.isfinite(value)
            for value in coordinates
        ):
            raise ValueError("Vector coordinates must be finite numbers.")
        x, y = coordinates[:2]
        if not -180 <= x <= 180 or not -85.05112878 <= y <= 85.05112878:
            raise ValueError(
                "Vector coordinates are outside the map's supported bounds."
            )
        positions.append((x, y))
        if len(positions) > MAX_VECTOR_POSITIONS:
            raise ValueError("Vector previews support at most 100,000 positions.")

    for feature in features:
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError("Invalid GeoJSON feature.")
        geometry = feature.get("geometry")
        if not isinstance(geometry, dict) or geometry.get("type") not in layouts:
            raise ValueError("Unsupported vector geometry in this preview.")
        depth, kind = layouts[geometry["type"]]
        kinds.add(kind)
        check_coordinates(geometry.get("coordinates"), depth)
        # Only geometry is needed for symbol styling. Arbitrary properties and
        # foreign members do not become browser markup or analysis inputs.
    if len(kinds) != 1:
        raise ValueError(
            "Preview features must share a point, line or polygon geometry kind."
        )
    return {
        "kind": "vector",
        "geometryKind": kinds.pop(),
        "bounds": [
            min(p[0] for p in positions),
            min(p[1] for p in positions),
            max(p[0] for p in positions),
            max(p[1] for p in positions),
        ],
        "geojson": {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {},
                    "geometry": {
                        "type": f["geometry"]["type"],
                        "coordinates": f["geometry"]["coordinates"],
                    },
                }
                for f in features
            ],
        },
    }


def artifact_preview_process(
    writer: Any, path: Path, media_type: str, size: int, sha256: str
) -> None:
    """Verify an immutable file and return one preview from a killable native process.

    Args:
        writer: Supervisor's one-result pipe writer.
        path: Delivery-authorized confined path, never accepted from HTTP input.
        media_type: Manifest format, restricted by the preview delivery service.
        size: Published file size.
        sha256: Published file checksum.

    The parent bounds runtime and concurrency. Linux additionally limits address
    space to 2 GiB; decoded blocks and preview bytes have platform-independent caps.
    Failures contain no private paths or native-library diagnostics.
    """
    try:
        if sys.platform == "linux":
            import resource

            resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        before = path.stat()
        if before.st_size != size:
            raise ValueError("The result file changed. Run the model again.")
        if media_type == "application/geo+json" and size > MAX_PREVIEW_BYTES:
            raise ValueError(
                "This vector file is too large for a preview. Download it instead."
            )
        checksum = hashlib.sha256()
        with path.open("rb") as stream:
            while block := stream.read(1024 * 1024):
                checksum.update(block)
        if checksum.hexdigest() != sha256:
            raise ValueError("The result file changed. Run the model again.")
        reader = {
            "image/tiff": read_raster_preview,
            "application/geo+json": read_vector_preview,
        }[media_type]
        preview = reader(path)
        after = path.stat()
        if any(
            getattr(after, field) != getattr(before, field)
            for field in ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
        ):
            raise ValueError(
                "The result file changed while its preview was being read."
            )
        encoded = json.dumps(preview, allow_nan=False, separators=(",", ":")).encode()
        if len(encoded) > MAX_PREVIEW_BYTES:
            raise ValueError("This preview is too large. Download the file instead.")
        writer.put({"data": preview})
    except ValueError as error:
        writer.put(
            {
                "error": (
                    str(error)
                    if str(error).startswith(
                        (
                            "Preview",
                            "Raster blocks",
                            "This ",
                            "The result",
                            "Vector ",
                            "Unsupported vector",
                            "Invalid GeoJSON",
                        )
                    )
                    else "This file cannot be previewed. Download it instead."
                )
            }
        )
    except Exception:
        writer.put({"error": "This file cannot be previewed. Download it instead."})


class ArtifactPreviewService:
    """Deliver bounded previews using injected file authorization and lifetime contracts."""

    def __init__(
        self,
        acquire: Callable[[str, str, str], Awaitable[LeasedPreviewFile]],
        release: Callable[[str], Awaitable[bool]],
    ) -> None:
        """Connect delivery-owned file leases without importing Processing implementation.

        Args:
            acquire: Authorize session, run and file on every call and retain its files.
            release: Release a file lease once native work has completely stopped.
        """
        self.acquire = acquire
        self.release = release
        self._slots = asyncio.Semaphore(2)

    async def _acquire_file(
        self, owner: str, run_id: str, artifact_id: str
    ) -> LeasedPreviewFile:
        """Finish acquisition before releasing a lease when HTTP cancellation races a database read.

        Args:
            owner: Current session hash.
            run_id: Requested run identity.
            artifact_id: Requested file identity.

        Returns:
            The acquired immutable file lease.

        Raises:
            Exception: Authorization failure from the file-delivery owner.
            asyncio.CancelledError: After releasing a lease acquired during cancellation.
        """
        task = asyncio.create_task(self.acquire(owner, run_id, artifact_id))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            while not task.done():
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            if not task.cancelled() and task.exception() is None:
                await self.release(task.result().lease_id)
            raise

    async def read(self, owner: str, run_id: str, artifact_id: str) -> dict[str, Any]:
        """Authorize, generate and reauthorize a preview without retaining a server cache.

        Args:
            owner: Hashed browser-session identity, supplied by the HTTP boundary.
            run_id: Opaque immutable run identity.
            artifact_id: Opaque file identity within that run.

        Returns:
            Bounded display data tied to the exact requested file and checksum.

        Raises:
            ArtifactPreviewError: If busy, timed out or unsupported for display.
            Exception: Authorization failures from the owning delivery boundary.
            asyncio.CancelledError: After reclaiming native work and its file lease.
        """
        if self._slots.locked():
            raise ArtifactPreviewError("Map previews are busy. Try again shortly.", 429)
        async with self._slots:
            source = await self._acquire_file(owner, run_id, artifact_id)
            try:
                if source.media_type not in PREVIEW_MEDIA_TYPES:
                    raise ArtifactPreviewError(
                        "This file has no map preview. Download it instead."
                    )
                try:
                    result = await run_bounded_process(
                        artifact_preview_process,
                        (source.path, source.media_type, source.size, source.sha256),
                        PREVIEW_SECONDS,
                    )
                except ProcessDeadlineError as error:
                    raise ArtifactPreviewError(
                        "The preview took too long. Download the file instead.", 504
                    ) from error
                if "error" in result:
                    raise ArtifactPreviewError(result["error"])
                # Deletion or expiry during native work must not deliver a new preview.
                current = await self._acquire_file(owner, run_id, artifact_id)
                try:
                    if (current.path, current.size, current.sha256) != (
                        source.path,
                        source.size,
                        source.sha256,
                    ):
                        raise ArtifactPreviewError(
                            "The result file changed. Run the model again.", 410
                        )
                finally:
                    await self.release(current.lease_id)
                return {
                    "jobId": run_id,
                    "artifactId": artifact_id,
                    "sha256": source.sha256,
                    **result["data"],
                }
            finally:
                await self.release(source.lease_id)
