"""Scanner-facing GeoTIFF Item builder boundary.

Issue #88 owns the concurrent extraction of raster eligibility from the legacy
``eolab_app.geotiff`` module. This focused import keeps scanner orchestration
independent of that migration while preserving one authoritative builder until
the two maintenance branches are rebased.
"""

from eolab_app.geotiff import (
    MOUNTED_GEOTIFF_COLLECTION_ID,
    build_stac_item,
)


__all__ = ("MOUNTED_GEOTIFF_COLLECTION_ID", "build_stac_item")
