"""Validate original drawn-source identity and the shared editable polygon contract."""

import ast
import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from pydantic import ValidationError
import pytest

from eolab_app.annotation_sessions.models import AnnotationFeature
from eolab_app.drawings.models import (
    CreateDrawingLayer,
    DrawingCollection,
    DrawingFeature,
    UpdateDrawingLayer,
)

ADMISSION_CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "drawing-admission.json").read_text(
        encoding="utf-8"
    )
)


def collection(name: str = "Drawn parcels") -> dict[str, Any]:
    """Return two original polygons with duplicate labels and distinct stable IDs.

    Args:
        name: Source name, independent of either polygon's label.

    Returns:
        Full GeoJSON drawing collection accepted by the editor and source API.
    """
    return {
        "type": "FeatureCollection",
        "name": name,
        "features": [
            {
                "type": "Feature",
                "id": "parcel-a",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 0]]],
                },
                "properties": {"name": "Priority", "note": "Existing forest"},
            },
            {
                "type": "Feature",
                "id": "parcel-b",
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[3, 0], [5, 0], [5, 2], [3, 0]]],
                },
                "properties": {"name": "Priority", "note": "Restoration area"},
            },
        ],
    }


def test_drawn_ids_survive_source_roundtrip_and_do_not_depend_on_labels() -> None:
    """Keep IDs when polygons are reordered, renamed, reshaped, deleted and restored."""
    original = collection("  Drawn parcels  ")
    original["features"][0]["properties"]["name"] = " Priority "
    admitted = DrawingCollection.model_validate(original)
    assert admitted.model_dump(mode="json") == original
    changed = deepcopy(original)
    changed["features"].reverse()
    changed["features"][0]["properties"]["name"] = "Changed label"
    changed["features"][0]["geometry"]["coordinates"][0][1] = [6, 0]
    updated = UpdateDrawingLayer(expectedRevision=1, collection=changed)
    assert [feature.id for feature in updated.collection.features] == [
        "parcel-b",
        "parcel-a",
    ]
    assert updated.collection.features[0].properties.name == "Changed label"
    changed["features"].pop()
    assert DrawingCollection.model_validate(changed).features[0].id == "parcel-b"
    assert [
        feature.id for feature in DrawingCollection.model_validate(original).features
    ] == ["parcel-a", "parcel-b"]


def test_source_names_preserve_text_but_reject_blank_labels() -> None:
    """Reject blank source and polygon names without trimming valid imported labels."""
    for blank in ("", " \t\n"):
        with pytest.raises(ValidationError):
            DrawingCollection.model_validate(collection(blank))
        document = collection()
        document["features"][0]["properties"]["name"] = blank
        with pytest.raises(ValidationError):
            DrawingCollection.model_validate(document)


@pytest.mark.parametrize(
    "identifier", [None, "", " ", "with space", "a/b", "x" * 101, 1]
)
def test_drawing_requires_original_stable_text_ids(identifier: Any) -> None:
    """Reject identifiers that cannot survive the existing editor's storage contract.

    Args:
        identifier: Missing, malformed or coerced source identifier.
    """
    document = collection()
    document["features"][0]["id"] = identifier
    with pytest.raises(ValidationError):
        DrawingCollection.model_validate(document)


def test_duplicate_ids_are_rejected_even_when_polygon_names_differ() -> None:
    """Require identity uniqueness across the original full collection."""
    document = collection()
    document["features"][1]["id"] = document["features"][0]["id"]
    document["features"][1]["properties"]["name"] = "Different name"
    with pytest.raises(ValidationError, match="unique"):
        DrawingCollection.model_validate(document)


@pytest.mark.parametrize(
    "geometry",
    [
        {"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 1]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [2, 0], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [181, 0], [2, 2], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 90], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 0]]] * 2},
        {"type": "MultiPolygon", "coordinates": [[[[0, 0], [2, 0], [2, 2], [0, 0]]]]},
        *[
            case["geometry"]
            for case in ADMISSION_CASES["geometry"]
            if not case["valid"]
        ],
    ],
)
def test_drawing_and_collaboration_keep_the_same_editable_geometry_contract(
    geometry: dict[str, Any],
) -> None:
    """Reject the same unsupported rings at both original source producers.

    Args:
        geometry: Open, crossing, degenerate, out-of-bounds or unsupported geometry.
    """
    feature = collection()["features"][0]
    feature["geometry"] = geometry
    for contract in (DrawingFeature, AnnotationFeature):
        with pytest.raises(ValidationError):
            contract.model_validate(feature)


@pytest.mark.parametrize(
    "case",
    [case for case in ADMISSION_CASES["geometry"] if case["valid"]],
    ids=lambda case: case["name"],
)
def test_editable_geometry_admission_preserves_supported_boundaries(
    case: dict[str, Any],
) -> None:
    """Admit the same valid boundary examples used by the browser source reader.

    Args:
        case: Shared accepted geometry example.
    """
    feature = collection()["features"][0]
    feature["geometry"] = case["geometry"]
    for contract in (DrawingFeature, AnnotationFeature):
        assert (
            contract.model_validate(feature).model_dump(mode="json")["geometry"]
            == case["geometry"]
        )


@pytest.mark.parametrize("case", ADMISSION_CASES["text"], ids=lambda case: case["name"])
def test_drawing_text_admission_matches_browser_limits(case: dict[str, Any]) -> None:
    """Use the browser's UTF-16 limits while preserving admitted imported text exactly.

    Args:
        case: Shared source-name, polygon-name or note boundary example.
    """
    document = collection()
    text = case["unit"] * case["count"]
    if case["field"] == "sourceName":
        document["name"] = text
    else:
        field = "name" if case["field"] == "polygonName" else "note"
        document["features"][0]["properties"][field] = text
    if case["valid"]:
        assert (
            DrawingCollection.model_validate(document).model_dump(mode="json")
            == document
        )
    else:
        with pytest.raises(ValidationError):
            DrawingCollection.model_validate(document)


@pytest.mark.parametrize(
    "field", ["filter", "appearance", "owner", "path", "assignments"]
)
def test_drawing_collection_does_not_accept_view_or_consumer_state(field: str) -> None:
    """Keep the original source independent of filters, appearance and scenarios.

    Args:
        field: State owned by a consumer rather than the drawing source.
    """
    with pytest.raises(ValidationError):
        DrawingCollection.model_validate({**collection(), field: {}})


def test_drawing_revision_and_local_identity_are_validated_at_creation_and_update() -> (
    None
):
    """Reject spoofed permissions and invalid revisions before storage is called."""
    for extra in ({"canEdit": True}, {"id": "server-id"}, {"owner": "another-browser"}):
        with pytest.raises(ValidationError):
            CreateDrawingLayer.model_validate(
                {"localLayerId": "device-layer", "collection": collection(), **extra}
            )
    for revision in (True, 0, -1, "1", 1.5):
        with pytest.raises(ValidationError):
            UpdateDrawingLayer(expectedRevision=revision, collection=collection())


def test_empty_drawing_and_large_document_limits_match_editor_capacity() -> None:
    """Allow removal of every polygon while retaining source identity and bound uploads."""
    assert DrawingCollection(name="Empty", features=[]).features == []
    too_many = collection()
    too_many["features"] = [
        {**deepcopy(too_many["features"][0]), "id": f"polygon-{index}"}
        for index in range(501)
    ]
    with pytest.raises(ValidationError):
        DrawingCollection.model_validate(too_many)
    oversized = collection()
    oversized["features"] = [
        {
            **deepcopy(oversized["features"][0]),
            "id": f"polygon-{index}",
            "properties": {"name": "Long note", "note": "森林" * 5000},
        }
        for index in range(300)
    ]
    with pytest.raises(ValidationError, match="8 MiB"):
        DrawingCollection.model_validate(oversized)


def test_drawing_source_owner_does_not_depend_on_consumers_or_http() -> None:
    """Keep reusable drawing data independent of Planning, map rendering and routes."""
    modules: set[str] = set()
    for path in Path("src/eolab_app/drawings").glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                modules.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module is not None:
                modules.add(node.module)
    forbidden = (
        "eolab_app.planning",
        "eolab_app.annotation_sessions",
        "eolab_app.saved_maps",
        "eolab_app.vector",
        "eolab_app.raster",
        "eolab_app.processing",
        "eolab_app.routes",
        "fastapi",
    )
    assert not any(
        module == prefix or module.startswith(f"{prefix}.")
        for module in modules
        for prefix in forbidden
    )
