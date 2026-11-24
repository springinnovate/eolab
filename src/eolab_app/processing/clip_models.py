"""Raster-clip inputs and result details layered on shared Processing contracts."""

from eolab_app.catalog_selection import ResolvedCatalogSelection, VectorSelection
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ModelWrapValidatorHandler,
    model_validator,
    model_serializer,
    SerializerFunctionWrapHandler,
)

from eolab_jobs.models import (
    Artifact,
    JobListResponse,
    JobProgressResponse,
    JobResponse,
    JobResultResponse,
    JobLimits,
)
from eolab_app.sampling_box import Wgs84SamplingBox, sampling_box_bounds
from eolab_app.raster.models import CatalogRasterRequest, Wgs84Bounds
from eolab_app.raster.source_models import (
    RasterAnalysisSourceReference,
    RunArtifactReference,
)

OPERATION_VERSION = "raster.clip.v1"


class ClipPolygonGroupMember(BaseModel):
    """Identify an original polygon layer and the features selected for this run.

    Attributes:
        label: Map layer name to show in run inputs and source errors.
        selection: Path-free original source identity and captured filter.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    label: Annotated[str, Field(min_length=1)]
    selection: VectorSelection


class ClipPolygonGroup(BaseModel):
    """Clip to the combined footprint of the captured polygon layers.

    Attributes:
        kind: The literal string `"polygonGroup"` identifies the area choice.
        name: Group name displayed in the model setup and run history.
        members: Original source selections recorded when the run is submitted.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["polygonGroup"]
    name: Annotated[str, Field(min_length=1, max_length=80)]
    members: Annotated[tuple[ClipPolygonGroupMember, ...], Field(min_length=1)]


class ClipInputs(BaseModel):
    """A raster or temporal observation and an explicit geographic clip area.

    Catalog requests use collectionId/itemId or a nested ``source`` reference.
    Temporal observations and private run files use their exact nested ``source``
    references.
    Choose the entire native grid explicitly, a geodesic sampling box, a
    geographic rectangle, a polygon layer, or the combined area of a polygon group.
    """

    model_config = ConfigDict(extra="forbid")
    source: RasterAnalysisSourceReference | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    collection_id: str | None = Field(
        default=None, alias="collectionId", exclude_if=lambda value: value is None
    )
    item_id: str | None = Field(
        default=None, alias="itemId", exclude_if=lambda value: value is None
    )

    selectedBounds: Wgs84Bounds | None = None
    samplingBox: Wgs84SamplingBox | None = None
    catalogSelection: VectorSelection | None = None
    polygonGroup: ClipPolygonGroup | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    wholeRaster: Literal[True] | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @model_validator(mode="wrap")
    @classmethod
    def validate_clip_inputs(
        cls, value: Any, handler: ModelWrapValidatorHandler[Self]
    ) -> Self:
        """Validate new clip inputs and reuse already validated request instances.

        Raw and persisted inputs require one raster reference and one explicit
        geographic area. Internal callers may reuse a validated request without
        repeating these checks; they must not mutate its inputs or construct it
        with Pydantic's unchecked construction/copy methods.

        Args:
            value: Raw input or an already validated clip request.
            handler: Pydantic's field validation and model construction handler.

        Returns:
            Validated request.

        Raises:
            ValueError: If source identities conflict or the area is absent or ambiguous.
        """
        request = handler(value)
        if request is value:
            return request
        if request.source is None:
            CatalogRasterRequest(
                collectionId=request.collection_id, itemId=request.item_id
            )
        elif request.collection_id is not None or request.item_id is not None:
            raise ValueError("Choose one raster source")
        if (
            sum(
                value is not None
                for value in (
                    request.selectedBounds,
                    request.samplingBox,
                    request.catalogSelection,
                    request.polygonGroup,
                    request.wholeRaster,
                )
            )
            != 1
        ):
            raise ValueError(
                "Choose exactly one map area, vector selection, or entire raster"
            )
        return request


class ClipJobRequest(ClipInputs):
    """Raster and area to clip, with a stable key for retrying one submission."""

    requestId: Annotated[
        str, Field(min_length=16, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    ]


class UnpreparedClip(BaseModel):
    """Saved clip inputs awaiting metadata inspection by the job worker."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["raster.clip.v1"] = OPERATION_VERSION
    request: ClipInputs


class ClipArea(BaseModel):
    """Retain the grid or selected area for a native clip.

    Geodesic boxes keep their center and kilometer side length; their bounds are
    only the geographic envelope. Group members retain their original source
    selections. Resolved source paths are available only during worker execution.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    kind: Literal[
        "bounds", "samplingBox", "catalogSelection", "polygonGroup", "wholeRaster"
    ]
    bounds: tuple[float, float, float, float] | None
    samplingBox: Wgs84SamplingBox | None = None
    catalogSelection: VectorSelection | None = None
    resolved: ResolvedCatalogSelection | None = Field(default=None, exclude=True)
    polygonGroup: ClipPolygonGroup | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    resolvedGroup: tuple[ResolvedCatalogSelection, ...] = Field(
        default=(), exclude=True
    )

    @model_validator(mode="after")
    def require_area_contract(self) -> "ClipArea":
        """Validate the persisted selection discriminator before native execution.

        Returns:
            The validated operation-owned area.

        Raises:
            ValueError: For inconsistent vector or box inputs.
        """
        if self.kind == "polygonGroup":
            if (
                self.polygonGroup is None
                or self.catalogSelection is not None
                or self.resolved is not None
                or self.samplingBox is not None
            ):
                raise ValueError("A combined clip requires a polygon group")
            if self.resolvedGroup and tuple(
                source.selection for source in self.resolvedGroup
            ) != tuple(member.selection for member in self.polygonGroup.members):
                raise ValueError("Resolved sources do not match the polygon group")
        elif self.polygonGroup is not None or self.resolvedGroup:
            raise ValueError("Only a polygon group area may carry group members")
        if self.kind == "wholeRaster":
            if any(
                value is not None
                for value in (
                    self.bounds,
                    self.samplingBox,
                    self.catalogSelection,
                    self.resolved,
                )
            ):
                raise ValueError("An entire raster cannot also specify a clip area")
            return self
        if self.bounds is None:
            raise ValueError("A clipped area requires geographic bounds")
        Wgs84Bounds(
            west=self.bounds[0],
            south=self.bounds[1],
            east=self.bounds[2],
            north=self.bounds[3],
        )
        if self.kind == "samplingBox":
            if (
                self.samplingBox is None
                or self.bounds != sampling_box_bounds(self.samplingBox)
                or self.catalogSelection is not None
                or self.resolved is not None
            ):
                raise ValueError(
                    "Sampling boxes require only their descriptor and geographic envelope"
                )
            return self
        if self.samplingBox is not None:
            raise ValueError("Only sampling boxes may carry a samplingBox descriptor")
        if self.kind == "catalogSelection":
            if self.catalogSelection is None:
                raise ValueError(
                    "Vector areas require only a vector selection descriptor"
                )
            if (
                self.resolved is not None
                and self.resolved.selection != self.catalogSelection
            ):
                raise ValueError("Resolved source does not match the vector selection")
        elif self.catalogSelection is not None or self.resolved is not None:
            raise ValueError("Only vector areas may carry a vector source")
        return self

    @model_serializer(mode="wrap")
    def serialize_area(
        self, handler: SerializerFunctionWrapHandler
    ) -> dict[str, object]:
        """Omit the vector descriptor when serializing a box.

        Args:
            handler: Pydantic's serialization handler.

        Returns:
            Path-free area matching its versioned discriminator.
        """
        data = handler(self)
        if self.kind != "samplingBox":
            data.pop("samplingBox", None)
        if self.kind != "catalogSelection":
            data.pop("catalogSelection", None)
        return data


class ClipGrid(BaseModel):
    """Native clip window, source block count and estimated uncompressed size."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    crs: str
    transform: tuple[float, float, float, float, float, float]
    window: tuple[int, int, int, int]
    width: int
    height: int
    dtype: str
    nodata: str | None
    nativeBlocks: int
    estimatedRawBytes: int


class ClipSpec(BaseModel):
    """A path-free clip plan with the selected source and native output grid.

    Catalog rasters carry their admitted metadata signature. Private files carry
    their published checksum. Temporal observations carry their variable and UTC
    timestamp in the source reference.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["raster.clip.v1"] = OPERATION_VERSION
    source: RasterAnalysisSourceReference
    sourceSignature: tuple[int, int, int, int] | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    sourceChecksum: str | None = Field(
        default=None, pattern=r"^[a-f0-9]{64}$", exclude_if=lambda value: value is None
    )
    area: ClipArea
    grid: ClipGrid

    @model_validator(mode="after")
    def check_source_checksum(self) -> "ClipSpec":
        """Validate the metadata appropriate to the stored source reference.

        Returns:
            The prepared clip with the correct source identity contract.

        Raises:
            ValueError: If the signature or checksum disagrees with the source type.
        """
        private = isinstance(self.source, RunArtifactReference)
        if private != (self.sourceChecksum is not None):
            raise ValueError("Private raster plans require their published checksum")
        if isinstance(self.source, CatalogRasterRequest) != (
            self.sourceSignature is not None
        ):
            raise ValueError("Only catalog raster plans require a source signature")
        return self


class ClipAreaSummary(BaseModel):
    """Browser-safe area description without copying geometry into every poll."""

    kind: Literal[
        "bounds", "samplingBox", "catalogSelection", "polygonGroup", "wholeRaster"
    ]
    bounds: tuple[float, float, float, float] | None
    samplingBox: Wgs84SamplingBox | None = Field(
        default=None, exclude_if=lambda value: value is None
    )


class ClipResultResponse(JobResultResponse):
    """Add raster validity counts to shared owned download metadata."""

    validPixels: int


class ClipProgressResponse(JobProgressResponse):
    """Add bounded native block progress and supported clip execution phases."""

    phase: (
        Literal[
            "preparing",
            "calculating",
            "clipping",
            "creating_cog",
            "validating",
            "checksumming",
            "ready",
        ]
        | None
    ) = None
    completedBlocks: int | None = None
    totalBlocks: int | None = None


class ClipJobResponse(JobResponse):
    """Describe a clip job's source, including its selected observation if temporal."""

    operation: Literal["raster.clip.v1"]
    source: RasterAnalysisSourceReference | None
    grid: ClipGrid | None
    area: ClipAreaSummary | None
    progress: ClipProgressResponse
    result: ClipResultResponse | None


# The listing reuses the common envelope; adding a supported operation can extend
# its response union without copying job ownership, status, failure, or timestamps.
ClipJobsResponse = JobListResponse[ClipJobResponse]


@dataclass(frozen=True)
class RasterClipLimits(JobLimits):
    """Configure clip job scheduling and result retention.

    Clipping streams native blocks without a total-work or storage ceiling.
    """


@dataclass(frozen=True)
class ClipArtifact(Artifact):
    """Extend shared artifact metadata with the clip's valid-pixel count."""

    valid_pixels: int
    media_type: str = field(default="image/tiff", kw_only=True)
