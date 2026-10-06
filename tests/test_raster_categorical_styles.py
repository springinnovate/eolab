"""Exercise categorical appearance at the raster-owned public boundary."""

import json
import math
from pathlib import Path
from xml.etree import ElementTree

import pytest
from pydantic import ValidationError

from eolab_app.raster.categorical_sld import (
    OGC_NAMESPACE,
    SLD_NAMESPACE,
    build_categorical_raster_sld,
)
from eolab_app.raster.styles import (
    MAX_CATEGORICAL_RASTER_STYLE_BYTES,
    parse_categorical_raster_style,
    parse_categorical_raster_style_json,
)
from eolab_app.rendering.errors import PublishedLayerRequestError


def _style(**changes: object) -> dict[str, object]:
    """Build a fresh small wire style with optional field replacements.

    Args:
        **changes: Top-level field replacements.

    Returns:
        Independent JSON-compatible categorical style.
    """
    return {
        "mode": "categorical",
        "categories": [{"value": 41, "label": "Forest", "color": "#228B22"}],
        **changes,
    }


def test_categorical_style_normalizes_without_reordering_or_mutable_rows() -> None:
    """Preserve display order while normalizing exact numbers and appearances."""
    style = parse_categorical_raster_style(
        _style(
            categories=[
                {"value": 41.0, "label": " Forest ", "color": "#228B22"},
                {"value": -1, "label": "Other", "color": "#ABCDEF", "opacity": 0},
                {"value": 0, "label": "Zero", "color": "#000000", "opacity": 0.5},
            ]
        )
    )
    assert [category.value for category in style.categories] == [41, -1, 0]
    assert style.categories[0].label == "Forest"
    assert style.categories[0].color == "#228b22"
    assert style.categories[0].opacity == 1
    assert style.unmapped.color == "#808080"
    assert style.unmapped.opacity == 1
    assert isinstance(style.categories, tuple)
    with pytest.raises(ValidationError, match="frozen"):
        style.categories[0].label = "Changed"


@pytest.mark.parametrize(
    "value",
    [
        True,
        False,
        "41",
        None,
        41.5,
        math.nan,
        math.inf,
        -math.inf,
        9_007_199_254_740_992,
        -9_007_199_254_740_992,
    ],
)
def test_categorical_style_rejects_inexact_or_non_numeric_codes(value: object) -> None:
    """Reject values that could silently coerce or change at a renderer boundary.

    Args:
        value: Invalid untrusted category code.
    """
    with pytest.raises(PublishedLayerRequestError):
        parse_categorical_raster_style(
            _style(
                categories=[
                    {"value": value, "label": "Invalid", "color": "#000000"},
                ]
            )
        )


@pytest.mark.parametrize(
    "changes",
    [
        {"mode": "continuous"},
        {"unknown": True},
        {"categories": []},
        {"unmapped": {"color": "red"}},
        {"unmapped": {"opacity": -0.1}},
        {"unmapped": {"opacity": True}},
        {"unmapped": {"extra": "ignored?"}},
        {"unmapped": None},
    ],
)
def test_categorical_style_rejects_invalid_top_level_fields(
    changes: dict[str, object],
) -> None:
    """Keep the appearance boundary strict and its defaults explicit.

    Args:
        changes: Invalid replacement fields.
    """
    with pytest.raises(PublishedLayerRequestError):
        parse_categorical_raster_style(_style(**changes))


@pytest.mark.parametrize(
    "changes",
    [
        {"color": "#123"},
        {"color": "#12345678"},
        {"color": "#gggggg"},
        {"color": None},
        {"label": "  "},
        {"label": 1},
        {"label": "x" * 129},
        {"opacity": -0.01},
        {"opacity": 1.01},
        {"opacity": "1"},
        {"opacity": True},
        {"opacity": math.inf},
        {"opacity": math.nan},
        {"path": "/arbitrary/source.tif"},
    ],
)
def test_categorical_style_rejects_invalid_category_fields(
    changes: dict[str, object],
) -> None:
    """Reject malformed rows rather than dropping or partially applying them.

    Args:
        changes: Invalid category field replacements.
    """
    category = {"value": 41, "label": "Forest", "color": "#228b22", **changes}
    with pytest.raises(PublishedLayerRequestError):
        parse_categorical_raster_style(_style(categories=[category]))


@pytest.mark.parametrize("values", [[41, 41.0], [0, -0.0]])
def test_categorical_style_rejects_equivalent_duplicate_codes(
    values: list[int | float],
) -> None:
    """Treat numeric equality consistently across JSON, Python, and JavaScript.

    Args:
        values: Distinct JSON spellings of one exact category.
    """
    with pytest.raises(PublishedLayerRequestError):
        parse_categorical_raster_style(
            _style(
                categories=[
                    {"value": value, "label": str(value), "color": "#000000"}
                    for value in values
                ]
            )
        )


def test_categorical_style_bounds_category_count_and_utf8_bytes() -> None:
    """Bound both category work and retained text, including multibyte labels."""
    categories = [
        {"value": value, "label": str(value), "color": "#000000"}
        for value in range(256)
    ]
    assert (
        len(parse_categorical_raster_style(_style(categories=categories)).categories)
        == 256
    )
    with pytest.raises(PublishedLayerRequestError):
        parse_categorical_raster_style(_style(categories=[*categories, categories[0]]))
    oversized = _style(
        categories=[{**category, "label": "🌲" * 128} for category in categories]
    )
    with pytest.raises(PublishedLayerRequestError):
        parse_categorical_raster_style(oversized)
    with pytest.raises(PublishedLayerRequestError):
        parse_categorical_raster_style_json(
            " " * MAX_CATEGORICAL_RASTER_STYLE_BYTES + json.dumps(_style())
        )


@pytest.mark.parametrize(
    "serialized",
    [
        "{",
        "null",
        "[]",
        "true",
        '{"mode":"categorical","mode":"categorical","categories":[]}',
        '{"mode":"categorical","categories":[{"value":1,"value":2,"label":"x","color":"#000000"}]}',
        '{"mode":"categorical","categories":[{"value":NaN,"label":"x","color":"#000000"}]}',
    ],
)
def test_categorical_json_rejects_ambiguous_or_invalid_documents(
    serialized: str,
) -> None:
    """Reject repeated fields and invalid JSON values before appearance use.

    Args:
        serialized: Malformed or ambiguous wire representation.
    """
    with pytest.raises(PublishedLayerRequestError):
        parse_categorical_raster_style_json(serialized)


def test_categorical_json_roundtrip_preserves_safe_integer_extremes() -> None:
    """Keep the largest browser-safe codes exact across structured and JSON APIs."""
    candidate = _style(
        categories=[
            {"value": value, "label": str(value), "color": "#123456"}
            for value in [-9_007_199_254_740_991, 9_007_199_254_740_991]
        ]
    )
    assert parse_categorical_raster_style_json(
        json.dumps(candidate)
    ) == parse_categorical_raster_style(candidate)


def test_categorical_sld_keeps_exact_literals_without_executable_labels() -> None:
    """Compile sorting and fallback without altering stored order or user text."""
    style = parse_categorical_raster_style(
        _style(
            categories=[
                {
                    "value": 41,
                    "label": "${env('unsafe')} <Forest>",
                    "color": "#228b22",
                    "opacity": 0.5,
                },
                {"value": -1, "label": "Negative", "color": "#000000", "opacity": 0},
            ],
            unmapped={"color": "#aabbcc", "opacity": 0.25},
        )
    )
    document = build_categorical_raster_sld("eolab:categorical", style, 0.4)
    root = ElementTree.fromstring(document)
    function = root.find(f".//{{{OGC_NAMESPACE}}}Function")
    assert function is not None
    assert function.attrib == {"name": "eolabCategoricalRaster"}
    assert [entry.text for entry in function] == [
        "-1:#000000:0;41:#228b22:0.5",
        "#aabbcc",
        "0.25",
    ]
    assert all(entry.tag == f"{{{OGC_NAMESPACE}}}Literal" for entry in function)
    assert b"unsafe" not in document
    assert float(root.findtext(f".//{{{SLD_NAMESPACE}}}Opacity")) == 0.4
    assert [category.value for category in style.categories] == [41, -1]


def test_categorical_native_fixture_matches_python_sld_generator() -> None:
    """Keep native GeoTools parser tests attached to the actual server output."""
    style = parse_categorical_raster_style(
        _style(
            categories=[
                {
                    "value": value,
                    "label": str(value),
                    "color": "#ff0000",
                    "opacity": 0 if value == 0 else 0.5 if value == 1 else 1,
                }
                for value in [
                    -9_007_199_254_740_991,
                    -1,
                    0,
                    1,
                    41,
                    9_007_199_254_740_991,
                ]
            ]
        )
    )
    fixture = (
        Path(__file__).parents[1]
        / "geoserver/reader-assessment/src/test/resources/categorical-raster.sld"
    )
    generated = build_categorical_raster_sld("eolab:categorical", style, 1).decode()
    assert ElementTree.canonicalize(
        fixture.read_text(), rewrite_prefixes=True
    ) == ElementTree.canonicalize(generated, rewrite_prefixes=True)
