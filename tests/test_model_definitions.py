"""Model boundary tests: bounded YAML, immutable recipes and real input contracts."""

import copy
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from eolab_app.processing.model_definitions import ModelDefinition, ModelRegistry
from eolab_app.processing.model_run_contracts import ModelRunRequest, RunDocument
from eolab_app.processing.model_runs import resolve_model_request
from eolab_app.processing.model_yaml import canonical_json, export_yaml, parse_yaml
from eolab_app.processing.models import ProcessingError


@pytest.mark.parametrize("model_count", [1, 101])
def test_discovery_and_recipe_export_need_no_catalog_or_renderer(
    model_count: int,
) -> None:
    """Expose the full library without a count ceiling or execution dependencies.

    Args:
        model_count: Installed versions, including a library beyond the former cap.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from eolab_app.processing.service import ProcessingService
    from eolab_app.routes.processing import create_processing_router

    definition = ModelRegistry.load_installed().get("raster-summary", "1.0.0")
    definitions = tuple(
        ModelDefinition.model_validate(
            {**definition.to_document(), "version": f"1.0.{index}"}
        )
        for index in range(model_count)
    )
    registry = ModelRegistry(definitions)
    app = FastAPI()
    app.include_router(
        create_processing_router(
            ProcessingService(object(), object(), model_registry=registry)
        )
    )
    with TestClient(app, base_url="https://testserver") as client:
        response = client.get("/api/processing/models")
        assert response.status_code == 200, response.text
        models = response.json()["models"]
        assert len(models) == model_count
        assert {model["version"]: model["definitionSha256"] for model in models} == {
            item.version: item.digest for item in definitions
        }
        model = models[0]
        recipe = client.get("/api/processing/models/raster-summary/versions/1.0.0/yaml")
        assert recipe.status_code == 200
        assert "no-store" in recipe.headers["cache-control"]
        assert int(recipe.headers["content-length"]) == len(recipe.content)
        assert (
            ModelDefinition.model_validate(parse_yaml(recipe.content)).digest
            == model["definitionSha256"]
        )


def summary_request() -> dict[str, Any]:
    """Load the reviewed synthetic submission used for boundary-only tests.

    Returns:
        Independent path-free request data.
    """
    import json

    return json.loads(
        Path("docs/model-examples/raster-summary.request.json").read_text()
    )


def test_installed_summary_matches_approved_example_and_round_trips() -> None:
    """Installed package discovery and YAML round trips preserve definition identity."""
    definition = ModelRegistry.load_installed().get("raster-summary", "1.0.0")
    example = parse_yaml(
        Path("docs/model-examples/raster-summary.model.yaml").read_bytes()
    )
    assert definition.to_document() == example
    reloaded = ModelDefinition.model_validate(
        parse_yaml(export_yaml(definition.to_document()))
    )
    assert canonical_json(reloaded.to_document()) == canonical_json(definition.to_document())
    assert definition.digest == summary_request()["model"]["definitionSha256"]
    with pytest.raises(TypeError):
        definition.inputs["other"] = definition.inputs["raster"]
    with pytest.raises(TypeError):
        definition.steps[0].inputs["other"] = definition.steps[0].inputs["raster"]
    with pytest.raises(ValidationError):
        definition.inputs["raster"].label = "Changed"


def test_run_example_has_typed_path_free_execution_and_round_trips() -> None:
    """Validate the complete Run YAML example, including its resolved grid policy."""
    document = RunDocument.model_validate(
        parse_yaml(
            Path("docs/model-examples/raster-summary.run.yaml").read_bytes(), run=True
        )
    )
    normalized = document.model_dump(mode="json", by_alias=True, exclude_unset=True)
    reloaded = RunDocument.model_validate(
        parse_yaml(export_yaml(normalized, run=True), run=True)
    )
    assert normalized == reloaded.model_dump(
        mode="json", by_alias=True, exclude_unset=True
    )
    normalized["execution"]["source_path"] = "/private/raster.tif"
    with pytest.raises(ValidationError):
        RunDocument.model_validate(normalized)


@pytest.mark.parametrize(
    "document",
    [
        b"key: 1\nkey: 2",
        b"key: &x [1,2]\nother: *x",
        b"key: !!python/object:object {}",
        b"key: 2026-10-08",
        b"key: .inf",
        b"1: value",
        b"<<: {}",
        b"{}\n---\n{}",
        b"%YAML 1.1\n---\n{}",
        b"key: " + b"[" * 40 + b"]" * 40,
        b"key: [" + b"1," * 2050 + b"]",
        b"key: " + b"a" * 65536,
        b"\xff",
    ],
    ids=[
        "duplicate",
        "alias",
        "tag",
        "timestamp",
        "nonfinite",
        "nonstring-key",
        "merge",
        "multidocument",
        "directive",
        "depth",
        "nodes",
        "bytes",
        "encoding",
    ],
)
def test_yaml_rejects_unsupported_or_unbounded_documents(document: bytes) -> None:
    """Reject structure and content hazards before model construction.

    Args:
        document: Invalid or excessive YAML fixture.
    """
    with pytest.raises(ProcessingError, match="YAML document"):
        parse_yaml(document)


@pytest.mark.parametrize(
    "change",
    [
        {"schema": "eolab.model/v99"},
        {"unknown": True},
        {"steps": []},
        {"executionProfile": "/tmp/profile"},
        {"id": "../model"},
    ],
)
def test_definition_rejects_invalid_contract_fields(change: dict[str, Any]) -> None:
    """Reject unknown fields and unsupported schema shapes.

    Args:
        change: Top-level invalid replacement fields.
    """
    value = ModelRegistry.load_installed().get("raster-summary", "1.0.0").to_document()
    with pytest.raises(ValidationError):
        ModelDefinition.model_validate({**value, **change})


@pytest.mark.parametrize(
    "kind", ["operation", "input", "output", "default", "parameter", "duplicate"]
)
def test_registry_rejects_definitions_that_cannot_execute(kind: str) -> None:
    """Fail library readiness rather than hide incompatible installed recipes.

    Args:
        kind: ModelSchema mismatch introduced into a valid recipe.
    """
    definition = ModelRegistry.load_installed().get("raster-summary", "1.0.0")
    value = copy.deepcopy(definition.to_document())
    if kind == "operation":
        value["steps"][0]["operation"] = "python.shell.v1"
    elif kind == "input":
        value["inputs"]["raster"]["type"] = "mask_source"
    elif kind == "output":
        value["outputs"]["statistics"]["source"] = "calculate.unknown"
    elif kind == "default":
        value["parameters"]["summary"]["default"] = "pixelValue(a)"
    elif kind == "parameter":
        value["steps"][0]["parameters"]["expression"] = {"parameter": "missing"}
    with pytest.raises((ProcessingError, ValidationError)):
        replacement = ModelDefinition.model_validate(value)
        ModelRegistry(
            (replacement, replacement) if kind == "duplicate" else (replacement,)
        )


def test_model_defaults_bind_to_existing_aggregate_contract() -> None:
    """A real summary request uses native aggregate validation, with explicit defaults."""
    value = summary_request()
    value["parameters"] = {}
    calculation, invocation = resolve_model_request(
        ModelRunRequest.model_validate(value), ModelRegistry.load_installed()
    )
    assert calculation.calculations[0].expression == "sum(a)"
    assert invocation.parameters == {"summary": "sum(a)"}
    assert calculation.selectedBounds.west == -1
    assert invocation.model.definition.digest == value["model"]["definitionSha256"]


@pytest.mark.parametrize(
    "kind", ["path", "parameter", "formula", "digest", "area", "input", "nan"]
)
def test_model_submission_rejects_invalid_bindings(kind: str) -> None:
    """Reject arbitrary paths, unknown fields, unavailable identities and bad formulas.

    Args:
        kind: Invalid public input to exercise.
    """
    value = summary_request()
    if kind == "path":
        value["inputs"]["raster"]["path"] = "/private/input.tif"
    elif kind == "parameter":
        value["parameters"]["memory"] = 100000
    elif kind == "formula":
        value["parameters"]["summary"] = "__import__('os')"
    elif kind == "digest":
        value["model"]["definitionSha256"] = "0" * 64
    elif kind == "area":
        value["inputs"]["area"]["wholeRaster"] = True
    elif kind == "input":
        del value["inputs"]["raster"]
    else:
        value["parameters"]["summary"] = float("nan")
    with pytest.raises((ProcessingError, ValidationError)):
        resolve_model_request(
            ModelRunRequest.model_validate(value), ModelRegistry.load_installed()
        )
