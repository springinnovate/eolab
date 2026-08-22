"""Test scanner-owned dataset builder module boundaries."""

from eolab_app.catalog.geotiff import (
    MOUNTED_GEOTIFF_COLLECTION_ID,
    build_stac_item as build_geotiff_stac_item,
)
from eolab_app.catalog.shapefile import build_stac_item as build_shapefile_stac_item


def test_dataset_builders_remain_independent_catalog_boundaries() -> None:
    """Expose distinct format-specific builders without a generic utility."""
    assert MOUNTED_GEOTIFF_COLLECTION_ID == "eolab-mounted-geotiffs"
    assert build_geotiff_stac_item is not build_shapefile_stac_item
