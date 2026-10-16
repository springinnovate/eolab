"""Build model calculation jobs, record how they run, and export their results."""

import base64
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from functools import lru_cache
import hashlib
from importlib.metadata import version, PackageNotFoundError
from importlib.resources import files
import json
import mimetypes
from pathlib import Path, PurePath
import re
from typing import Any
import unicodedata

import fiona
import pyproj
import rasterio
import shapely
from pydantic import AwareDatetime, BaseModel, ValidationError

from eolab_app.processing.model_definitions import (
    FixedInputBinding,
    ModelSchema,
    ModelRegistry,
    validate_operation,
)
from eolab_app.processing.model_run_contracts import (
    MODEL_OPERATION,
    MODEL_RUN_RETENTION_SECONDS,
    ModelInvocation,
    ModelRunPresentation,
    ModelRunRequest,
    ModelRunSpec,
    RunDocument,
)
from eolab_app.processing.model_yaml import (
    encode_canonical_json,
    compute_document_checksum,
    export_yaml,
)
from eolab_app.processing.models import (
    OpaqueId,
    PreparedJobPlan,
    ProcessingError,
    ProcessingLimits,
    Artifact,
)
from eolab_app.processing.artifact_manifest import (
    FileDeclaration,
    ProducedFile,
    PublishedFile,
    read_artifact_manifest,
)
from eolab_app.processing.model_operations import get_model_operation


def describe_model_run_name(row: dict[str, Any]) -> dict[str, str]:
    """Describe a run with its editable name and fixed local creation timestamp.

    Args:
        row: Owned job record, including its original summary and subscriber presentation.

    Returns:
        The editable name, a YYYY_MM_DD_HH_MM_SS timestamp, and their combined label.
        Historical runs use their original label and a UTC creation timestamp.

    Raises:
        ValidationError: If persisted presentation settings are invalid.
    """
    presentation = ModelRunPresentation.model_validate(row.get("presentation") or {})
    summary = row.get("summary") or row["spec"]
    name = presentation.label or summary["label"]
    created = row["created_at"].astimezone(
        timezone(timedelta(minutes=presentation.utcOffsetMinutes))
    )
    timestamp = created.strftime("%Y_%m_%d_%H_%M_%S")
    return {"name": name, "nameTimestamp": timestamp, "label": f"{name} · {timestamp}"}


def build_model_download_filename(
    row: dict[str, Any], output_name: str, original_filename: str, media_type: str
) -> str:
    """Name a downloaded output using its run name and fixed creation timestamp.

    Args:
        row: Owned model run with its creation time and current display settings.
        output_name: Unique recipe output or collection member name; YAML exports
            use their document kind instead.
        original_filename: Safe stored filename supplying the file extension.
        media_type: Declared format, used to choose a standard extension only when
            the stored extension leaves no room for a run name.

    Returns:
        A portable ASCII basename of at most 160 characters, with no public ID.
        Only the run-name portion is shortened, keeping collection members distinct.
        An exceptionally long stored extension uses its MIME type's usual extension,
        or .bin when none is known.

    Raises:
        ValidationError: If persisted presentation settings are invalid.
    """
    run = describe_model_run_name(row)
    ascii_name = (
        unicodedata.normalize("NFKD", run["name"]).encode("ascii", "ignore").decode()
    )
    name = re.sub(r"[^A-Za-z0-9]+", "-", ascii_name).strip("-").lower() or "model-run"
    suffix = PurePath(original_filename).suffix
    available = 160 - len(output_name) - len(run["nameTimestamp"]) - len(suffix) - 2
    if available < 1:
        suffix = mimetypes.guess_extension(media_type, strict=False) or ".bin"
        if len(suffix) > 16:
            suffix = ".bin"
        available = 160 - len(output_name) - len(run["nameTimestamp"]) - len(suffix) - 2
    return (
        f"{output_name}_{name[:available].rstrip('-')}_{run['nameTimestamp']}{suffix}"
    )


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
    for dependency in (
        "ecoshard",
        "scipy",
        "wwf-es-beneficiaries",
        "shortest-distances",
        "geopandas",
        "pandas",
        "pyogrio",
    ):
        try:
            installed = version(dependency)
        except PackageNotFoundError:
            installed = "unavailable"
        digest.update(f"{dependency}={installed}\n".encode())
    digest.update(
        encode_canonical_json(
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
) -> tuple[BaseModel, ModelInvocation]:
    """Bind a YAML recipe to its registered operation request.

    Checks the selected recipe version and checksum, applies parameter defaults,
    and saves the effective inputs alongside the calculation request.

    Args:
        request: The model, datasets, analysis area, parameters and label submitted by a user.
        registry: Installed model definitions available on this deployment.

    Returns:
        The operation request to execute and the recipe/input record to save with it.

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
    operation = get_model_operation(step.operation)
    try:
        parameters = {
            name: request.parameters.get(name, declaration.default)
            for name, declaration in definition.parameters.items()
        }
        invocation = ModelInvocation.model_validate(
            {
                "model": {
                    **request.model.model_dump(),
                    "definition": definition.to_document(),
                },
                "inputs": request.inputs,
                "parameters": parameters,
                "label": request.label,
            }
        )
        calculation = operation.bind(
            {
                name: (
                    binding.value
                    if isinstance(binding, FixedInputBinding)
                    else invocation.inputs[binding.input]
                )
                for name, binding in step.inputs.items()
            },
            {
                name: invocation.parameters[binding.parameter]
                for name, binding in step.parameters.items()
            },
            request.requestId,
            request.label,
        )
    except (ValidationError, ValueError) as error:
        raise ProcessingError(
            "invalid_model_inputs",
            "The model's raster, area or parameters are invalid.",
        ) from error
    return calculation, invocation


def build_model_job_submission(
    prepared: PreparedJobPlan,
    invocation: ModelInvocation,
    signature: tuple[int, int, int, int] | None,
    additional_signatures: dict[str, tuple[int, int, int, int]] | None = None,
) -> PreparedJobPlan:
    """Create a model job submission and save its recipe, inputs and software identity.

    Args:
        prepared: The operation submission, including any polygons already copied for this run.
        invocation: The model definition, selected inputs and effective parameter values.
        signature: Catalog source identity, or None for a retained published file.
        additional_signatures: Catalog identities for additional operation inputs.

    Returns:
        A model job ready to queue, with the information needed for later Run YAML
        export and at least seven days of result/detail retention after completion.
        It does not join another run's calculation.

    Raises:
        ProcessingError: If the saved recipe and inputs exceed the YAML size limits.
    """
    definition = invocation.model.definition
    operation = get_model_operation(definition.steps[0].operation)
    contracts = {
        item.name: item for item in (operation.output, *operation.additional_outputs)
    }
    outputs = {
        output.source.split(".")[1]: {
            "name": name,
            "label": output.label or contracts[output.source.split(".")[1]].label,
            "kind": contracts[output.source.split(".")[1]].kind,
            "mediaType": contracts[output.source.split(".")[1]].media_type,
            "presentation": output.presentation,
            "role": output.role,
        }
        for name, output in definition.outputs.items()
    }
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
                .inputs[operation.primary_input]
                .input: {
                    "sourceSignature": compute_document_checksum(
                        signature
                        if signature is not None
                        else {"sha256": prepared.input_files[0].sha256}
                    ),
                    **(
                        {
                            "sha256": prepared.input_files[0].sha256,
                            "bytes": prepared.input_files[0].size,
                        }
                        if prepared.input_files
                        else {}
                    ),
                    "band": 1,
                }
            },
        },
    }
    if additional_signatures:
        metadata["execution"]["additionalSources"] = {
            name: compute_document_checksum(identity)
            for name, identity in additional_signatures.items()
        }
    export_yaml(metadata, run=True)
    spec = ModelRunSpec(
        calculation=prepared.specification,
        sourceSignature=signature,
        additionalSourceSignatures=additional_signatures or {},
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
            "operationId": operation.id,
            "output": outputs[operation.output.name],
            "outputs": outputs,
        },
        retained_metadata=metadata,
        minimum_retention_seconds=MODEL_RUN_RETENTION_SECONDS,
        work_key=None,
        presentation=None,
    )


def declare_model_files(
    row: dict[str, Any], artifact: Artifact
) -> tuple[FileDeclaration, ...]:
    """Bind complete operation files to the outputs captured from a run's YAML.

    Args:
        row: Current model attempt with its validated public output declarations.
        artifact: Primary and additional files returned by the trusted operation.

    Returns:
        Only the scientific files explicitly requested by this recipe. The worker
        separately includes the operation's provenance record. Collection outputs
        retain each member's operation-supplied name and combine the recipe label
        with the member label; single-file outputs use the recipe alias.

    Raises:
        ProcessingError: If files are missing, duplicated, unknown, or have a format
            different from the registered operation contract.
        ValidationError: If native file metadata is invalid.
    """
    operation = get_model_operation(read_model_job_operation_id(row))
    contracts = {
        item.name: item for item in (operation.output, *operation.additional_outputs)
    }
    primary = ProducedFile(
        name=operation.output.name,
        storage_name=getattr(artifact, "result_name", "result.tif"),
        filename=artifact.filename,
        media_type=artifact.media_type,
        size=artifact.size,
        sha256=artifact.sha256,
    )
    produced = (primary, *artifact.additional_outputs)
    if len({item.name for item in produced}) != len(produced):
        raise ProcessingError(
            "invalid_model_result",
            "The operation returned unexpected result files.",
            500,
        )
    by_output: dict[str, list[ProducedFile]] = {}
    for item in produced:
        output_name = item.output_name or item.name
        contract = contracts.get(output_name)
        if (
            contract is None
            or item.media_type != contract.media_type
            or contract.multiple_files != (item.output_name is not None)
            or contract.multiple_files != (item.member_label is not None)
        ):
            raise ProcessingError(
                "invalid_model_result",
                "The operation returned unexpected result files.",
                500,
            )
        by_output.setdefault(output_name, []).append(item)
    summary = row.get("summary") or row["spec"]
    outputs = summary.get("outputs") or {operation.output.name: summary["output"]}
    declarations = []
    for name, output in outputs.items():
        if (
            name not in by_output
            or name not in contracts
            or output["mediaType"] != contracts[name].media_type
            or output["role"] != contracts[name].role
        ):
            raise ProcessingError(
                "invalid_model_result",
                "A declared model output is missing or invalid.",
                500,
            )
        for item in by_output[name]:
            declarations.append(
                FileDeclaration(
                    name=(
                        item.name if contracts[name].multiple_files else output["name"]
                    ),
                    label=(
                        f"{output['label']} · {item.member_label}"
                        if contracts[name].multiple_files
                        else output["label"]
                    ),
                    role=output["role"],
                    storage_name=item.storage_name,
                    filename=item.filename,
                    media_type=item.media_type,
                    size=item.size,
                    sha256=item.sha256,
                )
            )
    return tuple(declarations)


def record_model_preparation(
    row: dict[str, Any],
    prepared: PreparedJobPlan,
    limits: ProcessingLimits,
) -> PreparedJobPlan:
    """Add the prepared raster grid and calculation settings to a model job.

    Args:
        row: The worker's current job record, including the recipe and inputs saved at submission.
        prepared: The prepared summary or clip plan and required disk reservation.
        limits: The worker's configured time, memory, disk and result-retention limits.

    Returns:
        The model job plan with preparation details ready to save. Raster result
        grids also enter the public summary, which outlives saved YAML metadata.
        The original recipe and selected inputs remain unchanged.

    Raises:
        ProcessingError: If the updated Run YAML exceeds its document limits.
        ValidationError: If the stored model or prepared calculation is invalid.
        ValueError: If the prepared operation differs from the saved recipe.
    """
    wrapper = ModelRunSpec.model_validate(row["spec"])
    operation = get_model_operation(prepared.operation)
    spec = operation.prepared_type.model_validate(prepared.specification)
    metadata = json.loads(encode_canonical_json(row["retained_metadata"]))
    invocation = ModelInvocation.model_validate(metadata["invocation"])
    validate_operation(invocation.model.definition)
    if invocation.model.definition.steps[0].operation != spec.operation:
        raise ValueError("Prepared operation does not match the saved recipe")
    raster_name = (
        invocation.model.definition.steps[0].inputs[operation.primary_input].input
    )
    execution = metadata["execution"]
    execution.update(
        {
            "state": "prepared",
            "limits": {
                "runtimeSeconds": None,
                "processMemoryBytes": None,
                "reservedBytes": prepared.reserved_bytes,
                "resultTtlSeconds": limits.result_ttl_seconds,
            },
            "numericalPolicy": operation.policy(spec).model_dump(
                mode="json", exclude_none=True
            ),
        }
    )
    execution["sources"][raster_name]["grid"] = spec.grid.model_dump(mode="json")
    export_yaml(metadata, run=True)
    return replace(
        prepared,
        operation=MODEL_OPERATION,
        specification=wrapper.model_copy(update={"calculation": spec}).model_dump(
            mode="json", by_alias=True
        ),
        summary={**row["summary"], "grid": spec.grid.model_dump(mode="json")},
        retained_metadata=metadata,
    )


def serialize_model_job(row: dict[str, Any]) -> dict[str, Any]:
    """Convert a model job record into the status response shown to its user.

    Args:
        row: A job record already checked to belong to the requesting browser session.

    Returns:
        Model identity, status, progress, errors, expiry and available result links.
        Running progress includes an installed operation's stage description when
        available. Unknown phases or unavailable operations omit the description;
        the response schema validates the resulting progress before delivery.
        Expired results have no download links.

    Raises:
        ProcessingError: If a completed result's operation or format is unsupported.
    """
    summary = row.get("summary") or row["spec"]
    status = row["status"]
    if status == "ready" and row["expires_at"] <= datetime.now(timezone.utc):
        status = "expired"
    artifact = row.get("artifact") if status == "ready" else None
    progress = row["progress"]
    # Preserve both historical block counters and operation-supplied work units.
    measured = {"phase": progress.get("phase")}
    if "completed" in progress and progress.get("total", 0) > 0:
        measured.update(
            completed=progress["completed"],
            total=progress["total"],
            unit=progress["unit"],
        )
    if "completedBlocks" in progress and progress.get("totalBlocks", 0) > 0:
        measured.update(
            completed=progress["completedBlocks"],
            total=progress["totalBlocks"],
            unit="blocks",
        )
    if status == "running" and isinstance(measured["phase"], str):
        try:
            operation = get_model_operation(read_model_job_operation_id(row))
        except ProcessingError as error:
            if error.code != "unsupported_model_operation":
                raise
        else:
            measured["description"] = dict(operation.progress_descriptions).get(
                measured["phase"]
            )
    identifier = row["id"]
    result = None
    if artifact is not None:
        operation = get_model_operation(read_model_job_operation_id(row))
        if artifact["media_type"] != operation.output.media_type:
            raise ProcessingError(
                "invalid_model_result",
                "The result format does not match this model output.",
                500,
            )
        output = summary.get("output") or {
            "name": operation.output.name,
            "label": operation.output.label,
            "kind": operation.output.kind,
            "mediaType": operation.output.media_type,
            "presentation": operation.output.presentation,
            "role": "result",
        }
        result = {
            **output,
            "url": f"/api/processing/jobs/{row['id']}/result",
            "provenanceUrl": f"/api/processing/jobs/{row['id']}/provenance",
            "displayName": f"{output['label']} · {describe_model_run_name(row)['label']}",
            "filename": build_model_download_filename(
                row, output["name"], artifact["filename"], artifact["media_type"]
            ),
            "bytes": artifact["size"],
            "sha256": artifact["sha256"],
            **operation.result(summary, artifact),
        }
    return {
        "jobId": identifier,
        "operation": MODEL_OPERATION,
        "status": status,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "expiresAt": row["expires_at"],
        "model": summary["model"],
        **describe_model_run_name(row),
        "metadataExpiresAt": row.get("metadata_expires_at"),
        "deletionUndo": (
            {"deletionId": row["deletion_id"], "expiresAt": row["deletion_undo_until"]}
            if status == "deleted"
            and row.get("deletion_undo_until")
            and row["deletion_undo_until"] > datetime.now(timezone.utc)
            else None
        ),
        "progress": measured,
        "error": row["error"],
        "result": result,
        "artifacts": serialize_model_artifacts(row),
    }


def describe_artifact_file(file: PublishedFile, row: dict[str, Any]) -> dict[str, Any]:
    """Describe a completed file without publishing its private storage basename.

    Args:
        file: Validated immutable inventory entry.
        row: Owned model run supplying its current name and fixed creation time.

    Returns:
        Public scientific metadata, independent of download availability.

    Raises:
        ValidationError: If the run's persisted display settings are invalid.
    """
    return {
        "artifactId": file.id,
        "name": file.name,
        "label": file.label,
        "displayName": f"{file.label} · {describe_model_run_name(row)['label']}",
        "role": file.role,
        "filename": build_model_download_filename(
            row, file.name, file.filename, file.media_type
        ),
        "mediaType": file.media_type,
        "bytes": file.size,
        "sha256": file.sha256,
    }


def serialize_model_artifacts(row: dict[str, Any]) -> dict[str, Any]:
    """List complete retained files only while an owned model run is available.

    Args:
        row: Job record already authorized for the requesting session.

    Returns:
        A path-free manifest with owner-checked download URLs, or an empty list
        explaining that files are pending or unavailable. Historical runs without
        inventories retain their original result/provenance URLs separately.

    Raises:
        ValidationError: If the stored manifest is malformed.
    """
    files = []
    total = 0
    availability = (
        "pending"
        if row["status"] in {"queued", "running", "cancelling"}
        else "unavailable"
    )
    stored = (row.get("artifact") or {}).get("manifest")
    if (
        row["status"] == "ready"
        and row["expires_at"] > datetime.now(timezone.utc)
        and stored
    ):
        manifest = read_artifact_manifest(stored)
        availability, total = "available", manifest.total_bytes
        files = [
            {
                **describe_artifact_file(file, row),
                "url": f"/api/processing/jobs/{row['id']}/artifacts/{file.id}",
            }
            for file in manifest.files
        ]
    return {
        "jobId": row["id"],
        "availability": availability,
        "expiresAt": row["expires_at"],
        "files": files,
        "totalBytes": total,
    }


def read_model_job_operation_id(row: dict[str, Any]) -> str:
    """Read a model job's operation, including records written before adapters existed.

    Earlier summary records contained neither an operation ID nor an output
    descriptor. The original clip adapter alone stored a top-level grid. This
    compatibility rule is limited to those two historical persisted schemas.

    Args:
        row: Owned job with its compact public summary.

    Returns:
        Operation ID captured at admission or identified from the historical schema.
    """
    summary = row.get("summary") or row["spec"]
    if "operationId" in summary:
        return summary["operationId"]
    return "raster.clip.v1" if "grid" in summary else "raster.aggregate.v1"


def read_model_invocation(row: dict[str, Any]) -> ModelInvocation:
    """Read the recipe and input values saved for a model run.

    The returned name reflects the owner's latest edit; the stored invocation
    and its calculation inputs remain unchanged.

    Args:
        row: A job record already authorized for the requesting session.

    Returns:
        The saved recipe, input selections and effective parameter values.

    Raises:
        ProcessingError: If the job is not a model run, was deleted, or its
            saved metadata expired.
        ValidationError: If the saved invocation is invalid.
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
    metadata = json.loads(encode_canonical_json(row["retained_metadata"]))
    presentation = ModelRunPresentation.model_validate(row.get("presentation") or {})
    if presentation.label is not None:
        metadata["invocation"]["label"] = presentation.label
    return ModelInvocation.model_validate(metadata["invocation"])


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
    invocation = read_model_invocation(row)
    metadata = json.loads(encode_canonical_json(row["retained_metadata"]))
    if not run:
        return export_yaml(invocation.model.definition.to_document())
    execution = metadata["execution"]
    outcome = row.get("retained_outcome")
    if outcome is not None:
        artifact = outcome.get("artifact")
        execution["outcome"] = {
            "status": outcome["status"],
            "error": outcome.get("error"),
            **(
                get_model_operation(
                    invocation.model.definition.steps[0].operation
                ).outcome(artifact)
                if artifact
                else {"statistics": None}
            ),
        }
        if artifact and artifact.get("manifest"):
            execution["outcome"]["artifacts"] = [
                describe_artifact_file(file, row)
                for file in read_artifact_manifest(artifact["manifest"]).files
            ]
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
        base64.urlsafe_b64encode(encode_canonical_json(payload))
        .rstrip(b"=")
        .decode("ascii")
    )
