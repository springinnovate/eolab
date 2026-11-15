"""Exercise calculated attributes through native reading and authorized WMS delivery."""

import asyncio
import json
from pathlib import Path
from threading import Event
from urllib.parse import parse_qsl

import fiona
import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.calculated_fields import CalculatedField
from eolab_app.rendering.errors import PublishedLayerRequestError
from eolab_app.rendering.render_queue import GeoServerRenderQueue
from eolab_app.diagnostics.tracker import GetMapRequestTracker
from eolab_app.routes.wms_proxy import create_wms_proxy_router
from eolab_app.vector.fields import OgrVectorFieldReader
from eolab_app.vector.filters import VectorFilter, filter_ecql, filter_vector_sld
from eolab_app.vector.models import (
    ResolvedVectorSource,
    VectorLayer,
    VectorStyle,
    with_calculated_fields,
)
from eolab_app.vector.sources import PublishedVectorRegistry
from eolab_app.vector.styles import (
    build_vector_sld,
    default_vector_style,
    vector_style_name,
)
from eolab_app.vector.styling import VectorStyleService
from tests.test_vector_styling import RecordingStyler

DEFINITIONS = (
    CalculatedField(
        name="raw density", expression="'people text' / 'area km2'", numericText=True
    ),
    CalculatedField(name="density", expression="'raw density' * 2 + 1"),
)


def calculated_style() -> VectorStyle:
    """Return the graduated appearance used by Python and native rendering fixtures.

    Returns:
        Two numeric classes and a distinct missing-value color.
    """
    return VectorStyle.model_validate(
        {
            **default_vector_style("polygon").model_dump(by_alias=True),
            "graduated": {
                "field": "density",
                "method": "equal-interval",
                "classCount": 2,
                "palette": "blues",
                "rules": [
                    {"minimum": None, "maximum": 20, "color": "#112233"},
                    {"minimum": 20, "maximum": None, "color": "#445566"},
                ],
                "missingColor": "#778899",
            },
        }
    )


def test_native_sld_fixture_uses_production_compiler() -> None:
    """Keep the native parsed/rendered fixture identical to production SLD generation."""
    document = build_vector_sld(
        "calculated", calculated_style(), calculated_fields=DEFINITIONS
    )
    fixture = (
        Path(__file__).parents[1]
        / "geoserver/reader-assessment/src/test/resources/vector-calculated-fields.sld"
    )
    assert fixture.read_bytes() == document


def test_calculated_source_read_classification_filter_and_source_identity(
    tmp_path: Path,
) -> None:
    """Classify and filter computed values while retaining the original geometry and attributes.

    Args:
        tmp_path: Isolated source location.
    """
    path = tmp_path / "source.gpkg"
    rows = [("8", 2), (" 1e2 ", 4), (None, 2), ("5", 0), ("12abc", 2)]
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="parcels",
        crs="EPSG:4326",
        schema={
            "geometry": "Polygon",
            "properties": {"people text": "str", "area km2": "float"},
        },
    ) as sink:
        for people, area in rows:
            sink.write(
                {
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[(0, 0), (1, 0), (1, 1), (0, 0)]],
                    },
                    "properties": {"people text": people, "area km2": float(area)},
                }
            )
    original = ResolvedVectorSource("mounted", "geopackage", path, "data", "parcels")
    layer = VectorLayer(
        "parcels",
        original,
        {"people text": "str", "area km2": "float"},
        5,
        (0, 0, 1, 1),
        "polygon",
    )
    view = with_calculated_fields(layer, DEFINITIONS)
    reader = OgrVectorFieldReader()
    values = reader.read_numbers(view.source, "density", 100, Event())
    assert values.values == (9, 51)
    assert values.null_count == 3
    registry = PublishedVectorRegistry()
    registry.authorize("eolab:parcels", original, "vector-polygon")
    service = VectorStyleService(None, None, RecordingStyler(), registry, reader)
    summary = asyncio.run(
        service.classify_layer_numeric(view, "density", "equal-interval", 2)
    )
    assert summary.observed_minimum == 9
    assert summary.observed_maximum == 51
    assert summary.null_count == 3
    applied = asyncio.run(service.apply_layer_style(view, calculated_style()))
    assert applied.style_name == registry.require_current(
        "eolab:parcels"
    ).sign_style_name(
        vector_style_name("parcels", calculated_style(), calculated_fields=DEFINITIONS)
    )
    predicate = VectorFilter(
        enabled=True, rules=[{"field": "density", "operator": "ge", "value": 20}]
    )
    counts = reader.count_filter(view.source, predicate, 100, Event())
    assert (counts.matched, counts.total) == (1, 5)
    assert view.source == original
    assert "density" not in layer.fields
    with fiona.open(path, layer="parcels") as source:
        assert list(source.schema["properties"]) == ["people text", "area km2"]
        assert [feature.properties["people text"] for feature in source] == [
            row[0] for row in rows
        ]


def test_signed_view_context_isolates_filter_rendering_and_inspection(
    tmp_path: Path,
) -> None:
    """Bind formulas to source/style identity and preserve consistent inspection/filter values.

    Args:
        tmp_path: Source identity location; this test does not read its file.
    """
    source = ResolvedVectorSource(
        "mounted", "geopackage", tmp_path / "source.gpkg", "data", "parcels"
    )
    registry = PublishedVectorRegistry()
    registry.authorize("eolab:parcels", source, "vector-polygon")
    style = calculated_style()
    name = registry.authorize_style(
        "eolab:parcels",
        source,
        vector_style_name("parcels", style, calculated_fields=DEFINITIONS),
    )
    predicate = VectorFilter(
        enabled=True, rules=[{"field": "density", "operator": "ge", "value": 20}]
    )
    alias = registry.authorize_filter("eolab:parcels", predicate, DEFINITIONS)
    changed = (
        DEFINITIONS[0],
        DEFINITIONS[1].model_copy(update={"expression": "'raw density' * 3"}),
    )
    assert registry.authorize_filter("eolab:parcels", predicate, changed) != alias
    authorization = registry.require_current(alias)
    query = {
        "layers": alias,
        "query_layers": alias,
        "styles": name,
        "vector_style": style.model_dump_json(by_alias=True),
        "vector_calculated_fields": json.dumps(
            [value.model_dump() for value in DEFINITIONS]
        ),
        "propertyname": "density",
    }
    forwarded = dict(authorization.prepare_query("getfeatureinfo", list(query.items())))
    assert forwarded["layers"] == "eolab:parcels"
    assert "propertyname" not in forwarded
    assert "vector_calculated_fields" not in forwarded
    assert "eolabArithmetic" in forwarded["sld_body"]
    assert forwarded["cql_filter"] == filter_ecql(predicate, DEFINITIONS)
    content = json.dumps(
        {
            "type": "FeatureCollection",
            "features": [
                {
                    "id": "parcels.3",
                    "properties": {"people text": " 1e2 ", "area km2": 4},
                },
                {
                    "id": "parcels.4",
                    "properties": {"people text": "12abc", "area km2": 2},
                },
            ],
        }
    ).encode()
    result = json.loads(authorization.prepare_feature_info(content, query))
    assert [value["properties"]["density"] for value in result["features"]] == [
        51,
        None,
    ]
    assert result["features"][0]["id"] == "parcels.3"
    altered = {
        **query,
        "vector_calculated_fields": json.dumps(
            [value.model_dump() for value in changed]
        ),
    }
    with pytest.raises(PublishedLayerRequestError, match="do not match"):
        authorization.prepare_query("getmap", list(altered.items()))
    composite = authorization.build_composite_sld(
        alias, name, None, style.model_dump(by_alias=True), 1, DEFINITIONS
    )
    assert composite == filter_vector_sld(
        build_vector_sld(
            name, style, layer_name="eolab:parcels", calculated_fields=DEFINITIONS
        ),
        predicate,
        DEFINITIONS,
    )
    with pytest.raises(PublishedLayerRequestError):
        registry.require_current("eolab:parcels").prepare_query(
            "getmap",
            list(
                {**query, "layers": "eolab:parcels", "styles": "vector-polygon"}.items()
            ),
        )


def test_wms_inspection_transforms_only_approved_context(tmp_path: Path) -> None:
    """Use the real WMS route to reject tampering and return calculated feature values.

    Args:
        tmp_path: Source identity location; upstream reads are provided by the fixture.
    """
    source = ResolvedVectorSource(
        "mounted", "geopackage", tmp_path / "source.gpkg", "data", "parcels"
    )
    registry = PublishedVectorRegistry()
    registry.authorize("eolab:parcels", source, "vector-polygon")
    style = default_vector_style("polygon")
    name = registry.authorize_style(
        "eolab:parcels",
        source,
        vector_style_name("parcels", style, calculated_fields=DEFINITIONS),
    )
    alias = registry.authorize_filter("eolab:parcels", VectorFilter(), DEFINITIONS)
    assert registry.require_current(alias).filter is None
    captured: list[dict[str, str]] = []

    def upstream(request: httpx2.Request) -> httpx2.Response:
        """Return original attributes after recording the prepared native request.

        Args:
            request: Authorized request forwarded by the real WMS route.

        Returns:
            Native feature information with stable feature identity and raw fields.
        """
        captured.append(dict(parse_qsl(request.content.decode())))
        return httpx2.Response(
            200,
            json={
                "type": "FeatureCollection",
                "features": [
                    {
                        "id": "parcels.7",
                        "properties": {"people text": "8", "area km2": 2},
                    },
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
    query = {
        "service": "WMS",
        "version": "1.1.1",
        "request": "GetFeatureInfo",
        "layers": alias,
        "query_layers": alias,
        "styles": name,
        "srs": "EPSG:4326",
        "bbox": "-1,-1,2,2",
        "width": "256",
        "height": "256",
        "format": "image/png",
        "info_format": "application/json",
        "x": "128",
        "y": "128",
        "vector_style": style.model_dump_json(by_alias=True),
        "vector_calculated_fields": json.dumps(
            [value.model_dump() for value in DEFINITIONS]
        ),
        "propertyname": "density",
    }
    with TestClient(app) as browser:
        response = browser.post("/geoserver/eolab/wms", data=query)
        assert response.status_code == 200
        assert response.json()["features"][0]["properties"]["density"] == 9
        assert "propertyname" not in captured[0]
        assert "cql_filter" not in captured[0]
        tampered = {**query, "vector_calculated_fields": "[]"}
        assert browser.post("/geoserver/eolab/wms", data=tampered).status_code == 400
        assert len(captured) == 1
    asyncio.run(client.aclose())
