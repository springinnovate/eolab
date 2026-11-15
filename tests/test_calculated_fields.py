"""Verify arithmetic semantics and their use by original vector readers."""

from pathlib import Path
from threading import Event
from typing import Any

import fiona
from fastapi import FastAPI, Request, Response
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest
from shapely.geometry import box, mapping

from eolab_app.attribute_filter import VectorFilter, ogr_predicate
from eolab_app.bounded_vector import count_selected_features, polygon_records
from eolab_app.calculated_fields import (
    CalculatedField,
    CalculatedFieldError,
    evaluate_calculated_fields,
    required_source_fields,
    validate_calculated_fields,
)
from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from eolab_app.vector.extents import read_selected_extent
from eolab_app.vector_fields import visit_vector_fields
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.routes.vector_uploads import create_vector_uploads_router
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector_uploads import VectorUploadStore
from catalog_selection_support import FixtureCatalog
from test_raster_source_access import FileAuthority, PRIVATE
from test_vector_uploads import HEADERS, write_layer

@pytest.mark.parametrize(
    "expression,expected",
    [
        ("'Total people' / 'Area km2' * 100", 600),
        ("2 + 3 * 4", 14),
        ("(2 + 3) * 4", 20),
        ("-(-2 + +3) / 2", -0.5),
        ("20 / 2 / 2", 5),
        ("'Owner''s count' + .5e1", 12),
        ("1e308 * 10 - 1e308 * 10", None),
        ("'Total people' / 0", None),
    ],
)
def test_arithmetic_contract(expression: str, expected: float | None) -> None:
    """Use ordinary precedence, exact quoted names and missing arithmetic results.

    Args:
        expression: User expression covering an independent grammar or numeric rule.
        expected: Independently calculated finite result or missing value.
    """
    fields = {"Total people": "int64", "Area km2": "float", "Owner's count": "int"}
    compiled = validate_calculated_fields(
        (CalculatedField(name="answer", expression=expression),), fields
    )
    assert evaluate_calculated_fields(
        compiled, {"Total people": 18, "Area km2": 3, "Owner's count": 7}
    ) == {"answer": expected}


@pytest.mark.parametrize(
    "value,expected",
    [
        (" 12.5 ", 12.5),
        ("-1e3", -1000),
        ("+.5", 0.5),
        ("", None),
        ("12abc", None),
        ("1,000", None),
        ("0x10", None),
        ("NaN", None),
        ("Infinity", None),
        ("1e999", None),
        (None, None),
    ],
)
def test_numeric_text_conversion(value: str | None, expected: float | None) -> None:
    """Accept only complete trimmed decimal/scientific strings, preserving missingness.

    Args:
        value: Native text or missing property value.
        expected: Finite conversion or missing result.
    """
    definition = CalculatedField(name="number", expression="'text'", numericText=True)
    compiled = validate_calculated_fields((definition,), {"text": "str"})
    assert evaluate_calculated_fields(compiled, {"text": value}) == {"number": expected}


@pytest.mark.parametrize(
    "expression",
    [
        "",
        "'a",
        "'a' +",
        "('a'",
        "'a')",
        "2(3)",
        "'a' 'b'",
        "abs('a')",
        "'a' ** 2",
        "__import__('os')",
        "1e999",
    ],
)
def test_invalid_expressions_do_not_create_fields(expression: str) -> None:
    """Reject incomplete grammar and unsupported code before accepting a field.

    Args:
        expression: Invalid public expression.
    """
    with pytest.raises((CalculatedFieldError, ValidationError)):
        validate_calculated_fields(
            (CalculatedField(name="result", expression=expression),), {"a": "float"}
        )


def test_definitions_bind_in_order_and_preserve_source_values() -> None:
    """Chain fields without mutating original attributes or accepting forward references."""
    definitions = (
        CalculatedField(name="scaled", expression="'raw count' * 2"),
        CalculatedField(name="adjusted", expression="'scaled' - 'other'"),
    )
    source = {"raw count": 4, "other": 1}
    compiled = validate_calculated_fields(definitions, {name: "int" for name in source})
    assert required_source_fields(compiled, ("adjusted", "raw count")) == (
        "raw count",
        "other",
    )
    assert evaluate_calculated_fields(compiled, source) == {"scaled": 8, "adjusted": 7}
    assert source == {"raw count": 4, "other": 1}
    with pytest.raises(CalculatedFieldError, match="unavailable"):
        validate_calculated_fields(
            tuple(reversed(definitions)), {name: "int" for name in source}
        )
    with pytest.raises(CalculatedFieldError, match="already exists"):
        validate_calculated_fields(
            (CalculatedField(name="RAW COUNT", expression="2"),), {"raw count": "int"}
        )
    with pytest.raises(CalculatedFieldError, match="Treat numeric text"):
        validate_calculated_fields(
            (CalculatedField(name="value", expression="'text'"),), {"text": "str"}
        )
    with pytest.raises(CalculatedFieldError, match="not a numeric"):
        validate_calculated_fields(
            (CalculatedField(name="value", expression="'flag'", numericText=True),),
            {"flag": "bool"},
        )


def test_long_parenthesis_and_unary_programs_do_not_use_python_recursion() -> None:
    """Bounded expressions remain valid even when nesting exceeds Python's call stack."""
    for expression in ("(" * 1200 + "2" + ")" * 1200, "-" * 1500 + "2"):
        compiled = validate_calculated_fields(
            (CalculatedField(name="value", expression=expression),), {}
        )
        assert evaluate_calculated_fields(compiled, {}) == {"value": 2}


def test_original_readers_use_the_same_calculated_values_and_predicates(
    tmp_path: Path,
) -> None:
    """Keep whole-layer fields, polygon selection, counts and extents consistent.

    Args:
        tmp_path: Isolated directory containing an immutable test GeoPackage.
    """
    path = tmp_path / "source.gpkg"
    schema = {"population": "int", "area": "float"}
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="areas",
        crs="EPSG:4326",
        schema={"geometry": "Polygon", "properties": schema},
    ) as dataset:
        for index, (population, area) in enumerate(((12, 3), (20, 2), (7, 0))):
            dataset.write(
                {
                    "geometry": mapping(box(index * 2, 0, index * 2 + 1, 1)),
                    "properties": {"population": population, "area": area},
                }
            )
    original = path.read_bytes()
    definitions = (CalculatedField(name="density", expression="'population' / 'area'"),)
    compiled = validate_calculated_fields(definitions, schema)
    rows: list[dict[str, float | None]] = []
    assert visit_vector_fields(
        str(path),
        "areas",
        ("density",),
        None,
        Event(),
        lambda row: rows.append(dict(row)),
        calculated_fields=compiled,
    )
    assert rows == [{"density": 4}, {"density": 10}, {"density": None}]
    predicate = VectorFilter(rules=[{"field": "density", "operator": "gt", "value": 5}])
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="areas",
        assetKey="data",
        layerName="areas",
        filter=predicate,
        calculatedFields=definitions,
    )
    resolved = ResolvedCatalogSelection(
        selection,
        path,
        "GPKG",
        ogr_predicate(predicate, frozenset({"density"})),
        compiled,
    )
    assert resolved.where is None
    assert count_selected_features(resolved, limits=None) == {"matched": 1, "total": 3}
    with polygon_records(
        resolved,
        ("population", "density"),
        timeout_seconds=None,
        max_features=None,
        max_feature_coordinates=None,
    ) as records:
        selected = list(records)
    assert selected[0][1] == {"population": 20, "density": 10}
    assert read_selected_extent(resolved) == {"matched": 1, "bbox": [2, 0, 3, 1]}
    assert path.read_bytes() == original
    other = validate_calculated_fields(
        (CalculatedField(name="density", expression="'population' * 100"),), schema
    )
    assert evaluate_calculated_fields(other, {"population": 12}) == {"density": 1200}
    assert evaluate_calculated_fields(compiled, {"population": 12, "area": 3}) == {
        "density": 4
    }


def test_native_predicate_never_drops_calculated_alternatives() -> None:
    """An OR containing a calculated rule must inspect every original candidate."""
    rules = [
        {"field": "number", "operator": "gt", "value": 2},
        {"field": "computed", "operator": "lt", "value": 9},
    ]
    assert (
        ogr_predicate(VectorFilter(match="any", rules=rules), frozenset({"computed"}))
        is None
    )
    assert (
        ogr_predicate(VectorFilter(match="all", rules=rules), frozenset({"computed"}))
        == '("number" IS NOT NULL AND "number" > 2)'
    )


@pytest.mark.parametrize("source_kind", ["catalog", "upload", "result"])
def test_invalid_calculations_return_useful_selection_route_errors(
    tmp_path: Path, source_kind: str
) -> None:
    """Reject invalid view fields through public counts and extent routes before Jobs.

    Args:
        tmp_path: Isolated immutable source and upload files.
        source_kind: Catalog source, browser upload or private Processing result.
    """
    path = tmp_path / "source.gpkg"
    body = write_layer(path, geometry="MultiPolygon")
    catalog = FixtureCatalog(
        ResolvedVectorSource("mounted", "geopackage", path, "data", "areas")
    )
    uploads = VectorUploadStore(tmp_path / "uploads", None)
    authority = FileAuthority(path, "application/geopackage+sqlite3")
    sampler = VectorSamplingService(
        catalog, catalog, uploads=uploads, artifact_files=authority.files
    )

    def read_result_owner(request: Request, response: Response) -> str:
        """Supply the already established source owner at the composition boundary.

        Args:
            request: Incoming request, unused by this fixed test authority.
            response: Cookie response, unused by this fixed test authority.

        Returns:
            Owner accepted by the controlled original-file authority.
        """
        return "owner"

    app = FastAPI()
    app.include_router(create_vector_uploads_router(uploads))
    app.include_router(create_vector_sampling_router(sampler, read_result_owner))
    with TestClient(app, base_url="https://testserver") as client:
        source: dict[str, Any]
        if source_kind == "upload":
            uploaded = client.post(
                "/api/vector-uploads",
                params={"name": "Areas"},
                headers=HEADERS,
                content=body,
            )
            assert uploaded.status_code == 201, uploaded.text
            source = {"uploadId": uploaded.json()["id"]}
        elif source_kind == "result":
            source = {**PRIVATE, "layerName": "areas"}
        else:
            source = {"collectionId": "eolab-mounted-vectors", "itemId": "areas"}
        for definition, detail in (
            ({"name": "result", "expression": "'count' +"}, "Finish the expression"),
            (
                {"name": "result", "expression": "'absent' * 2"},
                "Field 'absent' is unavailable",
            ),
            ({"name": "count", "expression": "1"}, "Field 'count' already exists"),
        ):
            payload = {**source, "filter": {}, "calculatedFields": [definition]}
            for endpoint in ("areas", "extent"):
                response = client.post(
                    f"/api/vector-sampling/{endpoint}", json=payload, headers=HEADERS
                )
                assert response.status_code == 409, response.text
                assert detail in response.json()["detail"]
                assert response.headers["Cache-Control"] == "private, no-store"
                assert str(tmp_path) not in response.text
                assert not authority.leases
