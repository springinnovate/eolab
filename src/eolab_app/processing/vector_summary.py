"""Sum original polygon attributes by group and publish dissolved overview geometry."""

from dataclasses import asdict, dataclass, field
import hashlib
import json
import math
from pathlib import Path
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
    VectorSummaryInput,
    VectorSummarySpec,
)


@dataclass
class _SummaryGroup:
    """Accumulate one attribute group's exact input values and original polygons."""

    polygons: list[BaseGeometry] = field(default_factory=list)
    values: list[int | float] = field(default_factory=list)


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
    source: ResolvedCatalogSelection, inputs: VectorSummaryInput
) -> tuple[str, bool]:
    """Check selected attribute types against the original native layer schema.

    Args:
        source: Authorized original polygon source.
        inputs: Captured grouping and numeric field names.

    Returns:
        Fiona's grouping-field type and whether the numeric field contains integers.

    Raises:
        ProcessingError: If either field is absent or has an unsupported type.
        FionaError: If the native dataset cannot be opened.
    """
    with fiona.open(
        source.path, layer=source.selection.layerName, enabled_drivers=[source.driver]
    ) as dataset:
        fields = dataset.schema["properties"]
        if inputs.groupField not in fields or inputs.valueField not in fields:
            raise ProcessingError(
                "invalid_vector_summary_fields",
                "A selected field is missing. Choose the layer and fields again.",
            )
        group_type = fields[inputs.groupField]
        value_type = fields[inputs.valueField].split(":", 1)[0]
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
        if value_type not in {"int", "int32", "int64", "float"}:
            raise ProcessingError(
                "invalid_vector_summary_fields", "Choose a numeric field to sum."
            )
        return group_type, value_type != "float"


def _simplify_group_boundary(
    geometry: BaseGeometry, tolerance_m: float
) -> BaseGeometry:
    """Simplify a group's boundary using approximate metres at its middle latitude.

    A local equirectangular scale converts longitude and latitude to distances.
    This remains finite for wide groups and preserves disconnected parts; its
    distance accuracy decreases as a group spans more latitudes. The operation
    is intended for overview geometry, not measurements or changes to totals.

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


def _sum_group_values(values: list[int | float], integer: bool) -> int | float | None:
    """Sum finite source values accurately and check the output format's numeric range.

    Args:
        values: Original finite values in one group, excluding missing attributes.
        integer: Whether the original schema and output column use signed integers.

    Returns:
        An exact integer total, an accurately rounded floating total, or None when
        every source value was missing.

    Raises:
        ProcessingError: If the total cannot be represented by its GeoPackage column.
    """
    if not values:
        return None
    try:
        total = sum(values) if integer else math.fsum(values)
    except OverflowError as error:
        raise ProcessingError(
            "vector_summary_overflow",
            "A group total is too large for a numeric vector field.",
        ) from error
    if (integer and not -(2**63) <= total < 2**63) or not math.isfinite(total):
        raise ProcessingError(
            "vector_summary_overflow",
            "A group total is too large for a numeric vector field.",
        )
    return total


def calculate_vector_summary(
    source: ResolvedCatalogSelection, spec: VectorSummarySpec, directory: Path
) -> VectorSummaryArtifact:
    """Write one dissolved polygon feature and numeric total per original field value.

    Missing groups become one null group. Null and non-finite numeric values do
    not contribute; an all-missing group receives a null total. Integer sums stay
    integers, floating sums use math.fsum, and boundary simplification never
    changes which original values contribute. Native execution is supervised by
    Processing, with no application-imposed work, memory or time ceiling.

    Args:
        source: Authorized original polygons and captured exact predicate.
        spec: Admitted field choices and boundary tolerance.
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
    group_type, integer_values = _read_summary_schema(source, inputs)
    summary_field = _unique_field_name(f"sum_{inputs.valueField}", {inputs.groupField})
    fields = {
        inputs.groupField: group_type,
        summary_field: "int64" if integer_values else "float",
    }
    geometry_field = _unique_field_name("geom", set(fields))
    identifier_field = _unique_field_name("fid", {*fields, geometry_field})
    groups: dict[str | int | float | bool | None, _SummaryGroup] = {}
    included = missing = 0
    write_progress(directory, "reading_vector_features", 0, 0, unit="features")
    with polygon_records(
        source,
        tuple(dict.fromkeys((inputs.groupField, inputs.valueField))),
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
            value = properties[inputs.valueField]
            if value is None or not math.isfinite(value):
                missing += 1
            else:
                group.values.append(value)
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
            total = _sum_group_values(group.values, integer_values)
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
                    "properties": {inputs.groupField: key, summary_field: total},
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
        summary_field=summary_field,
        input_feature_count=included,
        missing_value_count=missing,
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
