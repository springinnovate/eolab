"""Verify grouped sums and overview geometry from real original vector files."""

from dataclasses import replace
from pathlib import Path
from typing import Any

import fiona
import pytest
from shapely.geometry import Point, box, mapping, shape

from eolab_app.attribute_filter import VectorFilter
from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.vector_summary import calculate_vector_summary
from eolab_app.processing.vector_summary_models import (
    VectorSummaryInput,
    VectorSummaryRequest,
    VectorSummarySpec,
)


def summary_source(
    directory: Path,
    rows: list[tuple[Any, int | float | str | None]],
    *,
    group_name: str = "state_name",
    value_name: str = "total_es",
    numeric_type: str = "float",
    candidate: VectorFilter | None = None,
) -> tuple[ResolvedCatalogSelection, VectorSummarySpec]:
    """Write source rows and their immutable selection without any rendering component.

    Args:
        directory: Isolated test source/output directory.
        rows: Group and value attributes, with one distinct polygon per row.
        group_name: Native grouping-column name for collision coverage.
        value_name: Native numeric-column name, including long names.
        numeric_type: Fiona source type for the value column.
        candidate: Optional exact selection predicate.

    Returns:
        Original source descriptor and exact-boundary summary specification.
    """
    path = directory / "source.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="areas",
        crs="EPSG:4326",
        schema={
            "geometry": "Polygon",
            "properties": {group_name: "str", value_name: numeric_type},
        },
        GEOMETRY_NAME="source_geometry",
        FID="source_fid",
    ) as dataset:
        for index, (group, value) in enumerate(rows):
            if value is not None and numeric_type == "float":
                value = float(value)
            dataset.write(
                {
                    "geometry": mapping(box(index * 2, 0, index * 2 + 1, 1)),
                    "properties": {group_name: group, value_name: value},
                }
            )
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="source",
        assetKey="data",
        layerName="areas",
        filter=candidate or VectorFilter(),
    )
    source = ResolvedCatalogSelection(selection, path, "GPKG", None)
    return source, VectorSummarySpec(
        inputs=VectorSummaryRequest(
            vector=VectorSummaryInput(
                selection=selection, groupField=group_name, valueField=value_name
            ),
            boundary_tolerance_m=0,
        )
    )


def read_summary(path: Path) -> dict[Any, tuple[Any, Any]]:
    """Read completed group values and geometries through the ordinary GeoPackage driver.

    Args:
        path: Published calculation file in its worker attempt directory.

    Returns:
        Group keys mapped to their sum and Shapely geometry.
    """
    with fiona.open(path, layer="summary") as dataset:
        group_field, sum_field = tuple(dataset.schema["properties"])
        return {
            feature.properties[group_field]: (
                feature.properties[sum_field],
                shape(feature.geometry),
            )
            for feature in dataset
        }


def test_groups_preserve_exact_values_nulls_and_disconnected_parts(
    tmp_path: Path,
) -> None:
    """Sum original attributes accurately and retain every group's polygon parts.

    Args:
        tmp_path: Real isolated vector files.
    """
    source, spec = summary_source(
        tmp_path,
        [
            ("A", 1e16),
            ("A", 1),
            ("A", -1e16),
            (None, 4),
            (None, None),
            ("missing", None),
        ],
    )
    artifact = calculate_vector_summary(source, spec, tmp_path)
    values = read_summary(tmp_path / "result.gpkg")
    assert {key: pair[0] for key, pair in values.items()} == {
        "A": 1,
        None: 4,
        "missing": None,
    }
    assert len(values["A"][1].geoms) == 3
    assert values["A"][1].area == 3
    assert artifact.feature_count == 3 and artifact.input_feature_count == 6
    assert artifact.missing_value_count == 2


def test_integer_sums_preserve_values_above_float_precision(tmp_path: Path) -> None:
    """Keep integer totals exact rather than rounding them through double precision.

    Args:
        tmp_path: Real isolated vector files.
    """
    source, spec = summary_source(
        tmp_path, [("A", 2**53), ("A", 1)], numeric_type="int64"
    )
    calculate_vector_summary(source, spec, tmp_path)
    assert read_summary(tmp_path / "result.gpkg")["A"][0] == 2**53 + 1


@pytest.mark.parametrize(
    "group_name, expected",
    [
        ("sum_total_es", "sum_total_es_2"),
        ("SUM_TOTAL_ES", "sum_total_es_2"),
        ("fid", "sum_total_es"),
        ("geom", "sum_total_es"),
    ],
)
def test_output_column_collisions_preserve_group_and_sum(
    tmp_path: Path, group_name: str, expected: str
) -> None:
    """Preserve names that collide with the sum or GeoPackage storage columns.

    Args:
        tmp_path: Real isolated vector files.
        group_name: Source field to preserve in the result.
        expected: Collision-free generated total name.
    """
    source, spec = summary_source(tmp_path, [("A", 2)], group_name=group_name)
    artifact = calculate_vector_summary(source, spec, tmp_path)
    assert artifact.summary_field == expected
    with fiona.open(tmp_path / "result.gpkg", layer="summary") as result:
        assert tuple(result.schema["properties"]) == (group_name, expected)
        assert next(iter(result)).properties[group_name] == "A"


def test_long_sum_column_remains_usable_by_ordinary_vector_apis(tmp_path: Path) -> None:
    """Fit a generated sum name into the existing vector API field-name contract.

    Args:
        tmp_path: Real isolated vector files.
    """
    source, spec = summary_source(tmp_path, [("A", 2)], value_name="x" * 256)
    artifact = calculate_vector_summary(source, spec, tmp_path)
    assert len(artifact.summary_field) == 256
    assert read_summary(tmp_path / "result.gpkg")["A"][0] == 2


def test_captured_filter_controls_both_sum_and_geometry(tmp_path: Path) -> None:
    """Read exactly the original features matching the accepted predicate.

    Args:
        tmp_path: Real isolated vector files.
    """
    candidate = VectorFilter.model_validate(
        {
            "enabled": True,
            "match": "all",
            "rules": [{"field": "total_es", "operator": "gt", "value": 2}],
        }
    )
    source, spec = summary_source(
        tmp_path, [("A", 2), ("A", 8), ("B", 1)], candidate=candidate
    )
    calculate_vector_summary(source, spec, tmp_path)
    values = read_summary(tmp_path / "result.gpkg")
    assert set(values) == {"A"}
    assert values["A"][0] == 8 and values["A"][1].bounds == (2, 0, 3, 1)


def test_boundary_detail_reduces_vertices_without_changing_totals(
    tmp_path: Path,
) -> None:
    """Simplify a detailed polygon while keeping its sum and valid multipart geometry.

    Args:
        tmp_path: Real isolated vector files.
    """
    source, spec = summary_source(tmp_path, [("A", 7)])
    geometry = Point(1, 20).buffer(0.1, quad_segs=128)
    with fiona.open(
        source.path,
        "w",
        driver="GPKG",
        layer="areas",
        crs="EPSG:4326",
        schema={
            "geometry": "Polygon",
            "properties": {"state_name": "str", "total_es": "float"},
        },
    ) as dataset:
        dataset.write(
            {
                "geometry": mapping(geometry),
                "properties": {"state_name": "A", "total_es": 7.0},
            }
        )
    simplified = spec.model_copy(
        update={"inputs": spec.inputs.model_copy(update={"boundary_tolerance_m": 1000})}
    )
    calculate_vector_summary(source, simplified, tmp_path)
    total, result = read_summary(tmp_path / "result.gpkg")["A"]
    assert total == 7 and result.is_valid
    assert len(result.geoms[0].exterior.coords) < len(geometry.exterior.coords)
    assert result.area > geometry.area * 0.8


@pytest.mark.parametrize("case", ["field", "type", "empty", "overflow"])
def test_invalid_summary_inputs_fail_locally(tmp_path: Path, case: str) -> None:
    """Reject missing or unsuitable fields, empty selections and unrepresentable totals.

    Args:
        tmp_path: Real isolated vector files.
        case: Invalid external-input or output-integrity condition.
    """
    rows = (
        [("A", 2**63 - 1), ("A", 1)]
        if case == "overflow"
        else [("A", "bad" if case == "type" else 1)]
    )
    source, spec = summary_source(
        tmp_path, rows, numeric_type="str" if case == "type" else "int64"
    )
    if case == "field":
        spec = spec.model_copy(
            update={
                "inputs": spec.inputs.model_copy(
                    update={
                        "vector": spec.inputs.vector.model_copy(
                            update={"valueField": "absent"}
                        )
                    }
                )
            }
        )
    if case == "empty":
        source = replace(
            source,
            selection=source.selection.model_copy(
                update={
                    "filter": VectorFilter.model_validate(
                        {
                            "enabled": True,
                            "match": "all",
                            "rules": [
                                {"field": "total_es", "operator": "gt", "value": 3}
                            ],
                        }
                    )
                }
            ),
        )
    with pytest.raises(ProcessingError) as failure:
        calculate_vector_summary(source, spec, tmp_path)
    assert (
        failure.value.code
        == {
            "field": "invalid_vector_summary_fields",
            "type": "invalid_vector_summary_fields",
            "empty": "empty_vector_selection",
            "overflow": "vector_summary_overflow",
        }[case]
    )
