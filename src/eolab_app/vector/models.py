"""Public requests, responses, and internal vector value objects."""

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from eolab_app.catalog.vector import (
    MOUNTED_VECTOR_COLLECTION_ID,
    VECTOR_SOURCE_METADATA_KEY,
)


VECTOR_RENDERING_POLICY = "vector-v1"
VECTOR_READER_CONTRACT = "geoserver-3.0.1-geotools-35.1-vector-v1"
VECTOR_RENDERING_METADATA_KEY = "eolab:vector_rendering"
VectorFormat = Literal[
    "shapefile",
    "geopackage",
    "geojson",
    "zipped-shapefile",
    "file-geodatabase",
]
VectorGeometryKind = Literal["point", "line", "polygon"]
VectorSourceKind = Literal["mounted", "remote"]
VectorSourceSignature = tuple[tuple[str, int, int, int, int, int], ...]


@dataclass(frozen=True)
class ResolvedVectorSource:
    """Exact source and layer identity derived from one authoritative Item.

    Attributes:
        source_kind: Whether the Asset is mounted or remotely addressed.
        source_format: Explicit container or file format.
        source_path: Canonical mounted container path, or ``None`` for remote
            sources.
        asset_key: STAC Asset carrying the primary container identity.
        layer_name: Exact native layer name, or ``None`` for single-layer
            formats without a named inner layer.
        component_paths: Canonical files forming a mounted Shapefile.
    """

    source_kind: VectorSourceKind
    source_format: VectorFormat
    source_path: Path | None
    asset_key: str
    layer_name: str | None
    component_paths: tuple[Path, ...] = ()


class CatalogVectorRequest(BaseModel):
    """Identify one mounted-vector catalog Item without accepting paths."""

    model_config = ConfigDict(extra="forbid")

    collection_id: Literal[MOUNTED_VECTOR_COLLECTION_ID] = Field(
        alias="collectionId",
    )
    item_id: str = Field(
        alias="itemId",
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._~-]*$",
        strict=True,
    )


class VectorReaderAssessment(BaseModel):
    """Machine-readable result from the deployed vector datastore probe."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    contract: Literal[VECTOR_READER_CONTRACT]
    compatible: bool
    reason_code: Literal[
        "geoserver_datastore_unavailable",
        "geoserver_layer_missing",
        "geoserver_crs_metadata_incompatible",
        "geoserver_geometry_unreadable",
        "geoserver_vector_reader_incompatible",
    ] | None = Field(default=None, alias="reasonCode")
    geometry_kind: VectorGeometryKind | None = Field(
        default=None,
        alias="geometryKind",
    )

    @model_validator(mode="after")
    def require_compatible_shape(self) -> "VectorReaderAssessment":
        """Require geometry only for compatible reader results.

        Returns:
            The validated deployed-reader assessment.

        Raises:
            ValueError: If compatibility, reason, and geometry disagree.
        """
        if self.compatible:
            if self.reason_code is not None or self.geometry_kind is None:
                raise ValueError(
                    "Compatible vector assessments require geometry and no reason"
                )
        elif self.reason_code is None or self.geometry_kind is not None:
            raise ValueError(
                "Incompatible vector assessments require a reason and no geometry"
            )
        return self
