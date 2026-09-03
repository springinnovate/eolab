"""Test per-layer GeoWebCache publication configuration."""

import asyncio
from xml.etree import ElementTree

import httpx2

from eolab_app.rendering.geoserver import GeoServerPublicationGateway
from eolab_app.rendering.geowebcache import GeoWebCacheLayerConfigurator


def _failure_classifier(
    operation: str,
    status_code: int,
    excerpt: str,
) -> tuple[str, str]:
    """Return a controlled test error classification.

    Args:
        operation: Stable operation label from the gateway.
        status_code: Rejected upstream HTTP status.
        excerpt: Sanitized upstream response excerpt.

    Returns:
        Fixed public failure category and message.
    """
    del operation, status_code, excerpt
    return "upstream_failure", "failed"


def test_layer_configurator_keys_raster_environment_and_omits_it_for_vector() -> None:
    """Cache bounded raster color ramps without widening vector requests."""
    requests: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        """Record and accept one GeoWebCache request.

        Args:
            request: Request sent through the controlled HTTP transport.

        Returns:
            Successful empty response.
        """
        requests.append(request)
        return httpx2.Response(200)

    async def configure() -> None:
        """Configure controlled raster and vector cache layers.

        Returns:
            None after both requests complete.
        """
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(handler)
        ) as client:
            gateway = GeoServerPublicationGateway(
                client,
                "http://geoserver/geoserver",
                "test",
                RuntimeError,
                _failure_classifier,
            )
            configurator = GeoWebCacheLayerConfigurator(gateway)
            await configurator.configure(
                "raster-one",
                allow_style_environment=True,
            )
            await configurator.configure(
                "vector-one",
                allow_style_environment=False,
            )

    asyncio.run(configure())

    assert [request.url.path for request in requests] == [
        "/geoserver/gwc/rest/layers/eolab:raster-one.xml",
        "/geoserver/gwc/rest/layers/eolab:vector-one.xml",
    ]
    raster = ElementTree.fromstring(requests[0].content)
    vector = ElementTree.fromstring(requests[1].content)
    assert raster.findtext("gridSubsets/gridSubset/gridSetName") == "EPSG:3857"
    assert raster.findtext("parameterFilters/regexParameterFilter/key") == "ENV"
    assert vector.find("parameterFilters") is None
    assert all(b"900913" not in request.content for request in requests)
