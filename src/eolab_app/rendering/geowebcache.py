"""GeoWebCache configuration for one EOLab-published map layer."""

from urllib.parse import quote

from eolab_app.rendering.geoserver import GeoServerPublicationGateway
from eolab_infrastructure.geowebcache_documents import (
    GEOSERVER_WORKSPACE_NAME,
    geowebcache_layer_document,
)


class GeoWebCacheLayerConfigurator:
    """Converge published layers to EOLab's bounded tile-cache contract."""

    def __init__(self, gateway: GeoServerPublicationGateway) -> None:
        """Store the shared authenticated GeoServer transport boundary.

        Args:
            gateway: Existing strict transport for the owning publisher.

        Returns:
            None.
        """
        self._gateway = gateway

    async def configure(
        self,
        resource_name: str,
        *,
        allow_style_environment: bool,
    ) -> None:
        """Enable one layer only on the EPSG:3857 cache grid.

        Args:
            resource_name: Stable unqualified GeoServer resource name.
            allow_style_environment: Whether raster ``ENV`` values form part
                of the cache key. Vector layers reject ``ENV`` publicly.

        Returns:
            None after GeoWebCache accepts the exact layer configuration.

        Raises:
            Exception: The owning publisher's categorized publication error.
        """
        qualified_name = f"{GEOSERVER_WORKSPACE_NAME}:{resource_name}"
        encoded_name = quote(qualified_name, safe="")
        await self._gateway.application_request(
            "configure GeoWebCache layer",
            "PUT",
            f"/gwc/rest/layers/{encoded_name}.xml",
            accepted_statuses=frozenset({200}),
            content=geowebcache_layer_document(
                resource_name,
                allow_style_environment=allow_style_environment,
            ),
            headers={
                "Accept": "application/xml",
                "Content-Type": "application/xml",
            },
        )
