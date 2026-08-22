"""Public and internal value objects for temporary uploaded AOIs."""

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


@dataclass(frozen=True)
class DatasetChoice:
    """One validated selectable spatial dataset in an upload.

    Attributes:
        id: Opaque browser-facing selection identifier.
        label: Untrusted display label from the uploaded container.
        source_path: Server-owned path opened by Fiona.
        layer_name: Exact layer name for a GeoPackage, if applicable.
    """

    id: str
    label: str
    source_path: Path
    layer_name: str | None


@dataclass
class TemporaryAoiRecord:
    """One process-local upload and its lifecycle metadata.

    Attributes:
        id: Opaque browser-facing temporary identifier.
        filename: Untrusted original filename retained only for display.
        directory: Server-owned isolated upload directory.
        choices: Opaque selection identifiers mapped to validated datasets.
        expires_at: UTC expiration timestamp.
        replacement_id: Existing AOI removed only after this upload is ready.
    """

    id: str
    filename: str
    directory: Path
    choices: dict[str, DatasetChoice]
    expires_at: datetime
    replacement_id: str | None


class TemporaryAoiChoiceResponse(BaseModel):
    """Browser-safe selectable dataset description.

    Attributes:
        id: Opaque choice identifier accepted by the selection endpoint.
        label: Untrusted layer or internal Shapefile name for display only.
    """

    id: str
    label: str


class TemporaryAoiSelectionRequiredResponse(BaseModel):
    """Response requiring an explicit dataset choice before geometry reads.

    Attributes:
        id: Opaque process-local upload identifier.
        state: Stable selection-required discriminator.
        filename: Untrusted original filename for display only.
        selected_dataset: Always ``None`` before an explicit choice.
        expires_at: Fixed UTC expiration timestamp.
        choices: Usable datasets identified by opaque choice IDs.
    """

    id: str
    state: Literal["selectionRequired"] = "selectionRequired"
    filename: str
    selected_dataset: None = Field(default=None, alias="selectedDataset")
    expires_at: datetime = Field(alias="expiresAt")
    choices: list[TemporaryAoiChoiceResponse]


class TemporaryAoiReadyResponse(BaseModel):
    """Bounded WGS 84 geometry ready for a browser overlay.

    Attributes:
        id: Opaque process-local AOI identifier.
        state: Stable ready discriminator.
        filename: Untrusted original filename for display only.
        selected_dataset: Selected layer or internal Shapefile display name.
        expires_at: Fixed UTC expiration timestamp.
        bbox: Finite canonical WGS 84 bounds.
        geometry: Bounded WGS 84 GeoJSON FeatureCollection.
    """

    id: str
    state: Literal["ready"] = "ready"
    filename: str
    selected_dataset: str = Field(alias="selectedDataset")
    expires_at: datetime = Field(alias="expiresAt")
    bbox: tuple[float, float, float, float]
    geometry: dict[str, Any]


class TemporaryAoiSelectionRequest(BaseModel):
    """Select one server-issued dataset choice without accepting a path.

    Attributes:
        choice_id: Opaque choice identifier returned by the upload endpoint.
    """

    model_config = ConfigDict(extra="forbid")

    choice_id: str = Field(
        alias="choiceId",
        min_length=32,
        max_length=32,
        pattern=r"^[A-Za-z0-9_-]{32}$",
        strict=True,
    )


TemporaryAoiUploadResponse = (
    TemporaryAoiSelectionRequiredResponse | TemporaryAoiReadyResponse
)
