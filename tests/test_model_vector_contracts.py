"""Exercise configured vector inputs and typed outcomes without a built-in vector tool."""

from dataclasses import replace
from typing import Annotated, Any, Literal

import pytest
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from eolab_app.processing import model_definitions as definitions
from eolab_app.processing import model_operations as operations
from eolab_app.processing.model_definitions import (
    ChoiceParameter,
    ModelDefinition,
    ModelInput,
    ModelRegistry,
)
from eolab_app.processing.model_operations import OperationOutput
from eolab_app.processing.model_result_contracts import ModelVectorResult
from eolab_app.processing.model_run_contracts import (
    ModelExecution,
    ModelInvocation,
    ModelRunRequest,
    ModelRunSpec,
    RunDocument,
)
from eolab_app.processing.model_runs import (
    build_model_calculation_request,
    record_model_preparation,
)
from eolab_app.processing.model_yaml import export_yaml, parse_yaml
from eolab_app.processing.models import (
    PreparedJobPlan,
    ProcessingError,
    ProcessingLimits,
)
from eolab_app.processing.vector_input_models import VectorFieldSelection


class CoordinatePolicy(BaseModel):
    """Fixture operation settings independent of any installed algorithm."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    precision: Literal["source"]


class ChangedFeatures(BaseModel):
    """Fixture scientific diagnostics declared only by the fixture operation."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    changedFeatureCount: Annotated[int, Field(strict=True, ge=0)]


class VectorPlan(BaseModel):
    """Fixture prepared specification containing only original vector choices."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["fixture.vector-fields.v1"] = "fixture.vector-fields.v1"
    source: VectorFieldSelection


def bind_vector_fixture(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
) -> VectorFieldSelection:
    """Bind a fixture's configured vector input through its shared value contract.

    Args:
        inputs: The original vector and named attributes under the source argument.
        parameters: Empty fixture settings.
        request_id: Submission identity already owned by model admission.
        label: Display name already owned by model admission.

    Returns:
        The operation's typed source and field selections.
    """
    return VectorFieldSelection.model_validate(inputs["source"])


@pytest.fixture
def vector_definition(monkeypatch: pytest.MonkeyPatch) -> ModelDefinition:
    """Register a test-only vector operation and a recipe with unfamiliar field roles.

    Args:
        monkeypatch: Restore installed operation registrations after the test.

    Returns:
        A valid configured vector recipe without adding an installed model or target.
    """
    original = operations.get_model_operation("raster.clip.v1")
    operation = replace(
        original,
        id="fixture.vector-fields.v1",
        inputs=(("source", "vector"),),
        parameters=(),
        output=OperationOutput(
            "features", "vector", "map", "application/geopackage+sqlite3", "Features"
        ),
        execution_profile="fixture-vector",
        source=None,
        primary_input=None,
        requires_raster_grid=False,
        bind=bind_vector_fixture,
        policy_type=CoordinatePolicy,
        prepared_type=VectorPlan,
        policy=lambda spec: CoordinatePolicy(precision="source"),
        outcome_details_type=ChangedFeatures,
    )
    registry = {**operations.OPERATIONS, operation.id: operation}
    monkeypatch.setattr(operations, "OPERATIONS", registry)
    monkeypatch.setattr(definitions, "OPERATIONS", registry)
    definition = ModelDefinition.model_validate(
        {
            "schema": "eolab.model/v1",
            "id": "configured-vectors",
            "version": "1.0.0",
            "title": "Configured vectors",
            "description": "Select a source and attributes for a registered operation.",
            "inputs": {
                "polygons": {
                    "type": "vector",
                    "label": "Source features",
                    "geometry": "polygon",
                    "fields": {
                        "identifier": {"label": "Feature code", "kind": "scalar"},
                        "weight": {"label": "Feature weight", "kind": "numeric"},
                    },
                }
            },
            "parameters": {},
            "steps": [
                {
                    "id": "calculate",
                    "operation": operation.id,
                    "inputs": {"source": {"input": "polygons"}},
                    "parameters": {},
                }
            ],
            "outputs": {
                "features": {
                    "source": "calculate.features",
                    "role": "result",
                    "presentation": "map",
                    "saveEligible": True,
                }
            },
            "executionProfile": "fixture-vector",
        }
    )
    ModelRegistry((definition,))
    return definition


def vector_request(
    definition: ModelDefinition, fields: dict[str, Any]
) -> ModelRunRequest:
    """Create a browser request with an immutable uploaded-source descriptor.

    Args:
        definition: Recipe supplying the expected identity and input declarations.
        fields: Source attribute selections, including invalid cases under test.

    Returns:
        A parsed public request awaiting model-specific admission validation.
    """
    return ModelRunRequest.model_validate(
        {
            "requestId": "configured-vector-request",
            "utcOffsetMinutes": 0,
            "label": "Chosen features",
            "model": {
                "id": definition.id,
                "version": definition.version,
                "definitionSha256": definition.digest,
            },
            "inputs": {
                "polygons": {
                    "selection": {
                        "uploadId": "12345678-1234-1234-1234-123456789abc",
                        "layerName": "features",
                        "filter": {"enabled": False, "match": "all", "rules": []},
                    },
                    "fields": fields,
                }
            },
            "parameters": {},
        }
    )


@pytest.fixture
def vector_rows_definition(vector_definition: ModelDefinition) -> ModelDefinition:
    """Configure repeatable pickers on the neutral fixture's original vector input.

    Args:
        vector_definition: Registered fixture with no built-in algorithm dependency.

    Returns:
        A recipe with a numeric attribute and a choice setting in each row.
    """
    document = vector_definition.to_document()
    document["inputs"]["polygons"]["rows"] = {
        "label": "Measurements",
        "itemLabel": "Measurement",
        "fields": {"measure": {"label": "Attribute", "kind": "numeric"}},
        "parameters": {
            "method": {
                "type": "choice",
                "label": "Adjustment",
                "choices": [
                    {"value": "retain", "label": "Original values"},
                    {"value": "normalize", "label": "Normalized values"},
                ],
                "default": "retain",
            }
        },
    }
    return ModelDefinition.model_validate(document)


def vector_rows_request(definition: ModelDefinition, rows: Any) -> ModelRunRequest:
    """Create a public vector request with valid or intentionally malformed rows.

    Args:
        definition: Recipe used for request identity and picker configuration.
        rows: Captured row payload to test at the model admission boundary.

    Returns:
        A parsed request whose row configuration has not yet been checked.
    """
    body = vector_request(
        definition, {"identifier": "code", "weight": "population"}
    ).model_dump(mode="json")
    body["inputs"]["polygons"]["rows"] = rows
    return ModelRunRequest.model_validate(body)


def test_row_recipe_round_trip_preserves_choices_identity_and_immutability(
    vector_rows_definition: ModelDefinition,
) -> None:
    """Keep row declarations and ordered options immutable in exported recipes.

    Args:
        vector_rows_definition: Neutral recipe with repeatable field and choice pickers.
    """
    definition = vector_rows_definition
    reloaded = ModelDefinition.model_validate(
        parse_yaml(export_yaml(definition.to_document()))
    )
    assert reloaded.digest == definition.digest
    rows = reloaded.inputs["polygons"].rows
    assert rows is not None
    choice = rows.parameters["method"]
    assert isinstance(choice, ChoiceParameter)
    assert tuple(item.value for item in choice.choices) == ("retain", "normalize")
    assert choice.default == "retain"
    with pytest.raises(ValidationError):
        choice.choices[0].value = "changed"
    with pytest.raises(TypeError):
        rows.fields["other"] = rows.fields["measure"]
    with pytest.raises(TypeError):
        rows.parameters["other"] = choice
    changed = definition.to_document()
    changed["inputs"]["polygons"]["rows"]["parameters"]["method"]["choices"][0][
        "label"
    ] = "Unadjusted values"
    assert ModelDefinition.model_validate(changed).digest != definition.digest


@pytest.mark.parametrize("row_count", [1, 40])
def test_configured_rows_bind_in_order_and_round_trip(
    vector_rows_definition: ModelDefinition, row_count: int
) -> None:
    """Capture every configured row in order without a row-count ceiling.

    Args:
        vector_rows_definition: Neutral fixture declaring one field and one choice.
        row_count: A single row or more rows than ordinary parameter-count limits.
    """
    rows = [
        {
            "fields": {"measure": f"attribute_{index}"},
            "parameters": {"method": "normalize" if index % 2 else "retain"},
        }
        for index in range(row_count)
    ]
    request = vector_rows_request(vector_rows_definition, rows)
    calculation, invocation = build_model_calculation_request(
        request, ModelRegistry((vector_rows_definition,))
    )
    assert calculation.model_dump(mode="json")["rows"] == rows
    assert invocation.inputs == request.inputs
    assert (
        ModelInvocation.model_validate_json(invocation.model_dump_json(by_alias=True))
        == invocation
    )
    saved = invocation.model_dump(mode="json", by_alias=True)
    saved["inputs"]["polygons"]["rows"][0]["parameters"]["method"] = "unknown"
    with pytest.raises(ValidationError, match="declared row values"):
        ModelInvocation.model_validate(saved)


@pytest.mark.parametrize(
    "rows",
    [
        None,
        [],
        [{"fields": {}, "parameters": {"method": "retain"}}],
        [
            {
                "fields": {"measure": "amount", "other": "area"},
                "parameters": {"method": "retain"},
            }
        ],
        [{"fields": {"measure": ""}, "parameters": {"method": "retain"}}],
        [{"fields": {"measure": 12}, "parameters": {"method": "retain"}}],
        [{"fields": {"measure": "amount"}, "parameters": {}}],
        [
            {
                "fields": {"measure": "amount"},
                "parameters": {"method": "retain", "other": "retain"},
            }
        ],
        [{"fields": {"measure": "amount"}, "parameters": {"method": "unknown"}}],
        [{"fields": {"measure": "amount"}, "parameters": {"method": 2}}],
        [{"fields": {"measure": "amount"}, "parameters": {"method": None}}],
        [
            {
                "fields": {"measure": "amount"},
                "parameters": {"method": "retain"},
                "rows": [],
            }
        ],
    ],
)
def test_admission_rejects_invalid_vector_rows(
    vector_rows_definition: ModelDefinition, rows: Any
) -> None:
    """Reject missing bindings, unsupported choices and nested rows before work starts.

    Args:
        vector_rows_definition: Recipe declaring exact row field and parameter roles.
        rows: Malformed row bindings supplied by a public client.
    """
    with pytest.raises(ProcessingError) as error:
        build_model_calculation_request(
            vector_rows_request(vector_rows_definition, rows),
            ModelRegistry((vector_rows_definition,)),
        )
    assert error.value.code == "invalid_model_inputs"


def test_configured_rows_are_required_and_unconfigured_rows_are_forbidden(
    vector_definition: ModelDefinition, vector_rows_definition: ModelDefinition
) -> None:
    """Require rows only when enabled and preserve the ordinary vector wire shape.

    Args:
        vector_definition: Ordinary vector fixture without repeated pickers.
        vector_rows_definition: Same operation with required repeated pickers.
    """
    ordinary = vector_request(
        vector_definition, {"identifier": "code", "weight": "population"}
    )
    calculation, _ = build_model_calculation_request(
        ordinary, ModelRegistry((vector_definition,))
    )
    assert "rows" not in calculation.model_dump(mode="json")
    with pytest.raises(ProcessingError, match="invalid"):
        build_model_calculation_request(
            vector_request(
                vector_rows_definition, {"identifier": "code", "weight": "population"}
            ),
            ModelRegistry((vector_rows_definition,)),
        )
    for rows in (None, [{"fields": {}, "parameters": {}}]):
        with pytest.raises(ProcessingError, match="invalid"):
            build_model_calculation_request(
                vector_rows_request(vector_definition, rows),
                ModelRegistry((vector_definition,)),
            )


def test_rows_can_configure_attributes_without_choices(
    vector_rows_definition: ModelDefinition,
) -> None:
    """Permit field-only repeated inputs while keeping parameters explicit on the wire.

    Args:
        vector_rows_definition: Neutral fixture whose row choices are removed here.
    """
    document = vector_rows_definition.to_document()
    document["inputs"]["polygons"]["rows"]["parameters"] = {}
    definition = ModelDefinition.model_validate(document)
    rows = [{"fields": {"measure": "amount"}, "parameters": {}}]
    calculation, _ = build_model_calculation_request(
        vector_rows_request(definition, rows), ModelRegistry((definition,))
    )
    assert calculation.model_dump(mode="json")["rows"] == rows
    assert definition.to_document()["inputs"]["polygons"]["rows"]["parameters"] == {}


@pytest.mark.parametrize(
    "change",
    [
        {"fields": {}},
        {"rows": {}},
        {
            "parameters": {
                "method": {
                    "type": "number",
                    "label": "Size",
                    "unit": "m",
                    "minimum": 0,
                    "default": 1,
                }
            }
        },
    ],
)
def test_recipe_rejects_invalid_row_configuration(
    vector_rows_definition: ModelDefinition, change: dict[str, Any]
) -> None:
    """Limit repeatable configuration to attributes and existing choice parameters.

    Args:
        vector_rows_definition: Valid neutral recipe supplying the surrounding contract.
        change: Empty field declarations, nested rows or an unsupported parameter type.
    """
    document = vector_rows_definition.to_document()
    document["inputs"]["polygons"]["rows"].update(change)
    with pytest.raises(ValidationError):
        ModelDefinition.model_validate(document)


@pytest.mark.parametrize("roles", [("identifier", "weight"), ("zone", "score"), ()])
def test_configured_field_roles_bind_and_round_trip(
    vector_definition: ModelDefinition, roles: tuple[str, ...]
) -> None:
    """Use configured role names and source-only choices without generic-code changes.

    Args:
        vector_definition: Registered fixture model with a generic vector input.
        roles: Alternate picker roles, or no attributes for source-only selection.
    """
    document = vector_definition.to_document()
    document["inputs"]["polygons"]["fields"] = {
        role: {"label": role.title(), "kind": "numeric"} for role in roles
    }
    definition = ModelDefinition.model_validate(parse_yaml(export_yaml(document)))
    fields = {role: f"source_{role}" for role in roles}
    request = vector_request(definition, fields)
    calculation, invocation = build_model_calculation_request(
        request, ModelRegistry((definition,))
    )
    assert isinstance(calculation, VectorFieldSelection)
    assert calculation.fields == fields
    assert invocation.inputs == request.inputs
    assert (
        ModelInvocation.model_validate_json(invocation.model_dump_json(by_alias=True))
        == invocation
    )
    if not roles:
        document["inputs"]["polygons"].pop("fields")
    assert definition.to_document() == document
    with pytest.raises(TypeError):
        definition.inputs["polygons"].fields["unconfigured"] = next(
            iter(vector_definition.inputs["polygons"].fields.values())
        )


def test_vector_input_can_omit_field_configuration(
    vector_definition: ModelDefinition,
) -> None:
    """A source-only recipe needs neither field declarations nor operation adapters.

    Args:
        vector_definition: Registered fixture model accepting the shared vector type.
    """
    document = vector_definition.to_document()
    document["inputs"]["polygons"].pop("fields")
    definition = ModelDefinition.model_validate(document)
    calculation, _ = build_model_calculation_request(
        vector_request(definition, {}), ModelRegistry((definition,))
    )
    assert calculation.fields == {}
    assert definition.to_document() == document


@pytest.mark.parametrize(
    "fields",
    [
        {},
        {"identifier": "code"},
        {"identifier": "code", "weight": "population", "other": "area"},
        {"identifier": "code", "weight": ""},
        {"identifier": "code", "weight": 12},
    ],
)
def test_admission_rejects_missing_extra_or_invalid_field_choices(
    vector_definition: ModelDefinition, fields: dict[str, Any]
) -> None:
    """Reject malformed vector captures at the existing public model input boundary.

    Args:
        vector_definition: Recipe declaring exactly identifier and weight roles.
        fields: Invalid role keys or source attribute values.
    """
    with pytest.raises(ProcessingError) as error:
        build_model_calculation_request(
            vector_request(vector_definition, fields),
            ModelRegistry((vector_definition,)),
        )
    assert error.value.code == "invalid_model_inputs"


@pytest.mark.parametrize(
    "change",
    [
        {"type": "raster", "fields": {}},
        {"type": "raster", "geometry": "polygon"},
        {"type": "raster", "rows": None},
        {"geometry": "point"},
        {"fields": {"value": {"label": "Value", "kind": "geometry"}}},
    ],
)
def test_recipe_rejects_invalid_vector_picker_configuration(
    change: dict[str, Any],
) -> None:
    """Validate recipe-owned picker metadata without inspecting source features.

    Args:
        change: Unsupported input geometry, selector type or non-vector configuration.
    """
    with pytest.raises(ValidationError):
        ModelInput.model_validate({"type": "vector", "label": "Features", **change})


def test_existing_input_dumps_do_not_acquire_vector_settings() -> None:
    """Preserve ordinary input JSON when optional vector metadata is absent."""
    value = {"type": "raster", "label": "Values"}
    assert ModelInput.model_validate(value).model_dump() == value


def test_preparation_records_vector_policy_without_reading_a_raster_grid(
    vector_definition: ModelDefinition,
) -> None:
    """Pass a grid-free prepared plan through the existing capture producer and reader.

    Args:
        vector_definition: Fixture operation whose prepared type has no grid attribute.
    """
    selection, invocation = build_model_calculation_request(
        vector_request(
            vector_definition, {"identifier": "code", "weight": "population"}
        ),
        ModelRegistry((vector_definition,)),
    )
    spec = VectorPlan(source=selection)
    wrapper = ModelRunSpec(
        calculation=spec, implementationRevision="a" * 64, applicationBuild="fixture"
    )
    execution = {
        "state": "pending",
        "applicationBuild": "fixture",
        "operations": {
            "calculate": {"id": spec.operation, "implementationRevision": "a" * 64}
        },
        "sources": {},
    }
    prepared = record_model_preparation(
        {
            "summary": {},
            "retained_metadata": {
                "invocation": invocation.model_dump(mode="json", by_alias=True),
                "execution": execution,
            },
        },
        wrapper,
        PreparedJobPlan(
            operation=spec.operation,
            specification=spec.model_dump(mode="json"),
            summary={},
            reserved_bytes=0,
        ),
        ProcessingLimits(),
    )
    recorded = prepared.retained_metadata["execution"]
    assert "grid" not in recorded and "grid" not in prepared.summary
    parsed = ModelExecution.model_validate(recorded)
    assert parsed.state == "prepared" and parsed.grid is None
    assert parsed.numericalPolicy == CoordinatePolicy(precision="source")


def vector_execution(details: Any) -> dict[str, Any]:
    """Build retained vector facts and operation-specific diagnostics for export tests.

    Args:
        details: Completed scientific facts, including malformed persisted cases.

    Returns:
        Prepared execution metadata with no raster grid or summary-specific fields.
    """
    return {
        "state": "prepared",
        "applicationBuild": "fixture",
        "operations": {
            "calculate": {
                "id": "fixture.vector-fields.v1",
                "implementationRevision": "a" * 64,
            }
        },
        "sources": {},
        "limits": {"resultTtlSeconds": 604800},
        "numericalPolicy": {"precision": "source"},
        "outcome": {
            "status": "ready",
            "error": None,
            "statistics": None,
            "vector": {
                "filename": "features.gpkg",
                "bytes": 4096,
                "sha256": "b" * 64,
                "layerName": "features",
                "featureCount": 3,
            },
            "details": details,
        },
    }


def test_run_yaml_round_trips_operation_owned_details_without_a_raster_grid(
    vector_definition: ModelDefinition,
) -> None:
    """Keep unfamiliar scientific fields typed and local to their recorded operation.

    Args:
        vector_definition: Registered vector fixture with its own outcome detail schema.
    """
    _, invocation = build_model_calculation_request(
        vector_request(
            vector_definition, {"identifier": "code", "weight": "population"}
        ),
        ModelRegistry((vector_definition,)),
    )
    document = RunDocument.model_validate(
        {
            "schema": "eolab.run/v1",
            "jobId": "c" * 32,
            "capturedAt": "2026-11-13T00:00:00Z",
            "invocation": invocation,
            "execution": vector_execution({"changedFeatureCount": 2}),
        }
    )
    assert isinstance(document.execution.outcome.details, ChangedFeatures)
    exported = document.model_dump(mode="json", by_alias=True, exclude_unset=True)
    assert "grid" not in exported["execution"]
    assert exported["execution"]["outcome"]["details"] == {"changedFeatureCount": 2}
    restored = RunDocument.model_validate(
        parse_yaml(export_yaml(exported, run=True), run=True)
    )
    assert restored == document


@pytest.mark.parametrize(
    "details",
    [{}, {"changedFeatureCount": -1}, {"changedFeatureCount": "2"}, {"other": 2}],
)
def test_persisted_details_must_match_the_registered_operation(
    vector_definition: ModelDefinition, details: dict[str, Any]
) -> None:
    """Reject changed, malformed or foreign diagnostics while loading saved metadata.

    Args:
        vector_definition: Registers the fixture's typed diagnostics boundary.
        details: Invalid completed facts read from a saved run.
    """
    with pytest.raises(ValidationError):
        ModelExecution.model_validate(vector_execution(details))


def test_operations_without_a_details_contract_reject_details(
    vector_definition: ModelDefinition, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Do not accept arbitrary scientific JSON for an operation that declares none.

    Args:
        vector_definition: Fixture registration whose details contract is removed.
        monkeypatch: Isolated operation registration update.
    """
    operation = operations.get_model_operation("fixture.vector-fields.v1")
    monkeypatch.setattr(
        operations,
        "OPERATIONS",
        {
            **operations.OPERATIONS,
            operation.id: replace(operation, outcome_details_type=None),
        },
    )
    with pytest.raises(ValidationError, match="does not declare outcome details"):
        ModelExecution.model_validate(vector_execution({"changedFeatureCount": 2}))
    execution = vector_execution(None)
    assert ModelExecution.model_validate(execution).outcome.details is None


@pytest.mark.parametrize("numeric_field", [None, "rank"])
def test_vector_results_allow_an_optional_numeric_display_field(
    numeric_field: str | None,
) -> None:
    """Describe ordinary vector outputs without requiring aggregation facts.

    Args:
        numeric_field: Optional producer preference for the initial vector style.
    """
    result = ModelVectorResult.model_validate(
        {
            "kind": "vector",
            "mediaType": "application/geopackage+sqlite3",
            "presentation": "map",
            "name": "features",
            "label": "Features",
            "displayName": "Features from fixture run",
            "role": "result",
            "url": "/result",
            "provenanceUrl": "/provenance",
            "filename": "features.gpkg",
            "bytes": 4096,
            "sha256": "b" * 64,
            "layerName": "features",
            "featureCount": 3,
            **({"defaultNumericField": numeric_field} if numeric_field else {}),
        }
    )
    assert result.defaultNumericField == numeric_field
    assert ("defaultNumericField" in result.model_dump()) == (numeric_field is not None)
