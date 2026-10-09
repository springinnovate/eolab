"""Build unfamiliar YAML recipes to test operation reuse without application edits."""

from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.model_yaml import export_yaml, parse_yaml


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
