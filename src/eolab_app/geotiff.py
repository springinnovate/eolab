"""Compatibility exports for the catalog GeoTIFF builder and raster policy.

New code imports catalog metadata from :mod:`eolab_app.catalog.geotiff` and
rendering eligibility from :mod:`eolab_app.raster.eligibility`.
"""

from eolab_app.catalog.geotiff import (
    ACQUISITION_DATETIME_DESCRIPTION,
    FALLBACK_DATETIME_DESCRIPTION,
    FILE_EXTENSION,
    PROJECTION_EXTENSION,
    RASTER_EXTENSION,
    RFC3339_TIMESTAMP,
    STAC_RASTER_DATA_TYPES,
    SUGGESTED_WARP_BOUNDS_DESCRIPTION,
    build_stac_item,
)
from eolab_app.raster.eligibility import (
    COG_MEDIA_TYPE,
    DIRECT_RENDERING_MAX_BYTES,
    GEOTIFF_MEDIA_TYPE,
    GEOTIFF_MEDIA_TYPES,
    MOUNTED_GEOTIFF_COLLECTION_ID,
    MOUNTED_GEOTIFF_ITEM_ID_PATTERN,
    OVERVIEW_RENDERING_MAX_BYTES,
    OVERVIEW_RENDERING_MAX_DIMENSION,
    RASTER_DATA_TYPE_BYTES,
    RENDERING_MAX_BLOCK_EDGE,
    RENDERING_METADATA_KEY,
    RENDERING_POLICY,
    SUPPORTED_RENDERING_DATA_TYPES,
    assess_raster_renderability,
    inspect_raster_renderability as inspect_geotiff_renderability,
)


__all__ = (
    "ACQUISITION_DATETIME_DESCRIPTION",
    "COG_MEDIA_TYPE",
    "DIRECT_RENDERING_MAX_BYTES",
    "FALLBACK_DATETIME_DESCRIPTION",
    "FILE_EXTENSION",
    "GEOTIFF_MEDIA_TYPE",
    "GEOTIFF_MEDIA_TYPES",
    "MOUNTED_GEOTIFF_COLLECTION_ID",
    "MOUNTED_GEOTIFF_ITEM_ID_PATTERN",
    "OVERVIEW_RENDERING_MAX_BYTES",
    "OVERVIEW_RENDERING_MAX_DIMENSION",
    "PROJECTION_EXTENSION",
    "RASTER_DATA_TYPE_BYTES",
    "RASTER_EXTENSION",
    "RENDERING_MAX_BLOCK_EDGE",
    "RENDERING_METADATA_KEY",
    "RENDERING_POLICY",
    "RFC3339_TIMESTAMP",
    "STAC_RASTER_DATA_TYPES",
    "SUPPORTED_RENDERING_DATA_TYPES",
    "SUGGESTED_WARP_BOUNDS_DESCRIPTION",
    "assess_raster_renderability",
    "build_stac_item",
    "inspect_geotiff_renderability",
)
