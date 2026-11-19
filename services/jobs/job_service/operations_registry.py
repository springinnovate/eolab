"""Explicit registration of code-installed operation functions and schemas."""

from dataclasses import dataclass
from typing import Callable

from pydantic import BaseModel

from job_service.models import Operation
from job_service.operations.diagnostic import (
    DiagnosticInput,
    DiagnosticResult,
    diagnostic,
)
from eolab_app.vector.outline_operation import (
    OutlineInput,
    OutlineResult,
    calculate_outline,
)
from eolab_app.vector.extent_operation import (
    ExtentInput,
    SelectionExtentResult,
    measure_selected_extent,
)
from eolab_app.vector.selection_operation import (
    ComparisonInput,
    ComparisonResult,
    compare_selected_features,
    SelectionMeasurementInput,
    SelectionMeasurementResult,
    measure_selected_features,
)
from eolab_app.vector.field_calculation_operation import (
    FieldCalculationInput,
    FieldCalculationOutcome,
    calculate_vector_fields,
)
from eolab_app.vector.parcel_models import (
    ParcelIdInput,
    ParcelLookupInput,
    ParcelRowsInput,
)
from eolab_app.vector.parcel_operation import (
    ParcelIdResult,
    ParcelLookupResult,
    ParcelRowsResult,
    validate_catalog_parcel_ids,
    lookup_catalog_parcel,
    read_catalog_parcel_rows,
)


@dataclass(frozen=True)
class InstalledOperation:
    """Code-installed schemas and an algorithm returning its constructed result model.

    The child runner passes validated input_model instances to execute, which
    returns a validated result_model instance ready for serialization. The parent
    validates decoded subprocess output against result_model before publishing it.
    """

    name: str
    description: str
    input_model: type[BaseModel]
    result_model: type[BaseModel]
    execute: Callable[[BaseModel], BaseModel]

    def describe(self) -> Operation:
        """Publish JSON schemas for discovery.

        Returns:
            Public operation contract without executable code or paths.
        """
        return Operation(
            name=self.name,
            description=self.description,
            inputSchema=self.input_model.model_json_schema(),
            resultSchema=self.result_model.model_json_schema(),
        )


OPERATIONS = {
    "diagnostic.v1": InstalledOperation(
        "diagnostic.v1",
        "Echo a value, delay then echo, or raise a controlled exception.",
        DiagnosticInput,
        DiagnosticResult,
        diagnostic,
    ),
    "vector.outline.v1": InstalledOperation(
        "vector.outline.v1",
        "Build a simplified display outline from an immutable catalog selection.",
        OutlineInput,
        OutlineResult,
        calculate_outline,
    ),
    "vector.selection-extent.v1": InstalledOperation(
        "vector.selection-extent.v1",
        "Measure original-source bounds of matching catalog, uploaded or run-file features.",
        ExtentInput,
        SelectionExtentResult,
        measure_selected_extent,
    ),
    "vector.selection-measurement.v1": InstalledOperation(
        "vector.selection-measurement.v1",
        "Count matching features in a catalog or uploaded vector layer for an analysis area.",
        SelectionMeasurementInput,
        SelectionMeasurementResult,
        measure_selected_features,
    ),
    "vector.intersection.v1": InstalledOperation(
        "vector.intersection.v1",
        "Find whole features intersecting the filtered polygons of an authorized layer.",
        ComparisonInput,
        ComparisonResult,
        compare_selected_features,
    ),
    "vector.field-calculation.v1": InstalledOperation(
        "vector.field-calculation.v1",
        "Calculate whole-layer numeric attributes without changing original sources.",
        FieldCalculationInput,
        FieldCalculationOutcome,
        calculate_vector_fields,
    ),
    "vector.parcel-id-validation.v1": InstalledOperation(
        "vector.parcel-id-validation.v1",
        "Validate one original parcel ID field across an entire Catalog polygon layer.",
        ParcelIdInput,
        ParcelIdResult,
        validate_catalog_parcel_ids,
    ),
    "vector.parcel-rows.v1": InstalledOperation(
        "vector.parcel-rows.v1",
        "Page exact filtered Catalog parcel IDs and original display attributes.",
        ParcelRowsInput,
        ParcelRowsResult,
        read_catalog_parcel_rows,
    ),
    "vector.parcel-lookup.v1": InstalledOperation(
        "vector.parcel-lookup.v1",
        "Find an exact typed ID in the original Catalog parcel layer.",
        ParcelLookupInput,
        ParcelLookupResult,
        lookup_catalog_parcel,
    ),
}
