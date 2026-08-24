"""Test raster-owned public WMS parameter authorization."""

import pytest

from eolab_app.raster.wms_authorization import (
    validate_raster_style_environment,
)
from eolab_app.rendering.errors import PublishedLayerRequestError
from tests.app_support import RASTER_STYLE_ENVIRONMENT_ERROR


@pytest.mark.parametrize(
    "environment",
    (
        "",
        "min:0;med:50;max:100;cmin:#2b83ba;cmed:#ffffbf;opacity:1",
        "min:0;min:1;med:50;max:100;cmin:#2b83ba;cmed:#ffffbf",
        "min:0;med:NaN;max:100;cmin:#2b83ba;cmed:#ffffbf;cmax:#d7191c",
        "min:0;med:100;max:50;cmin:#2b83ba;cmed:#ffffbf;cmax:#d7191c",
        "min:0;med:50;max:100;cmin:blue;cmed:#ffffbf;cmax:#d7191c",
    ),
)
def test_raster_style_environment_rejects_unowned_or_unsafe_values(
    environment: str,
) -> None:
    """Keep dynamic-style substitutions within the raster-owned contract.

    Args:
        environment: Invalid untrusted WMS environment value.

    Returns:
        None.
    """
    with pytest.raises(PublishedLayerRequestError) as error:
        validate_raster_style_environment(environment)

    assert str(error.value) == RASTER_STYLE_ENVIRONMENT_ERROR


def test_raster_style_environment_accepts_bounded_thresholds_and_colors() -> None:
    """Accept the exact substitutions consumed by the deployed raster SLD."""
    validate_raster_style_environment(
        "min:0;med:50;max:100;cmin:#2b83ba;cmed:#ffffbf;cmax:#d7191c"
    )
