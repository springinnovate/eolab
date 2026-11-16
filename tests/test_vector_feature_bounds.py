"""Keep selected-feature bounds on the authorized, bounded inspection path."""

import asyncio
from base64 import urlsafe_b64decode
from collections.abc import Awaitable, Callable
import json
from pathlib import Path
from urllib.parse import parse_qsl

import httpx2
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from eolab_app.calculated_fields import CalculatedField
from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.rendering.render_queue import GeoServerRenderQueue
from eolab_app.rendering.errors import PublishedLayerRequestError
from eolab_app.raster.wms_authorization import PublishedRasterAuthorization
from eolab_app.routes.wms_proxy import create_wms_proxy_router
from eolab_app.vector.filters import VectorFilter
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sources import PublishedVectorRegistry
from eolab_app.vector.styles import default_vector_style, vector_style_name


def _feature_info_query(
    layer: str = "eolab:parcels", *, include_bounds: bool
) -> dict[str, str]:
    """Return a public feature query with an optional selected-feature envelope.

    Args:
        layer: Current authorized vector publication identity.
        include_bounds: Whether the caller requests geographic feature bounds.

    Returns:
        Valid public WMS parameters using the browser's JSON response format.
    """
    query = {
        "service": "WMS",
        "version": "1.1.1",
        "request": "GetFeatureInfo",
        "layers": layer,
        "query_layers": layer,
        "styles": "vector-polygon",
        "srs": "EPSG:3857",
        "bbox": "-10000000,0,0,10000000",
        "width": "800",
        "height": "600",
        "format": "image/png",
        "info_format": "application/json",
        "x": "128",
        "y": "128",
        "feature_count": "5",
        "buffer": "8",
    }
    if include_bounds:
        query["vector_feature_bounds"] = "true"
    return query


@pytest.mark.parametrize(
    "content_type",
    [
        "application/vnd.eolab.feature-info+json",
        "Application/Vnd.Eolab.Feature-Info+Json; charset=UTF-8",
    ],
)
@pytest.mark.parametrize("filtered", [False, True])
@pytest.mark.parametrize("properties", [None, "name"])
def test_inspection_retains_feature_bounds_and_requested_attributes(
    tmp_path: Path, filtered: bool, properties: str | None, content_type: str
) -> None:
    """Use original-layer envelopes without changing public field or filter choices.

    Args:
        tmp_path: Isolated source identity; native I/O is supplied by the transport.
        filtered: Whether the visible publication has an accepted attribute filter.
        properties: Optional public request for a subset of scalar attributes.
        content_type: Native selected-writer MIME type, optionally with a charset.
    """
    source = ResolvedVectorSource(
        "mounted", "geopackage", tmp_path / "source.gpkg", "data", "parcels"
    )
    registry = PublishedVectorRegistry()
    registry.authorize(
        "eolab:parcels",
        source,
        "vector-polygon",
        inspection_layer_name="eolab:parcels_original",
    )
    layer = "eolab:parcels"
    if filtered:
        layer = registry.authorize_filter(
            layer,
            VectorFilter(
                enabled=True,
                rules=[{"field": "name", "operator": "eq", "value": "Habitat"}],
            ),
        )
    captured: list[dict[str, str]] = []
    bounds = [-84.0, 8.0, -79.0, 12.0]

    def upstream(request: httpx2.Request) -> httpx2.Response:
        """Record the native query and supply one geometry-free selected feature.

        Args:
            request: Authorized original-layer request from the actual WMS route.

        Returns:
            The native writer's bounded geographic-envelope response shape.
        """
        captured.append(
            dict(parse_qsl(request.content.decode()))
            if request.content
            else dict(request.url.params)
        )
        return httpx2.Response(
            200,
            headers={"Content-Type": content_type},
            json={
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "id": "parcels.7",
                        "geometry": None,
                        "bbox": bounds,
                        "properties": (
                            {"name": "Habitat"}
                            if properties
                            else {"name": "Habitat", "rank": 2}
                        ),
                    }
                ],
            },
        )

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
    app = FastAPI()
    app.include_router(
        create_wms_proxy_router(
            client,
            "http://geoserver/geoserver",
            (registry,),
            GetMapRequestTracker(2),
            GeoServerRenderQueue(2),
        )
    )
    query = _feature_info_query(layer, include_bounds=True)
    if properties is not None:
        query["propertyName"] = properties
    with TestClient(app) as browser:
        response = browser.post("/geoserver/eolab/wms", data=query)
        assert response.status_code == 200
        _, separator, parameters = content_type.partition(";")
        assert (
            response.headers["content-type"]
            == f"application/json{separator}{parameters}"
        )
        feature = response.json()["features"][0]
        assert feature["id"] == "parcels.7"
        assert feature["bbox"] == bounds
        assert feature["geometry"] is None
        assert feature["properties"] == (
            {"name": "Habitat"} if properties else {"name": "Habitat", "rank": 2}
        )
        assert captured[0]["info_format"] == "application/vnd.eolab.feature-info+json"
        assert (
            captured[0]["layers"]
            == captured[0]["query_layers"]
            == "eolab:parcels_original"
        )
        assert "propertyname" not in {name.lower() for name in captured[0]}
        assert "vector_feature_bounds" not in captured[0]
        if properties is None:
            assert "format_options" not in captured[0]
        else:
            option, encoded = captured[0]["format_options"].split(":")
            assert option == "eolabProperties"
            assert json.loads(urlsafe_b64decode(encoded)) == ["name"]
        assert captured[0]["feature_count"] == "5"
        assert captured[0]["buffer"] == "8"
        assert ("cql_filter" in captured[0]) == filtered
        assert response.headers["x-content-type-options"] == "nosniff"
        untrusted = {**query, "info_format": "application/vnd.eolab.feature-info+json"}
        assert browser.post("/geoserver/eolab/wms", data=untrusted).status_code == 400
        invalid_flag = {**query, "vector_feature_bounds": "false"}
        assert (
            browser.post("/geoserver/eolab/wms", data=invalid_flag).status_code == 400
        )
        custom_options = {**query, "format_options": "eolabProperties:anything"}
        assert (
            browser.post("/geoserver/eolab/wms", data=custom_options).status_code == 400
        )
        assert len(captured) == 1
    asyncio.run(client.aclose())


def test_attribute_only_inspection_keeps_native_projection(tmp_path: Path) -> None:
    """Preserve hover's one-field projection without requesting feature geometry.

    Args:
        tmp_path: Isolated source identity, with no filesystem read.
    """
    source = ResolvedVectorSource(
        "mounted", "geopackage", tmp_path / "source.gpkg", "data", "parcels"
    )
    registry = PublishedVectorRegistry()
    registry.authorize("eolab:parcels", source, "vector-polygon")
    query = {
        "layers": "eolab:parcels",
        "query_layers": "eolab:parcels",
        "styles": "vector-polygon",
        "info_format": "application/json",
        "propertyName": "name",
    }
    assert (
        dict(
            registry.require_current("eolab:parcels").prepare_query(
                "getfeatureinfo", list(query.items())
            )
        )
        == query
    )


def test_raster_inspection_rejects_vector_bounds() -> None:
    """Keep the new optional vector request out of raster WMS behavior."""
    with pytest.raises(PublishedLayerRequestError, match="only for vector"):
        PublishedRasterAuthorization().validate_parameters(
            "getfeatureinfo", {"vector_feature_bounds": "true"}
        )


@pytest.mark.parametrize(
    ("include_bounds", "content_type", "oversized", "expected_status"),
    [
        (False, "application/json; charset=UTF-8", False, 200),
        (False, "application/vnd.eolab.feature-info+json", False, 502),
        (True, "application/json", False, 502),
        (True, "text/html", False, 502),
        (False, "text/html", False, 502),
        (True, "application/vnd.eolab.feature-info+jsonx", False, 502),
        (True, "application/vnd.eolab.feature-info+json", True, 502),
    ],
)
def test_feature_info_requires_the_selected_response_format(
    tmp_path: Path,
    include_bounds: bool,
    content_type: str,
    oversized: bool,
    expected_status: int,
) -> None:
    """Accept only the selected writer's MIME while retaining byte and header limits.

    Args:
        tmp_path: Isolated source path used only as an authorized identity.
        include_bounds: Whether the browser selects bounded feature information.
        content_type: MIME type actually returned by the upstream service.
        oversized: Whether the body exceeds the existing 512 KiB response budget.
        expected_status: Public response status for this boundary case.
    """
    registry = PublishedVectorRegistry()
    registry.authorize(
        "eolab:parcels",
        ResolvedVectorSource(
            "mounted", "geopackage", tmp_path / "source.gpkg", "data", "parcels"
        ),
        "vector-polygon",
    )
    content = (
        b"x" * (512 * 1024 + 1)
        if oversized
        else b'{"type":"FeatureCollection","features":[]}'
    )

    def upstream(request: httpx2.Request) -> httpx2.Response:
        """Return the controlled native representation for the requested writer.

        Args:
            request: Authorized request carrying the server-selected format.

        Returns:
            Controlled response with an unsafe header that must not be exposed.
        """
        expected_format = (
            "application/vnd.eolab.feature-info+json"
            if include_bounds
            else "application/json"
        )
        assert request.url.params["info_format"] == expected_format
        return httpx2.Response(
            200,
            content=content,
            headers={"Content-Type": content_type, "Set-Cookie": "private=value"},
        )

    client = httpx2.AsyncClient(transport=httpx2.MockTransport(upstream))
    app = FastAPI()
    app.include_router(
        create_wms_proxy_router(
            client,
            "http://geoserver/geoserver",
            (registry,),
            GetMapRequestTracker(1),
            GeoServerRenderQueue(1),
        )
    )
    with TestClient(app) as browser:
        response = browser.get(
            "/geoserver/eolab/wms",
            params=_feature_info_query(include_bounds=include_bounds),
        )
        assert response.status_code == expected_status
        assert "set-cookie" not in response.headers
        if expected_status == 200:
            assert response.headers["content-type"] == content_type
            assert response.headers["x-content-type-options"] == "nosniff"
            assert response.content == content
        else:
            assert response.json()["detail"] == (
                "The rendering service returned too much feature information"
                if oversized
                else "The rendering service returned invalid feature information"
            )
    asyncio.run(client.aclose())


@pytest.mark.parametrize("calculated", [False, True])
def test_coalesced_feature_bounds_normalize_only_outward_responses(
    tmp_path: Path,
    calculated: bool,
) -> None:
    """Keep a shared native response intact while each browser receives public JSON.

    Args:
        tmp_path: Isolated source path used only as an authorized identity.
        calculated: Whether approved calculated fields reserialize the response.
    """

    async def scenario() -> None:
        """Overlap two authorized callers through the real shared render queue."""
        source = ResolvedVectorSource(
            "mounted", "geopackage", tmp_path / "source.gpkg", "data", "parcels"
        )
        registry = PublishedVectorRegistry()
        registry.authorize("eolab:parcels", source, "vector-polygon")
        query = _feature_info_query(include_bounds=True)
        if calculated:
            definitions = (
                CalculatedField(name="double_rank", expression="'rank' * 2"),
            )
            style = default_vector_style("polygon")
            query["styles"] = registry.authorize_style(
                "eolab:parcels",
                source,
                vector_style_name("parcels", style, calculated_fields=definitions),
            )
            query["vector_style"] = style.model_dump_json(by_alias=True)
            query["vector_calculated_fields"] = json.dumps(
                [definition.model_dump() for definition in definitions]
            )
        native_content = json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "id": "parcels.7",
                        "geometry": None,
                        "bbox": [-84, 8, -79, 12],
                        "properties": {"name": "Forêt", "rank": 2},
                    }
                ],
            },
            ensure_ascii=False,
        ).encode("utf-16")
        native_response = httpx2.Response(
            200,
            content=native_content,
            headers={
                "Content-Type": "application/vnd.eolab.feature-info+json; charset=UTF-16",
                "ETag": '"feature-bounds"',
                "Set-Cookie": "private=value",
            },
        )
        original_headers = dict(native_response.headers)
        started = asyncio.Event()
        release = asyncio.Event()
        both_admitted = asyncio.Event()
        admission_count = 0
        upstream_count = 0
        authorization_count = 0

        class ObservedQueue(GeoServerRenderQueue):
            """Signal caller admission without replacing the queue's sharing behavior."""

            async def run(
                self,
                request: Callable[[], Awaitable[httpx2.Response]],
                *,
                request_key: str | None = None,
            ) -> httpx2.Response:
                """Count submissions before delegating to the actual shared queue.

                Args:
                    request: Authorized deferred native request.
                    request_key: Prepared query identity supplied by the WMS route.

                Returns:
                    The original shared upstream response.
                """
                nonlocal admission_count
                admission_count += 1
                if admission_count == 2:
                    both_admitted.set()
                return await super().run(request, request_key=request_key)

        async def authorize(names: tuple[str, ...], request: Request) -> bool:
            """Authorize each private source request before response sharing.

            Args:
                names: Requested publication identities.
                request: Individual browser request.

            Returns:
                True to retain the existing private, no-store response policy.
            """
            nonlocal authorization_count
            assert names == ("eolab:parcels",)
            assert request.method == "POST"
            authorization_count += 1
            return True

        async def upstream(request: httpx2.Request) -> httpx2.Response:
            """Hold one native response until both browser requests are admitted.

            Args:
                request: Prepared native request from the actual WMS route.

            Returns:
                A single immutable native response shared by both callers.
            """
            nonlocal upstream_count
            parameters = (
                dict(parse_qsl(request.content.decode()))
                if request.content
                else dict(request.url.params)
            )
            assert (
                parameters["info_format"] == "application/vnd.eolab.feature-info+json"
            )
            upstream_count += 1
            started.set()
            await release.wait()
            return native_response

        queue = ObservedQueue(1)
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(upstream)
        ) as client:
            app = FastAPI()
            app.include_router(
                create_wms_proxy_router(
                    client,
                    "http://geoserver/geoserver",
                    (registry,),
                    GetMapRequestTracker(1),
                    queue,
                    authorize_layers=authorize,
                )
            )
            async with httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app=app),
                base_url="http://browser",
            ) as browser:
                first = asyncio.create_task(
                    browser.post("/geoserver/eolab/wms", data=query)
                )
                await started.wait()
                second = asyncio.create_task(
                    browser.post("/geoserver/eolab/wms", data=query)
                )
                await both_admitted.wait()
                release.set()
                responses = await asyncio.gather(first, second)
                assert upstream_count == 1
                assert authorization_count == 2
                for response in responses:
                    assert response.status_code == 200
                    assert response.headers["content-type"] == (
                        "application/json"
                        if calculated
                        else "application/json; charset=UTF-16"
                    )
                    assert response.headers["cache-control"] == "private, no-store"
                    assert response.headers["x-content-type-options"] == "nosniff"
                    assert "set-cookie" not in response.headers
                    properties = response.json()["features"][0]["properties"]
                    assert properties["name"] == "Forêt"
                    if calculated:
                        assert properties["double_rank"] == 4
                        assert not response.content.startswith(b"\xff\xfe")
                    else:
                        assert response.content == native_content
                        assert response.headers["etag"] == '"feature-bounds"'
                assert dict(native_response.headers) == original_headers
                assert native_response.content == native_content
        await queue.close()

    asyncio.run(asyncio.wait_for(scenario(), 5))
