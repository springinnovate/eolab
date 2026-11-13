"""Verify grouped statistics and overview geometry from real original vector files."""

from dataclasses import replace
import json
import math
from pathlib import Path
from sys import float_info
from typing import Any

import fiona
import pytest
from shapely import get_num_coordinates, union_all
from shapely.errors import GEOSException
from shapely.geometry import MultiPolygon, Point, Polygon, box, mapping, shape
from shapely.geometry.base import BaseGeometry

from eolab_app.attribute_filter import VectorFilter
from eolab_app.catalog_selection import CatalogSelection, ResolvedCatalogSelection
from eolab_app.processing.model_definitions import ModelRegistry
from eolab_app.processing.model_run_contracts import ModelRunRequest
from eolab_app.processing.model_runs import build_model_calculation_request
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.vector_summary import calculate_vector_summary
from eolab_app.processing.vector_summary_models import (
    VectorSummaryInput,
    VectorSummaryCalculation,
    VectorSummaryRequest,
    VectorSummarySpec,
    VectorSummaryStatistic,
)


@pytest.mark.parametrize(
    "capture_kind", ["configured", "missing_role", "extra_role", "old_shape"]
)
def test_summary_uses_configured_field_choices(capture_kind: str) -> None:
    """Bind the installed recipe's fixed grouping field and repeated summary rows.

    Args:
        capture_kind: Valid configured roles, malformed roles or the removed input shape.
    """
    registry = ModelRegistry.load_installed()
    definition = registry.get("vector-summary", "2.0.0")
    selected = {
        "selection": {
            "collectionId": "eolab-mounted-vectors",
            "itemId": "source",
            "assetKey": "data",
            "layerName": "areas",
            "filter": {"enabled": False, "match": "all", "rules": []},
        },
        "fields": {"group": "state_name"},
        "rows": [{"fields": {"value": "total_es"}, "parameters": {"statistic": "sum"}}],
    }
    if capture_kind == "missing_role":
        selected["rows"][0]["fields"].pop("value")
    elif capture_kind == "extra_role":
        selected["fields"]["weight"] = "population"
    elif capture_kind == "old_shape":
        selected.pop("fields")
        selected.update(groupField="state_name", valueField="total_es")
    request = ModelRunRequest.model_validate(
        {
            "requestId": "summary-configured-fields",
            "utcOffsetMinutes": 0,
            "label": "Totals per state",
            "model": {
                "id": definition.id,
                "version": definition.version,
                "definitionSha256": definition.digest,
            },
            "inputs": {"vector": selected},
            "parameters": {},
        }
    )
    if capture_kind != "configured":
        with pytest.raises(ProcessingError) as error:
            build_model_calculation_request(request, registry)
        assert error.value.code == "invalid_model_inputs"
        return
    calculation, invocation = build_model_calculation_request(request, registry)
    assert isinstance(calculation, VectorSummaryRequest)
    assert calculation.vector.groupField == "state_name"
    assert calculation.summaries == (
        VectorSummaryCalculation(field="total_es", statistic="sum"),
    )
    assert calculation.boundary_tolerance_m == 1000
    assert invocation.inputs == {"vector": selected}


def summary_source(
    directory: Path,
    rows: list[tuple[Any, int | float | str | None]],
    *,
    group_name: str = "state_name",
    value_name: str = "total_es",
    numeric_type: str = "float",
    candidate: VectorFilter | None = None,
    statistic: VectorSummaryStatistic = "sum",
    geometries: list[BaseGeometry] | None = None,
) -> tuple[ResolvedCatalogSelection, VectorSummarySpec]:
    """Write source rows and their immutable selection without any rendering component.

    Args:
        directory: Isolated test source/output directory.
        rows: Group and value attributes, with one distinct polygon per row.
        group_name: Native grouping-column name for collision coverage.
        value_name: Native numeric-column name, including long names.
        numeric_type: Fiona source type for the value column.
        candidate: Optional exact selection predicate.
        statistic: Reduction captured in the operation request.
        geometries: Optional original polygon boundaries, one per row.

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
            "geometry": "Unknown" if geometries is not None else "Polygon",
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
                    "geometry": mapping(
                        geometries[index]
                        if geometries is not None
                        else box(index * 2, 0, index * 2 + 1, 1)
                    ),
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
            vector=VectorSummaryInput(selection=selection, groupField=group_name),
            summaries=(
                VectorSummaryCalculation(field=value_name, statistic=statistic),
            ),
            boundary_tolerance_m=0,
        )
    )


def read_summary(path: Path) -> dict[Any, tuple[Any, Any]]:
    """Read completed group values and geometries through the ordinary GeoPackage driver.

    Args:
        path: Published calculation file in its worker attempt directory.

    Returns:
        Group keys mapped to their numeric result and Shapely geometry.
    """
    with fiona.open(path, layer="summary") as dataset:
        group_field, summary_field = tuple(dataset.schema["properties"])
        return {
            feature.properties[group_field]: (
                feature.properties[summary_field],
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
    assert artifact.columns[0].missing_value_count == 2


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


def test_many_field_statistic_pairs_share_original_reads_and_geometry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Produce independent columns from one source stream and one merge per group.

    Args:
        tmp_path: Original and output GeoPackages on isolated storage.
        monkeypatch: Count real native reader and union boundary calls.
    """
    from contextlib import contextmanager
    from collections.abc import Iterator
    from eolab_app.processing import vector_summary

    source, spec = summary_source(tmp_path, [("A", 2), ("A", 4), ("B", None)])
    # A second source field has a different missing-value pattern.
    path = tmp_path / "multiple.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="areas",
        crs="EPSG:4326",
        schema={
            "geometry": "Polygon",
            "properties": {"state_name": "str", "total_es": "int64", "weight": "float"},
        },
    ) as dataset:
        for index, (group, value, weight) in enumerate(
            [("A", 2**53, 1.5), ("A", 1, 2.5), ("B", None, 8.5)]
        ):
            dataset.write(
                {
                    "geometry": mapping(box(index * 2, 0, index * 2 + 1, 1)),
                    "properties": {
                        "state_name": group,
                        "total_es": value,
                        "weight": weight,
                    },
                }
            )
    source = replace(source, path=path)
    calculations = (
        VectorSummaryCalculation(field="total_es", statistic="sum"),
        VectorSummaryCalculation(field="total_es", statistic="mean"),
        VectorSummaryCalculation(field="weight", statistic="mean"),
        VectorSummaryCalculation(field="weight", statistic="stdev"),
        VectorSummaryCalculation(field="total_es", statistic="sum"),
    )
    spec = spec.model_copy(
        update={"inputs": spec.inputs.model_copy(update={"summaries": calculations})}
    )
    reader = vector_summary.polygon_records
    dissolve = vector_summary.disjoint_subset_union_all
    reads: list[tuple[str, ...]] = []
    merges: list[int] = []

    @contextmanager
    def record_source_reads(*args: Any, **kwargs: Any) -> Iterator[Any]:
        """Count source openings while preserving the real reader's context lifecycle.

        Args:
            *args: Original reader arguments including requested fields.
            **kwargs: Original unlimited Processing read settings.

        Yields:
            The real source record iterator.
        """
        reads.append(args[1])
        with reader(*args, **kwargs) as records:
            yield records

    def record_group_merge(polygons: list[Any]) -> Any:
        """Count native dissolves and return their real geometry.

        Args:
            polygons: Original polygons in one group.

        Returns:
            The native union geometry.
        """
        merges.append(len(polygons))
        return dissolve(polygons)

    monkeypatch.setattr(vector_summary, "polygon_records", record_source_reads)
    monkeypatch.setattr(vector_summary, "disjoint_subset_union_all", record_group_merge)
    artifact = calculate_vector_summary(source, spec, tmp_path)
    assert reads == [("state_name", "total_es", "weight")]
    assert merges == [2, 1]
    assert [column.output_field for column in artifact.columns] == [
        "sum_total_es",
        "mean_total_es",
        "mean_weight",
        "stdev_weight",
        "sum_total_es_2",
    ]
    assert [column.missing_value_count for column in artifact.columns] == [
        1,
        1,
        0,
        0,
        1,
    ]
    assert (
        artifact.summary_field == "sum_total_es" and artifact.missing_value_count == 1
    )
    with fiona.open(tmp_path / "result.gpkg", layer="summary") as result:
        features = {feature.properties["state_name"]: feature for feature in result}
        assert dict(features["A"].properties) == {
            "state_name": "A",
            "sum_total_es": 2**53 + 1,
            "mean_total_es": (2**53 + 1) / 2,
            "mean_weight": 2,
            "stdev_weight": 0.5,
            "sum_total_es_2": 2**53 + 1,
        }
        assert features["B"].properties["sum_total_es"] is None
        assert features["B"].properties["mean_weight"] == 8.5
        assert len(shape(features["A"].geometry).geoms) == 2
        assert result.schema["properties"]["sum_total_es"] == "int"
        assert result.schema["properties"]["mean_weight"] == "float"


@pytest.mark.parametrize(
    "statistic, expected",
    [("sum", 6), ("mean", 3), ("max", 4), ("min", 2), ("stdev", 1)],
)
def test_group_statistics_exclude_missing_values_without_removing_geometry(
    tmp_path: Path, statistic: VectorSummaryStatistic, expected: float
) -> None:
    """Publish finite-value statistics, null empty groups and the complete group geometry.

    Args:
        tmp_path: Real original and output GeoPackages.
        statistic: Selected group reduction.
        expected: Exact result for the group's two finite values.
    """
    source, spec = summary_source(
        tmp_path,
        [
            ("A", 2),
            ("A", 4),
            ("A", None),
            ("A", math.nan),
            ("A", math.inf),
            ("A", -math.inf),
            ("missing", None),
            (None, 8),
        ],
        statistic=statistic,
    )
    artifact = calculate_vector_summary(source, spec, tmp_path)
    values = read_summary(tmp_path / "result.gpkg")
    assert values["A"][0] == expected
    assert values["missing"][0] is None
    assert values[None][0] == (0 if statistic == "stdev" else 8)
    assert len(values["A"][1].geoms) == 6 and values["A"][1].area == 6
    assert artifact.columns[0].output_field == f"{statistic}_total_es"
    assert (
        artifact.input_feature_count == 8
        and artifact.columns[0].missing_value_count == 5
    )
    provenance = json.loads((tmp_path / "provenance.json").read_text())
    assert provenance["inputs"]["summaries"] == [
        {"field": "total_es", "statistic": statistic}
    ]


@pytest.mark.parametrize(
    "statistic, expected, integer_output",
    [
        ("sum", 2**61 + 1, True),
        ("min", 2**60, True),
        ("max", 2**60 + 1, True),
        ("mean", float(2**60), False),
        ("stdev", 0.5, False),
    ],
)
def test_integer_statistics_preserve_precision_and_choose_output_type(
    tmp_path: Path,
    statistic: VectorSummaryStatistic,
    expected: int | float,
    integer_output: bool,
) -> None:
    """Retain native integer precision through reduction, converting only float outputs.

    Args:
        tmp_path: Real original and output GeoPackages.
        statistic: Selected reduction over consecutive large integers.
        expected: Exact or nearest representable output value.
        integer_output: Whether the statistic must retain an integer column.
    """
    source, spec = summary_source(
        tmp_path,
        [("A", 2**60), ("A", 2**60 + 1)],
        numeric_type="int64",
        statistic=statistic,
    )
    calculate_vector_summary(source, spec, tmp_path)
    with fiona.open(tmp_path / "result.gpkg", layer="summary") as result:
        value = next(iter(result)).properties[f"{statistic}_total_es"]
        assert type(value) is (int if integer_output else float)
        assert value == expected


def test_integer_mean_does_not_require_its_sum_to_fit_int64(tmp_path: Path) -> None:
    """Write a finite mean even when the exact integer total exceeds the output range.

    Args:
        tmp_path: Real original and output GeoPackages.
    """
    source, spec = summary_source(
        tmp_path, [("A", 2**63 - 1)] * 2, numeric_type="int64", statistic="mean"
    )
    calculate_vector_summary(source, spec, tmp_path)
    value = read_summary(tmp_path / "result.gpkg")["A"][0]
    assert isinstance(value, float) and value == float(2**63 - 1)


@pytest.mark.parametrize(
    "statistic, values, expected",
    [
        ("sum", [1e308, 1e308, -1e308], 1e308),
        ("mean", [float_info.max] * 2, float_info.max),
        ("mean", [1e308, 1e308, -1e308], 1e308 / 3),
        ("mean", [1e16, 1, -1e16], 1 / 3),
        ("stdev", [float_info.max, -float_info.max], float_info.max),
        ("stdev", [1e308, 1e308], 0),
        ("stdev", [1e-300, -1e-300], 1e-300),
        ("stdev", [1e15, 1e15 + 1], 0.5),
    ],
)
def test_float_statistics_avoid_intermediate_overflow_and_cancellation(
    tmp_path: Path,
    statistic: VectorSummaryStatistic,
    values: list[float],
    expected: float,
) -> None:
    """Write representable statistics even when naive totals or squared differences overflow.

    Args:
        tmp_path: Real original and output GeoPackages.
        statistic: Numerically sensitive reduction.
        values: Finite source doubles with extreme magnitude or small variation.
        expected: Correctly representable result, including tiny deviations.
    """
    source, spec = summary_source(
        tmp_path, [("A", value) for value in values], statistic=statistic
    )
    calculate_vector_summary(source, spec, tmp_path)
    value = read_summary(tmp_path / "result.gpkg")["A"][0]
    assert value == pytest.approx(expected, rel=1e-15, abs=0)


def test_float_sum_rejects_an_unrepresentable_final_result(tmp_path: Path) -> None:
    """Reject true float overflow after the exact fallback distinguishes intermediate overflow.

    Args:
        tmp_path: Real original and output GeoPackages.
    """
    source, spec = summary_source(tmp_path, [("A", 1e308), ("A", 1e308)])
    with pytest.raises(ProcessingError) as error:
        calculate_vector_summary(source, spec, tmp_path)
    assert error.value.code == "vector_summary_overflow"


@pytest.mark.parametrize("statistic", ["sum", "mean", "max", "min", "stdev"])
def test_statistic_column_collision_preserves_group_field(
    tmp_path: Path,
    statistic: VectorSummaryStatistic,
) -> None:
    """Give every statistic the existing case-insensitive collision-safe field naming.

    Args:
        tmp_path: Real original and output GeoPackages.
        statistic: Selected reduction whose normal column name already names the group.
    """
    group_name = f"{statistic}_total_es".upper()
    source, spec = summary_source(
        tmp_path, [("A", 2)], group_name=group_name, statistic=statistic
    )
    artifact = calculate_vector_summary(source, spec, tmp_path)
    assert artifact.columns[0].output_field == f"{statistic}_total_es_2"
    assert read_summary(tmp_path / "result.gpkg")["A"][0] == (
        0 if statistic == "stdev" else 2
    )


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
    assert artifact.columns[0].output_field == expected
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
    assert len(artifact.columns[0].output_field) == 256
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


@pytest.mark.parametrize("tolerance", [0, 1, 1000])
def test_touching_hole_remains_valid_without_coordinate_scaling(
    tmp_path: Path, tolerance: float
) -> None:
    """Keep a valid point-touching hole that an affine round trip invalidates.

    Args:
        tmp_path: Real source and output directory.
        tolerance: Exact or simplified boundary detail requested by the user.
    """
    original = Polygon(
        [(-125, 32), (-124, 36), (-125, 36), (-125, 32)],
        [[(-124.5, 34), (-124.75, 35), (-124.75, 34), (-124.5, 34)]],
    )
    source, spec = summary_source(tmp_path, [("A", 7)], geometries=[original])
    spec = spec.model_copy(
        update={
            "inputs": spec.inputs.model_copy(update={"boundary_tolerance_m": tolerance})
        }
    )
    calculate_vector_summary(source, spec, tmp_path)
    value, result = read_summary(tmp_path / "result.gpkg")["A"]
    assert value == 7
    assert result.is_valid and result.equals(original)
    assert len(result.geoms[0].interiors) == 1


@pytest.mark.parametrize(
    "statistic,expected",
    [("sum", 12), ("mean", 6), ("min", 2), ("max", 10), ("stdev", 4)],
)
@pytest.mark.parametrize("tolerance", [0, 1000])
def test_overview_preserves_overlapping_parts_and_original_statistics(
    tmp_path: Path,
    statistic: VectorSummaryStatistic,
    expected: float,
    tolerance: float,
) -> None:
    """Dissolve overlapping features and retain every original value at either detail.

    Args:
        tmp_path: Real source and output directory.
        statistic: Requested reduction, independent of boundary processing.
        expected: Exact result from the two finite original values.
        tolerance: Exact original boundaries or a coarser overview.
    """
    originals = [Point(x, 20).buffer(0.1, quad_segs=128) for x in (0, 0.1, 2)]
    source, spec = summary_source(
        tmp_path,
        [("A", 2), ("A", 10), ("A", None)],
        statistic=statistic,
        geometries=originals,
    )
    spec = spec.model_copy(
        update={
            "inputs": spec.inputs.model_copy(update={"boundary_tolerance_m": tolerance})
        }
    )
    artifact = calculate_vector_summary(source, spec, tmp_path)
    value, result = read_summary(tmp_path / "result.gpkg")["A"]
    assert value == expected
    assert result.is_valid and len(result.geoms) == 2
    assert artifact.input_feature_count == 3 and artifact.missing_value_count == 1
    if tolerance == 0:
        assert result.equals(union_all(originals))
    else:
        assert get_num_coordinates(result) < sum(
            get_num_coordinates(p) for p in originals
        )


@pytest.mark.parametrize("failure", ["invalid", "exception", "missing_part"])
def test_failed_native_simplification_retains_original_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    failure: str,
) -> None:
    """Keep the known-valid original when the native simplifier returns invalid rings.

    Args:
        tmp_path: Real source and output directory.
        monkeypatch: Inject an invalid result at the native-library boundary.
        caplog: Capture the diagnostic explaining retained boundary detail.
        failure: Invalid topology, a native exception, or a missing polygon component.
    """
    original = MultiPolygon([Point(x, 20).buffer(0.1, quad_segs=128) for x in (0, 2)])
    source, spec = summary_source(tmp_path, [("A", 7)], geometries=[original])

    def failed_simplification(geometry: BaseGeometry, tolerance: float) -> BaseGeometry:
        """Inject a failed native overview while keeping the real original union.

        Args:
            geometry: Valid dissolved group geometry.
            tolerance: Requested angular boundary detail.

        Returns:
            A malformed or incomplete overview result.

        Raises:
            GEOSException: When the native simplifier is configured to fail.
        """
        if failure == "exception":
            raise GEOSException("Native simplification failed")
        if failure == "missing_part":
            return geometry.geoms[0]
        return Polygon([(0, 0), (1, 1), (0, 1), (1, 0), (0, 0)])

    monkeypatch.setattr(
        "eolab_app.processing.vector_summary.coverage_simplify", failed_simplification
    )
    spec = spec.model_copy(
        update={"inputs": spec.inputs.model_copy(update={"boundary_tolerance_m": 1000})}
    )
    calculate_vector_summary(source, spec, tmp_path)
    value, result = read_summary(tmp_path / "result.gpkg")["A"]
    assert value == 7 and result.is_valid and result.equals(original)
    assert "Retained detailed boundary for vector summary group 'A'" in caplog.text


def test_overview_preserves_small_disconnected_parts_and_holes(tmp_path: Path) -> None:
    """Keep small islands and interior holes instead of collapsing them to a grid.

    Args:
        tmp_path: Real source and output directory.
    """
    outer = Point(0, 20).buffer(0.1, quad_segs=64)
    hole = Point(0, 20).buffer(0.001, quad_segs=32)
    original = MultiPolygon(
        [
            Polygon(outer.exterior.coords, [hole.exterior.coords]),
            Point(2, 20).buffer(1e-7, quad_segs=16),
        ]
    )
    source, spec = summary_source(tmp_path, [("A", 7)], geometries=[original])
    spec = spec.model_copy(
        update={"inputs": spec.inputs.model_copy(update={"boundary_tolerance_m": 1000})}
    )
    calculate_vector_summary(source, spec, tmp_path)
    value, result = read_summary(tmp_path / "result.gpkg")["A"]
    assert value == 7 and result.is_valid and len(result.geoms) == 2
    assert all(part.area > 0 for part in result.geoms)
    assert sum(len(part.interiors) for part in result.geoms) == 1
    assert get_num_coordinates(result) < get_num_coordinates(original)


@pytest.mark.parametrize("failure", ["exception", "invalid", "empty"])
def test_failed_native_union_reports_group_geometry_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    failure: str,
) -> None:
    """Reject an unusable exact native union with a diagnostic naming the group.

    Args:
        tmp_path: Real source and output directory.
        monkeypatch: Inject a failure at the native dissolve boundary.
        caplog: Capture the original grouping value in the diagnostic.
        failure: Native exception, invalid polygon, or empty output.
    """
    source, spec = summary_source(tmp_path, [("A", 7)])

    def failed_union(polygons: Any) -> BaseGeometry:
        """Return unusable native output or raise the requested GEOS failure.

        Args:
            polygons: Original polygon parts passed to the native union.

        Returns:
            Invalid or empty geometry from the simulated native boundary.

        Raises:
            GEOSException: When the native union is configured to fail.
        """
        if failure == "exception":
            raise GEOSException("Native union failed")
        if failure == "empty":
            return Polygon()
        return Polygon([(0, 0), (1, 1), (0, 1), (1, 0), (0, 0)])

    monkeypatch.setattr(
        "eolab_app.processing.vector_summary.disjoint_subset_union_all", failed_union
    )
    with pytest.raises(ProcessingError) as error:
        calculate_vector_summary(source, spec, tmp_path)
    assert error.value.code == "invalid_vector_summary_geometry"
    assert "Vector summary group 'A'" in caplog.text


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
                        "summaries": (
                            VectorSummaryCalculation(field="absent", statistic="sum"),
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
