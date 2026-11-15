"""Build one GeoPackage containing original polygons and stored display levels.

Run with a GDAL-enabled Python environment. Every display level copies all IDs
and attributes from the original. Geometry is simplified once during preparation;
features whose original bounding-box diagonal is at most the tolerance receive
empty display geometry. Original geometry and attributes remain unchanged.
"""

from __future__ import annotations

import argparse
from contextlib import closing
import math
from pathlib import Path
import sqlite3
import struct
import tempfile
from collections.abc import Callable, Sequence


def _identifier(value: str) -> str:
    """Quote an exact SQLite table or column name.

    Args:
        value: Native identifier from the source dataset.

    Returns:
        Double-quoted identifier with embedded quotes escaped.
    """
    return '"' + value.replace('"', '""') + '"'


def prepare_vector_overviews(
    source: Path,
    output: Path,
    layer_name: str,
    tolerances: Sequence[float],
    *,
    progress: Callable[[str], None] | None = None,
) -> None:
    """Copy a GeoPackage and append indexed, one-to-one polygon display tables.

    Args:
        source: Original GeoPackage, opened read-only and never modified.
        output: New GeoPackage path. Existing files are never replaced.
        layer_name: Exact original polygon table to prepare.
        tolerances: Unique positive simplification distances in projected metres.
        progress: Optional callback receiving one message for each completed stage.

    Raises:
        ValueError: If the input is not a supported polygon source or tolerances
            are invalid. Version 1 supports two-dimensional projected metre data.
        FileExistsError: If the destination exists.
        OSError: If copying or publishing the new package fails.
        RuntimeError: If GDAL cannot read, simplify, or write a display level.
        sqlite3.Error: If source or output metadata cannot be read or written.
    """
    from osgeo import gdal, ogr

    gdal.UseExceptions()
    source = source.resolve(strict=True)
    output = output.resolve()
    if output.exists():
        raise FileExistsError(f"Output already exists: {output.name}")
    if (
        not tolerances
        or any(not math.isfinite(value) or value <= 0 for value in tolerances)
        or len(set(tolerances)) != len(tolerances)
    ):
        raise ValueError("Specify unique, positive, finite metre tolerances")
    distances = sorted(tolerances)
    with gdal.OpenEx(str(source), gdal.OF_VECTOR | gdal.OF_READONLY) as dataset:
        source_layer = dataset.GetLayerByName(layer_name)
        if source_layer is None:
            raise ValueError(f"Source polygon layer does not exist: {layer_name}")
        geometry_type = source_layer.GetGeomType()
        if geometry_type not in (ogr.wkbPolygon, ogr.wkbMultiPolygon):
            raise ValueError("Display levels require two-dimensional polygon geometry")
        spatial_reference = source_layer.GetSpatialRef()
        if (
            spatial_reference is None
            or not spatial_reference.IsProjected()
            or spatial_reference.GetLinearUnits() != 1
        ):
            raise ValueError(
                "Display levels require a projected metre coordinate system"
            )
        geometry_column = source_layer.GetGeometryColumn()
        fid_column = source_layer.GetFIDColumn()
        if not fid_column:
            raise ValueError("Source polygons require a feature ID column")

    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{output.stem}-", suffix=".gpkg", dir=output.parent, delete=False
        ) as scratch:
            temporary = Path(scratch.name)
        with closing(
            sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
        ) as original:
            with closing(sqlite3.connect(temporary)) as destination:
                if (
                    original.execute(
                        "SELECT 1 FROM sqlite_master WHERE name='eolab_vector_overviews'"
                    ).fetchone()
                    is not None
                ):
                    raise ValueError(
                        "Prepare display levels from an original package without overviews"
                    )
                original.backup(destination)
                srs_id = original.execute(
                    "SELECT srs_id FROM gpkg_geometry_columns WHERE table_name=?",
                    (layer_name,),
                ).fetchone()[0]
        if progress is not None:
            progress("Copied original GeoPackage")

        source_index = f"rtree_{layer_name}_{geometry_column}"
        with gdal.OpenEx(str(temporary), gdal.OF_VECTOR | gdal.OF_UPDATE) as dataset:
            layer_literal = layer_name.replace("'", "''")
            geometry_literal = geometry_column.replace("'", "''")
            indexed = dataset.ExecuteSQL(
                f"SELECT HasSpatialIndex('{layer_literal}', '{geometry_literal}')"
            )
            has_index = bool(indexed.GetNextFeature().GetField(0))
            dataset.ReleaseResultSet(indexed)
            if not has_index:
                raise ValueError("Source polygon layer requires a spatial index")

        records = []
        for index, tolerance in enumerate(distances, start=1):
            overview_name = f"{layer_name}__overview_{index}"
            with closing(sqlite3.connect(temporary)) as connection:
                if (
                    connection.execute(
                        "SELECT 1 FROM sqlite_master WHERE name=?", (overview_name,)
                    ).fetchone()
                    is not None
                ):
                    raise ValueError(
                        f"Display table name already exists: {overview_name}"
                    )
            options = gdal.VectorTranslateOptions(
                format="GPKG",
                accessMode="update",
                layers=[layer_name],
                layerName=overview_name,
                geometryType=(
                    "MULTIPOLYGON"
                    if geometry_type == ogr.wkbMultiPolygon
                    else "POLYGON"
                ),
                options=["-simplify", str(tolerance), "-preserve_fid"],
                layerCreationOptions=[
                    f"FID={fid_column}",
                    f"GEOMETRY_NAME={geometry_column}",
                    "SPATIAL_INDEX=YES",
                ],
            )
            with gdal.VectorTranslate(str(temporary), str(source), options=options):
                pass

            # GeoPackageBinary: little-endian, empty, no envelope; 2-D empty WKB.
            empty_geometry = ogr.Geometry(geometry_type).ExportToWkb(ogr.wkbNDR)
            empty_blob = b"GP\x00\x11" + struct.pack("<i", srs_id) + empty_geometry
            threshold = tolerance * tolerance
            with gdal.OpenEx(
                str(temporary), gdal.OF_VECTOR | gdal.OF_UPDATE
            ) as dataset:
                dataset.ExecuteSQL(
                    f"UPDATE {_identifier(overview_name)} SET {_identifier(geometry_column)}=X'{empty_blob.hex()}' "
                    f"WHERE {_identifier(fid_column)} IN (SELECT id FROM {_identifier(source_index)} "
                    f"WHERE (maxx-minx)*(maxx-minx)+(maxy-miny)*(maxy-miny)<={threshold!r})"
                )
            records.append((1, layer_name, overview_name, tolerance))
            if progress is not None:
                progress(f"Prepared {tolerance:g} m display level")

        with closing(sqlite3.connect(temporary)) as connection:
            connection.execute(
                "CREATE TABLE eolab_vector_overviews (version INTEGER NOT NULL, "
                "source_layer TEXT NOT NULL, overview_layer TEXT NOT NULL UNIQUE, "
                "tolerance REAL NOT NULL, PRIMARY KEY(source_layer,tolerance))"
            )
            connection.executemany(
                "INSERT INTO eolab_vector_overviews VALUES (?,?,?,?)", records
            )
            connection.commit()
        # Both paths are on the same filesystem; publish atomically without replacing.
        output.hardlink_to(temporary)
        temporary.unlink()
        temporary = None
        if progress is not None:
            progress(f"Published {output.name}")
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> None:
    """Parse administrator arguments and prepare the requested display package.

    Raises:
        SystemExit: If arguments are invalid or package preparation fails.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Original GeoPackage")
    parser.add_argument("output", type=Path, help="New GeoPackage with display levels")
    parser.add_argument("--layer", required=True, help="Original polygon table name")
    parser.add_argument(
        "--tolerances", type=float, nargs="+", required=True, metavar="METRES"
    )
    arguments = parser.parse_args()
    try:
        prepare_vector_overviews(
            arguments.source,
            arguments.output,
            arguments.layer,
            arguments.tolerances,
            progress=lambda message: print(message, flush=True),
        )
    except (OSError, ValueError, RuntimeError, sqlite3.Error) as error:
        parser.exit(1, f"Could not prepare display levels: {error}\n")


if __name__ == "__main__":
    main()
