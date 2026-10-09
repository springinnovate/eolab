"""Build model calculation jobs, record how they run, and export their results."""

import base64
from dataclasses import replace
from datetime import datetime, timezone
from functools import lru_cache
import hashlib
from importlib.metadata import version
from importlib.resources import files
import json
from pathlib import Path
from typing import Any

import fiona
import pyproj
import rasterio
import shapely
from pydantic import AwareDatetime, TypeAdapter, ValidationError

from eolab_app.processing.aggregate_models import AggregateJobRequest, AggregateSpec
from eolab_app.processing.model_definitions import (
    ModelSchema,
    ModelRegistry,
    SummaryExpressionParameter,
    validate_operation,
)
from eolab_app.processing.model_run_contracts import (
    MODEL_OPERATION,
    ModelInvocation,
    ModelRunRequest,
    ModelRunSpec,
    RunDocument,
    SummaryArea,
)
from eolab_app.processing.model_yaml import (
    canonical_json,
    definition_digest,
    export_yaml,
)
from eolab_app.processing.models import (
    OpaqueId,
    PreparedJobPlan,
    ProcessingError,
    ProcessingLimits,
)
from eolab_app.raster.models import CatalogRasterRequest


@lru_cache(maxsize=1)
def compute_implementation_checksum() -> str:
    """Compute a checksum of the installed backend code and numerical libraries.

    The checksum includes EOlab's Python source files and the installed versions
    of its numerical libraries. It is cached for the process lifetime. The API
    saves it when accepting a run; the worker compares it before execution to
    avoid silently running that request with different software.

    Returns:
        A SHA-256 hexadecimal checksum, not a Git commit or model version.

    Raises:
        OSError: If installed source files cannot be read.
        PackageNotFoundError: If required package version metadata is unavailable.
    """
    digest = hashlib.sha256()
    # Identify the installed package as a build artifact; do not import or
    # inspect sibling services to determine whether a model may execute.
    pending = [("", files("eolab_app"))]
    while pending:
        prefix, directory = pending.pop()
        for path in sorted(directory.iterdir(), key=lambda item: item.name):
            name = f"{prefix}/{path.name}"
            if path.is_dir() and path.name != "__pycache__":
                pending.append((name, path))
            elif path.name.endswith(".py"):
                digest.update((name + "\0").encode())
                digest.update(path.read_bytes())
    for dependency in ("numpy", "rasterio", "pyproj", "shapely", "fiona"):
        digest.update(f"{dependency}={version(dependency)}\n".encode())
    digest.update(
        canonical_json(
            {
                "rasterioGdal": rasterio.__gdal_version__,
                "fionaGdal": fiona.__gdal_version__,
                "proj": pyproj.proj_version_str,
                "geos": shapely.geos_version_string,
            }
        )
    )
    return digest.hexdigest()


def get_application_build_id() -> str:
    """Read the application's Git commit, or identify a development installation.

    Returns:
        The production commit from ``/app/revision`` when available. Otherwise,
        a development identifier containing the package version and code checksum.

    Raises:
        OSError: If the revision or installed source files cannot be read.
        PackageNotFoundError: If required package version metadata is unavailable.
    """
    path = Path("/app/revision")
    if path.is_file():
        value = path.read_text(encoding="utf-8").strip()
        if len(value) == 40 and all(
            character in "0123456789abcdef" for character in value
        ):
            return value
    return f"development:{version('eolab')}:{compute_implementation_checksum()}"


def build_model_calculation_request(
    request: ModelRunRequest,
    registry: ModelRegistry,
) -> tuple[AggregateJobRequest, ModelInvocation]:
    """Translate model inputs and parameters into a raster-summary request.

    Checks the selected recipe version and checksum, applies parameter defaults,
    and saves the effective inputs alongside the calculation request.

    Args:
        request: The model, datasets, analysis area, parameters and label submitted by a user.
        registry: Installed model definitions available on this deployment.

    Returns:
        The aggregate request to execute and the recipe/input record to save with it.

    Raises:
        ProcessingError: If the model is unavailable, its definition has changed,
            or the selected input, area or formula is invalid.
    """
    definition = registry.get(request.model.id, request.model.version)
    if definition.digest != request.model.definitionSha256:
        raise ProcessingError(
            "model_changed",
            "The model definition changed. Refresh model setup before running.",
            409,
        )
    if set(request.inputs) != set(definition.inputs) or set(request.parameters) - set(
        definition.parameters
    ):
        raise ProcessingError(
            "invalid_model_inputs",
            "Supply exactly the model's inputs and declared parameters.",
        )
    step = definition.steps[0]
    raster_name, area_name = step.inputs["raster"].input, step.inputs["area"].input
    parameter_name = step.parameters["expression"].parameter
    declaration = definition.parameters[parameter_name]
    try:
        source = CatalogRasterRequest.model_validate(request.inputs[raster_name])
        area = TypeAdapter(SummaryArea).validate_python(request.inputs[area_name])
        parameter = SummaryExpressionParameter.model_validate(
            {
                **declaration.model_dump(),
                "default": request.parameters.get(parameter_name, declaration.default),
            }
        )
        area_fields = (
            {"selectedBounds": area.selectedBounds}
            if area.kind == "selectedArea"
            else (
                {"catalogSelection": area.selection}
                if area.kind == "catalogSelection"
                else (
                    {"polygonArea": area.reference}
                    if area.kind == "polygonArea"
                    else {"wholeRaster": True}
                )
            )
        )
        calculation = AggregateJobRequest(
            requestId=request.requestId,
            sources={"a": source},
            calculations=[{"label": request.label, "expression": parameter.default}],
            **area_fields,
        )
        invocation = ModelInvocation.model_validate(
            {
                "model": {
                    **request.model.model_dump(),
                    "definition": definition.to_document(),
                },
                "inputs": {
                    raster_name: source.model_dump(mode="json", by_alias=True),
                    area_name: area.model_dump(mode="json", by_alias=True),
                },
                "parameters": {parameter_name: parameter.default},
                "label": request.label,
            }
        )
    except (ValidationError, ValueError) as error:
        raise ProcessingError(
            "invalid_model_inputs",
            "The model's raster, area or summary formula is invalid.",
        ) from error
    return calculation, invocation


def build_model_job_submission(
    prepared: PreparedJobPlan,
    invocation: ModelInvocation,
    signature: tuple[int, int, int, int],
) -> PreparedJobPlan:
    """Create a model job submission and save its recipe, inputs and software identity.

    Args:
        prepared: The aggregate submission, including any polygons already copied for this run.
        invocation: The model definition, selected inputs and effective parameter values.
        signature: The raster's catalog source signature at submission.

    Returns:
        A model job ready to queue, with the information needed for later Run YAML
        export. It does not join another run's calculation.

    Raises:
        ProcessingError: If the saved recipe and inputs exceed the YAML size limits.
    """
    definition = invocation.model.definition
    revision = compute_implementation_checksum()
    build = get_application_build_id()
    metadata = {
        "invocation": invocation.model_dump(mode="json", by_alias=True),
        "execution": {
            "state": "pending",
            "applicationBuild": build,
            "operations": {
                definition.steps[0].id: {
                    "id": definition.steps[0].operation,
                    "implementationRevision": revision,
                }
            },
            "sources": {
                definition.steps[0]
                .inputs["raster"]
                .input: {
                    "sourceSignature": definition_digest(signature),
                    "band": 1,
                }
            },
        },
    }
    export_yaml(metadata, run=True)
    spec = ModelRunSpec(
        calculation=prepared.specification,
        sourceSignature=signature,
        implementationRevision=revision,
        applicationBuild=build,
    )
    return replace(
        prepared,
        operation=MODEL_OPERATION,
        specification=spec.model_dump(mode="json", by_alias=True),
        summary={
            "model": {
                **invocation.model.model_dump(exclude={"definition"}),
                "title": definition.title,
            },
            "label": invocation.label,
        },
        retained_metadata=metadata,
        work_key=None,
        presentation=None,
    )


def record_model_preparation(
    row: dict[str, Any],
    prepared: PreparedJobPlan,
    limits: ProcessingLimits,
) -> PreparedJobPlan:
    """Add the prepared raster grid and calculation settings to a model job.

    Args:
        row: The worker's current job record, including the recipe and inputs saved at submission.
        prepared: The prepared raster-summary plan and required disk reservation.
        limits: The worker's configured time, memory, disk and result-retention limits.

    Returns:
        The model job plan with preparation details ready to save. Its original
        recipe and selected inputs remain unchanged.

    Raises:
        ProcessingError: If the updated Run YAML exceeds its document limits.
        ValidationError: If the stored model or prepared calculation is invalid.
    """
    wrapper = ModelRunSpec.model_validate(row["spec"])
    spec = AggregateSpec.model_validate(prepared.specification)
    metadata = json.loads(canonical_json(row["retained_metadata"]))
    invocation = ModelInvocation.model_validate(metadata["invocation"])
    validate_operation(invocation.model.definition)
    raster_name = invocation.model.definition.steps[0].inputs["raster"].input
    execution = metadata["execution"]
    execution.update(
        {
            "state": "prepared",
            "limits": {
                "runtimeSeconds": limits.runtime_seconds,
                "processMemoryBytes": limits.process_memory_bytes,
                "reservedBytes": prepared.reserved_bytes,
                "resultTtlSeconds": limits.result_ttl_seconds,
            },
            "numericalPolicy": {
                "version": "raster.aggregate.v1",
                "grid": "native",
                "resampling": "none",
                "numericInclusion": "cell_center",
                "nodata": "exclude_source_nodata_and_nonfinite",
                "valueDomain": "stored_native_values",
            },
        }
    )
    execution["sources"][raster_name]["grid"] = spec.grid.model_dump(mode="json")
    if spec.grid.groundArea is not None:
        execution["numericalPolicy"]["groundArea"] = spec.grid.groundArea.model_dump(
            mode="json"
        )
    export_yaml(metadata, run=True)
    return replace(
        prepared,
        operation=MODEL_OPERATION,
        specification=wrapper.model_copy(update={"calculation": spec}).model_dump(
            mode="json", by_alias=True
        ),
        summary=row["summary"],
        retained_metadata=metadata,
    )


def serialize_model_job(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a model job record into the status response shown to its user.

    Args:
        row: A job record already checked to belong to the requesting browser session.

    Returns:
        Model identity, status, progress, errors, expiry dates and available CSV links.
        Expired results have no download links.
    """
    summary = row.get("summary") or row["spec"]
    status = row["status"]
    if status == "ready" and row["expires_at"] <= datetime.now(timezone.utc):
        status = "expired"
    artifact = row.get("artifact") if status == "ready" else None
    progress = row["progress"]
    # Existing aggregate progress counts are native blocks within the current phase.
    measured = {"phase": progress.get("phase")}
    if "completedBlocks" in progress and progress.get("totalBlocks", 0) > 0:
        measured.update(
            completed=progress["completedBlocks"],
            total=progress["totalBlocks"],
            unit="blocks",
        )
    identifier = row["id"]
    return {
        "jobId": identifier,
        "operation": MODEL_OPERATION,
        "status": status,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "expiresAt": row["expires_at"],
        "model": summary["model"],
        "label": summary["label"],
        "metadataExpiresAt": row.get("metadata_expires_at"),
        "progress": measured,
        "error": row["error"],
        "result": (
            None
            if artifact is None
            else {
                "url": f"/api/processing/jobs/{identifier}/result",
                "provenanceUrl": f"/api/processing/jobs/{identifier}/provenance",
                "filename": artifact["filename"],
                "bytes": artifact["size"],
                "sha256": artifact["sha256"],
                "rows": artifact["rows"],
                "cacheHit": False,
            }
        ),
    }


def export_model_job_yaml(row: dict[str, Any], *, run: bool) -> bytes:
    """Generate Model YAML or Run YAML from the recipe and data saved with a job.

    The export uses the saved recipe even if its installed version has changed
    or been removed. The caller must first check that the requesting browser
    session owns the job.

    Args:
        row: The requesting session's job record.
        run: True for the full Run YAML; False for only the reusable model recipe.

    Returns:
        UTF-8 YAML bytes ready to download. Run YAML includes the selected inputs,
        calculation settings and any finished summary values or failure.

    Raises:
        ProcessingError: If the job is not a model run, was deleted, or its saved
            metadata expired; also if the YAML exceeds export limits.
        ValidationError: If the saved recipe or execution details are invalid.
    """
    expiry = row.get("metadata_expires_at")
    if row["operation"] != MODEL_OPERATION:
        raise ProcessingError("job_not_found", "This model run is unavailable.", 404)
    if (
        row["status"] == "deleted"
        or not row.get("retained_metadata")
        or (expiry is not None and expiry <= datetime.now(timezone.utc))
    ):
        raise ProcessingError(
            "model_metadata_expired",
            "This run's captured metadata is no longer available.",
            410,
        )
    metadata = json.loads(canonical_json(row["retained_metadata"]))
    invocation = ModelInvocation.model_validate(metadata["invocation"])
    if not run:
        return export_yaml(invocation.model.definition.to_document())
    execution = metadata["execution"]
    outcome = row.get("retained_outcome")
    if outcome is not None:
        artifact = outcome.get("artifact")
        execution["outcome"] = {
            "status": outcome["status"],
            "error": outcome.get("error"),
            "statistics": artifact.get("rows") if artifact else None,
        }
    document = RunDocument.model_validate(
        {
            "schema": "eolab.run/v1",
            "jobId": row["id"],
            "capturedAt": row["created_at"].isoformat(),
            "invocation": invocation.model_dump(mode="json", by_alias=True),
            "execution": execution,
        }
    )
    return export_yaml(
        document.model_dump(mode="json", by_alias=True, exclude_unset=True), run=True
    )


class ModelRunPageCursor(ModelSchema):
    """The creation time and job ID marking where a model-history page ends.

    This value selects the next page; it does not grant access to any job.
    Each database query still filters by the requesting browser session.
    """

    createdAt: AwareDatetime
    jobId: OpaqueId


def decode_model_run_cursor(value: str | None) -> tuple[datetime, str] | None:
    """Decode the starting point for the next page of model runs.

    Args:
        value: The previous response's nextCursor value, or None for the first page.

    Returns:
        The creation time and job ID to list older entries than, or None.

    Raises:
        ProcessingError: If the cursor is invalid or exceeds its size limit.
    """
    if value is None:
        return None
    try:
        if len(value) > 256:
            raise ValueError("Cursor too long")
        data = base64.b64decode(
            value + "=" * (-len(value) % 4), altchars=b"-_", validate=True
        )
        cursor = ModelRunPageCursor.model_validate_json(data)
        return cursor.createdAt, cursor.jobId
    except (ValueError, ValidationError) as error:
        raise ProcessingError(
            "invalid_cursor", "This model-list cursor is invalid.", 422
        ) from error


def encode_model_run_cursor(row: dict[str, Any]) -> str:
    """Create a continuation token from the last model run returned on a page.

    Args:
        row: The last visible job record in a model-history page.

    Returns:
        A URL-safe token encoding that job's creation time and ID.
    """
    payload = {"createdAt": row["created_at"].isoformat(), "jobId": row["id"]}
    return (
        base64.urlsafe_b64encode(canonical_json(payload)).rstrip(b"=").decode("ascii")
    )
