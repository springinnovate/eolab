"""Check whole-layer arithmetic fields through the existing Jobs execution service."""

import asyncio
from collections.abc import Mapping
from pathlib import Path
from threading import Event
from typing import Annotated, Any, Literal, cast
from uuid import UUID

import httpx2
from pydantic import BaseModel, ConfigDict, Field, model_validator

from eolab_app.calculated_fields import (
    CalculatedField,
    evaluate_calculated_fields,
    required_source_fields,
    validate_calculated_fields,
)
from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.vector.errors import VectorConflictError
from eolab_jobs.client import JobFailed, JobsClient, MAX_REQUEST_BYTES

CATALOG_URL = "http://stac-api:8080"
SCAN_MOUNT = Path("/scan-source")
UPLOAD_MOUNT = Path("/vector-uploads")
OpaqueId = Annotated[str, Field(strict=True, pattern=r"^[a-f0-9]{32}$")]


class UploadedCalculationSource(BaseModel):
    """Identify the requesting browser's original uploaded vector file."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    uploadId: UUID


class ArtifactCalculationSource(BaseModel):
    """Identify an immutable vector result without changing its ownership or expiry."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["runArtifact"]
    jobId: OpaqueId
    artifactId: OpaqueId


class FieldCalculationRequest(BaseModel):
    """Define the complete ordered calculated-field list for one vector view.

    Attributes:
        source: Catalog, upload or run-file identity; never a filesystem path.
        calculatedFields: Candidate definitions. Each may use original fields or
            earlier definitions. The view installs the complete list on success.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    source: CatalogVectorRequest | UploadedCalculationSource | ArtifactCalculationSource
    calculatedFields: Annotated[tuple[CalculatedField, ...], Field(max_length=64)]

    @model_validator(mode="after")
    def bound_definition_payload(self) -> "FieldCalculationRequest":
        """Leave room for private credentials inside the Jobs request size limit.

        Returns:
            This accepted source and definition list.

        Raises:
            ValueError: If the formula definitions cannot fit in one Jobs request.
        """
        if (
            len(self.model_dump_json(by_alias=True).encode("utf-8"))
            > MAX_REQUEST_BYTES - 1024
        ):
            raise ValueError(
                "These field definitions are too large. Shorten the expressions or use fewer fields."
            )
        return self


class FieldCalculationInput(FieldCalculationRequest):
    """Supply server-owned read credentials to the isolated Jobs operation.

    Attributes:
        uploadOwner: Browser identity for upload admission metadata only.
        readLease: Renewable source-file capability for a run result. The caller
            holds it until the Jobs process has exited, including cancellation.
    """

    uploadOwner: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    readLease: OpaqueId | None = None

    @model_validator(mode="after")
    def require_source_credential(self) -> "FieldCalculationInput":
        """Require the credential owned by the selected private-source boundary.

        Returns:
            This validated internal operation input.

        Raises:
            ValueError: If a credential is absent or belongs to another source kind.
        """
        if isinstance(self.source, UploadedCalculationSource) != (
            self.uploadOwner is not None
        ):
            raise ValueError("Only uploaded calculations require an upload owner")
        if isinstance(self.source, ArtifactCalculationSource) != (
            self.readLease is not None
        ):
            raise ValueError("Only run-result calculations require a read lease")
        return self


class FieldCalculationResult(BaseModel):
    """Return accepted definitions, combined fields and whole-source missing counts.

    Attributes:
        calculatedFields: Validated ordered definitions, reproducible from the source.
        fields: Original and calculated attribute names with their declared types.
        featureCount: Number of original features visited, regardless of map filters.
        missingCounts: Features with missing values for each calculated field.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    calculatedFields: tuple[CalculatedField, ...]
    fields: dict[str, str]
    featureCount: Annotated[int, Field(strict=True, ge=0)]
    missingCounts: dict[str, Annotated[int, Field(strict=True, ge=0)]]


class FieldCalculationOutcome(BaseModel):
    """Deliver a completed calculation or a safe input/read error across Jobs."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    result: FieldCalculationResult | None = None
    error: str | None = None

    @model_validator(mode="after")
    def require_result_or_error(self) -> "FieldCalculationOutcome":
        """Reject ambiguous or empty operation responses.

        Returns:
            This validated result envelope.

        Raises:
            ValueError: If neither or both response alternatives are present.
        """
        if (self.result is None) == (self.error is None):
            raise ValueError("Expected a field calculation or a readable error")
        return self


class FieldCalculationJobs:
    """Run a complete attribute calculation and cancel it when its caller leaves."""

    def __init__(self, jobs: JobsClient) -> None:
        """Use the application's authenticated Jobs client.

        Args:
            jobs: Existing execution, observation and cancellation adapter.
        """
        self.jobs = jobs

    async def calculate(self, inputs: FieldCalculationInput) -> FieldCalculationResult:
        """Wait for whole-layer validation before returning accepted definitions.

        Args:
            inputs: Source identity, candidate fields and server-only credentials.

        Returns:
            Complete field metadata and missing-value counts; no partial installation.

        Raises:
            VectorConflictError: If a formula, source or execution service is unavailable.
            asyncio.CancelledError: After Jobs confirms the native process has stopped.
        """
        try:
            result = await self.jobs.run(
                {
                    "operation": "vector.field-calculation.v1",
                    "inputs": inputs.model_dump(mode="json", by_alias=True),
                    "priority": 0,
                },
                timeout_seconds=None,
                delete_on_completion=True,
                require_terminal_cleanup=True,
            )
            outcome = FieldCalculationOutcome.model_validate(result.value)
        except JobFailed as error:
            raise VectorConflictError(
                "The field calculation could not finish. Try again."
            ) from error
        except (httpx2.HTTPError, ValueError, TimeoutError) as error:
            raise VectorConflictError(
                "The field calculator is temporarily unavailable. Try again shortly."
            ) from error
        if outcome.error is not None:
            raise VectorConflictError(outcome.error)
        return cast(FieldCalculationResult, outcome.result)


def calculate_vector_fields(inputs: FieldCalculationInput) -> FieldCalculationOutcome:
    """Evaluate each original feature's attributes in an isolated Jobs process.

    Native imports occur only during execution, keeping operation discovery light.
    The operation never reads geometry, modifies a source or retains feature values.

    Args:
        inputs: Path-free source identity, candidate fields and private read credentials.

    Returns:
        Complete counts and definitions, or a path-free validation/read error.
    """
    from eolab_app.catalog_selection import SelectionUnavailableError
    from eolab_app.source_files import SourceFileError
    from eolab_app.vector.errors import VectorFeatureError
    from eolab_app.vector_uploads import VectorUploadError

    try:
        return FieldCalculationOutcome(
            result=asyncio.run(_calculate_vector_fields(inputs))
        )
    except (
        VectorFeatureError,
        VectorUploadError,
        SelectionUnavailableError,
        SourceFileError,
    ) as error:
        return FieldCalculationOutcome(error=str(error))


async def _calculate_vector_fields(
    inputs: FieldCalculationInput,
) -> FieldCalculationResult:
    """Authorize the original source and scan only the formula's input attributes.

    Args:
        inputs: Validated internal execution request.

    Returns:
        Complete accepted field definitions and per-field missing counts.

    Raises:
        VectorConflictError: If formulas or original attribute reads are invalid.
        VectorFeatureError: If Catalog source access fails.
        VectorUploadError: If the upload is unavailable to this browser.
        SelectionUnavailableError: If the run-file capability cannot be resolved.
    """
    import fiona
    from eolab_app.vector.catalog import StacVectorCatalog
    from eolab_app.vector.metadata import catalog_vector_fields
    from eolab_app.vector.sources import MountedVectorResolver
    from eolab_app.vector_uploads import VectorUploadStore

    source = inputs.source
    async with httpx2.AsyncClient(
        timeout=10, trust_env=False, follow_redirects=False
    ) as client:
        if isinstance(source, CatalogVectorRequest):
            item = await StacVectorCatalog(client, CATALOG_URL).get_item(source)
            resolved = MountedVectorResolver(SCAN_MOUNT).resolve(item)
            if resolved.source_path is None or resolved.source_format not in {
                "geopackage",
                "shapefile",
            }:
                raise VectorConflictError(
                    "Choose a mounted GeoPackage or Shapefile layer."
                )
            path, layer_name, fields = (
                resolved.source_path,
                resolved.layer_name,
                catalog_vector_fields(item),
            )
        elif isinstance(source, UploadedCalculationSource):
            metadata, path = VectorUploadStore(
                UPLOAD_MOUNT, max_bytes=None
            ).get_upload_source(cast(str, inputs.uploadOwner), source.uploadId)
            layer_name, fields = metadata.layer_name, metadata.fields
        else:
            from eolab_app.source_files import resolve_leased_source_path

            path = await resolve_leased_source_path(
                client,
                source.jobId,
                source.artifactId,
                cast(str, inputs.readLease),
                Path("/processing-data"),
                "application/geopackage+sqlite3",
            )
            try:
                with fiona.open(path, enabled_drivers=["GPKG"]) as dataset:
                    layer_name, fields = dataset.name, dict(
                        dataset.schema["properties"]
                    )
            except (OSError, ValueError, fiona.errors.FionaError) as error:
                raise VectorConflictError(
                    "This vector result could not be read."
                ) from error
    return scan_calculated_fields(path, layer_name, fields, inputs.calculatedFields)


def scan_calculated_fields(
    path: Path,
    layer_name: str | None,
    source_fields: Mapping[str, str],
    definitions: tuple[CalculatedField, ...],
) -> FieldCalculationResult:
    """Count calculated values over the complete source without reading geometry.

    Args:
        path: Original file resolved by its authorized source owner.
        layer_name: Exact native layer, or None for a single-layer source.
        source_fields: Admitted original attribute names and types.
        definitions: Ordered candidate definitions from the request boundary.

    Returns:
        Combined schema and exact whole-source counts, independent of a view filter.

    Raises:
        VectorConflictError: If a formula is invalid or the original source cannot be read.
    """
    from eolab_app.vector_fields import visit_vector_fields

    try:
        compiled = validate_calculated_fields(definitions, source_fields)
    except ValueError as error:
        raise VectorConflictError(str(error)) from error
    missing = dict.fromkeys((definition.name for definition in definitions), 0)
    count = 0

    def count_values(properties: Mapping[str, Any]) -> None:
        """Accumulate missing values for this original feature without retaining it.

        Args:
            properties: Original attributes requested by the compiled definitions.
        """
        nonlocal count
        count += 1
        for name, value in evaluate_calculated_fields(compiled, properties).items():
            missing[name] += int(value is None)

    try:
        visit_vector_fields(
            str(path),
            layer_name,
            required_source_fields(compiled, tuple(missing)),
            None,
            Event(),
            count_values,
        )
    except (OSError, RuntimeError, ValueError, UnicodeDecodeError) as error:
        raise VectorConflictError(
            "The layer's attributes could not be read. Reopen the layer and try again."
        ) from error
    return FieldCalculationResult(
        calculatedFields=definitions,
        fields={**source_fields, **dict.fromkeys(missing, "float")},
        featureCount=count,
        missingCounts=missing,
    )
