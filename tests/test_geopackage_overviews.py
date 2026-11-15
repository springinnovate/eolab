"""Exercise single-package display preparation and original-source admission."""

from contextlib import closing
from pathlib import Path
import sqlite3

import pytest

from eolab_app.catalog.geopackage_overviews import (
    GeoPackageOverview,
    OVERVIEW_METADATA_KEY,
    parse_catalog_overviews,
    read_geopackage_overviews,
)
from scripts.prepare_vector_overviews import prepare_vector_overviews


@pytest.fixture
def original_package(tmp_path: Path) -> Path:
    """Create native polygons with nonsequential IDs and representative fields.

    Args:
        tmp_path: Isolated directory for source and prepared packages.

    Returns:
        Original GeoPackage with custom ID/geometry names and a point sibling.
    """
    ogr = pytest.importorskip("osgeo.ogr")
    osr = pytest.importorskip("osgeo.osr")
    path = tmp_path / "original.gpkg"
    dataset = ogr.GetDriverByName("GPKG").CreateDataSource(str(path))
    crs = osr.SpatialReference()
    crs.ImportFromEPSG(6933)
    layer = dataset.CreateLayer(
        "areas",
        crs,
        ogr.wkbMultiPolygon,
        options=["FID=feature_key", "GEOMETRY_NAME=shape"],
    )
    for name, kind in (
        ("name", ogr.OFTString),
        ("total", ogr.OFTReal),
        ("large", ogr.OFTInteger64),
    ):
        layer.CreateField(ogr.FieldDefn(name, kind))
    shapes = (
        (7, "MULTIPOLYGON (((0 0,1 0,1 1,0 1,0 0)))"),
        (21, "MULTIPOLYGON (((0 0,500 1,1000 0,1000 1000,0 1000,0 0)))"),
    )
    for fid, wkt in shapes:
        feature = ogr.Feature(layer.GetLayerDefn())
        feature.SetFID(fid)
        feature.SetField("name", "Protected area – sample")
        if fid == 21:
            feature.SetField("total", 123.5)
        feature.SetField("large", 2**61 + fid)
        feature.SetGeometry(ogr.CreateGeometryFromWkt(wkt))
        layer.CreateFeature(feature)
    points = dataset.CreateLayer("sites", crs, ogr.wkbPoint)
    point = ogr.Feature(points.GetLayerDefn())
    point.SetGeometry(ogr.CreateGeometryFromWkt("POINT (20 30)"))
    points.CreateFeature(point)
    dataset = None
    return path


def test_preparation_preserves_original_fields_and_indexes_display_geometry(
    original_package: Path,
    tmp_path: Path,
) -> None:
    """Retain original bytes and exact attributes while simplifying indexed shapes.

    Args:
        original_package: Native source with fields that must survive copying.
        tmp_path: Isolated output directory.
    """
    output = tmp_path / "prepared.gpkg"
    prepare_vector_overviews(original_package, output, "areas", [100, 10])
    with (
        closing(sqlite3.connect(original_package)) as original,
        closing(sqlite3.connect(output)) as prepared,
    ):
        original_rows = original.execute(
            "SELECT * FROM areas ORDER BY feature_key"
        ).fetchall()
        assert (
            prepared.execute("SELECT * FROM areas ORDER BY feature_key").fetchall()
            == original_rows
        )
        assert (
            original.execute(
                "SELECT name FROM sqlite_master WHERE name='eolab_vector_overviews'"
            ).fetchone()
            is None
        )
        fields = "feature_key, name, total, large"
        values = original.execute(
            f"SELECT {fields} FROM areas ORDER BY feature_key"
        ).fetchall()
        for index in (1, 2):
            assert (
                prepared.execute(
                    f"SELECT {fields} FROM areas__overview_{index} ORDER BY feature_key"
                ).fetchall()
                == values
            )
            rows = prepared.execute(
                f"SELECT feature_key, shape FROM areas__overview_{index} ORDER BY feature_key"
            ).fetchall()
            assert rows[0][1][3] & 0x10  # GeoPackageBinary empty geometry flag.
            assert len(rows[1][1]) < len(original_rows[1][1])
            assert prepared.execute(
                f"SELECT id FROM rtree_areas__overview_{index}_shape"
            ).fetchall() == [(21,)]
        assert prepared.execute("SELECT COUNT(*) FROM sites").fetchone() == (1,)
    assert read_geopackage_overviews(output) == {
        "areas": (
            GeoPackageOverview("areas__overview_1", 10.0, "shape"),
            GeoPackageOverview("areas__overview_2", 100.0, "shape"),
        )
    }
    assert not list(tmp_path.glob(".prepared-*.gpkg"))


def test_scan_catalogs_original_and_ordinary_sibling_without_display_duplicates(
    original_package: Path,
    tmp_path: Path,
) -> None:
    """A prepared container publishes one original item plus ordinary siblings.

    Args:
        original_package: Native source with polygon and unrelated point layers.
        tmp_path: Isolated output and Catalog source root.
    """
    from eolab_app.catalog.geopackage import build_stac_items

    output = tmp_path / "prepared.gpkg"
    prepare_vector_overviews(original_package, output, "areas", [10])
    items = build_stac_items(tmp_path, output)
    assert [item["properties"]["eolab:geopackage_layer"] for item in items] == [
        "areas",
        "sites",
    ]
    assert items[0]["properties"]["eolab:vector_source"]["layer_name"] == "areas"
    assert items[0]["properties"][OVERVIEW_METADATA_KEY] == [
        {
            "layer_name": "areas__overview_1",
            "tolerance": 10.0,
            "geometry_column": "shape",
        }
    ]
    assert OVERVIEW_METADATA_KEY not in items[1]["properties"]
    assert build_stac_items(tmp_path, output) == items


@pytest.mark.parametrize(
    "mutation,message",
    [
        ("UPDATE eolab_vector_overviews SET version=2", "version"),
        ("UPDATE eolab_vector_overviews SET overview_layer='absent'", "missing layers"),
        (
            "UPDATE eolab_vector_overviews SET source_layer=overview_layer",
            "conflicting",
        ),
        ("DELETE FROM areas__overview_1 WHERE feature_key=21", "feature IDs"),
        ("ALTER TABLE areas__overview_1 ADD COLUMN extra TEXT", "schema"),
        (
            "DELETE FROM gpkg_extensions WHERE table_name='areas__overview_1'",
            "spatial index",
        ),
    ],
)
def test_admission_rejects_broken_relationships(
    original_package: Path,
    tmp_path: Path,
    mutation: str,
    message: str,
) -> None:
    """Reject invalid external package relationships before exposing display levels.

    Args:
        original_package: Valid native source.
        tmp_path: Isolated output directory.
        mutation: SQL corruption applied to the prepared fixture.
        message: Expected owning-boundary error text.
    """
    output = tmp_path / "prepared.gpkg"
    prepare_vector_overviews(original_package, output, "areas", [10])
    with closing(sqlite3.connect(output)) as connection:
        connection.execute(mutation)
        connection.commit()
    with pytest.raises(ValueError, match=message):
        read_geopackage_overviews(output)


@pytest.mark.parametrize(
    "levels", [[], [0], [-1], [float("nan")], [float("inf")], [10, 10]]
)
def test_preparation_rejects_invalid_distances_before_publishing(
    original_package: Path,
    tmp_path: Path,
    levels: list[float],
) -> None:
    """Invalid user distances leave neither an output nor temporary package.

    Args:
        original_package: Source that must remain intact.
        tmp_path: Isolated output directory.
        levels: Invalid command-level tolerance values.
    """
    output = tmp_path / "prepared.gpkg"
    with pytest.raises(ValueError, match="tolerances"):
        prepare_vector_overviews(original_package, output, "areas", levels)
    assert not output.exists()
    assert not list(tmp_path.glob(".prepared-*.gpkg"))


def test_preparation_failure_and_existing_output_do_not_replace_files(
    original_package: Path,
    tmp_path: Path,
) -> None:
    """Keep existing outputs and clean a partially built package on failure.

    Args:
        original_package: Native source copied during preparation.
        tmp_path: Isolated output directory.
    """
    output = tmp_path / "prepared.gpkg"
    output.write_bytes(b"existing data")
    with pytest.raises(FileExistsError):
        prepare_vector_overviews(original_package, output, "areas", [10])
    assert output.read_bytes() == b"existing data"
    failing_output = tmp_path / "failed.gpkg"

    def interrupt_preparation(message: str) -> None:
        """Simulate cancellation after the original has been copied.

        Args:
            message: Preparation stage reached before interruption.

        Raises:
            RuntimeError: Always, to verify partial-output cleanup.
        """
        raise RuntimeError(message)

    with pytest.raises(RuntimeError, match="Copied"):
        prepare_vector_overviews(
            original_package,
            failing_output,
            "areas",
            [10],
            progress=interrupt_preparation,
        )
    assert not failing_output.exists()
    assert not list(tmp_path.glob(".failed-*.gpkg"))


@pytest.mark.parametrize(
    "value",
    [
        [],
        {},
        [{"layer_name": "areas", "tolerance": True, "geometry_column": "geom"}],
        [{"layer_name": "areas", "tolerance": 0, "geometry_column": "geom"}],
        [
            {
                "layer_name": "areas",
                "tolerance": 1,
                "geometry_column": "geom",
                "extra": 1,
            }
        ],
    ],
)
def test_persisted_overview_metadata_has_one_closed_contract(value: object) -> None:
    """Reject malformed persisted metadata at the Catalog read boundary.

    Args:
        value: Invalid Catalog property to reject.
    """
    with pytest.raises(ValueError):
        parse_catalog_overviews(value)
    assert parse_catalog_overviews(None) == ()
