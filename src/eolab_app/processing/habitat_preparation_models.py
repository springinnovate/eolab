"""Describe Catalog areas, scientific identity and reports for Habitat input jobs."""

from dataclasses import dataclass, field
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from eolab_app.catalog_selection import CatalogSelection
from eolab_app.processing.habitat_earth_engine import HabitatTileFailure
from eolab_app.processing.models import Artifact

OPERATION = "habitat.prepare-inputs.v1"
BULK_OPERATION = "habitat.retry-missing-inputs.v1"
HABITAT_PREPARATION_OWNER = "administration:habitat-input-preparation:v1"
"""Server-controlled job scope outside the hexadecimal browser-owner namespace."""
PreparationRequestId = Annotated[
    str, Field(strict=True, min_length=16, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
]
"""Client retry identifier using the existing Processing submission syntax."""


class _HabitatPreparationArea(BaseModel):
    """Keep a named Catalog predicate and assessment year immutable and path-free."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    name: Annotated[str, Field(strict=True, min_length=1, max_length=80, pattern=r"\S")]
    selection: CatalogSelection
    year: Annotated[int, Field(strict=True)]


class HabitatInputPreparationRequest(_HabitatPreparationArea):
    """Request one named Catalog area's inputs with an idempotent retry identifier.

    Attributes:
        requestId: Stable identifier reused when retrying the same HTTP submission.
        name: Administrator's description of the area being prepared.
        selection: Original Catalog source and exact attribute predicate.
        year: Assessment year supported by the packaged scientific configuration.
    """

    requestId: PreparationRequestId


class HabitatInputPreparationInputs(_HabitatPreparationArea):
    """Capture a preparation request with its server-selected scientific identity.

    Attributes:
        name: Administrator's description retained with the preparation job.
        selection: Immutable Catalog identity and predicate, without copied polygons.
        year: Assessment year chosen when the job was admitted.
        configurationSha256: Packaged stack digest captured at admission, including
            source definitions, bands, year and the globally anchored tile grid.
    """

    configurationSha256: Annotated[str, Field(strict=True, pattern=r"^[a-f0-9]{64}$")]


class HabitatBulkPreparationRequest(BaseModel):
    """Identify one administrator request to prepare all retained missing inputs.

    Attributes:
        requestId: Stable command identifier reused after an uncertain response.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    requestId: PreparationRequestId


class HabitatBulkPreparationInputs(HabitatBulkPreparationRequest):
    """Capture the saved areas and child commands selected when bulk work is accepted.

    Attributes:
        requestId: Administrator's stable bulk command identifier.
        areas: Distinct Catalog selections and years with stable child request IDs.
            Each child captures the current scientific configuration when queued.
    """

    areas: tuple[HabitatInputPreparationRequest, ...]


class HabitatBulkPreparationSummary(BaseModel):
    """Expose the number of saved areas and years accepted for bulk checking.

    Attributes:
        areaCount: Number of distinct saved selection/year combinations.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    areaCount: Annotated[int, Field(strict=True, ge=0)]


class HabitatBulkPreparationMetadata(BaseModel):
    """Validate retained bulk-job details when reading a persisted history record.

    Attributes:
        inputs: Public count retained for the ordinary metadata lifetime.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    inputs: HabitatBulkPreparationSummary


class HabitatBulkPreparationOutcome(BaseModel):
    """Describe whether one saved area was queued, skipped, or could not be checked.

    Attributes:
        name: Saved administrator label for this polygon selection.
        year: Saved assessment year.
        status: Whether preparation was queued, cached, already active, or failed.
        jobId: Accepted ordinary preparation identifier, only for queued outcomes.
        detail: Sanitized explanation, only for failed outcomes.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    name: str
    year: int
    status: Literal["queued", "cached", "active", "failed"]
    jobId: Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")] | None = None
    detail: str | None = None


class HabitatBulkPreparationReport(HabitatBulkPreparationSummary):
    """Record completed bulk checks and admissions, independently of tile downloads.

    Attributes:
        version: Bulk-report schema version.
        areaCount: Number of saved area/year combinations checked.
        queuedCount: Ordinary preparations accepted by Processing.
        cachedCount: Areas with complete cache coverage when checked.
        activeCount: Areas skipped because matching work was already active.
        failedCount: Areas whose coverage check or admission failed.
        outcomes: One result per captured area, in the captured order.
    """

    version: Literal[1] = 1
    queuedCount: Annotated[int, Field(strict=True, ge=0)]
    cachedCount: Annotated[int, Field(strict=True, ge=0)]
    activeCount: Annotated[int, Field(strict=True, ge=0)]
    failedCount: Annotated[int, Field(strict=True, ge=0)]
    outcomes: tuple[HabitatBulkPreparationOutcome, ...]


class QueuedHabitatBulkPreparation(BaseModel):
    """Retain a bulk request until the ordinary worker checks its saved areas.

    Attributes:
        operation: Registered Habitat bulk preparation operation.
        request: Captured area/year scope and recoverable child commands.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["habitat.retry-missing-inputs.v1"] = BULK_OPERATION
    request: HabitatBulkPreparationInputs


class HabitatBulkPreparationSpec(BaseModel):
    """Carry completed bulk outcomes to the normal retained-report publisher.

    Attributes:
        operation: Registered Habitat bulk preparation operation.
        report: Check/admission results; queued children continue independently.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["habitat.retry-missing-inputs.v1"] = BULK_OPERATION
    report: HabitatBulkPreparationReport


@dataclass(frozen=True)
class HabitatBulkPreparationArtifact(Artifact):
    """Publish a bulk-check receipt through ordinary result retention and downloads.

    Attributes:
        area_count: Number of captured area/year combinations.
        queued_count: Accepted ordinary preparation jobs.
        cached_count: Areas already completely cached when checked.
        active_count: Areas skipped because preparation was already active.
        failed_count: Areas with a check or admission failure.
        result_name: Report basename accepted by ordinary artifact storage.
        media_type: JSON report format.
    """

    area_count: int
    queued_count: int
    cached_count: int
    active_count: int
    failed_count: int
    result_name: Literal["result.json"] = field(default="result.json", init=False)
    media_type: Literal["application/json"] = field(
        default="application/json", kw_only=True
    )


class QueuedHabitatInputPreparation(BaseModel):
    """Retain accepted preparation inputs until an ordinary worker claims the job.

    Attributes:
        operation: Trusted Processing operation used to dispatch this work.
        request: Named Catalog selection, year and scientific identity, never geometry.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["habitat.prepare-inputs.v1"] = OPERATION
    request: HabitatInputPreparationInputs


class HabitatInputPreparationSpec(BaseModel):
    """Carry captured inputs into native acquisition without retaining AOI geometry.

    Attributes:
        operation: Trusted Processing operation used to dispatch this work.
        inputs: Admitted source predicate, assessment year and scientific identity.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["habitat.prepare-inputs.v1"] = OPERATION
    inputs: HabitatInputPreparationInputs


class HabitatInputPreparationReport(HabitatInputPreparationInputs):
    """Record the results of the tile attempts without exposing shared cache files.

    Attributes:
        version: Completion-report schema version.
        name: Administrator's description of the prepared area.
        selection: Catalog source and predicate whose exact polygons were read.
        year: Prepared scientific assessment year.
        configurationSha256: Scientific stack identity used for acquisition.
        tileCount: Complete tiles used or downloaded by this preparation.
        requiredTileCount: All acquisition tiles intersecting the selected area.
        failedTileCount: Number of remote tile requests that failed.
        tileFailures: Path-free provider details for each failed request.
    """

    version: Literal[2] = 2
    tileCount: Annotated[int, Field(strict=True, ge=0)]
    requiredTileCount: Annotated[int, Field(strict=True, ge=0)]
    failedTileCount: Annotated[int, Field(strict=True, ge=0)]
    tileFailures: tuple[HabitatTileFailure, ...]


@dataclass(frozen=True)
class HabitatInputPreparationArtifact(Artifact):
    """Publish a JSON receipt through the existing result-file lifecycle.

    Attributes:
        year: Assessment year whose input tiles are now prepared.
        configuration_sha256: Scientific stack identity recorded in the receipt.
        tile_count: Complete tiles reused or downloaded by this job.
        required_tile_count: All tiles required by the selected area.
        failed_tile_count: Tile downloads that failed during this job. Individual
            failure details are kept in the report file.
        result_name: Private report basename accepted by ordinary artifact storage.
        media_type: JSON report format; cached TIFFs remain outside this artifact.
    """

    year: int
    configuration_sha256: str
    tile_count: int
    required_tile_count: int
    failed_tile_count: int
    result_name: Literal["result.json"] = field(default="result.json", init=False)
    media_type: Literal["application/json"] = field(
        default="application/json", kw_only=True
    )
