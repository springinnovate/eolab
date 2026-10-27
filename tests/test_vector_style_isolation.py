"""Keep each map's vector appearance usable after another map changes its style."""

import asyncio
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl
from xml.etree import ElementTree

import httpx2
from fastapi import FastAPI

from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.rendering.composite import CompositeMapRenderingService
from eolab_app.rendering.render_queue import GeoServerRenderQueue
from eolab_app.routes.composite_map import create_composite_map_router
from eolab_app.routes.wms_proxy import create_wms_proxy_router
from eolab_app.vector.filters import CatalogVectorFilterRequest, VectorFilter
from eolab_app.vector.models import CatalogVectorRequest, VectorStyle
from eolab_app.vector.publication import VectorPublicationService
from eolab_app.vector.sources import MountedVectorResolver, PublishedVectorRegistry
from eolab_app.vector.styles import (
    OGC_NAMESPACE,
    SLD_NAMESPACE,
    vector_label_rendering_buffer,
)
from eolab_app.vector.styling import VectorStyleService
from tests.test_vector_categories import assessed_category_item
from tests.test_vector_publication import RecordingPublisher, StaticCatalog
from tests.test_vector_styling import (
    RecordingStyler,
    UnusedFieldReader,
    polygon_request,
)


def _vector_services(
    item: dict[str, Any],
    mount: Path,
    registry: PublishedVectorRegistry,
) -> tuple[VectorPublicationService, VectorStyleService]:
    """Use real publication and styling services with an isolated GeoServer substitute.

    Args:
        item: Assessed catalog item returned by the catalog substitute.
        mount: Root containing the item's original GeoPackage.
        registry: Shared vector authorization registry.

    Returns:
        Publication and styling services sharing the supplied registry.
    """
    catalog, resolver = StaticCatalog(item), MountedVectorResolver(mount)
    return (
        VectorPublicationService(catalog, resolver, RecordingPublisher(), registry),
        VectorStyleService(
            catalog, resolver, RecordingStyler(), registry, UnusedFieldReader()
        ),
    )


def _map_query(
    layer: str,
    style: str,
    appearance: VectorStyle | None = None,
) -> dict[str, str]:
    """Build a small WMS map request with an explicit layer and appearance.

    Args:
        layer: Published layer or filtered alias.
        style: Published appearance selected by this map.
        appearance: Complete settings accompanying a signed custom style.

    Returns:
        Valid GetMap query parameters.
    """
    query = {
        "service": "WMS",
        "version": "1.1.1",
        "request": "GetMap",
        "layers": layer,
        "styles": style,
        "srs": "EPSG:3857",
        "bbox": "0,0,256,256",
        "width": "256",
        "height": "256",
        "format": "image/png",
        "transparent": "true",
    }
    if appearance is not None:
        query["vector_style"] = appearance.model_dump_json(by_alias=True)
    return query


def _upstream_parameters(request: httpx2.Request) -> dict[str, str]:
    """Read the actual form body or URL sent to the GeoServer substitute.

    Args:
        request: Captured KVP request for rendering, hover or a legend.

    Returns:
        Native WMS parameters, including empty style names.
    """
    if request.method == "POST":
        return dict(parse_qsl(request.content.decode(), keep_blank_values=True))
    return dict(request.url.params)


def test_vector_maps_keep_their_styles_after_republication(tmp_path: Path) -> None:
    """Keep old tiles, inspection, legends and filters working after another view opens.

    Args:
        tmp_path: Isolated mounted GeoPackages used by the actual source resolver.
    """
    item, _ = assessed_category_item(tmp_path)
    other_item, _ = assessed_category_item(tmp_path / "other")
    other_item["id"] += "-other"
    registry = PublishedVectorRegistry()
    publication, styling = _vector_services(item, tmp_path, registry)
    other_publication, other_styling = _vector_services(
        other_item, tmp_path / "other", registry
    )
    identity = CatalogVectorRequest(collectionId=item["collection"], itemId=item["id"])
    captured: list[httpx2.Request] = []

    def upstream(request: httpx2.Request) -> httpx2.Response:
        """Record forwarded rendering requests and return a valid image or feature response.

        Args:
            request: Authorized request sent to the GeoServer substitute.

        Returns:
            An empty feature collection for inspection, or a small image response.
        """
        captured.append(request)
        if _upstream_parameters(request).get("request") == "GetFeatureInfo":
            return httpx2.Response(
                200, json={"type": "FeatureCollection", "features": []}
            )
        return httpx2.Response(
            200, content=b"png", headers={"Content-Type": "image/png"}
        )

    async def use_two_maps() -> None:
        """Open two appearances through shared services and exercise their public rendering routes."""
        published = await publication.publish(identity)
        first = await styling.apply(polygon_request(item, label_field="category"))
        predicate = VectorFilter(
            enabled=True,
            match="all",
            rules=[
                {"field": "category", "operator": "eq", "value": "A"},
            ],
        )
        filtered = await publication.apply_filter(
            CatalogVectorFilterRequest(
                **identity.model_dump(by_alias=True),
                filter=predicate,
            )
        )
        queue, tracker = GeoServerRenderQueue(2), GetMapRequestTracker(2)
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(upstream)
        ) as geoserver:
            app = FastAPI()
            app.include_router(
                create_composite_map_router(
                    CompositeMapRenderingService((registry,)),
                    geoserver,
                    "http://geoserver/geoserver",
                    tracker,
                    queue,
                )
            )
            app.include_router(
                create_wms_proxy_router(
                    geoserver,
                    "http://geoserver/geoserver",
                    (registry,),
                    tracker,
                    queue,
                )
            )
            async with httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app=app),
                base_url="http://test",
            ) as browser:
                first_plan = {
                    "layers": [
                        {
                            "layerName": published.layer_name,
                            "styleName": first.style_name,
                            "styleDefinition": first.style.model_dump(by_alias=True),
                            "opacity": 1,
                        }
                    ]
                }
                plan_response = await browser.post(
                    "/api/map-rendering/plans", json=first_plan
                )
                assert plan_response.status_code == 200
                plan = plan_response.json()

                # A second view republishes the source and restores a different, unlabeled appearance.
                await publication.publish(identity)
                second = await styling.apply(polygon_request(item))
                assert first.style_name != second.style_name
                authorization = registry.require_current(published.layer_name)
                for index in range(128):
                    request = polygon_request(item)
                    request = request.model_copy(
                        update={
                            "style": request.style.model_copy(
                                update={
                                    "fill_color": f"#{index:06x}",
                                }
                            ),
                        }
                    )
                    changed = await styling.apply(request)
                    assert authorization.is_style_authorized(changed.style_name)
                    # New styles use the same source object instead of retaining history.
                    assert (
                        registry.require_current(published.layer_name) is authorization
                    )
                tile = await browser.get(
                    plan["wmsUrl"], params=_map_query("composite", "")
                )
                assert tile.status_code == 200, tile.text
                parameters = _upstream_parameters(captured[-1])
                root = ElementTree.fromstring(parameters["sld_body"])
                assert parameters["buffer"] == str(
                    vector_label_rendering_buffer(first.style)
                )
                assert (
                    root.findtext(
                        f".//{{{SLD_NAMESPACE}}}Geometry/{{{OGC_NAMESPACE}}}Function/"
                        f"{{{OGC_NAMESPACE}}}PropertyName"
                    )
                    == "shape"
                )
                rebuilt = await browser.post(
                    "/api/map-rendering/plans", json=first_plan
                )
                assert rebuilt.status_code == 200
                assert rebuilt.json() == plan

                for appearance in (first, second):
                    query = _map_query(
                        published.layer_name, appearance.style_name, appearance.style
                    )
                    assert (
                        await browser.post("/geoserver/eolab/wms", data=query)
                    ).status_code == 200
                    parameters = _upstream_parameters(captured[-1])
                    assert parameters["styles"] == ""
                    root = ElementTree.fromstring(parameters["sld_body"])
                    assert (
                        root.findtext(
                            f".//{{{SLD_NAMESPACE}}}UserStyle/{{{SLD_NAMESPACE}}}Name"
                        )
                        == appearance.style_name
                    )
                    assert parameters["buffer"] == str(
                        vector_label_rendering_buffer(appearance.style)
                    )
                info = {
                    **_map_query(filtered.layerName, first.style_name, first.style),
                    "request": "GetFeatureInfo",
                    "query_layers": filtered.layerName,
                    "info_format": "application/json",
                    "x": "128",
                    "y": "128",
                    "feature_count": "5",
                    "buffer": "8",
                }
                assert (
                    await browser.post("/geoserver/eolab/wms", data=info)
                ).status_code == 200
                parameters = _upstream_parameters(captured[-1])
                assert parameters["styles"] == ""
                assert parameters["query_layers"] == published.layer_name
                assert parameters["buffer"] == "8"
                assert "\"category\" = 'A'" in parameters["cql_filter"]
                legend = {
                    "service": "WMS",
                    "version": "1.1.1",
                    "request": "GetLegendGraphic",
                    "layer": filtered.layerName,
                    "style": first.style_name,
                    "vector_style": first.style.model_dump_json(by_alias=True),
                    "format": "image/png",
                }
                assert (
                    await browser.post("/geoserver/eolab/wms", data=legend)
                ).status_code == 200
                parameters = _upstream_parameters(captured[-1])
                assert parameters["style"] == ""
                assert parameters["layer"] == published.layer_name
                assert "sld_body" in parameters
                cleared = await publication.apply_filter(
                    CatalogVectorFilterRequest(
                        **identity.model_dump(by_alias=True),
                        filter=predicate.model_copy(update={"enabled": False}),
                    )
                )
                assert cleared.layerName == published.layer_name
                query = _map_query(cleared.layerName, first.style_name, first.style)
                assert (
                    await browser.get("/geoserver/eolab/wms", params=query)
                ).status_code == 200
                assert "cql_filter" not in _upstream_parameters(captured[-1])

                await other_publication.publish(
                    CatalogVectorRequest(
                        collectionId=other_item["collection"],
                        itemId=other_item["id"],
                    )
                )
                other = await other_styling.apply(polygon_request(other_item))
                forwarded = len(captured)
                tampered = first.style_name[:-1] + (
                    "0" if first.style_name[-1] != "0" else "1"
                )
                for rejected_style in ("unpublished-style", other.style_name, tampered):
                    rejected = await browser.get(
                        "/geoserver/eolab/wms",
                        params=_map_query(published.layer_name, rejected_style),
                    )
                    assert rejected.status_code == 400
                assert (
                    await browser.get(
                        "/geoserver/eolab/wms",
                        params=_map_query(
                            published.layer_name, first.style_name, second.style
                        ),
                    )
                ).status_code == 400
                mismatched_plan = {
                    "layers": [
                        {
                            **first_plan["layers"][0],
                            "styleDefinition": second.style.model_dump(by_alias=True),
                        }
                    ]
                }
                assert (
                    await browser.post("/api/map-rendering/plans", json=mismatched_plan)
                ).status_code == 400
                assert len(captured) == forwarded

                # Rebinding a layer to another file must not transfer prior styles or filters.
                registry.authorize(
                    published.layer_name,
                    MountedVectorResolver(tmp_path / "other").resolve(other_item),
                    "vector-polygon",
                )
                for layer, status in (
                    (published.layer_name, 400),
                    (filtered.layerName, 409),
                ):
                    assert (
                        await browser.get(
                            "/geoserver/eolab/wms",
                            params=_map_query(layer, first.style_name),
                        )
                    ).status_code == status
                assert (
                    await browser.get(
                        plan["wmsUrl"], params=_map_query("composite", "")
                    )
                ).status_code == 400
                assert len(captured) == forwarded
            await queue.close()

    asyncio.run(use_two_maps())
