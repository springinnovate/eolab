"""Describe Catalog areas, scientific identity and reports for Habitat input jobs."""

from dataclasses import dataclass, field
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from eolab_app.catalog_selection import CatalogSelection
from eolab_app.processing.habitat_earth_engine import HabitatTileFailure
from eolab_app.processing.models import Artifact

OPERATION = "habitat.prepare-inputs.v1"
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
