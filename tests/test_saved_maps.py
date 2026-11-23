"""Check saved-map wire validation and the HTTP boundary without other services."""

from copy import deepcopy
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from eolab_app.routes.saved_maps import (
    create_saved_maps_admin_router,
    create_saved_maps_router,
)
from eolab_app.saved_maps.models import CreateSavedMap, MAX_REQUEST_BYTES
from eolab_app.saved_maps.store import SavedMapStore
from eolab_app.settings import load_settings

VIEW = json.loads(
    (Path(__file__).parent / "fixtures" / "saved-map-catalog.json").read_text()
)
HEADERS = {"X-EOLab-Saved-Maps": "1"}
BASE = "/api/saved-maps"


def map_request(slug: str = "amazon-priorities") -> dict[str, Any]:
    """Build independent request JSON from the browser/server parity fixture.

    Args:
        slug: URL name for the new map.

    Returns:
        New request dictionary, safe for each test to modify.
    """
    return {"slug": slug, "title": "Amazon priorities", "view": deepcopy(VIEW)}


def test_browser_document_round_trip() -> None:
    """Keep optional fields absent and preserve the existing browser wire document."""
    result = CreateSavedMap.model_validate(map_request())
    assert result.model_dump(mode="json", exclude_unset=True) == map_request()
    for version in (1, 2, 3, 4, 6):
        request = map_request()
        request["view"].update(schemaVersion=version, layers=[])
        if version >= 3:
            request["view"]["basemap"] = "none"
        else:
            request["view"].pop("basemap", None)
        with pytest.raises(ValidationError, match="schemaVersion"):
            CreateSavedMap.model_validate(request)


def test_calculated_fields_and_private_results_round_trip() -> None:
    """Persist ordered definitions and private references without source data."""
    candidate = map_request()
    candidate["view"].update(basemap="detailed")
    fields = [
        {
            "version": 1,
            "name": "Density",
            "expression": "'Population' / 'Area km2'",
            "numericText": False,
        }
    ]
    presentation = {
        "isCustom": True,
        "visible": True,
        "opacity": 1,
        "calculatedFields": fields,
        "style": {"kind": "vector", "definition": {"graduated": {"field": "Density"}}},
        "filter": {
            "enabled": True,
            "match": "all",
            "rules": [{"field": "Density", "operator": "gt", "value": 2}],
        },
    }
    candidate["view"]["layers"] = [
        {**presentation, "catalogItem": {"collection": "vectors", "id": "regions"}},
        {
            **presentation,
            "uploadId": "12345678-1234-1234-1234-123456789abc",
        },
        {
            **presentation,
            "runArtifact": {
                "jobId": "a" * 32,
                "artifactId": "b" * 32,
                "layerName": "results",
            },
        },
    ]
    parsed = CreateSavedMap.model_validate(candidate)
    assert parsed.model_dump(mode="json", exclude_unset=True) == candidate
    assert (
        CreateSavedMap.model_validate_json(
            parsed.model_dump_json(exclude_unset=True)
        ).model_dump(mode="json", exclude_unset=True)
        == candidate
    )
    for invalid_field in (
        {**fields[0], "values": [1, 2]},
        {**fields[0], "numericText": "true"},
    ):
        invalid = deepcopy(candidate)
        invalid["view"]["layers"][0]["calculatedFields"] = [invalid_field]
        with pytest.raises(ValidationError):
            CreateSavedMap.model_validate(invalid)


def test_raster_upload_view_round_trip_preserves_private_source_and_style() -> None:
    """Persist an opaque raster upload without publishing data or vector predicates."""
    candidate = map_request()
    view = candidate["view"]
    view["basemap"] = "none"
    layer = view["layers"][0]
    layer.pop("catalogItem")
    layer.update(uploadId="12345678-1234-1234-1234-123456789abc", isCustom=True)
    view["layers"] = [layer]
    parsed = CreateSavedMap.model_validate(candidate)
    assert parsed.model_dump(mode="json", exclude_unset=True) == candidate
    layer["calculatedFields"] = [
        {
            "version": 1,
            "name": "Density",
            "expression": "'Population' / 'Area km2'",
            "numericText": False,
        }
    ]
    with pytest.raises(
        ValidationError, match="Calculated fields require a vector layer"
    ):
        CreateSavedMap.model_validate(candidate)
    del layer["calculatedFields"]
    layer["filter"] = {"field": "class", "value": 1}
    with pytest.raises(
        ValidationError, match="Raster uploads do not support vector filters"
    ):
        CreateSavedMap.model_validate(candidate)


def test_repeated_catalog_views_round_trip() -> None:
    """Preserve duplicate raster and vector views while keeping polygon view IDs unique."""
    candidate = map_request()
    raster, vector = candidate["view"]["layers"]
    second_raster = deepcopy(raster)
    second_raster.update(customName="Impact comparison", opacity=0.3)
    second_raster["style"]["continuous"]["definition"]["minimumColor"] = "#FFFFFF"
    second_vector = deepcopy(vector)
    second_vector.update(customName="Brazil", visible=True, legendIncluded=False)
    second_vector["filterViewId"] = "00000000-0000-4000-8000-000000000042"
    second_vector["style"]["definition"]["color"] = "#123456"
    second_vector["filter"] = {"field": "ISO3", "value": "BRA"}
    candidate["view"]["layers"] = [raster, second_vector, second_raster, vector]
    parsed = CreateSavedMap.model_validate(candidate)
    assert parsed.model_dump(mode="json", exclude_unset=True) == candidate
    assert (
        CreateSavedMap.model_validate_json(
            parsed.model_dump_json(exclude_unset=True)
        ).model_dump(mode="json", exclude_unset=True)
        == candidate
    )
    vector["filterViewId"] = second_vector["filterViewId"]
    with pytest.raises(ValidationError, match="needs its own ID"):
        CreateSavedMap.model_validate(candidate)


def test_temporal_views_preserve_explicit_selections_and_independent_appearance() -> (
    None
):
    """Round-trip repeated observations without accepting paths or rendering state."""
    candidate = map_request()
    candidate["view"].update(basemap="detailed")
    layer = {
        "temporalSource": {
            "collectionId": "eolab-temporal-datasets",
            "itemId": "era5",
            "variable": "air_temperature",
            "time": "2020-01-15T04:00:00-08:00",
        },
        "customName": "Temperature",
        "visible": True,
        "opacity": 0.6,
        "legendIncluded": False,
        "style": deepcopy(VIEW["layers"][0]["style"]),
    }
    candidate["view"]["layers"] = [layer, deepcopy(layer)]
    candidate["view"]["layers"][1].update(customName="Comparison", opacity=0.3)
    document = CreateSavedMap.model_validate(candidate).model_dump(
        mode="json", exclude_unset=True
    )
    for expected in candidate["view"]["layers"]:
        expected["temporalSource"]["time"] = "2020-01-15T12:00:00.000Z"
    assert document == candidate
    assert (
        CreateSavedMap.model_validate_json(json.dumps(document)).model_dump(
            mode="json", exclude_unset=True
        )
        == document
    )

    for replacement in (None, "bad date", "2020-01-15T12:00:00"):
        invalid = deepcopy(candidate)
        invalid["view"]["layers"][0]["temporalSource"]["time"] = replacement
        with pytest.raises(ValidationError):
            CreateSavedMap.model_validate(invalid)
    for field in ("path", "publication", "viewId"):
        invalid = deepcopy(candidate)
        invalid["view"]["layers"][0]["temporalSource"][field] = "not saved"
        with pytest.raises(ValidationError):
            CreateSavedMap.model_validate(invalid)
    invalid = deepcopy(candidate)
    invalid["view"]["layers"][0]["style"] = {"kind": "vector", "definition": {}}
    with pytest.raises(ValidationError):
        CreateSavedMap.model_validate(invalid)
    invalid = deepcopy(candidate)
    invalid["view"]["layers"][0]["filter"] = {}
    with pytest.raises(ValidationError):
        CreateSavedMap.model_validate(invalid)


def test_private_upload_reference_contract() -> None:
    """Preserve separate upload views without accepting source data or credentials."""
    candidate = map_request()
    candidate["view"].update(basemap="detailed")
    candidate["view"]["layers"] = [
        {
            "uploadId": "11111111-1111-4111-8111-111111111111",
            "customName": "Wetlands",
            "visible": False,
            "opacity": 0.4,
            "legendIncluded": False,
            "style": {"kind": "vector", "definition": {"fillColor": "#123456"}},
            "filter": {
                "enabled": True,
                "match": "all",
                "rules": [
                    {"field": "label", "operator": "eq", "value": "Café wetlands"}
                ],
            },
        }
    ]
    second_view = deepcopy(candidate["view"]["layers"][0])
    second_view.update(
        customName="All wetlands", visible=True, opacity=0.8, isDuplicate=True
    )
    second_view["style"]["definition"]["fillColor"] = "#ABCDEF"
    del second_view["filter"]
    candidate["view"]["layers"].append(second_view)
    parsed = CreateSavedMap.model_validate(candidate)
    assert parsed.model_dump(mode="json", exclude_unset=True) == candidate
    assert (
        CreateSavedMap.model_validate_json(
            parsed.model_dump_json(exclude_unset=True)
        ).model_dump(mode="json", exclude_unset=True)
        == candidate
    )
    for field in (
        "catalogItem",
        "sourcePath",
        "fields",
        "features",
        "browserHash",
        "publication",
    ):
        invalid = deepcopy(candidate)
        invalid["view"]["layers"][0][field] = "not part of a map reference"
        with pytest.raises(ValidationError):
            CreateSavedMap.model_validate(invalid)
    invalid = deepcopy(candidate)
    invalid["view"]["layers"][0]["uploadId"] = "../private.gpkg"
    with pytest.raises(ValidationError):
        CreateSavedMap.model_validate(invalid)
    invalid = deepcopy(candidate)
    invalid["view"]["layers"][0]["style"] = deepcopy(VIEW["layers"][0]["style"])
    with pytest.raises(ValidationError):
        CreateSavedMap.model_validate(invalid)


def test_custom_layer_name_round_trip() -> None:
    """Keep custom names as presentation text while preserving catalog identities."""
    candidate = map_request()
    layer = candidate["view"]["layers"][0]
    original_identity = deepcopy(layer["catalogItem"])
    layer["customName"] = "  Protected areas <custom>  "
    parsed = CreateSavedMap.model_validate(candidate)
    exported = parsed.model_dump(mode="json", exclude_unset=True)["view"]["layers"][0]
    assert exported["customName"] == "Protected areas <custom>"
    assert exported["catalogItem"] == original_identity
    for value in ("", " ", "x" * 161, 4, {}):
        layer["customName"] = value
        with pytest.raises(ValidationError):
            CreateSavedMap.model_validate(candidate)
    layer["customName"] = "🌲" * 160
    assert (
        CreateSavedMap.model_validate(candidate).view.layers[0].customName
        == layer["customName"]
    )
    layer["customName"] = None
    assert CreateSavedMap.model_validate(candidate).view.layers[0].customName is None


@pytest.mark.parametrize("basemap_id", ["maptiler", "maptiler-streets"])
def test_subtitle_and_basemap_contract(basemap_id: str) -> None:
    """Store an optional subtitle and only a provider ID in saved maps.

    Args:
        basemap_id: Selected MapTiler basemap identifier.
    """
    candidate = map_request()
    candidate["subtitle"] = "  Explore habitat  "
    candidate["view"].update(basemap=basemap_id)
    parsed = CreateSavedMap.model_validate(candidate)
    assert parsed.subtitle == "Explore habitat"
    assert parsed.view.basemap == basemap_id
    exported = parsed.model_dump(mode="json", exclude_unset=True)
    assert exported["view"]["basemap"] == basemap_id
    candidate["subtitle"] = ""
    assert CreateSavedMap.model_validate(candidate).subtitle == ""
    candidate["view"]["basemap"] = "https://tiles.example/secret-key"
    with pytest.raises(ValidationError):
        CreateSavedMap.model_validate(candidate)
    candidate["view"].pop("basemap")
    with pytest.raises(ValidationError, match="basemap"):
        CreateSavedMap.model_validate(candidate)
    candidate["view"]["basemap"] = "none"
    candidate["subtitle"] = "x" * 241
    with pytest.raises(ValidationError):
        CreateSavedMap.model_validate(candidate)


def test_shared_annotation_reference_contract() -> None:
    """Round-trip the browser fixture while rejecting credentials and copied polygons."""
    view = json.loads(
        (Path(__file__).parent / "fixtures" / "saved-map-shared.json").read_text()
    )
    request = {"title": "Shared map", "slug": "shared-map", "view": view}
    assert (
        CreateSavedMap.model_validate(request).model_dump(
            mode="json", exclude_unset=True
        )
        == request
    )
    for field in (
        "features",
        "credential",
        "contributorId",
        "browserHash",
        "collection",
    ):
        candidate = deepcopy(request)
        candidate["view"]["layers"][0]["sharedAnnotation"][field] = "private"
        with pytest.raises(ValidationError):
            CreateSavedMap.model_validate(candidate)
    for notes in (False, True):
        candidate = deepcopy(request)
        candidate["view"].update(schemaVersion=5, basemap="none")
        candidate["view"]["layers"][0]["appearance"]["notes"] = notes
        with pytest.raises(ValidationError, match="notes"):
            CreateSavedMap.model_validate(candidate)
    candidate = deepcopy(request)
    candidate["view"]["layers"] *= 2
    with pytest.raises(ValidationError, match="duplicate"):
        CreateSavedMap.model_validate(candidate)


@pytest.mark.parametrize("source", ["annotation", "upload", "artifact", "drawing"])
def test_foreign_layer_reference_rejected_before_storage(source: str) -> None:
    """Reject saved drawings, private sources and invitations from another site.

    Args:
        source: Saved layer reference to exercise through create and edit routes.
    """
    view = json.loads(
        (Path(__file__).parent / "fixtures" / "saved-map-shared.json").read_text()
    )
    if source == "drawing":
        view = json.loads(
            (Path(__file__).parent / "fixtures" / "saved-map-v5.json").read_text()
        )
    elif source == "upload":
        view.update(basemap="detailed")
        view["layers"] = [
            {
                "uploadId": "11111111-1111-4111-8111-111111111111",
                "visible": True,
                "opacity": 1,
                "style": {"kind": "vector", "definition": {}},
            }
        ]
    elif source == "artifact":
        view.update(basemap="detailed")
        view["layers"] = [
            {
                "runArtifact": {
                    "jobId": "a" * 32,
                    "artifactId": "b" * 32,
                    "layerName": "results",
                },
                "visible": True,
                "opacity": 1,
                "style": {"kind": "vector", "definition": {}},
            }
        ]
    view["viewer"]["origin"] = "https://another-site.example"
    app = FastAPI()
    app.include_router(create_saved_maps_router(object()))
    app.include_router(
        create_saved_maps_admin_router(object(), "test-map-administrator")
    )
    response = TestClient(app, base_url="https://testserver").post(
        BASE,
        headers=HEADERS,
        json={"title": "Foreign", "slug": "foreign", "view": view},
    )
    assert response.status_code == 422
    assert "this EOLab site" in response.json()["detail"]
    response = TestClient(app, base_url="https://testserver").put(
        "/api/admin/saved-maps/foreign",
        headers={"X-EOLab-Admin": "1"},
        auth=("admin", "test-map-administrator"),
        json={"title": "Foreign", "slug": "foreign", "view": view, "revision": 1},
    )
    assert response.status_code == 422
    assert "this EOLab site" in response.json()["detail"]


@pytest.mark.parametrize(
    "slug", ["", "Uppercase", "../file", "a/b", "a--b", "-a", "a-", "a" * 81]
)
def test_invalid_url_names(slug: str) -> None:
    """Reject ambiguous or path-like URL names.

    Args:
        slug: Invalid URL name.
    """
    with pytest.raises(ValidationError):
        CreateSavedMap.model_validate(map_request(slug))


@pytest.mark.parametrize(
    "origin",
    [
        "https://site.example/path",
        "https://site.example/",
        "https://u:p@site.example",
        "https://site.example?x=1",
        "file:///tmp/map",
        "null",
    ],
)
def test_origin_is_only_a_site(origin: str) -> None:
    """Require the canonical site origin used by browser exports.

    Args:
        origin: Invalid origin candidate.
    """
    candidate = map_request()
    candidate["view"]["viewer"]["origin"] = origin
    with pytest.raises(ValidationError):
        CreateSavedMap.model_validate(candidate)


@pytest.mark.parametrize(
    "field,value",
    [
        ("schemaVersion", True),
        ("schemaVersion", 4),
        ("createdAt", "bad date"),
        ("layers", [{}] * 51),
    ],
)
def test_invalid_map_documents(field: str, value: Any) -> None:
    """Reject unsupported formats and malformed dates or layer lists.

    Args:
        field: Document field to replace.
        value: Invalid field content.
    """
    candidate = map_request()
    candidate["view"][field] = value
    with pytest.raises(ValidationError):
        CreateSavedMap.model_validate(candidate)


def test_layer_and_size_boundaries() -> None:
    """Reject source paths, null filters, invalid numbers and huge JSON."""
    mutations = []
    for key, value in [
        ("path", "/source/data.tif"),
        ("sourceRevision", None),
        ("sourceRevision", "sha256:" + "a" * 64),
        ("filter", None),
        ("opacity", "1"),
        ("visible", 1),
        ("opacity", float("nan")),
        ("filter", {"x": "a" * 8192}),
    ]:
        candidate = map_request()
        candidate["view"]["layers"][0][key] = value
        mutations.append(candidate)
    huge = map_request()
    huge["view"]["layers"][0]["style"]["continuous"]["definition"]["text"] = "a" * (
        512 * 1024
    )
    mutations.append(huge)
    for candidate in mutations:
        with pytest.raises(ValidationError):
            CreateSavedMap.model_validate(candidate)


def test_http_validation_and_storage_outage() -> None:
    """Reject invalid uploads before storage and keep unrelated routes usable on outage."""
    app = FastAPI()
    app.include_router(
        create_saved_maps_router(
            SavedMapStore("host=127.0.0.1 port=1 dbname=unavailable")
        )
    )
    client = TestClient(app)
    assert client.post(BASE, json=map_request()).status_code == 422
    assert (
        client.post(
            BASE,
            headers={**HEADERS, "Origin": "https://other.example"},
            json=map_request(),
        ).status_code
        == 403
    )
    assert (
        client.post(
            BASE, headers=HEADERS, content=b"x" * (MAX_REQUEST_BYTES + 1)
        ).status_code
        == 413
    )
    assert client.post(BASE, headers=HEADERS, content="{").status_code == 422
    assert (
        client.post(
            BASE, headers=HEADERS, content="[" * 2000 + "0" + "]" * 2000
        ).status_code
        == 422
    )
    assert (
        client.post(BASE, headers=HEADERS, json=map_request("bad/name")).status_code
        == 422
    )
    with client:
        response = client.post(BASE, headers=HEADERS, json=map_request())
        assert response.status_code == 503
        assert "unavailable" in response.json()["detail"]
        assert "127.0.0.1" not in response.text
        assert client.get("/openapi.json").status_code == 200
        assert client.get(BASE + "/unknown").status_code == 503


def test_bad_store_configuration() -> None:
    """Fail early on a nonsensical site capacity."""
    with pytest.raises(ValueError, match="positive"):
        SavedMapStore(capacity=0)


def test_capacity_environment(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Allow deployments to raise capacity and reject invalid configuration.

    Args:
        configured_environment: Required application environment.
        version_file_path: Test application version file.
        monkeypatch: Temporary environment overrides.
    """
    monkeypatch.delenv("SAVED_MAP_CAPACITY", raising=False)
    assert load_settings(version_file_path).saved_map_capacity == 1000
    monkeypatch.setenv("SAVED_MAP_CAPACITY", "5000")
    assert load_settings(version_file_path).saved_map_capacity == 5000
    monkeypatch.setenv("SAVED_MAP_CAPACITY", "0")
    with pytest.raises(ValueError, match="SAVED_MAP_CAPACITY"):
        load_settings(version_file_path)


def test_map_legend_preferences_round_trip() -> None:
    """Persist optional legend choices for both layer types without weakening validation."""
    candidate = map_request()
    candidate["view"] = json.loads(
        (Path(__file__).parent / "fixtures" / "saved-map-shared.json").read_text()
    )
    candidate["view"]["mapLegend"] = {"visible": False, "collapsed": True}
    for layer in candidate["view"]["layers"]:
        layer["legendIncluded"] = False
    parsed = CreateSavedMap.model_validate(candidate)
    assert parsed.model_dump(mode="json", exclude_unset=True) == candidate
    for value in (None, "false", 0, {}):
        invalid = deepcopy(candidate)
        invalid["view"]["mapLegend"] = value
        with pytest.raises(ValidationError):
            CreateSavedMap.model_validate(invalid)
        for index in range(len(candidate["view"]["layers"])):
            invalid = deepcopy(candidate)
            invalid["view"]["layers"][index]["legendIncluded"] = value
            with pytest.raises(ValidationError):
                CreateSavedMap.model_validate(invalid)


def test_visitor_controls_validate_and_round_trip() -> None:
    """Keep disabled-parent children and missing choices in the stored map document."""
    candidate = map_request()
    candidate["view"]["visitorControls"] = {
        "version": 1,
        "choices": {"inspectAndSelect": False, "featurePicking": True, "lasso": True},
    }
    saved = CreateSavedMap.model_validate(candidate)
    assert saved.model_dump(mode="json", exclude_unset=True) == candidate
    assert saved.view.visitorControls is not None
    assert saved.view.visitorControls.choices.rasterValues is False
    for visitor_controls in (
        None,
        {},
        {"version": 2, "choices": {}},
        {"version": True, "choices": {}},
        {"version": 1, "choices": []},
        {"version": 1, "choices": {"lasso": "true"}},
        {"version": 1, "choices": {"zoom": True}},
        {"version": 1, "choices": {}, "unknown": True},
    ):
        with pytest.raises(ValidationError):
            CreateSavedMap.model_validate(
                {
                    **candidate,
                    "view": {**candidate["view"], "visitorControls": visitor_controls},
                }
            )


def test_versioned_raster_appearance_round_trip() -> None:
    """Preserve both raster configurations and optional category state unchanged."""
    candidate = map_request()
    candidate["view"] = json.loads(
        (Path(__file__).parent / "fixtures" / "saved-map-categorical.json").read_text()
    )
    for mode in ("categorical", "continuous"):
        candidate["view"]["layers"][0]["style"]["mode"] = mode
        parsed = CreateSavedMap.model_validate(candidate)
        assert parsed.model_dump(mode="json", exclude_unset=True) == candidate
    candidate["view"]["layers"][0]["style"]["categorical"] = None
    parsed = CreateSavedMap.model_validate(candidate)
    assert parsed.model_dump(mode="json", exclude_unset=True) == candidate


@pytest.mark.parametrize(
    "path,value",
    [
        (("appearanceVersion",), 2),
        (("appearanceVersion",), True),
        (("appearanceVersion",), None),
        (("mode",), "unknown"),
        (("definition",), {}),
        (("continuous",), None),
        (("continuous", "styleWasEdited"), "false"),
        (("continuous", "paletteName"), "x" * 101),
        (("continuous", "definition"), {"text": "x" * 65536}),
        (("categorical",), None),
        (("categorical",), {"text": "🌲" * 17000}),
    ],
)
def test_versioned_raster_appearance_boundaries(
    path: tuple[str, ...], value: Any
) -> None:
    """Keep the portable envelope strict without importing raster semantics.

    Args:
        path: Appearance field to replace or append.
        value: Invalid scalar, mixed-envelope field, or oversized definition.
    """
    candidate = map_request()
    candidate["view"] = json.loads(
        (Path(__file__).parent / "fixtures" / "saved-map-categorical.json").read_text()
    )
    target = candidate["view"]["layers"][0]["style"]
    for part in path[:-1]:
        target = target[part]
    target[path[-1]] = value
    with pytest.raises(ValidationError):
        CreateSavedMap.model_validate(candidate)


def test_versioned_raster_appearance_requires_all_envelope_fields() -> None:
    """Reject incomplete and unversioned raster appearance in imported maps."""
    candidate = map_request()
    candidate["view"] = json.loads(
        (Path(__file__).parent / "fixtures" / "saved-map-categorical.json").read_text()
    )
    for field in ("appearanceVersion", "mode", "continuous", "categorical"):
        invalid = deepcopy(candidate)
        del invalid["view"]["layers"][0]["style"][field]
        with pytest.raises(ValidationError):
            CreateSavedMap.model_validate(invalid)
    candidate["view"]["layers"][0]["style"] = {
        "kind": "raster",
        "definition": {"minimum": 0, "maximum": 1},
        "paletteName": "viridis",
    }
    with pytest.raises(ValidationError):
        CreateSavedMap.model_validate(candidate)
