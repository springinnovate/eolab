"""Scanner-owned STAC Collections and dataset-to-Collection policy."""

from typing import Any

from eolab_app.catalog.geotiff import MOUNTED_GEOTIFF_COLLECTION_ID


MOUNTED_VECTOR_COLLECTION_ID = "eolab-mounted-vectors"

GEOTIFF_COLLECTION: dict[str, Any] = {
    "type": "Collection",
    "stac_version": "1.0.0",
    "id": MOUNTED_GEOTIFF_COLLECTION_ID,
    "title": "Mounted GeoTIFFs",
    "description": (
        "GeoTIFF files discovered in the configured read-only EOLab scan source. "
        "When acquisition metadata is unavailable, an Item's datetime is the "
        "source file's filesystem modification time and its description identifies "
        "that fallback."
    ),
    "license": "other",
    "extent": {
        "spatial": {"bbox": [[-180, -90, 180, 90]]},
        "temporal": {"interval": [[None, None]]},
    },
    "links": [],
}

SHAPEFILE_COLLECTION: dict[str, Any] = {
    "type": "Collection",
    "stac_version": "1.0.0",
    "id": MOUNTED_VECTOR_COLLECTION_ID,
    "title": "Mounted vector datasets",
    "description": (
        "Vector datasets discovered in the configured read-only EOLab scan "
        "source. An Item's datetime is the latest filesystem modification "
        "time among the files that form the dataset."
    ),
    "license": "other",
    "extent": {
        "spatial": {"bbox": [[-180, -90, 180, 90]]},
        "temporal": {"interval": [[None, None]]},
    },
    "links": [],
}

SCAN_COLLECTIONS = (GEOTIFF_COLLECTION, SHAPEFILE_COLLECTION)
SCAN_COLLECTION_IDENTIFIERS = tuple(
    collection["id"] for collection in SCAN_COLLECTIONS
)
