"""Read small GeoJSON map previews from leased, immutable model-run files."""

import asyncio
import json
import math
from pathlib import Path
import sys
from typing import Any

from eolab_app.execution.bounded_process import (
    run_bounded_process,
    ProcessDeadlineError,
)
from eolab_app.source_files import LeasedSourceFiles

MAX_PREVIEW_BYTES = 8 * 1024 * 1024
MAX_VECTOR_FEATURES = 5000
MAX_VECTOR_POSITIONS = 100_000
PREVIEW_SECONDS = 30


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


def artifact_preview_process(writer: Any, path: Path) -> None:
    """Read an authorized immutable GeoJSON file into one bounded display preview.

    Args:
        writer: Supervisor's one-result pipe writer.
        path: Delivery-authorized confined path, never accepted from HTTP input.

    The parent bounds runtime and concurrency. Linux additionally limits address
    space to 2 GiB; source bytes, geometry counts and preview bytes have
    platform-independent caps. Failures contain no private paths or native-library
    diagnostics.
    """
    try:
        if sys.platform == "linux":
            import resource

            resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        preview = read_vector_preview(path)
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
                            "This ",
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
    """Deliver GeoJSON previews using injected file authorization and lifetime contracts."""

    def __init__(self, files: LeasedSourceFiles) -> None:
        """Connect the common immutable-file source access boundary.

        Args:
            files: Owner-authorized source access shared with raster analysis.
        """
        self.files = files
        self._slots = asyncio.Semaphore(2)

    async def read(self, owner: str, run_id: str, artifact_id: str) -> dict[str, Any]:
        """Authorize, generate and reauthorize a GeoJSON preview without a server cache.

        GeoTIFFs retain the ordinary raster rendering and original-file download
        paths. Their preview requests are rejected after source authorization.

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
        async with self._slots, self.files.open(owner, run_id, artifact_id) as source:
            if source.media_type == "image/tiff":
                raise ArtifactPreviewError(
                    "GeoTIFF outputs use ordinary raster rendering. "
                    "Download the file or use Show on map."
                )
            if source.media_type != "application/geo+json":
                raise ArtifactPreviewError(
                    "This file has no map preview. Download it instead."
                )
            try:
                result = await run_bounded_process(
                    artifact_preview_process,
                    (source.path,),
                    PREVIEW_SECONDS,
                )
            except ProcessDeadlineError as error:
                raise ArtifactPreviewError(
                    "The preview took too long. Download the file instead.", 504
                ) from error
            if "error" in result:
                raise ArtifactPreviewError(result["error"])
            return {
                "jobId": run_id,
                "artifactId": artifact_id,
                "sha256": source.sha256,
                **result["data"],
            }
