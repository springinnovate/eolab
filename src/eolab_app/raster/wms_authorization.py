"""Raster-owned authorization for dynamic public WMS parameters."""

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass

from eolab_app.raster.categorical_sld import build_categorical_raster_sld
from eolab_app.raster.composite_sld import build_raster_composite_sld
from eolab_app.raster.styles import (
    parse_categorical_raster_style,
    parse_categorical_raster_style_json,
)
from eolab_app.rendering.errors import PublishedLayerRequestError
from eolab_app.calculated_fields import CalculatedField

RASTER_WMS_STYLE_NAME = "dynamic-raster"
_STYLE_OPACITY_KEYS = ("amin", "amed", "amax")
_GRADIENT_KEYS = frozenset(
    ("min", "med", "max", "cmin", "cmed", "cmax", *_STYLE_OPACITY_KEYS)
)
_STYLE_COLOR_PATTERN = re.compile(r"#[0-9a-fA-F]{6}")
_EXACT_VALUE_KEYS = frozenset({"vexact", "cexact", "aexact"})
_STYLE_ENVIRONMENT_ERROR = (
    "env requires ordered finite min, med, and max values, six-digit hex "
    "colors for cmin, cmed, and cmax, and opacities from 0 through 1 "
    "for amin, amed, and amax"
)


def parse_raster_style_environment(environment: str) -> dict[str, str]:
    """Parse validated substitutions consumed by the dynamic raster SLD.

    Args:
        environment: Three thresholds, three colors and three opacities, with
            an optional value, color and opacity for a single-value override.

    Returns:
        Exact validated assignment names and serialized values.

    Raises:
        PublishedLayerRequestError: If the dynamic raster style is malformed.
    """
    if len(environment) > 384:
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
    assignments = {}
    for field in environment.split(";"):
        name, separator, value = field.partition(":")
        if separator == "" or name in assignments:
            raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
        assignments[name] = value
    if assignments.keys() - _EXACT_VALUE_KEYS != _GRADIENT_KEYS:
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
    exact_keys = assignments.keys() & _EXACT_VALUE_KEYS
    if exact_keys:
        try:
            valid_override = (
                exact_keys == _EXACT_VALUE_KEYS
                and math.isfinite(float(assignments["vexact"]))
                and _STYLE_COLOR_PATTERN.fullmatch(assignments["cexact"])
                and 0 <= float(assignments["aexact"]) <= 1
            )
        except ValueError:
            valid_override = False
        if not valid_override:
            raise PublishedLayerRequestError(
                "Single-value styling requires a finite value, hex color and opacity from 0 through 1"
            )
    try:
        thresholds = tuple(
            float(assignments[name]) for name in ("min", "med", "max")
        )
        opacities = tuple(
            float(assignments[name]) for name in _STYLE_OPACITY_KEYS
        )
    except ValueError as error:
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR) from error
    if not (
        all(math.isfinite(value) for value in thresholds)
        and all(math.isfinite(value) and 0 <= value <= 1 for value in opacities)
        and thresholds[0] < thresholds[1] < thresholds[2]
        and all(
            _STYLE_COLOR_PATTERN.fullmatch(assignments[name])
            for name in ("cmin", "cmed", "cmax")
        )
    ):
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
    return assignments


def validate_raster_style_environment(environment: str) -> None:
    """Validate the substitutions consumed by the dynamic raster SLD.

    Args:
        environment: Untrusted WMS ``env`` query value.

    Raises:
        PublishedLayerRequestError: If the value does not contain exactly the
            three thresholds, three colors and three bounded opacities, with
            an optional complete exact-value rule.
    """
    parse_raster_style_environment(environment)


@dataclass(frozen=True)
class PublishedRasterAuthorization:
    """Raster-owned WMS request policy for an authorized published layer."""

    def is_style_authorized(self, style_name: str) -> bool:
        """Accept only the initialized dynamic raster style.

        Args:
            style_name: Public style identity supplied by the client.

        Returns:
            True for the raster rendering style.
        """
        return style_name == RASTER_WMS_STYLE_NAME

    def composite_buffer(self, style_definition: Mapping[str, object] | None) -> int:
        """Return zero because raster appearances do not draw outside their cells.

        Args:
            style_definition: Already authorized raster appearance.

        Returns:
            Zero extra query pixels.
        """
        return 0

    def validate_parameters(
        self,
        operation: str,
        query: Mapping[str, str],
    ) -> None:
        """Validate raster-owned WMS parameters.

        Args:
            operation: Normalized WMS operation.
            query: Normalized, globally bounded query parameters.

        Raises:
            PublishedLayerRequestError: If the requested representation conflicts
                with the operation or the continuous environment is malformed.
        """
        if "raster_style" in query and (operation != "getmap" or "env" in query):
            raise PublishedLayerRequestError(
                "raster_style requires GetMap without a continuous env"
            )
        if "featureid" in query:
            raise PublishedLayerRequestError(
                "featureid is supported only for vector layers"
            )
        if "vector_feature_bounds" in query:
            raise PublishedLayerRequestError(
                "vector_feature_bounds is supported only for vector layers"
            )
        if "vector_style" in query or "vector_calculated_fields" in query:
            raise PublishedLayerRequestError("vector_style is not supported for raster layers")
        if "env" in query:
            assignments = parse_raster_style_environment(query["env"])
            if "vexact" in assignments and operation != "getmap":
                raise PublishedLayerRequestError("Single-value raster styling requires GetMap")

    def prepare_query(
        self, operation: str, query: list[tuple[str, str]],
    ) -> list[tuple[str, str]]:
        """Translate authorized public identities into an upstream WMS request.

        Args:
            operation: Validated lowercase WMS operation.
            query: Globally bounded and feature-validated public query entries.

        Returns:
            A named gradient or an inline raster style. Categorical rendering
            uses nearest-neighbor sampling. Continuous rendering uses the WMS default.

        Raises:
            PublishedLayerRequestError: If the raster style is invalid.
        """
        normalized = {name.lower(): value for name, value in query}
        definition = normalized.get("raster_style")
        environment = normalized.get("env", "")
        if definition is not None:
            style = parse_categorical_raster_style_json(definition)
            document = build_categorical_raster_sld(normalized["layers"], style, 1)
        elif "vexact:" in environment:
            assignments = parse_raster_style_environment(environment)
            document = build_raster_composite_sld(normalized["layers"], assignments, 1)
        else:
            # Global WMS and GeoWebCache identify workspace styles by their full name.
            return [
                (
                    (name, f"eolab:{RASTER_WMS_STYLE_NAME}")
                    if name.lower() in {"style", "styles"} and value
                    else (name, value)
                )
                for name, value in query
            ]
        forwarded = [
            (name, value)
            for name, value in query
            if name.lower() not in {"env", "raster_style", "styles", "tiled", "tilesorigin"}
        ]
        if definition is not None:
            forwarded.append(("interpolations", "nearest neighbor"))
        return forwarded + [("styles", ""), ("sld_body", document.decode("utf-8"))]

    def composite_interpolation(
        self, style_definition: Mapping[str, object] | None
    ) -> str | None:
        """Describe resampling for an already authorized composite appearance.

        Args:
            style_definition: Categorical definition, or None for a ramp.

        Returns:
            Nearest-neighbor override for categories, otherwise service default.
        """
        return "nearest neighbor" if style_definition is not None else None

    def prepare_feature_info(self, content: bytes, query: Mapping[str, str]) -> bytes:
        """Preserve native raster feature information without vector attributes.

        Args:
            content: Bounded response from the native renderer.
            query: Already authorized original WMS parameters.

        Returns:
            The unchanged response; vector attribute context is rejected at admission.
        """
        return content

    def build_composite_sld(
        self,
        layer_name: str,
        style_name: str,
        style_environment: str | None,
        style_definition: Mapping[str, object] | None,
        opacity: float,
        calculated_fields: tuple[CalculatedField, ...] = (),
    ) -> bytes:
        """Build one authorized inline raster layer for composite rendering.

        Args:
            layer_name: Current workspace-qualified raster layer identity.
            style_name: Requested dynamic raster style identity.
            style_environment: Ramp environment, mutually exclusive with a table.
            style_definition: Bounded categorical appearance, or None for a ramp.
            opacity: Neutral retained-layer opacity from zero through one.
            calculated_fields: Unsupported vector attribute definitions.

        Returns:
            Complete single-layer SLD document.

        Raises:
            PublishedLayerRequestError: If the appearance is not a complete
                authorized dynamic raster style.
        """
        if calculated_fields:
            raise PublishedLayerRequestError(
                "Calculated vector fields are not supported for raster layers"
            )
        if not self.is_style_authorized(style_name):
            raise PublishedLayerRequestError(
                "Composite raster rendering requires its dynamic raster style"
            )
        if style_definition is not None:
            style = parse_categorical_raster_style(style_definition)
            return build_categorical_raster_sld(layer_name, style, opacity)
        assignments = parse_raster_style_environment(style_environment)
        return build_raster_composite_sld(layer_name, assignments, opacity)
