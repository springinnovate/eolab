"""Composition root for provider-neutral remote dataset handlers."""

from eolab_app.catalog.remote import (
    RemoteDatasetHandler,
    RemoteDatasetHandlerRegistry,
)
from eolab_app.catalog.remote_geotiff import build_remote_geotiff_item
from eolab_app.catalog.remote_shapefile import build_remote_shapefile_item


def create_default_remote_dataset_handler_registry(
) -> RemoteDatasetHandlerRegistry:
    """Create the explicit initial remote format registry.

    Returns:
        Registry containing GeoTIFF and multipart Shapefile builders.
    """
    return RemoteDatasetHandlerRegistry(handlers=(
        RemoteDatasetHandler(
            name="remote-geotiff",
            build_item=build_remote_geotiff_item,
        ),
        RemoteDatasetHandler(
            name="remote-shapefile",
            build_item=build_remote_shapefile_item,
        ),
    ))
