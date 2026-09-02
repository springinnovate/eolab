"""Raster-owned authorization for dynamic public WMS parameters."""

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.rendering.errors import PublishedLayerRequestError


RASTER_WMS_STYLE_NAME = "dynamic-raster"
_STYLE_ENVIRONMENT_KEYS = frozenset(
    {"min", "med", "max", "cmin", "cmed", "cmax"}
)
_STYLE_COLOR_PATTERN = re.compile(r"#[0-9a-fA-F]{6}")
_STYLE_OPACITY_KEYS = frozenset({"amin", "amed", "amax"})
_STYLE_ENVIRONMENT_ERROR = (
    "env must define ordered finite min, med, and max values plus cmin, "
    "cmed, and cmax six-digit hex colors, optionally followed by amin, "
    "amed, and amax finite opacities from 0 through 1"
)


def parse_raster_style_environment(environment: str) -> dict[str, str]:
    """Parse validated substitutions consumed by the dynamic raster SLD.

    Args:
        environment: Untrusted WMS ``env`` query value.

    Returns:
        Exact validated assignment names and serialized values.

    Raises:
        PublishedLayerRequestError: If the dynamic raster style is malformed.
    """
    fields = environment.split(";")
    if len(environment) > 384 or len(fields) not in (6, 9):
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
    assignments = {}
    for field in fields:
        name, separator, value = field.partition(":")
        if separator == "" or name in assignments:
            raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
        assignments[name] = value
    if assignments.keys() not in (
        _STYLE_ENVIRONMENT_KEYS,
        _STYLE_ENVIRONMENT_KEYS | _STYLE_OPACITY_KEYS,
    ):
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
    try:
        thresholds = tuple(
            float(assignments[name]) for name in ("min", "med", "max")
        )
        opacities = tuple(
            float(assignments.get(name, "1")) for name in _STYLE_OPACITY_KEYS
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
            six threshold/color assignments, with either all three bounded
            opacity assignments or none (legacy fully opaque rendering).
    """
    parse_raster_style_environment(environment)


@dataclass(frozen=True)
class PublishedRasterAuthorization:
    """Current raster source plus its feature-owned WMS request policy.

    Attributes:
        source_path: Canonical mounted GeoTIFF path.
        source_signature: Filesystem identity approved at publication.
        style_name: Only public WMS style authorized for this raster.
    """

    source_path: Path
    source_signature: RasterSourceIdentity
    style_name: str = RASTER_WMS_STYLE_NAME

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
            PublishedLayerRequestError: If a dynamic-style environment is
                malformed.
        """
        del operation
        if "env" in query:
            validate_raster_style_environment(query["env"])

    def build_composite_sld(
        self,
        layer_name: str,
        style_name: str,
        style_environment: str | None,
        style_definition: Mapping[str, object] | None,
        opacity: float,
    ) -> bytes:
        """Build one authorized inline raster layer for composite rendering.

        Args:
            layer_name: Current workspace-qualified raster layer identity.
            style_name: Requested dynamic raster style identity.
            style_environment: Required validated raster ramp environment.
            style_definition: Unsupported vector-style representation.
            opacity: Neutral retained-layer opacity from zero through one.

        Returns:
            Complete single-layer SLD document.

        Raises:
            PublishedLayerRequestError: If the appearance is not a complete
                authorized dynamic raster style.
        """
        if (
            style_name != self.style_name
            or style_environment is None
            or style_definition is not None
        ):
            raise PublishedLayerRequestError(
                "Composite raster rendering requires its dynamic raster style"
            )
        assignments = parse_raster_style_environment(style_environment)
        from eolab_app.raster.composite_sld import build_raster_composite_sld

        return build_raster_composite_sld(layer_name, assignments, opacity)
