"""Check saved-map wire validation and the HTTP boundary without other services."""

from copy import deepcopy
import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from eolab_app.routes.saved_maps import create_saved_maps_router
from eolab_app.saved_maps.models import CreateSavedMap, MAX_REQUEST_BYTES
from eolab_app.saved_maps.store import SavedMapStore
from eolab_app.settings import load_settings

VIEW = json.loads(
    (Path(__file__).parent / "fixtures" / "saved-map-v1.json").read_text()
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
        ("schemaVersion", 2),
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
    """Reject duplicate items, source paths, null filters, invalid numbers and huge JSON."""
    mutations = []
    duplicate = map_request()
    duplicate["view"]["layers"].append(deepcopy(duplicate["view"]["layers"][0]))
    mutations.append(duplicate)
    for key, value in [
        ("path", "/source/data.tif"),
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
    huge["view"]["layers"][0]["style"]["definition"]["text"] = "a" * (512 * 1024)
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
