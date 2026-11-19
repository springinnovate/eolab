"""Check the portable drawing definition shared by saved maps and Planning."""

import ast
from copy import deepcopy
import json
from pathlib import Path
from typing import Any
from uuid import UUID

from pydantic import ValidationError
import pytest

from eolab_app.map_layer_documents import MapDrawingLayer
from eolab_app.planning.models import PlanningLayer
from eolab_app.saved_maps.models import SavedMapView

VIEW = json.loads(
    (Path(__file__).parent / "fixtures" / "saved-map-v5.json").read_text()
)


def test_drawing_definition_is_identical_in_saved_maps_and_planning() -> None:
    """Round-trip repeated source views without capturing geometry or source revisions."""
    saved = SavedMapView.model_validate(VIEW)
    assert saved.model_dump(mode="json", exclude_unset=True) == VIEW
    assert (
        SavedMapView.model_validate_json(
            saved.model_dump_json(exclude_unset=True)
        ).model_dump(mode="json", exclude_unset=True)
        == VIEW
    )
    for definition, parsed in zip(VIEW["layers"][1:], saved.layers[1:], strict=True):
        planned = PlanningLayer.model_validate(
            {"id": "22222222-2222-4222-8222-222222222222", "definition": definition}
        )
        assert isinstance(parsed, MapDrawingLayer)
        assert type(planned.definition) is type(parsed)
        assert planned.definition == parsed
        assert (
            planned.definition.model_dump(mode="json", exclude_unset=True) == definition
        )
        assert planned.source_identity() == ("drawing", definition["drawingLayerId"])
        assert isinstance(parsed.drawingLayerId, UUID)
    assert saved.layers[1].drawingLayerId == saved.layers[2].drawingLayerId
    assert saved.layers[1].appearance != saved.layers[2].appearance
    assert saved.layers[2].isCustom is True
    assert saved.layers[2].legendIncluded is True
    assert not saved.layers[2].filter.active


@pytest.mark.parametrize(
    "field,value",
    [
        ("drawingLayerId", "../drawing.geojson"),
        ("drawingLayerId", None),
        ("isCustom", False),
        ("visible", "true"),
        ("legendIncluded", 1),
        ("opacity", "0.5"),
        ("opacity", 1.5),
        ("features", []),
        ("collection", {}),
        ("geometry", {}),
        ("credential", "private"),
        ("canEdit", True),
        ("sourceRevision", 1),
        ("catalogItem", {"collection": "vectors", "id": "parcels"}),
        ("style", {"kind": "vector", "definition": {}}),
        ("filter", None),
        (
            "filter",
            {"rules": [{"field": "parcel_id", "operator": "eq", "value": "one"}]},
        ),
        ("filter", {"rules": [{"field": "name", "operator": "gt", "value": 1}]}),
    ],
)
def test_drawing_definition_rejects_invalid_sources_and_view_state(
    field: str, value: Any
) -> None:
    """Validate the same source and view boundary before either consumer stores it.

    Args:
        field: Portable layer field to replace or add.
        value: Invalid source reference, private state, appearance or predicate.
    """
    definition = {**deepcopy(VIEW["layers"][1]), field: value}
    with pytest.raises(ValidationError):
        MapDrawingLayer.model_validate(definition)
    with pytest.raises(ValidationError):
        PlanningLayer.model_validate(
            {"id": "22222222-2222-4222-8222-222222222222", "definition": definition}
        )
    with pytest.raises(ValidationError):
        SavedMapView.model_validate({**VIEW, "layers": [definition]})


def test_portable_layer_contract_does_not_import_its_storage_owners() -> None:
    """Keep the common drawing definition independent of Planning and saved maps."""
    tree = ast.parse(Path("src/eolab_app/map_layer_documents.py").read_text())
    imports = {
        node.module
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module is not None
    }
    imports.update(
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    )
    assert not any(
        name == owner or name.startswith(owner + ".")
        for name in imports
        for owner in (
            "eolab_app.planning",
            "eolab_app.saved_maps",
            "eolab_app.drawings",
        )
    )
