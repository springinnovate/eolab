"""Concrete GeoServer REST adapter for raster publication."""

from pathlib import Path

import httpx2

from eolab_app.raster.errors import RasterUpstreamError


GEOSERVER_WORKSPACE_NAME = "eolab"
GEOSERVER_RASTER_STYLE_NAME = "dynamic-raster"


class GeoServerRasterPublisher:
    """Publish mounted GeoTIFFs through the internal GeoServer REST API."""

    def __init__(
        self,
        geoserver_client: httpx2.AsyncClient,
        geoserver_internal_url: str,
    ) -> None:
        """Create an adapter over an authenticated shared GeoServer client.

        Args:
            geoserver_client: Authenticated GeoServer REST client.
            geoserver_internal_url: Internal GeoServer base URL.
        """
        self._geoserver_client = geoserver_client
        self._geoserver_rest_url = (
            f"{geoserver_internal_url.rstrip('/')}/rest"
        )

    async def publish(self, resource_name: str, source_path: Path) -> None:
        """Idempotently publish and style one mounted GeoTIFF.

        Args:
            resource_name: Stable GeoServer coverage and layer name.
            source_path: Canonical mounted GeoTIFF path.

        Raises:
            RasterUpstreamError: If GeoServer is unavailable or rejects
                publication or styling.
        """
        try:
            store_response = await self._geoserver_client.put(
                f"{self._geoserver_rest_url}/workspaces/"
                f"{GEOSERVER_WORKSPACE_NAME}/coveragestores/"
                f"{resource_name}/external.geotiff",
                params={
                    "configure": "first",
                    "coverageName": resource_name,
                },
                content=source_path.as_uri(),
                headers={
                    "Accept": "application/json",
                    "Content-Type": "text/plain",
                },
            )
            if store_response.status_code != 201:
                raise RasterUpstreamError(
                    "GeoServer could not publish the selected GeoTIFF"
                )
            layer_url = (
                f"{self._geoserver_rest_url}/workspaces/"
                f"{GEOSERVER_WORKSPACE_NAME}/layers/{resource_name}"
            )
            style_response = await self._geoserver_client.put(
                f"{layer_url}.xml",
                content=(
                    "<layer><defaultStyle>"
                    f"<name>{GEOSERVER_RASTER_STYLE_NAME}</name>"
                    f"<workspace>{GEOSERVER_WORKSPACE_NAME}</workspace>"
                    "</defaultStyle></layer>"
                ),
                headers={"Content-Type": "application/xml"},
            )
        except httpx2.RequestError as error:
            raise RasterUpstreamError(
                "The rendering service is unavailable"
            ) from error
        if style_response.status_code != 200:
            raise RasterUpstreamError(
                "GeoServer could not style the selected GeoTIFF"
            )
