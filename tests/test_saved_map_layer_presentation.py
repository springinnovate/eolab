"""Validate saved Catalog and Custom card presentation independently of source services."""

from copy import deepcopy
import json
from pathlib import Path

from pydantic import ValidationError
import pytest

from eolab_app.saved_maps.models import CreateSavedMap


def test_custom_presentation_round_trip_for_all_source_kinds() -> None:
    """Preserve explicit card meaning without changing source identity or order."""
    view = json.loads(
        (Path(__file__).parent / "fixtures" / "saved-map-v1.json").read_text()
    )
    view.update(schemaVersion=3, basemap="detailed")
    candidate = {"slug": "custom-layers", "title": "Custom layers", "view": view}
    raster, vector = view["layers"]
    raster["isCustom"] = False
    vector["isCustom"] = True
    annotation = json.loads(
        (Path(__file__).parent / "fixtures" / "saved-map-v2.json").read_text()
    )["layers"][0]
    view["layers"].extend(
        [
            {**deepcopy(raster), "isCustom": True, "customName": "Comparison"},
            {
                "uploadId": "11111111-1111-4111-8111-111111111111",
                "isCustom": True,
                "visible": False,
                "opacity": 0.4,
                "style": deepcopy(vector["style"]),
            },
            {
                "temporalSource": {
                    "collectionId": "eolab-temporal-datasets",
                    "itemId": "era5",
                    "variable": "air_temperature",
                    "time": "2020-01-15T12:00:00.000Z",
                },
                "isCustom": True,
                "visible": True,
                "opacity": 0.6,
                "style": deepcopy(raster["style"]),
            },
            {**annotation, "isCustom": True},
        ]
    )
    parsed = CreateSavedMap.model_validate(candidate)
    assert parsed.model_dump(mode="json", exclude_unset=True) == candidate
    assert (
        CreateSavedMap.model_validate_json(
            parsed.model_dump_json(exclude_unset=True)
        ).model_dump(mode="json", exclude_unset=True)
        == candidate
    )
    for index in range(len(view["layers"])):
        for value in (None, "false", 0, 1, {}):
            invalid = deepcopy(candidate)
            invalid["view"]["layers"][index]["isCustom"] = value
            with pytest.raises(ValidationError):
                CreateSavedMap.model_validate(invalid)
