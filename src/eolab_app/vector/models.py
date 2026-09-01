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
VECTOR_FIELD_FEATURE_LIMIT = 100_000
VECTOR_CATEGORY_TEXT_LIMIT = 256
VECTOR_NUMERIC_DEFAULT_CLASS_COUNT = 5
VECTOR_NUMERIC_MINIMUM_CLASS_COUNT = 2
VECTOR_NUMERIC_MAXIMUM_CLASS_COUNT = 9
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
VectorClassificationMethod = Literal["equal-interval", "quantile"]
VectorSequentialPalette = Literal["blues", "viridis", "yellow-red", "purples"]


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


@dataclass(frozen=True)
class VectorNumericRead:
    """Bounded finite numeric values from one exact mounted vector layer.

    Attributes:
        values: Finite numeric property values in source iteration order.
        scanned_feature_count: Features inspected by the bounded read.
        null_count: Scanned features whose selected property is null.
        unsupported_value_count: Scanned non-null values excluded because they
            are not finite numbers.
        complete: Whether the source iterator was exhausted within the limit.
    """

    values: tuple[float, ...]
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


class CatalogVectorNumericClassificationRequest(CatalogVectorRequest):
    """Request one bounded classification for a current numeric field."""

    field: str = Field(min_length=1, max_length=256, strict=True)
    method: VectorClassificationMethod
    class_count: int = Field(
        alias="classCount",
        ge=VECTOR_NUMERIC_MINIMUM_CLASS_COUNT,
        le=VECTOR_NUMERIC_MAXIMUM_CLASS_COUNT,
        strict=True,
    )

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
            raise ValueError("Numeric field cannot contain control characters")
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
    count: int = Field(ge=1, le=VECTOR_FIELD_FEATURE_LIMIT, strict=True)


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
        le=VECTOR_FIELD_FEATURE_LIMIT,
    )
    distinct_count: int | None = Field(
        alias="distinctCount",
        default=None,
        ge=0,
        le=VECTOR_FIELD_FEATURE_LIMIT,
    )
    scanned_feature_count: int = Field(
        alias="scannedFeatureCount",
        ge=0,
        le=VECTOR_FIELD_FEATURE_LIMIT,
    )
    feature_count: int = Field(alias="featureCount", ge=0)
    null_count: int = Field(
        alias="nullCount",
        ge=0,
        le=VECTOR_FIELD_FEATURE_LIMIT,
    )
    unsupported_value_count: int = Field(
        alias="unsupportedValueCount",
        ge=0,
        le=VECTOR_FIELD_FEATURE_LIMIT,
    )
    complete: bool
    default_limit: Literal[VECTOR_CATEGORY_DEFAULT_LIMIT] = Field(
        alias="defaultLimit",
    )
    maximum_limit: Literal[VECTOR_CATEGORY_MAXIMUM_LIMIT] = Field(
        alias="maximumLimit",
    )


class VectorNumericClass(BaseModel):
    """One server-computed open-ended numeric class and observed count."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    minimum: float | None = None
    maximum: float | None = None
    count: int = Field(ge=0, le=VECTOR_FIELD_FEATURE_LIMIT, strict=True)

    @model_validator(mode="before")
    @classmethod
    def normalize_json_numbers(cls, candidate: object) -> object:
        """Restore finite floats after JSON removes integral decimal points.

        Args:
            candidate: Untrusted numeric-class mapping.

        Returns:
            A shallow mapping with numeric bounds converted to floats.

        Raises:
            ValueError: If a supplied bound is not a finite JSON number.
        """
        if not isinstance(candidate, dict):
            return candidate
        normalized = dict(candidate)
        for field in ("minimum", "maximum"):
            value = normalized.get(field)
            if value is None:
                continue
            if type(value) not in {int, float} or not isfinite(value):
                raise ValueError("Numeric class bounds must be finite")
            normalized[field] = float(value)
        return normalized

    @model_validator(mode="after")
    def require_ordered_bounds(self) -> "VectorNumericClass":
        """Require an increasing range when both open bounds are present.

        Returns:
            Validated numeric class.

        Raises:
            ValueError: If the lower bound is not below the upper bound.
        """
        if (
            self.minimum is not None
            and self.maximum is not None
            and self.minimum >= self.maximum
        ):
            raise ValueError("Numeric class minimum must be below maximum")
        return self


class VectorNumericClassificationSummary(BaseModel):
    """Browser-safe bounded classification of one authoritative field."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    field: str
    field_type: str = Field(alias="fieldType")
    method: VectorClassificationMethod
    requested_class_count: int = Field(
        alias="requestedClassCount",
        ge=VECTOR_NUMERIC_MINIMUM_CLASS_COUNT,
        le=VECTOR_NUMERIC_MAXIMUM_CLASS_COUNT,
        strict=True,
    )
    actual_class_count: int = Field(
        alias="actualClassCount",
        ge=1,
        le=VECTOR_NUMERIC_MAXIMUM_CLASS_COUNT,
        strict=True,
    )
    classes: tuple[VectorNumericClass, ...] = Field(
        min_length=1,
        max_length=VECTOR_NUMERIC_MAXIMUM_CLASS_COUNT,
    )
    observed_minimum: float = Field(alias="observedMinimum", strict=True)
    observed_maximum: float = Field(alias="observedMaximum", strict=True)
    numeric_value_count: int = Field(
        alias="numericValueCount",
        ge=1,
        le=VECTOR_FIELD_FEATURE_LIMIT,
        strict=True,
    )
    scanned_feature_count: int = Field(
        alias="scannedFeatureCount",
        ge=1,
        le=VECTOR_FIELD_FEATURE_LIMIT,
        strict=True,
    )
    feature_count: int = Field(alias="featureCount", ge=1, strict=True)
    null_count: int = Field(
        alias="nullCount",
        ge=0,
        le=VECTOR_FIELD_FEATURE_LIMIT,
        strict=True,
    )
    unsupported_value_count: int = Field(
        alias="unsupportedValueCount",
        ge=0,
        le=VECTOR_FIELD_FEATURE_LIMIT,
        strict=True,
    )
    complete: bool
    default_class_count: Literal[VECTOR_NUMERIC_DEFAULT_CLASS_COUNT] = Field(
        alias="defaultClassCount",
    )
    minimum_class_count: Literal[VECTOR_NUMERIC_MINIMUM_CLASS_COUNT] = Field(
        alias="minimumClassCount",
    )
    maximum_class_count: Literal[VECTOR_NUMERIC_MAXIMUM_CLASS_COUNT] = Field(
        alias="maximumClassCount",
    )

    @model_validator(mode="after")
    def require_consistent_classes(self) -> "VectorNumericClassificationSummary":
        """Require complete adjacent class coverage and consistent counts.

        Returns:
            Validated numeric classification summary.

        Raises:
            ValueError: If class cardinality, adjacency, extent, or counts
                disagree with the summary contract.
        """
        if len(self.classes) != self.actual_class_count:
            raise ValueError("Actual numeric class count is inconsistent")
        if self.classes[0].minimum is not None:
            raise ValueError("First numeric class must be lower-open")
        if self.classes[-1].maximum is not None:
            raise ValueError("Last numeric class must be upper-open")
        if any(
            current.maximum != following.minimum
            for current, following in zip(self.classes, self.classes[1:])
        ):
            raise ValueError("Numeric classes must be adjacent")
        if sum(classification.count for classification in self.classes) != (
            self.numeric_value_count
        ):
            raise ValueError("Numeric class counts must cover every numeric value")
        if self.observed_minimum > self.observed_maximum:
            raise ValueError("Observed numeric extent is invalid")
        return self


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


class VectorGraduatedRule(BaseModel):
    """One validated open-ended numeric range and symbol color."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    minimum: float | None = None
    maximum: float | None = None
    color: str = Field(
        pattern=r"^#[0-9A-Fa-f]{6}$",
        strict=True,
    )

    @model_validator(mode="before")
    @classmethod
    def normalize_json_numbers(cls, candidate: object) -> object:
        """Restore finite floats after JSON removes integral decimal points.

        Args:
            candidate: Untrusted graduated-rule mapping.

        Returns:
            A shallow mapping with supplied bounds converted to floats.

        Raises:
            ValueError: If a supplied bound is not a finite JSON number.
        """
        if not isinstance(candidate, dict):
            return candidate
        normalized = dict(candidate)
        for field in ("minimum", "maximum"):
            value = normalized.get(field)
            if value is None:
                continue
            if type(value) not in {int, float} or not isfinite(value):
                raise ValueError("Graduated rule bounds must be finite")
            normalized[field] = float(value)
        return normalized

    @field_validator("color")
    @classmethod
    def normalize_color(cls, value: str) -> str:
        """Normalize one graduated color for deterministic SLD output.

        Args:
            value: Validated six-digit CSS hex color.

        Returns:
            Lowercase color.
        """
        return value.lower()

    @model_validator(mode="after")
    def require_ordered_bounds(self) -> "VectorGraduatedRule":
        """Require an increasing range when both bounds are present.

        Returns:
            Validated graduated rule.

        Raises:
            ValueError: If its lower bound is not below its upper bound.
        """
        if (
            self.minimum is not None
            and self.maximum is not None
            and self.minimum >= self.maximum
        ):
            raise ValueError("Graduated rule minimum must be below maximum")
        return self


class VectorGraduatedStyle(BaseModel):
    """Validated graduated classification for one numeric Catalog field."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    field: str = Field(min_length=1, max_length=256, strict=True)
    method: VectorClassificationMethod
    class_count: int = Field(
        alias="classCount",
        ge=VECTOR_NUMERIC_MINIMUM_CLASS_COUNT,
        le=VECTOR_NUMERIC_MAXIMUM_CLASS_COUNT,
        strict=True,
    )
    palette: VectorSequentialPalette
    rules: tuple[VectorGraduatedRule, ...] = Field(
        min_length=1,
        max_length=VECTOR_NUMERIC_MAXIMUM_CLASS_COUNT,
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
            raise ValueError("Graduated field cannot contain control characters")
        return value

    @field_validator("missing_color")
    @classmethod
    def normalize_missing_color(cls, value: str | None) -> str | None:
        """Normalize the optional missing-value color.

        Args:
            value: Optional validated six-digit CSS hex color.

        Returns:
            Lowercase color or ``None``.
        """
        return value.lower() if value is not None else None

    @model_validator(mode="after")
    def require_complete_adjacent_rules(self) -> "VectorGraduatedStyle":
        """Require bounded rule count and complete adjacent numeric coverage.

        Returns:
            Validated graduated style.

        Raises:
            ValueError: If rules exceed the request, leave an outer gap, or
                contain non-adjacent internal boundaries.
        """
        if len(self.rules) > self.class_count:
            raise ValueError("Graduated rules cannot exceed requested classes")
        if self.rules[0].minimum is not None:
            raise ValueError("First graduated rule must be lower-open")
        if self.rules[-1].maximum is not None:
            raise ValueError("Last graduated rule must be upper-open")
        if any(
            current.maximum != following.minimum
            for current, following in zip(self.rules, self.rules[1:])
        ):
            raise ValueError("Graduated rules must be adjacent")
        return self


class VectorStyle(BaseModel):
    """Validated single-color, categorical, or graduated presentation."""

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
    graduated: VectorGraduatedStyle | None = None
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
        if self.categorical is not None and self.graduated is not None:
            raise ValueError("Vector styles cannot combine categories and ranges")
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
