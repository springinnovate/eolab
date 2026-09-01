"""Public requests, responses, and internal vector value objects."""

from dataclasses import dataclass
from math import isfinite
from pathlib import Path
from typing import Literal, TypeAlias

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

from eolab_app.catalog.vector import (
    MOUNTED_VECTOR_COLLECTION_ID,
    VECTOR_SOURCE_METADATA_KEY,
)


VECTOR_RENDERING_POLICY = "vector-v1"
VECTOR_READER_CONTRACT = "geoserver-3.0.1-geotools-35.1-vector-v1"
VECTOR_RENDERING_METADATA_KEY = "eolab:vector_rendering"
VECTOR_CATEGORY_DEFAULT_LIMIT = 20
VECTOR_CATEGORY_MAXIMUM_LIMIT = 50
VECTOR_CATEGORY_FEATURE_LIMIT = 100_000
VECTOR_CATEGORY_TEXT_LIMIT = 256
VectorFormat = Literal[
    "shapefile",
    "geopackage",
    "geojson",
    "zipped-shapefile",
    "file-geodatabase",
]
VectorGeometryKind = Literal["point", "line", "polygon"]
VectorLabelFontFamily = Literal["SansSerif", "Serif", "Monospaced"]
VectorLabelFontWeight = Literal["normal", "bold"]
VectorLabelPlacement = Literal["center", "above", "below", "follow-line"]
VectorSourceKind = Literal["mounted", "remote"]
VectorSourceSignature = tuple[tuple[str, int, int, int, int, int], ...]
VectorCategoryScalar: TypeAlias = StrictBool | StrictInt | StrictFloat | StrictStr


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


@dataclass(frozen=True)
class VectorCategoryRead:
    """Bounded category counts read from one exact mounted vector layer.

    Attributes:
        counts: Typed non-null values paired with observed feature counts.
        scanned_feature_count: Features included in the observed counts.
        null_count: Scanned features whose selected property is null.
        unsupported_value_count: Scanned non-null values excluded because they
            cannot safely become bounded SLD literals.
        complete: Whether the source iterator was exhausted within the limit.
    """

    counts: tuple[tuple[VectorCategoryScalar, int], ...]
    scanned_feature_count: int
    null_count: int
    unsupported_value_count: int
    complete: bool


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


class CatalogVectorCategoryRequest(CatalogVectorRequest):
    """Identify one Catalog vector and an authoritative attribute field."""

    field: str = Field(min_length=1, max_length=256, strict=True)

    @field_validator("field")
    @classmethod
    def reject_field_control_characters(cls, value: str) -> str:
        """Reject field identities that cannot safely cross text boundaries.

        Args:
            value: Candidate authoritative attribute field identity.

        Returns:
            Unmodified field identity, including meaningful whitespace.

        Raises:
            ValueError: If the name contains a control character.
        """
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("Category field cannot contain control characters")
        return value


class VectorCategoryValue(BaseModel):
    """One explicitly typed bounded scalar safe for an SLD literal."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    kind: Literal["boolean", "integer", "number", "string"]
    value: VectorCategoryScalar

    @model_validator(mode="before")
    @classmethod
    def normalize_explicit_number(
        cls,
        candidate: object,
    ) -> object:
        """Preserve an explicit floating kind when JSON writes ``1``.

        JSON has one number syntax, and browser serialization removes the
        decimal point from integral floats. The separate ``kind`` remains
        authoritative, so this validator restores a Python float before the
        strict scalar union is evaluated.

        Args:
            candidate: Untrusted category value mapping.

        Returns:
            A shallow copy with an explicit number converted to ``float``, or
            the original candidate for normal Pydantic validation.

        Raises:
            ValueError: If a declared number is not a finite JSON number.
        """
        if not isinstance(candidate, dict) or candidate.get("kind") != "number":
            return candidate
        value = candidate.get("value")
        if type(value) not in {int, float} or not isfinite(value):
            raise ValueError("Numeric category value is invalid")
        return {**candidate, "value": float(value)}

    @model_validator(mode="after")
    def require_matching_safe_value(self) -> "VectorCategoryValue":
        """Keep the declared JSON type aligned with a safe scalar value.

        Returns:
            Explicitly typed bounded category value.

        Raises:
            ValueError: If the declared kind and strict value type disagree, a
                number is non-finite, or text is too long or XML-incompatible.
        """
        expected_types = {
            "boolean": bool,
            "integer": int,
            "number": float,
            "string": str,
        }
        if type(self.value) is not expected_types[self.kind]:
            raise ValueError("Category value kind does not match its value")
        if isinstance(self.value, float) and not isfinite(self.value):
            raise ValueError("Category values must be finite")
        if isinstance(self.value, str):
            if len(self.value) > VECTOR_CATEGORY_TEXT_LIMIT:
                raise ValueError("Category text is too long")
            if any(
                ord(character) < 32 and character not in "\t\n\r"
                for character in self.value
            ):
                raise ValueError("Category text contains invalid controls")
        return self


class VectorCategoryValueCount(BaseModel):
    """One typed category value and its bounded observed feature count."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    value: VectorCategoryValue
    count: int = Field(ge=1, le=VECTOR_CATEGORY_FEATURE_LIMIT, strict=True)


class VectorCategorySummary(BaseModel):
    """Browser-safe bounded summary of one authoritative vector field."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    field: str
    field_type: str = Field(alias="fieldType")
    values: tuple[VectorCategoryValueCount, ...] = Field(
        max_length=VECTOR_CATEGORY_MAXIMUM_LIMIT,
    )
    observed_distinct_count: int = Field(
        alias="observedDistinctCount",
        ge=0,
        le=VECTOR_CATEGORY_FEATURE_LIMIT,
    )
    distinct_count: int | None = Field(
        alias="distinctCount",
        default=None,
        ge=0,
        le=VECTOR_CATEGORY_FEATURE_LIMIT,
    )
    scanned_feature_count: int = Field(
        alias="scannedFeatureCount",
        ge=0,
        le=VECTOR_CATEGORY_FEATURE_LIMIT,
    )
    feature_count: int = Field(alias="featureCount", ge=0)
    null_count: int = Field(
        alias="nullCount",
        ge=0,
        le=VECTOR_CATEGORY_FEATURE_LIMIT,
    )
    unsupported_value_count: int = Field(
        alias="unsupportedValueCount",
        ge=0,
        le=VECTOR_CATEGORY_FEATURE_LIMIT,
    )
    complete: bool
    default_limit: Literal[VECTOR_CATEGORY_DEFAULT_LIMIT] = Field(
        alias="defaultLimit",
    )
    maximum_limit: Literal[VECTOR_CATEGORY_MAXIMUM_LIMIT] = Field(
        alias="maximumLimit",
    )


class VectorLabelStyle(BaseModel):
    """Validated optional label presentation for one vector style."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    field: str = Field(min_length=1, max_length=256, strict=True)
    font_family: VectorLabelFontFamily = Field(alias="fontFamily")
    font_size: float = Field(alias="fontSize", ge=6, le=72, strict=True)
    font_weight: VectorLabelFontWeight = Field(alias="fontWeight")
    font_color: str = Field(
        alias="fontColor",
        pattern=r"^#[0-9A-Fa-f]{6}$",
        strict=True,
    )
    halo_color: str = Field(
        alias="haloColor",
        pattern=r"^#[0-9A-Fa-f]{6}$",
        strict=True,
    )
    halo_width: float = Field(
        alias="haloWidth", ge=0, le=10, strict=True
    )
    placement: VectorLabelPlacement
    minimum_zoom: int = Field(alias="minimumZoom", ge=0, le=22, strict=True)

    @field_validator("field")
    @classmethod
    def reject_control_characters(cls, value: str) -> str:
        """Reject field identities that cannot safely cross text boundaries.

        Args:
            value: Candidate authoritative attribute field identity.

        Returns:
            Unmodified field identity, including meaningful whitespace.

        Raises:
            ValueError: If the name contains a control character.
        """
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("Label field cannot contain control characters")
        return value

    @field_validator("font_color", "halo_color")
    @classmethod
    def normalize_label_color(cls, value: str) -> str:
        """Normalize validated label colors for stable SLD output.

        Args:
            value: Validated six-digit CSS hex color.

        Returns:
            Lowercase color.
        """
        return value.lower()


class VectorCategoryRule(BaseModel):
    """Validated typed equality rule for one categorical vector value."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    value: VectorCategoryValue
    color: str = Field(
        pattern=r"^#[0-9A-Fa-f]{6}$",
        strict=True,
    )

    @field_validator("color")
    @classmethod
    def normalize_color(cls, value: str) -> str:
        """Normalize one validated category color for stable SLD output.

        Args:
            value: Validated six-digit CSS hex color.

        Returns:
            Lowercase color.
        """
        return value.lower()


class VectorCategoricalStyle(BaseModel):
    """Validated bounded category rules for one authoritative field."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    field: str = Field(min_length=1, max_length=256, strict=True)
    limit: int = Field(ge=1, le=VECTOR_CATEGORY_MAXIMUM_LIMIT, strict=True)
    rules: tuple[VectorCategoryRule, ...] = Field(
        min_length=1,
        max_length=VECTOR_CATEGORY_MAXIMUM_LIMIT,
    )
    other_color: str | None = Field(
        default=None,
        alias="otherColor",
        pattern=r"^#[0-9A-Fa-f]{6}$",
        strict=True,
    )
    missing_color: str | None = Field(
        default=None,
        alias="missingColor",
        pattern=r"^#[0-9A-Fa-f]{6}$",
        strict=True,
    )

    @field_validator("field")
    @classmethod
    def reject_field_control_characters(cls, value: str) -> str:
        """Reject field identities that cannot safely cross text boundaries.

        Args:
            value: Candidate authoritative attribute field identity.

        Returns:
            Unmodified field identity.

        Raises:
            ValueError: If the field contains a control character.
        """
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("Category field cannot contain control characters")
        return value

    @field_validator("other_color", "missing_color")
    @classmethod
    def normalize_optional_color(cls, value: str | None) -> str | None:
        """Normalize optional fallback colors for stable SLD output.

        Args:
            value: Optional validated six-digit CSS hex color.

        Returns:
            Lowercase color or ``None``.
        """
        return value.lower() if value is not None else None

    @model_validator(mode="after")
    def require_unique_bounded_rules(self) -> "VectorCategoricalStyle":
        """Require typed value uniqueness and a limit covering every rule.

        Returns:
            Validated categorical style.

        Raises:
            ValueError: If values repeat with the same JSON type or the stored
                UI limit is smaller than the explicit rules.
        """
        identities = [
            (rule.value.kind, rule.value.value)
            for rule in self.rules
        ]
        if len(set(identities)) != len(identities):
            raise ValueError("Categorical style values must be unique")
        if len(self.rules) > self.limit:
            raise ValueError("Categorical style limit cannot be below its rules")
        return self


class VectorStyle(BaseModel):
    """Validated single-color or categorical vector presentation."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    geometry_kind: VectorGeometryKind = Field(alias="geometryKind")
    fill_color: str | None = Field(
        default=None,
        alias="fillColor",
        pattern=r"^#[0-9A-Fa-f]{6}$",
        strict=True,
    )
    fill_opacity: float | None = Field(
        default=None,
        alias="fillOpacity",
        ge=0,
        le=1,
        strict=True,
    )
    stroke_color: str = Field(
        alias="strokeColor",
        pattern=r"^#[0-9A-Fa-f]{6}$",
        strict=True,
    )
    stroke_opacity: float = Field(
        alias="strokeOpacity", ge=0, le=1, strict=True
    )
    stroke_width: float = Field(
        alias="strokeWidth", ge=0, le=20, strict=True
    )
    point_size: float | None = Field(
        default=None,
        alias="pointSize",
        ge=1,
        le=64,
        strict=True,
    )
    categorical: VectorCategoricalStyle | None = None
    label: VectorLabelStyle | None = None

    @field_validator("fill_color", "stroke_color")
    @classmethod
    def normalize_color(cls, value: str | None) -> str | None:
        """Normalize validated CSS hex colors for stable SLD output.

        Args:
            value: Optional validated six-digit CSS hex color.

        Returns:
            Lowercase color or ``None`` when the field is not applicable.
        """
        return value.lower() if value is not None else None

    @model_validator(mode="after")
    def require_geometry_specific_controls(self) -> "VectorStyle":
        """Reject controls that do not belong to the selected geometry.

        Returns:
            Geometry-consistent style state.

        Raises:
            ValueError: If required values are absent or inapplicable values
                are supplied.
        """
        if self.geometry_kind == "line":
            if any(
                value is not None
                for value in (
                    self.fill_color,
                    self.fill_opacity,
                    self.point_size,
                )
            ):
                raise ValueError(
                    "Line styles cannot include fill or point controls"
                )
            return self
        if self.fill_color is None or self.fill_opacity is None:
            raise ValueError("Point and polygon styles require fill controls")
        if self.geometry_kind == "point" and self.point_size is None:
            raise ValueError("Point styles require pointSize")
        if self.geometry_kind == "polygon" and self.point_size is not None:
            raise ValueError("Polygon styles cannot include pointSize")
        if (
            self.label is not None
            and self.label.placement == "follow-line"
            and self.geometry_kind != "line"
        ):
            raise ValueError("Only line styles can follow line geometry")
        return self


class CatalogVectorStyleRequest(CatalogVectorRequest):
    """Identify one Catalog vector and its complete validated style."""

    style: VectorStyle


class AppliedVectorStyle(BaseModel):
    """Browser-safe result of applying one validated vector style."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    style_name: str = Field(alias="styleName")
    style: VectorStyle


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


class PublishedVector(BaseModel):
    """Browser-safe identity of one published vector WMS layer."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    layer_name: str = Field(alias="layerName")
    bbox: tuple[float, float, float, float]
    geometry_kind: VectorGeometryKind = Field(alias="geometryKind")
    style_name: str = Field(alias="styleName")
    style: VectorStyle
