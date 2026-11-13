"""Connect grouped polygon summaries to the existing Processing operation lifecycle."""

from typing import Any

from eolab_app.catalog_selection import ResolvedCatalogSelection
from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.operation_context import OperationContext
from eolab_app.processing.vector_summary_models import (
    OPERATION,
    QueuedVectorSummary,
    VectorSummaryInput,
    VectorSummaryRequest,
    VectorSummarySpec,
)


def bind_vector_summary(
    inputs: dict[str, Any], parameters: dict[str, Any], request_id: str, label: str
) -> VectorSummaryRequest:
    """Bind a recipe's polygon fields, statistic and boundary detail to a summary request.

    Args:
        inputs: Captured source and configured group/value roles under "vector".
            The installed recipe and generic vector input contract validate those roles.
        parameters: Selected "statistic" and approximate simplification distance
            under "boundary_tolerance_m".
        request_id: Ordinary model submission retry identifier, owned by admission.
        label: Ordinary model run name, owned by the surrounding model request.

    Returns:
        Validated field choices, statistic and boundary tolerance without filesystem paths.

    Raises:
        ValidationError: If a selection, field name, statistic or tolerance is invalid.
    """
    selected = inputs["vector"]
    return VectorSummaryRequest(
        vector=VectorSummaryInput(
            selection=selected["selection"],
            groupField=selected["fields"]["group"],
            valueField=selected["fields"]["value"],
        ),
        **parameters,
    )


def build_vector_summary_submission(
    request: VectorSummaryRequest, polygons: dict[str, AggregateArea]
) -> PreparedJobPlan:
    """Queue a polygon summary without reading features or copying selection geometry.

    Args:
        request: Captured original source, predicate, fields and boundary detail.
        polygons: Empty mapping; this operation uses original vector descriptors.

    Returns:
        An ordinary queued plan eligible for existing private-input retention.
    """
    return PreparedJobPlan(
        operation=OPERATION,
        specification=QueuedVectorSummary(request=request).model_dump(
            mode="json", by_alias=True
        ),
        summary={},
        reserved_bytes=0,
    )


async def prepare_vector_summary(
    context: OperationContext, queued: QueuedVectorSummary, primary: None
) -> PreparedJobPlan:
    """Prepare the captured vector request for supervised execution without preflight scans.

    Args:
        context: Existing worker capabilities and lifecycle settings.
        queued: Admitted path-free summary request.
        primary: None because this operation requires no raster source.

    Returns:
        The ordinary typed native specification, without a fabricated raster grid.
    """
    return PreparedJobPlan(
        operation=OPERATION,
        specification=VectorSummarySpec(inputs=queued.request).model_dump(
            mode="json", by_alias=True
        ),
        summary={},
        reserved_bytes=0,
    )


async def prepare_vector_summary_execution(
    context: OperationContext, spec: VectorSummarySpec, primary: None
) -> tuple[ResolvedCatalogSelection, VectorSummarySpec]:
    """Resolve the captured vector through ordinary authorized and retained source access.

    Args:
        context: Worker-owned vector reader, including accepted private-upload retention.
        spec: Captured field choices and source predicate.
        primary: None because this calculation has no primary raster.

    Returns:
        Ephemeral authorized original source and the unchanged native specification.

    Raises:
        ProcessingError: If vector source reading is unavailable.
        SelectionUnavailableError: If the original source or its predicate is unavailable.
    """
    if context.areas is None:
        raise ProcessingError(
            "selection_unavailable", "Vector source reading is unavailable.", 409
        )
    source = await context.areas.resolve_for_sampling(spec.inputs.vector.selection)
    return source, spec


def describe_vector_summary_result(
    summary: dict[str, Any], artifact: dict[str, Any], policy: dict[str, Any] | None
) -> dict[str, Any]:
    """Describe the GeoPackage result without copying its geometry or field inventory.

    Args:
        summary: Ordinary model result declaration and captured identity.
        artifact: Published vector summary file metadata.
        policy: Retained numerical settings, when still available.

    Returns:
        Native layer name, output feature count and the generated numeric column name.
    """
    return {
        "layerName": "summary",
        "featureCount": artifact["feature_count"],
        "defaultNumericField": artifact["summary_field"],
    }


def describe_vector_summary_outcome(artifact: dict[str, Any]) -> dict[str, Any]:
    """Return vector file and grouping facts for the retained Run YAML.

    Args:
        artifact: Published file metadata returned by the registered summary worker.

    Returns:
        Ordinary vector metadata and the operation's separately typed grouping details.
    """
    return {
        "statistics": None,
        "vector": {
            "filename": artifact["filename"],
            "bytes": artifact["size"],
            "sha256": artifact["sha256"],
            "layerName": "summary",
            "featureCount": artifact["feature_count"],
        },
        "details": {
            "summaryField": artifact["summary_field"],
            "inputFeatureCount": artifact["input_feature_count"],
            "missingValueCount": artifact["missing_value_count"],
        },
    }
