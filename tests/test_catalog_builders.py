"""Test scanner-owned dataset builder module boundaries."""

from eolab_app.catalog.geotiff import (
    MOUNTED_GEOTIFF_COLLECTION_ID,
    build_stac_item as build_geotiff_stac_item,
)
from eolab_app.catalog.filegeodatabase import (
    build_stac_items as build_file_geodatabase_stac_items,
)
from eolab_app.catalog.geojson import build_stac_item as build_geojson_stac_item
from eolab_app.catalog.shapefile import build_stac_item as build_shapefile_stac_item


def test_dataset_builders_remain_independent_catalog_boundaries() -> None:
    """Expose distinct format-specific builders without a generic utility.

    Returns:
        None.
    """
    assert MOUNTED_GEOTIFF_COLLECTION_ID == "eolab-mounted-geotiffs"
    assert build_geotiff_stac_item is not build_shapefile_stac_item
    assert build_file_geodatabase_stac_items is not build_shapefile_stac_item
    assert build_geojson_stac_item is not build_shapefile_stac_item
