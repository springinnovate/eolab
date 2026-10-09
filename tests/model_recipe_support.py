"""Build unfamiliar YAML recipes to test operation reuse without application edits."""

from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.model_yaml import export_yaml, parse_yaml
from dataclasses import replace
import pytest
import eolab_app.processing.model_definitions as definitions
import eolab_app.processing.model_operations as operations
from eolab_app.processing.model_operations import OperationOutput


def custom_recipe(model_id: str) -> ModelDefinition:
    """Rename every recipe binding while preserving an installed operation contract.

    Args:
        model_id: Installed recipe whose operation should be reused.

    Returns:
        YAML-round-tripped custom recipe with independent names and output label.
    """
    document = ModelRegistry.load_installed().get(model_id, "1.0.0").to_document()
    document["id"] = "custom-" + model_id
    document["title"] = "Habitat calculation"
    document["inputs"] = {
        "habitat": document["inputs"]["raster"],
        "region": document["inputs"]["area"],
    }
    step = document["steps"][0]
    step["id"] = "evaluate"
    step["inputs"] = {"raster": {"input": "habitat"}, "area": {"input": "region"}}
    if document["parameters"]:
        declaration = document["parameters"]["summary"]
        declaration["default"] = "mean(a)"
        document["parameters"] = {"formula": declaration}
        step["parameters"] = {"expression": {"parameter": "formula"}}
    output = next(iter(document["outputs"].values()))
    output["source"] = "evaluate." + output["source"].split(".")[1]
    output["label"] = "Habitat output"
    document["outputs"] = {"habitat_result": output}
    return ModelDefinition.model_validate(parse_yaml(export_yaml(document)))


def multiple_output_recipe(monkeypatch: pytest.MonkeyPatch) -> ModelDefinition:
    """Register a fixture operation and a YAML recipe retaining several real files.

    Args:
        monkeypatch: Isolated registry replacement restored after each test.

    Returns:
        A clip recipe with renamed primary, intermediate and table output aliases.
    """
    definition = custom_recipe("raster-clip").to_document()
    original = operations.get_model_operation("raster.clip.v1")
    registered = {
        **operations.OPERATIONS,
        original.id: replace(
            original,
            additional_outputs=(
                OperationOutput(
                    "coverage",
                    "raster",
                    "map",
                    "image/tiff",
                    "Coverage",
                    "intermediate",
                ),
                OperationOutput("totals", "statistics", "table", "text/csv", "Totals"),
            ),
        ),
    }
    monkeypatch.setattr(operations, "OPERATIONS", registered)
    monkeypatch.setattr(definitions, "OPERATIONS", registered)
    definition["outputs"].update(
        inspected_coverage={
            "source": "evaluate.coverage",
            "role": "intermediate",
            "presentation": "map",
            "saveEligible": False,
            "type": "raster",
            "label": "Coverage used in this run",
        },
        habitat_totals={
            "source": "evaluate.totals",
            "role": "result",
            "presentation": "table",
            "saveEligible": True,
            "type": "statistics",
            "label": "Habitat totals",
        },
    )
    return ModelDefinition.model_validate(parse_yaml(export_yaml(definition)))
