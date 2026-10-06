"""Bounded, layer-local categorical raster appearance contracts."""

import json
import math
from collections.abc import Mapping
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from eolab_app.rendering.errors import PublishedLayerRequestError

MAX_CATEGORICAL_RASTER_CATEGORIES = 256
MAX_CATEGORICAL_RASTER_STYLE_BYTES = 65_536
MAX_CATEGORICAL_RASTER_LABEL_LENGTH = 128
MAX_EXACT_CATEGORY_VALUE = 9_007_199_254_740_991
_STYLE_ERROR = "Categorical raster style is invalid"
_LABEL_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


class RasterUnmappedStyle(BaseModel):
    """Appearance of valid samples absent from a category table.

    Attributes:
        color: Canonical six-digit RGB hex color.
        opacity: Pixel opacity before multiplication by layer opacity.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    color: str = Field(default="#808080", pattern=r"^#[0-9a-fA-F]{6}$", strict=True)
    opacity: float = Field(default=1, ge=0, le=1, allow_inf_nan=False, strict=True)

    @field_validator("color")
    @classmethod
    def normalize_color(cls, color: str) -> str:
        """Canonicalize a validated hex color without changing its appearance.

        Args:
            color: Validated six-digit RGB hex color.

        Returns:
            Lowercase RGB hex color.
        """
        return color.lower()


class RasterCategory(RasterUnmappedStyle):
    """One exact integer category, independent of source or analysis state.

    Attributes:
        value: Integer code exactly representable by JavaScript and GeoServer.
        label: Nonempty display label, trimmed and bounded to 128 characters.
        color: Required canonical six-digit RGB hex color.
        opacity: Pixel opacity before multiplication by layer opacity.
    """

    value: int = Field(
        ge=-MAX_EXACT_CATEGORY_VALUE, le=MAX_EXACT_CATEGORY_VALUE, strict=True
    )
    label: str = Field(
        min_length=1, max_length=MAX_CATEGORICAL_RASTER_LABEL_LENGTH, strict=True
    )
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$", strict=True)

    @field_validator("value", mode="before")
    @classmethod
    def normalize_exact_integer(cls, value: object) -> int:
        """Accept integral JSON numbers without rounding fractional samples.

        Args:
            value: Untrusted category code.

        Returns:
            Exactly represented integer category code.

        Raises:
            ValueError: If the code is not a finite, safely represented integer.
        """
        if (
            type(value) not in {int, float}
            or not -MAX_EXACT_CATEGORY_VALUE <= value <= MAX_EXACT_CATEGORY_VALUE
        ):
            raise ValueError("Category codes must be safe integers")
        if isinstance(value, float) and (
            not math.isfinite(value) or not value.is_integer()
        ):
            raise ValueError("Category codes must be safe integers")
        return int(value)

    @field_validator("label", mode="before")
    @classmethod
    def trim_label(cls, label: object) -> str:
        """Trim boundary whitespace from one display-only label.

        Args:
            label: Untrusted category label.

        Returns:
            Trimmed label for ordinary length validation.

        Raises:
            ValueError: If the label is not a string.
        """
        if not isinstance(label, str):
            raise ValueError("Category labels must be strings")
        return label.strip(_LABEL_WHITESPACE)


class CategoricalRasterStyle(BaseModel):
    """Immutable exact-value appearance belonging to one map layer.

    Attributes:
        mode: Explicit categorical discriminator.
        categories: Unique codes in the user's display order.
        unmapped: Appearance of valid values absent from the category table.
            NoData is always separate and remains transparent.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    mode: Literal["categorical"]
    categories: tuple[RasterCategory, ...] = Field(
        min_length=1, max_length=MAX_CATEGORICAL_RASTER_CATEGORIES
    )
    unmapped: RasterUnmappedStyle = Field(default_factory=RasterUnmappedStyle)

    @model_validator(mode="after")
    def require_unique_categories(self) -> "CategoricalRasterStyle":
        """Reject ambiguous duplicate codes, including equivalent JSON numbers.

        Returns:
            Validated category table in its original display order.

        Raises:
            ValueError: If a category code appears more than once.
        """
        values = [category.value for category in self.categories]
        if len(values) != len(set(values)):
            raise ValueError("Category codes must be unique")
        return self


def parse_categorical_raster_style(
    candidate: Mapping[str, object],
) -> CategoricalRasterStyle:
    """Validate one untrusted structured categorical style at its boundary.

    Args:
        candidate: JSON-compatible layer appearance, with no source identity.

    Returns:
        Canonical immutable appearance with category order preserved.

    Raises:
        PublishedLayerRequestError: If the style violates its shape, scalar,
            uniqueness, or 65,536-byte UTF-8 serialized input limit.
    """
    try:
        serialized = json.dumps(
            candidate, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        )
        if len(serialized.encode("utf-8")) > MAX_CATEGORICAL_RASTER_STYLE_BYTES:
            raise ValueError("Categorical raster style exceeds its byte limit")
        return CategoricalRasterStyle.model_validate(candidate)
    except (
        TypeError,
        ValueError,
        UnicodeError,
        ValidationError,
        RecursionError,
    ) as error:
        raise PublishedLayerRequestError(_STYLE_ERROR) from error


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Decode one JSON object without silently accepting duplicate fields.

    Args:
        pairs: Object fields in wire order, including any duplicates.

    Returns:
        Mapping with exactly one value for every field.

    Raises:
        ValueError: If one field name appears more than once.
    """
    result: dict[str, object] = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("Categorical raster style fields must not repeat")
        result[name] = value
    return result


def parse_categorical_raster_style_json(serialized: str) -> CategoricalRasterStyle:
    """Decode and validate a bounded categorical WMS style definition.

    Args:
        serialized: Untrusted UTF-8 JSON query value.

    Returns:
        Canonical immutable categorical appearance.

    Raises:
        PublishedLayerRequestError: If JSON is malformed, fields repeat, the
            encoded input exceeds 65,536 bytes, or the style is invalid.
    """
    try:
        if len(serialized.encode("utf-8")) > MAX_CATEGORICAL_RASTER_STYLE_BYTES:
            raise ValueError("Categorical raster style exceeds its byte limit")
        candidate = json.loads(serialized, object_pairs_hook=_unique_json_object)
    except (TypeError, ValueError, UnicodeError, RecursionError) as error:
        raise PublishedLayerRequestError(_STYLE_ERROR) from error
    return parse_categorical_raster_style(candidate)
