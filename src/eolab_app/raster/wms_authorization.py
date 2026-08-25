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
_STYLE_ENVIRONMENT_ERROR = (
    "env must define ordered finite min, med, and max values plus cmin, "
    "cmed, and cmax six-digit hex colors"
)


def validate_raster_style_environment(environment: str) -> None:
    """Validate the substitutions consumed by the dynamic raster SLD.

    Args:
        environment: Untrusted WMS ``env`` query value.

    Raises:
        PublishedLayerRequestError: If the value is not exactly the six
            finite, ordered threshold and color assignments owned by raster
            rendering.
    """
    fields = environment.split(";")
    if len(environment) > 256 or len(fields) != 6:
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
    assignments = {}
    for field in fields:
        name, separator, value = field.partition(":")
        if separator == "" or name in assignments:
            raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
        assignments[name] = value
    if assignments.keys() != _STYLE_ENVIRONMENT_KEYS:
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)
    try:
        thresholds = tuple(
            float(assignments[name]) for name in ("min", "med", "max")
        )
    except ValueError as error:
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR) from error
    if not (
        all(math.isfinite(value) for value in thresholds)
        and thresholds[0] < thresholds[1] < thresholds[2]
        and all(
            _STYLE_COLOR_PATTERN.fullmatch(assignments[name])
            for name in ("cmin", "cmed", "cmax")
        )
    ):
        raise PublishedLayerRequestError(_STYLE_ENVIRONMENT_ERROR)


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
