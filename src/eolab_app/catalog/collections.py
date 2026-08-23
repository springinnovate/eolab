"""Scanner-owned STAC Collections and dataset-to-Collection policy."""

from typing import Any

from eolab_app.catalog.geotiff import MOUNTED_GEOTIFF_COLLECTION_ID


MOUNTED_VECTOR_COLLECTION_ID = "eolab-mounted-vectors"

GEOTIFF_COLLECTION: dict[str, Any] = {
    "type": "Collection",
    "stac_version": "1.0.0",
    "id": MOUNTED_GEOTIFF_COLLECTION_ID,
    "title": "Scanned GeoTIFFs",
    "description": (
        "GeoTIFF files discovered in configured read-only mounted or remote "
        "EOLab scan sources. "
        "When acquisition metadata is unavailable, an Item's datetime is the "
        "mounted file or remote object's source modification time and its "
        "description identifies that fallback."
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
    "title": "Scanned vector datasets",
    "description": (
        "Vector datasets discovered in configured read-only mounted or remote "
        "EOLab scan sources. An Item's fallback datetime is the latest source "
        "modification time among the files or objects that form the dataset."
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
