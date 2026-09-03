"""Test raster-owned public WMS parameter authorization."""

from pathlib import Path
from xml.etree import ElementTree

import pytest

from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.raster.wms_authorization import (
    PublishedRasterAuthorization,
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


def test_raster_authorization_rejects_vector_feature_filter() -> None:
    """Keep selected-feature rendering confined to authorized vector layers."""
    authorization = PublishedRasterAuthorization(
        Path("raster.tif"),
        RasterSourceIdentity(1, 2, 3, 4),
    )

    with pytest.raises(
        PublishedLayerRequestError,
        match="featureid is supported only for vector layers",
    ):
        authorization.validate_parameters(
            "getmap",
            {"featureid": "parcels.42"},
        )


@pytest.mark.parametrize("alpha", ["0", "0.25", "1", "1e-3"])
def test_raster_style_accepts_three_bounded_opacities(alpha: str) -> None:
    """Authorize all three native SLD opacities, independently of layer opacity.

    Args:
        alpha: Valid finite opacity represented as an ENV value.
    """
    validate_raster_style_environment(
        "min:0;med:50;max:100;cmin:#2b83ba;cmed:#ffffbf;cmax:#d7191c"
        f";amin:{alpha};amed:0.5;amax:1"
    )


@pytest.mark.parametrize("suffix", [
    ";amin:0", ";amin:0;amed:0.5", ";amin:0;amed:0.5;other:1",
    ";amin:0;amin:0.5;amax:1", ";amin:NaN;amed:0.5;amax:1",
    ";amin:0;amed:Infinity;amax:1", ";amin:0;amed:0.5;amax:-0.1",
    ";amin:0;amed:0.5;amax:1.01", ";amin:;amed:0.5;amax:1",
    ";amin:0;amed:0.5;amax:blue", ";amin:0;amed:0.5;amax:1;opacity:0.5",
    ";amin:0;amed:0.5;amax:" + "0" * 384,
])
def test_raster_style_rejects_incomplete_or_unsafe_opacities(suffix: str) -> None:
    """Reject invalid alpha without widening the other authorized substitutions.

    Args:
        suffix: Malformed optional opacity assignments.
    """
    with pytest.raises(PublishedLayerRequestError):
        validate_raster_style_environment(
            "min:0;med:50;max:100;cmin:#2b83ba;cmed:#ffffbf;cmax:#d7191c" + suffix
        )


def test_deployed_raster_sld_consumes_opacity_with_opaque_legacy_defaults() -> None:
    """Keep native GeoServer alpha names/defaults aligned with authorization."""
    document = ElementTree.parse(Path(__file__).parents[1] / "geoserver/dynamic-raster.sld")
    entries = document.findall(".//{http://www.opengis.net/sld}ColorMapEntry")
    assert [entry.attrib["opacity"] for entry in entries] == [
        "${env('amin',1.0)}", "${env('amed',1.0)}", "${env('amax',1.0)}"
    ]
    assert document.findtext(".//{http://www.opengis.net/sld}Opacity") == "1.0"
