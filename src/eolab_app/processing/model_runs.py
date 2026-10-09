"""Model application adapters above existing Processing and aggregate contracts."""

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
def implementation_revision() -> str:
    """Identify the installed summary implementation and native library versions.

    Returns:
        SHA-256 of reviewed source modules and installed numerical dependencies.
        The API and worker must agree before an accepted model can execute.
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


def application_build() -> str:
    """Read the production source revision, with an explicit local-build identity.

    Returns:
        Git-derived production revision or a content-identified development build.
    """
    path = Path("/app/revision")
    if path.is_file():
        value = path.read_text(encoding="utf-8").strip()
        if len(value) == 40 and all(
            character in "0123456789abcdef" for character in value
        ):
            return value
    return f"development:{version('eolab')}:{implementation_revision()}"


def resolve_model_request(
    request: ModelRunRequest,
    registry: ModelRegistry,
) -> tuple[AggregateJobRequest, ModelInvocation]:
    """Bind a submitted recipe to the installed single-source aggregate contract.

    Args:
        request: Validated bounded submission envelope.
        registry: Eagerly validated installed definitions.

    Returns:
        Existing numerical request and immutable-intent capture with defaults.

    Raises:
        ProcessingError: For missing models, changed digests or invalid role values.
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


def capture_model_job(
    prepared: PreparedJobPlan,
    invocation: ModelInvocation,
    signature: tuple[int, int, int, int],
) -> PreparedJobPlan:
    """Wrap existing calculation inputs in one model job with retained provenance.

    Args:
        prepared: Existing aggregate submission, including any owned polygon copy.
        invocation: Validated effective model intent.
        signature: Catalog-authorized raster identity captured at admission.

    Returns:
        Unshared model submission using the existing queue and private workspace.

    Raises:
        ProcessingError: If retained export metadata exceeds its bounded envelope.
    """
    definition = invocation.model.definition
    revision = implementation_revision()
    build = application_build()
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


def prepare_model_job(
    row: dict[str, Any],
    prepared: PreparedJobPlan,
    limits: ProcessingLimits,
) -> PreparedJobPlan:
    """Append resolved numerical policy while preserving the accepted invocation.

    Args:
        row: Current fenced model attempt with its retained metadata.
        prepared: Prepared aggregate plan and its full disk reservation.
        limits: Effective worker policy, never values supplied by YAML.

    Returns:
        Wrapped plan and resolved provenance for atomic storage publication.

    Raises:
        ProcessingError: If the resolved export exceeds its document limits.
        ValidationError: If persisted model or aggregate data is invalid.
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


def public_model_job(row: dict[str, Any]) -> dict[str, Any]:
    """Project an already owned model row without native source or storage details.

    Args:
        row: Authorized subscriber row or newly admitted row.

    Returns:
        Model lifecycle, measured progress and currently available CSV downloads.
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


def owned_model_yaml(row: dict[str, Any], *, run: bool) -> bytes:
    """Export a captured definition/run without requiring its installed version.

    Args:
        row: Owner-authorized job; deleted and metadata-expired rows are unavailable.
        run: Include invocation, resolved execution and sanitized terminal outcome.

    Returns:
        Bounded UTF-8 YAML containing catalog references, never native capabilities.

    Raises:
        ProcessingError: If the job has no available model capture.
        ValidationError: If persisted invocation metadata violates its contract.
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


class PageCursor(ModelSchema):
    """Bounded continuation value; authorization is always reapplied to the query."""

    createdAt: AwareDatetime
    jobId: OpaqueId


def decode_cursor(value: str | None) -> tuple[datetime, str] | None:
    """Read an opaque model-list continuation token.

    Args:
        value: Optional URL-safe base64 token.

    Returns:
        Exclusive timestamp/ID boundary, or no boundary.

    Raises:
        ProcessingError: For an oversized or invalid cursor.
    """
    if value is None:
        return None
    try:
        if len(value) > 256:
            raise ValueError("Cursor too long")
        data = base64.b64decode(
            value + "=" * (-len(value) % 4), altchars=b"-_", validate=True
        )
        cursor = PageCursor.model_validate_json(data)
        return cursor.createdAt, cursor.jobId
    except (ValueError, ValidationError) as error:
        raise ProcessingError(
            "invalid_cursor", "This model-list cursor is invalid.", 422
        ) from error


def encode_cursor(row: dict[str, Any]) -> str:
    """Encode a stable page boundary without embedding an owner or source identity.

    Args:
        row: Last visible row in the page.

    Returns:
        URL-safe opaque continuation token.
    """
    payload = {"createdAt": row["created_at"].isoformat(), "jobId": row["id"]}
    return (
        base64.urlsafe_b64encode(canonical_json(payload)).rstrip(b"=").decode("ascii")
    )
