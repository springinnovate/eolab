"""Exercise parcel identity and row pages against real original vector layers."""

from pathlib import Path
from concurrent.futures import CancelledError
from typing import Any

import pytest
from osgeo import ogr
from pydantic import ValidationError

from eolab_app.attribute_filter import VectorFilter, ogr_predicate
from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import VectorReadLimits
from eolab_app.calculated_fields import CalculatedField, validate_calculated_fields
from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from eolab_app.vector.parcel_models import (
    ParcelId,
    ParcelIdInput,
    ParcelIdRequest,
    ParcelRowsRequest,
)
from eolab_app.vector.parcels import read_parcel_rows, validate_parcel_ids


def write_parcels(
    tmp_path: Path,
    rows: list[dict[str, Any]],
    *,
    id_type: int = ogr.OFTInteger64,
    id_subtype: int = ogr.OFSTNone,
    geometry_type: int = ogr.wkbPolygon,
    driver_name: str = "GPKG",
    predicate: VectorFilter | None = None,
) -> ResolvedCatalogSelection:
    """Write a real layer with null geometries and known original scalar fields.

    Args:
        tmp_path: Isolated destination directory.
        rows: Original properties for every feature, including invalid IDs.
        id_type: Native OGR ID field type.
        id_subtype: Optional Boolean subtype for ID rejection tests.
        geometry_type: Declared geometry schema; geometry itself stays null.
        driver_name: Native writer, GeoPackage or Shapefile.
        predicate: Optional selected-row predicate, excluded from ID validation.

    Returns:
        An authorized fixture descriptor pointing to the exact native layer.
    """
    path = tmp_path / ("parcels.gpkg" if driver_name == "GPKG" else "parcels.shp")
    with ogr.GetDriverByName(driver_name).CreateDataSource(str(path)) as dataset:
        layer = dataset.CreateLayer("parcels", geom_type=geometry_type)
        identifier = ogr.FieldDefn("parcel_id", id_type)
        identifier.SetSubType(id_subtype)
        layer.CreateField(identifier)
        for name, kind in (
            ("label", ogr.OFTString),
            ("score", ogr.OFTReal),
            ("large", ogr.OFTInteger64),
        ):
            layer.CreateField(ogr.FieldDefn(name, kind))
        for properties in rows:
            feature = ogr.Feature(layer.GetLayerDefn())
            for name, value in properties.items():
                if value is not None:
                    feature.SetField(name, value)
            layer.CreateFeature(feature)
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="parcels",
        assetKey="data",
        layerName="parcels",
        filter=predicate or VectorFilter(),
    )
    return ResolvedCatalogSelection(
        selection, path, driver_name, ogr_predicate(selection.filter)
    )


@pytest.mark.parametrize("geometry_type", [ogr.wkbPolygon, ogr.wkbMultiPolygon])
def test_validation_and_pages_preserve_int64_without_geometry(
    tmp_path: Path,
    geometry_type: int,
) -> None:
    """Keep exact large IDs and display values while accepting multipart schemas.

    Args:
        tmp_path: Isolated native source directory.
        geometry_type: Polygon or MultiPolygon schema with null geometries.
    """
    largest = 9223372036854775807
    resolved = write_parcels(
        tmp_path,
        [
            {"parcel_id": largest, "large": largest, "label": "one"},
            {"parcel_id": -largest, "large": None, "label": None},
        ],
        geometry_type=geometry_type,
    )
    validation = validate_parcel_ids(resolved, "parcel_id")
    assert validation.model_dump() == {
        "idField": "parcel_id",
        "idType": "integer",
        "featureCount": 2,
    }
    page = read_parcel_rows(resolved, "parcel_id", ("large", "label"), 0, 1)
    assert page.rows[0].id.model_dump() == {"type": "integer", "value": str(largest)}
    assert page.rows[0].properties == {"large": str(largest), "label": "one"}
    assert page.nextOffset == 1
    final = read_parcel_rows(resolved, "parcel_id", ("large", "label"), 1, 1)
    assert final.rows[0].id.value == str(-largest)
    assert final.rows[0].properties == {"large": None, "label": None}
    assert final.nextOffset is None


@pytest.mark.parametrize("driver_name", ["GPKG", "ESRI Shapefile"])
def test_string_ids_preserve_original_spelling(
    tmp_path: Path, driver_name: str
) -> None:
    """Preserve case, leading zeroes and string identity in both mounted formats.

    Args:
        tmp_path: Isolated native source directory.
        driver_name: Supported original-source format.
    """
    resolved = write_parcels(
        tmp_path,
        [{"parcel_id": value} for value in ("42", "042", "A", "a")],
        id_type=ogr.OFTString,
        driver_name=driver_name,
    )
    assert validate_parcel_ids(resolved, "parcel_id").featureCount == 4
    page = read_parcel_rows(resolved, "parcel_id", (), 0, 100)
    assert [(row.id.type, row.id.value) for row in page.rows] == [
        ("string", value) for value in ("42", "042", "A", "a")
    ]


@pytest.mark.parametrize("values", [[1, 1], [1, None]])
def test_validation_checks_invalid_ids_outside_live_filter(
    tmp_path: Path, values: list[int | None]
) -> None:
    """Reject duplicates and missing IDs outside the currently visible selection.

    Args:
        tmp_path: Isolated native source directory.
        values: A valid first ID followed by a duplicate or missing ID.
    """
    resolved = write_parcels(
        tmp_path,
        [{"parcel_id": value, "score": index} for index, value in enumerate(values)],
        predicate=VectorFilter(
            rules=[{"field": "score", "operator": "eq", "value": 0}]
        ),
    )
    with pytest.raises(GeometryValidationError):
        validate_parcel_ids(resolved, "parcel_id")
    assert len(read_parcel_rows(resolved, "parcel_id", (), 0, 100).rows) == 1


@pytest.mark.parametrize("value", [None, "", " \t "])
def test_blank_string_ids_fail_validation_and_pages(
    tmp_path: Path, value: str | None
) -> None:
    """Reject every selected invalid ID instead of silently omitting its feature.

    Args:
        tmp_path: Isolated native source directory.
        value: Missing, empty or whitespace-only source ID.
    """
    resolved = write_parcels(
        tmp_path, [{"parcel_id": "valid"}, {"parcel_id": value}], id_type=ogr.OFTString
    )
    with pytest.raises(GeometryValidationError, match="nonempty"):
        validate_parcel_ids(resolved, "parcel_id")
    with pytest.raises(GeometryValidationError, match="nonempty"):
        read_parcel_rows(resolved, "parcel_id", (), 0, 100)


@pytest.mark.parametrize(
    "kind,subtype", [(ogr.OFTReal, ogr.OFSTNone), (ogr.OFTInteger, ogr.OFSTBoolean)]
)
def test_float_and_boolean_id_schemas_are_rejected(
    tmp_path: Path, kind: int, subtype: int
) -> None:
    """Reject floating and Boolean columns even when their current values are integral.

    Args:
        tmp_path: Isolated native source directory.
        kind: Unsupported ID field type.
        subtype: Optional native Boolean subtype.
    """
    resolved = write_parcels(
        tmp_path, [{"parcel_id": 1}], id_type=kind, id_subtype=subtype
    )
    with pytest.raises(GeometryValidationError, match="integer or string"):
        validate_parcel_ids(resolved, "parcel_id")


def test_pages_filter_exactly_before_offset_without_deduplication(
    tmp_path: Path,
) -> None:
    """Use exact case and numeric predicates before paging, retaining duplicate rows.

    Args:
        tmp_path: Isolated native source directory.
    """
    predicate = VectorFilter(
        rules=[
            {"field": "label", "operator": "eq", "value": "Match"},
            {"field": "score", "operator": "ge", "value": 2},
        ]
    )
    resolved = write_parcels(
        tmp_path,
        [
            {"parcel_id": 1, "label": "Match", "score": 1},
            {"parcel_id": 2, "label": "match", "score": 2},
            {"parcel_id": 3, "label": "Match", "score": 3},
            {"parcel_id": 4, "label": "Match", "score": 4},
            {"parcel_id": 4, "label": "Match", "score": 5},
        ],
        predicate=predicate,
    )
    first = read_parcel_rows(resolved, "parcel_id", (), 0, 1)
    assert [row.id.value for row in first.rows] == ["3"]
    assert first.nextOffset == 1
    final = read_parcel_rows(resolved, "parcel_id", ("score",), 1, 2)
    assert [row.id.value for row in final.rows] == ["4", "4"]
    assert [row.properties for row in final.rows] == [
        {"score": "4.0"},
        {"score": "5.0"},
    ]
    assert final.nextOffset is None


def test_calculated_filter_works_but_calculated_ids_and_display_fields_fail(
    tmp_path: Path,
) -> None:
    """Retain selection calculations while limiting parcel identity to original fields.

    Args:
        tmp_path: Isolated native source directory.
    """
    original = write_parcels(
        tmp_path, [{"parcel_id": 1, "score": 1}, {"parcel_id": 2, "score": 3}]
    )
    definitions = (CalculatedField(name="twice", expression="'score' * 2"),)
    compiled = validate_calculated_fields(
        definitions, {"parcel_id": "int64", "score": "float"}
    )
    predicate = VectorFilter(rules=[{"field": "twice", "operator": "gt", "value": 3}])
    selection = original.selection.model_copy(
        update={"filter": predicate, "calculated_fields": definitions}
    )
    resolved = ResolvedCatalogSelection(
        selection, original.path, original.driver, None, compiled
    )
    assert [
        row.id.value for row in read_parcel_rows(resolved, "parcel_id", (), 0, 100).rows
    ] == ["2"]
    assert validate_parcel_ids(resolved, "parcel_id").featureCount == 2
    with pytest.raises(GeometryValidationError, match="original"):
        validate_parcel_ids(resolved, "twice")
    with pytest.raises(GeometryValidationError, match="original scalar"):
        read_parcel_rows(resolved, "parcel_id", ("twice",), 0, 100)


def test_any_filter_retains_string_and_numeric_matches(tmp_path: Path) -> None:
    """Keep either predicate's matches when string collation prevents native pushdown.

    Args:
        tmp_path: Isolated native source directory.
    """
    resolved = write_parcels(
        tmp_path,
        [
            {"parcel_id": " 42 ", "label": "Exact", "score": 0},
            {"parcel_id": "42", "label": "exact", "score": 0},
            {"parcel_id": "042", "label": "different", "score": 5},
        ],
        id_type=ogr.OFTString,
        predicate=VectorFilter(
            match="any",
            rules=[
                {"field": "label", "operator": "eq", "value": "Exact"},
                {"field": "score", "operator": "gt", "value": 4},
            ],
        ),
    )
    assert validate_parcel_ids(resolved, "parcel_id").featureCount == 3
    page = read_parcel_rows(resolved, "parcel_id", (), 0, 100)
    assert [row.id.value for row in page.rows] == [" 42 ", "042"]
    assert page.nextOffset is None


def test_empty_source_still_checks_original_field_schema(tmp_path: Path) -> None:
    """Allow empty source pages but reject nonexistent original fields before reading.

    Args:
        tmp_path: Isolated native source directory.
    """
    resolved = write_parcels(tmp_path, [])
    assert validate_parcel_ids(resolved, "parcel_id").featureCount == 0
    assert not read_parcel_rows(resolved, "parcel_id", (), 0, 100).rows
    with pytest.raises(GeometryValidationError, match="original parcel ID"):
        validate_parcel_ids(resolved, "missing")
    with pytest.raises(GeometryValidationError, match="original scalar"):
        read_parcel_rows(resolved, "parcel_id", ("missing",), 0, 100)


def test_cancellation_between_rows_never_returns_partial_validation(
    tmp_path: Path,
) -> None:
    """Abandon an active native stream without turning its prefix into a valid result.

    Args:
        tmp_path: Isolated native source directory.
    """
    resolved = write_parcels(tmp_path, [{"parcel_id": 1}, {"parcel_id": 2}])
    checks = iter((False, False, False, True))
    with pytest.raises(CancelledError):
        validate_parcel_ids(
            resolved, "parcel_id", cancellation_requested=lambda: next(checks)
        )


@pytest.mark.parametrize(
    "geometry_type", [ogr.wkbPoint, ogr.wkbLineString, ogr.wkbUnknown]
)
def test_nonpolygon_schema_is_rejected(tmp_path: Path, geometry_type: int) -> None:
    """Require a declared polygon source without inspecting feature geometry.

    Args:
        tmp_path: Isolated native source directory.
        geometry_type: Unsupported source geometry declaration.
    """
    resolved = write_parcels(tmp_path, [{"parcel_id": 1}], geometry_type=geometry_type)
    with pytest.raises(GeometryValidationError, match="Polygon"):
        validate_parcel_ids(resolved, "parcel_id")


def test_empty_selection_and_offsets_past_end_are_valid_pages(tmp_path: Path) -> None:
    """Return no rows and no continuation when exact matching is exhausted.

    Args:
        tmp_path: Isolated native source directory.
    """
    resolved = write_parcels(tmp_path, [{"parcel_id": 1}])
    assert read_parcel_rows(resolved, "parcel_id", (), 100, 100).model_dump() == {
        "rows": (),
        "offset": 100,
        "nextOffset": None,
    }
    selection = resolved.selection.model_copy(
        update={
            "filter": VectorFilter(
                rules=[{"field": "parcel_id", "operator": "eq", "value": 2}]
            )
        }
    )
    empty = ResolvedCatalogSelection(
        selection, resolved.path, resolved.driver, ogr_predicate(selection.filter)
    )
    assert not read_parcel_rows(empty, "parcel_id", (), 0, 100).rows


def test_feature_budget_never_certifies_incomplete_validation(tmp_path: Path) -> None:
    """Fail incomplete scans and unknown page continuation instead of truncating silently.

    Args:
        tmp_path: Isolated native source directory.
    """
    resolved = write_parcels(
        tmp_path, [{"parcel_id": 1}, {"parcel_id": 2}, {"parcel_id": 1}]
    )
    with pytest.raises(GeometryValidationError, match="candidate-feature budget"):
        validate_parcel_ids(resolved, "parcel_id", limits=VectorReadLimits(features=2))
    with pytest.raises(GeometryValidationError, match="candidate-feature budget"):
        read_parcel_rows(
            resolved, "parcel_id", (), 0, 1, limits=VectorReadLimits(features=1)
        )
    page = read_parcel_rows(
        resolved, "parcel_id", (), 0, 1, limits=VectorReadLimits(features=2)
    )
    assert page.nextOffset == 1


def test_deadline_and_cancellation_stop_native_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Honor caller cancellation and elapsed time before claiming a complete scan.

    Args:
        tmp_path: Isolated native source directory.
        monkeypatch: Replace elapsed time with deterministic deadline ticks.
    """
    resolved = write_parcels(tmp_path, [{"parcel_id": 1}])
    with pytest.raises(CancelledError):
        validate_parcel_ids(resolved, "parcel_id", cancellation_requested=lambda: True)
    ticks = iter((0, 16))
    monkeypatch.setattr("eolab_app.vector.parcels.monotonic", lambda: next(ticks))
    with pytest.raises(GeometryValidationError, match="time budget"):
        read_parcel_rows(resolved, "parcel_id", (), 0, 100)


def test_parcel_contracts_reject_paths_and_unsafe_request_shapes() -> None:
    """Keep source identity path-free and enforce bounded strict row-page options."""
    identity = {
        "collectionId": "eolab-mounted-vectors",
        "itemId": "parcels",
        "idField": "parcel_id",
    }
    with pytest.raises(ValidationError):
        ParcelIdRequest.model_validate({**identity, "path": "/private/source.gpkg"})
    for options in (
        {"offset": -1},
        {"offset": True},
        {"limit": 0},
        {"limit": 501},
        {"limit": 1.5},
    ):
        with pytest.raises(ValidationError):
            ParcelRowsRequest.model_validate({**identity, "filter": {}, **options})
    with pytest.raises(ValidationError):
        ParcelIdInput.model_validate(
            {"selection": {"path": "/private/source.gpkg"}, "idField": "parcel_id"}
        )
    for value in ("01", "+1", "-0", "1.0", " 1"):
        with pytest.raises(ValidationError):
            ParcelId(type="integer", value=value)
    assert ParcelId(type="string", value=" 1 ").value == " 1 "
