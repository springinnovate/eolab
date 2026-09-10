"""Protect Catalog Shapefile suffix recognition and filesystem grouping."""

from pathlib import Path

import pytest

from eolab_app.catalog.shapefile import (
    discover_shapefile_datasets,
    shapefile_component_extension,
)


@pytest.mark.parametrize(
    ("file_name", "expected"),
    (
        ("Roads.ShP", ".shp"),
        ("Roads.SHX", ".shx"),
        ("Roads.dBf", ".dbf"),
        ("Roads.PRJ", ".prj"),
        ("Roads.CPG", ".cpg"),
        ("Roads.QIX", ".qix"),
        ("Roads.SBN", ".sbn"),
        ("Roads.SBX", ".sbx"),
        ("Roads.ShP.XmL", ".shp.xml"),
        ("Roads.shp.xml.bak", None),
        ("Roads.xml", None),
        ("Roads.shp.bak", None),
        ("Roads", None),
        ("", None),
    ),
)
def test_shapefile_component_suffixes(file_name: str, expected: str | None) -> None:
    """Recognize canonical suffixes without accepting unrelated endings.

    Args:
        file_name: Candidate basename, including mixed and compound suffixes.
        expected: Canonical suffix or unsupported result.
    """
    assert shapefile_component_extension(file_name) == expected


def test_filesystem_grouping_preserves_exact_stems(tmp_path: Path) -> None:
    """Keep compound companions with their exact, case-sensitive stem.

    Args:
        tmp_path: Directory used to construct discovered component paths.
    """
    names = [
        "Roads.ShP",
        "Roads.SHX",
        "Roads.dBf",
        "Roads.PRJ",
        "Roads.ShP.XmL",
        "roads.cpg",
        "Roads.xml",
        "Roads.shp.bak",
        "Roads.shp.xml.bak",
    ]

    assert discover_shapefile_datasets(tmp_path, names) == [
        (tmp_path / "Roads.ShP", tuple(tmp_path / name for name in sorted(names[:5])))
    ]
