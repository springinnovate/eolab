"""Shared data builders for application integration tests."""

from collections.abc import Callable
from pathlib import Path

import httpx2
import rasterio
from rasterio.transform import from_origin


TEST_GEOTIFF_ITEM_ID = "geotiff-0123456789abcdef01234567"
RASTER_STYLE_ENVIRONMENT_ERROR = (
    "env must define ordered finite min, med, and max values plus cmin, "
    "cmed, and cmax six-digit hex colors"
)
VALID_GEOSERVER_METRICS = """
eolab_jvm_heap_used_bytes 268435456
eolab_jvm_heap_committed_bytes 536870912
eolab_jvm_heap_max_bytes 1073741824
eolab_jvm_process_cpu_load_ratio 0.125
jvm_gc_collection_seconds_count{gc="G1 Concurrent GC"} 10
jvm_gc_collection_seconds_sum{gc="G1 Concurrent GC"} 0.056
jvm_gc_collection_seconds_count{gc="G1 Old Generation"} 0
jvm_gc_collection_seconds_sum{gc="G1 Old Generation"} 0.0
jvm_gc_collection_seconds_count{gc="G1 Young Generation"} 32
jvm_gc_collection_seconds_sum{gc="G1 Young Generation"} 0.305
eolab_jvm_live_threads 42
eolab_jvm_uptime_seconds 3600.5
""".strip()


class GeoServerPublicationMock:
    """Model clean creation and complete publication reconciliation.

    Args:
        resource_name: Stable GeoServer store, coverage, and layer name.
        on_create: Optional callback invoked during the external GeoTIFF PUT.

    Attributes:
        requests: Ordered GeoServer REST requests handled by the mock.
        complete: Whether the store, coverage, and layer currently exist.
    """

    def __init__(
        self,
        resource_name: str = TEST_GEOTIFF_ITEM_ID,
        on_create: Callable[[], None] | None = None,
    ) -> None:
        """Create an initially clean GeoServer publication mock.

        Args:
            resource_name: Stable GeoServer store, coverage, and layer name.
            on_create: Optional callback invoked during external publication.

        Returns:
            None.
        """
        self.resource_name = resource_name
        self.on_create = on_create
        self.requests: list[httpx2.Request] = []
        self.complete = False

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        """Handle one publication REST request through the state contract.

        Args:
            request: GeoServer REST request issued by the application.

        Returns:
            Exact response for clean creation or complete reconciliation.

        Raises:
            AssertionError: If the application issues an unsupported request.
        """
        self.requests.append(request)
        path = request.url.path
        if request.method == "GET":
            if path.endswith("/workspaces/eolab.json"):
                return httpx2.Response(200)
            if path.endswith("/styles/dynamic-raster.sld"):
                return httpx2.Response(200)
            if path.endswith(
                f"/coveragestores/{self.resource_name}.json"
            ):
                return httpx2.Response(200 if self.complete else 404)
            if path.endswith(
                f"/coverages/{self.resource_name}.json"
            ):
                return httpx2.Response(200 if self.complete else 404)
            if path.endswith(f"/layers/{self.resource_name}.json"):
                return httpx2.Response(200 if self.complete else 404)
        if request.method == "PUT" and path.endswith("/external.geotiff"):
            if self.on_create is not None:
                self.on_create()
            self.complete = True
            return httpx2.Response(201)
        if request.method == "PUT" and path.endswith(
            f"/layers/{self.resource_name}.xml"
        ):
            return httpx2.Response(200)
        raise AssertionError(f"Unexpected GeoServer request: {request}")


def mounted_geotiff_item(
    asset_href: str,
    asset_media_type: str = "image/tiff; application=geotiff",
) -> dict[str, object]:
    """Build the scanner-owned STAC Item contract used by rendering tests.

    Args:
        asset_href: URI exposed by the Item's data asset.
        asset_media_type: Media type exposed by the data asset.

    Returns:
        A minimal mounted-GeoTIFF STAC Item.
    """
    return {
        "type": "Feature",
        "id": TEST_GEOTIFF_ITEM_ID,
        "collection": "eolab-mounted-geotiffs",
        "bbox": [-123.0, 48.0, -122.0, 49.0],
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [-123.0, 48.0],
                    [-122.0, 48.0],
                    [-122.0, 49.0],
                    [-123.0, 49.0],
                    [-123.0, 48.0],
                ]
            ],
        },
        "properties": {"datetime": "2025-01-01T00:00:00Z"},
        "assets": {
            "data": {
                "href": asset_href,
                "type": asset_media_type,
                "roles": ["data"],
                "eolab:rendering": {
                    "policy": "raster-v2",
                    "eligible": True,
                    "bounded_blocks": True,
                    "block_shapes": [[1, 1]],
                    "overview_factors": [[]],
                    "overview_storage": "none",
                    "compression": None,
                    "estimated_uncompressed_bytes": 1,
                },
            }
        },
    }


def write_geotiff(path: Path) -> None:
    """Create a minimal GeoTIFF whose current structure can be reassessed.

    Args:
        path: Destination path for the GeoTIFF.

    Returns:
        None.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=1,
        height=1,
        count=1,
        dtype="uint8",
        crs="EPSG:4326",
        transform=from_origin(-123, 49, 1, 1),
    ):
        pass
