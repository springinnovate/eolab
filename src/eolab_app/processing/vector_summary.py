"""Summarize original polygon attributes by group and publish dissolved overview geometry."""

from dataclasses import asdict, dataclass, field, replace
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import statistics
from typing import Literal

import fiona
from shapely import union_all
from shapely.affinity import scale
from shapely.geometry import MultiPolygon, mapping, shape
from shapely.geometry.base import BaseGeometry

from eolab_app.bounded_vector import polygon_records
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.vector_summary_models import (
    OPERATION,
    VectorSummaryArtifact,
    VectorSummaryCalculation,
    VectorSummaryColumn,
    VectorSummaryInput,
    VectorSummarySpec,
    VectorSummaryStatistic,
)


@dataclass
class _SummaryGroup:
    """Retain each requested source field once and the group's original polygons."""

    polygons: list[BaseGeometry] = field(default_factory=list)
    values: dict[str, list[int | float]] = field(default_factory=dict)


def _unique_field_name(preferred: str, used: set[str]) -> str:
    """Choose an output column distinct from existing names, ignoring case.

    Args:
        preferred: Readable column name to use when available.
        used: Existing column names, compared using Unicode case folding.

    Returns:
        The preferred name or a suffix starting at 2, within the ordinary vector
        API's 256-character field-name contract.
    """
    occupied = {name.casefold() for name in used}
    candidate = preferred[:256]
    suffix = 2
    while candidate.casefold() in occupied:
        ending = f"_{suffix}"
        candidate = preferred[: 256 - len(ending)] + ending
        suffix += 1
    return candidate


def _read_summary_schema(
    source: ResolvedCatalogSelection,
    inputs: VectorSummaryInput,
    summaries: tuple[VectorSummaryCalculation, ...],
) -> tuple[str, dict[str, bool]]:
    """Check selected attribute types against the original native layer schema.

    Args:
        source: Authorized original polygon source.
        inputs: Captured source and grouping field.
        summaries: Ordered numeric field/statistic pairs.

    Returns:
        Fiona's grouping type and each distinct numeric field's integer flag.

    Raises:
        ProcessingError: If a selected field is absent or has an unsupported type.
        FionaError: If the native dataset cannot be opened.
    """
    with fiona.open(
        source.path, layer=source.selection.layerName, enabled_drivers=[source.driver]
    ) as dataset:
        fields = dataset.schema["properties"]
        value_fields = dict.fromkeys(summary.field for summary in summaries)
        if {inputs.groupField, *value_fields} - set(fields):
            raise ProcessingError(
                "invalid_vector_summary_fields",
                "A selected field is missing. Choose the layer and fields again.",
            )
        group_type = fields[inputs.groupField]
        if group_type.split(":", 1)[0] not in {
            "str",
            "int",
            "int32",
            "int64",
            "float",
            "bool",
        }:
            raise ProcessingError(
                "invalid_vector_summary_fields",
                "Group by a text, number or boolean field.",
            )
        integer_fields = {}
        for name in value_fields:
            value_type = fields[name].split(":", 1)[0]
            if value_type not in {"int", "int32", "int64", "float"}:
                raise ProcessingError(
                    "invalid_vector_summary_fields",
                    "Choose numeric fields to summarize.",
                )
            integer_fields[name] = value_type != "float"
        return group_type, integer_fields


def _simplify_group_boundary(
    geometry: BaseGeometry, tolerance_m: float
) -> BaseGeometry:
    """Simplify a group's boundary using approximate metres at its middle latitude.

    A local equirectangular scale converts longitude and latitude to distances.
    This remains finite for wide groups and preserves disconnected parts; its
    distance accuracy decreases as a group spans more latitudes. The operation
    is intended for overview geometry, not measurements or changes to statistics.

    Args:
        geometry: Valid dissolved WGS84 Polygon or MultiPolygon.
        tolerance_m: Nonnegative approximate tolerance; zero retains the boundary.

    Returns:
        Topology-preserving simplified geometry in WGS84.
    """
    if tolerance_m == 0:
        return geometry
    _, south, _, north = geometry.bounds
    metres_per_degree = math.pi * 6_371_008.8 / 180
    longitude_scale = metres_per_degree * math.cos(math.radians((south + north) / 2))
    projected = scale(
        geometry, xfact=longitude_scale, yfact=metres_per_degree, origin=(0, 0)
    )
    simplified = projected.simplify(tolerance_m, preserve_topology=True)
    return scale(
        simplified,
        xfact=1 / longitude_scale,
        yfact=1 / metres_per_degree,
        origin=(0, 0),
    )


def _summarize_group_values(
    values: list[int | float], statistic: VectorSummaryStatistic, integer_output: bool
) -> int | float | None:
    """Reduce finite original values without rounding integer inputs prematurely.

    Mean and population standard deviation use the standard library's exact
    intermediate arithmetic, preserving small differences between large integers
    and avoiding overflow from squared finite floats. Floating sums use math.fsum;
    if its intermediate total overflows, exact fractions distinguish a finite
    cancelled sum from a result outside the output column's range.

    Args:
        values: Original finite values in one group, excluding missing attributes.
        statistic: Sum, arithmetic mean, maximum, minimum or population deviation.
        integer_output: Whether the GeoPackage column preserves integer-source
            sum/min/max as signed integers rather than converting to a float.

    Returns:
        An integer for integer-source sum/min/max, a float for other results, or
        None when every source value was missing. One value has zero deviation.

    Raises:
        ProcessingError: If the result cannot be represented by its GeoPackage column.
    """
    if not values:
        return None
    try:
        if statistic == "sum":
            if integer_output:
                result = sum(values)
            else:
                try:
                    result = math.fsum(values)
                except OverflowError:
                    result = float(sum(Fraction(value) for value in values))
        elif statistic == "mean":
            result = statistics.mean(values)
        elif statistic == "min":
            result = min(values)
        elif statistic == "max":
            result = max(values)
        else:
            result = statistics.pstdev(values)
    except OverflowError as error:
        raise ProcessingError(
            "vector_summary_overflow",
            "A group result is too large for a numeric vector field.",
        ) from error
    if (integer_output and not -(2**63) <= result < 2**63) or not math.isfinite(result):
        raise ProcessingError(
            "vector_summary_overflow",
            "A group result is too large for a numeric vector field.",
        )
    return result if integer_output else float(result)


def calculate_vector_summary(
    source: ResolvedCatalogSelection, spec: VectorSummarySpec, directory: Path
) -> VectorSummaryArtifact:
    """Write every requested statistic with one dissolved feature per original group.

    Missing groups become one null group. Null and non-finite numeric values do
    not contribute; an all-missing group receives a null result. Integer sums,
    minima and maxima stay integers; mean and population deviation use floats.
    Boundary simplification never changes which original values contribute.
    Processing supervises native execution without application-imposed work,
    memory or time ceilings. Repeated source fields share one list of values;
    all calculations share one source read and one geometry merge per group.

    Args:
        source: Authorized original polygons and captured exact predicate.
        spec: Admitted field/statistic pairs and boundary tolerance.
        directory: Worker-owned attempt directory for result and provenance files.

    Returns:
        Completed GeoPackage metadata ready for ordinary atomic publication.

    Raises:
        ProcessingError: If fields, selection or numeric output are invalid.
        SelectionUnavailableError: If the original polygon source cannot be read.
        GeometryValidationError: If original polygons are invalid.
        FionaError: If the result cannot be written by the native driver.
        OSError: If result or provenance storage is unavailable.
    """
    inputs = spec.inputs.vector
    group_type, integer_values = _read_summary_schema(
        source, inputs, spec.inputs.summaries
    )
    fields = {inputs.groupField: group_type}
    columns = []
    for summary in spec.inputs.summaries:
        output_field = _unique_field_name(
            f"{summary.statistic}_{summary.field}", set(fields)
        )
        integer_output = integer_values[summary.field] and summary.statistic in {
            "sum",
            "min",
            "max",
        }
        fields[output_field] = "int64" if integer_output else "float"
        columns.append(
            VectorSummaryColumn(summary.field, summary.statistic, output_field, 0)
        )
    geometry_field = _unique_field_name("geom", set(fields))
    identifier_field = _unique_field_name("fid", {*fields, geometry_field})
    groups: dict[str | int | float | bool | None, _SummaryGroup] = {}
    included = 0
    missing = dict.fromkeys(integer_values, 0)
    write_progress(directory, "reading_vector_features", 0, 0, unit="features")
    with polygon_records(
        source,
        tuple(dict.fromkeys((inputs.groupField, *integer_values))),
        timeout_seconds=None,
        max_features=None,
        max_feature_coordinates=None,
    ) as records:
        for geometry, properties in records:
            key = properties[inputs.groupField]
            if isinstance(key, float) and not math.isfinite(key):
                key = None
            group = groups.setdefault(key, _SummaryGroup())
            group.polygons.append(shape(geometry))
            for name in integer_values:
                values = group.values.setdefault(name, [])
                value = properties[name]
                if value is None or not math.isfinite(value):
                    missing[name] += 1
                else:
                    values.append(value)
            included += 1
            if included % 512 == 0:
                write_progress(
                    directory, "reading_vector_features", included, 0, unit="features"
                )
    if not groups:
        raise ProcessingError(
            "empty_vector_selection",
            "No polygon features match this selection. Change the filter and try again.",
        )
    path = directory / "result.gpkg"
    write_progress(directory, "merging_vector_groups", 0, len(groups), unit="groups")
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="summary",
        crs="EPSG:4326",
        schema={"geometry": "MultiPolygon", "properties": fields},
        GEOMETRY_NAME=geometry_field,
        FID=identifier_field,
    ) as destination:
        for completed, (key, group) in enumerate(groups.items(), 1):
            properties = {inputs.groupField: key}
            for column in columns:
                properties[column.output_field] = _summarize_group_values(
                    group.values[column.source_field],
                    column.statistic,
                    fields[column.output_field] == "int64",
                )
            merged = _simplify_group_boundary(
                union_all(group.polygons), spec.inputs.boundary_tolerance_m
            )
            if merged.geom_type == "Polygon":
                merged = MultiPolygon([merged])
            if (
                merged.geom_type != "MultiPolygon"
                or merged.is_empty
                or not merged.is_valid
            ):
                raise ProcessingError(
                    "invalid_vector_summary_geometry",
                    "A merged group could not be written as valid polygons. Try a finer boundary detail.",
                )
            destination.write(
                {
                    "geometry": mapping(merged),
                    "properties": properties,
                }
            )
            write_progress(
                directory,
                "merging_vector_groups",
                completed,
                len(groups),
                unit="groups",
            )
    with path.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    artifact = VectorSummaryArtifact(
        size=path.stat().st_size,
        sha256=checksum,
        filename="vector-summary.gpkg",
        feature_count=len(groups),
        columns=tuple(
            replace(column, missing_value_count=missing[column.source_field])
            for column in columns
        ),
        summary_field=columns[0].output_field,
        input_feature_count=included,
        missing_value_count=missing[columns[0].source_field],
    )
    (directory / "provenance.json").write_text(
        json.dumps(
            {
                "operation": OPERATION,
                "inputs": spec.inputs.model_dump(mode="json", by_alias=True),
                **asdict(artifact),
            },
            allow_nan=False,
        ),
        encoding="utf-8",
    )
    return artifact


def vector_summary_process_target(
    writer: ProcessResultWriter,
    action: Literal["summarize"],
    arguments: tuple[ResolvedCatalogSelection, VectorSummarySpec, Path, None],
) -> None:
    """Run a polygon summary through the ordinary cancellable native supervisor.

    Args:
        writer: Worker-owned result channel receiving metadata or a safe error.
        action: Registered summary action selected by the operation adapter.
        arguments: Authorized original source, captured inputs, output directory and settings.
    """
    source, spec, directory, _ = arguments
    try:
        writer.put(("ok", calculate_vector_summary(source, spec, directory)))
    except ProcessingError as error:
        writer.put(("error", (error.code, error.detail, error.status)))
    except SelectionUnavailableError as error:
        writer.put(("error", ("selection_unavailable", error.detail, 409)))
    except (ValueError, TypeError, ArithmeticError):
        writer.put(
            (
                "error",
                (
                    "invalid_vector_summary",
                    "The selected polygons or values could not be summarized. Check the source geometry and field types.",
                    422,
                ),
            )
        )
    except Exception:
        writer.put(
            (
                "error",
                (
                    "vector_summary_failed",
                    "The vector summary could not be read or written. Check source availability and available storage before retrying.",
                    500,
                ),
            )
        )
