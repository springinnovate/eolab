"""Rendering-neutral catalog identity for mounted GeoTIFF sources."""


GEOTIFF_MEDIA_TYPE = "image/tiff; application=geotiff"
COG_MEDIA_TYPE = (
    "image/tiff; application=geotiff; profile=cloud-optimized"
)
GEOTIFF_MEDIA_TYPES = frozenset({GEOTIFF_MEDIA_TYPE, COG_MEDIA_TYPE})
MOUNTED_GEOTIFF_COLLECTION_ID = "eolab-mounted-geotiffs"
MOUNTED_GEOTIFF_ITEM_ID_PATTERN = r"^geotiff-[0-9a-f]{24}$"
