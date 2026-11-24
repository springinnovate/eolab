"""Admit a cataloged GeoTIFF stack as one searchable temporal dataset."""

import json
import math
import sqlite3
from contextlib import closing
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from itertools import chain
from pathlib import Path
from typing import Any, Literal, cast

import numpy
import yaml
from affine import Affine
from pydantic import BaseModel, ConfigDict, Field
from rasterio.crs import CRS
from rasterio.transform import array_bounds

from eolab_app.catalog.collections import TEMPORAL_COLLECTION_ID
from eolab_app.catalog.models import DatasetCandidate
from eolab_app.raster.geographic_bounds import (
    covers_full_longitude_turn,
    normalize_wgs84_bounds,
    transform_bounds_to_wgs84,
)


class ArchiveSource(BaseModel):
    """Identify a GeoTIFF stack and its relative SQLite observation catalog."""

    model_config = ConfigDict(extra="forbid", strict=True)

    format: Literal["temporal_cog"]
    catalog: str = Field(min_length=1)


class ArchiveDescription(BaseModel):
    """Supply the archive identity, title, and optional precision for displaying dates.

    Snapshot labels use year, month, day or timestamp. Calendar aggregates use
    the covered period preceding their exclusive end. Explicit intervals are
    identified by their ending timestamp.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(pattern=r"\S")
    title: str = Field(pattern=r"\S")
    source: ArchiveSource
    time_labels: (
        Literal[
            "year",
            "month",
            "day",
            "timestamp",
            "calendar_year",
            "calendar_month",
            "calendar_day",
            "explicit",
        ]
        | None
    ) = None


@dataclass(frozen=True)
class AdmittedArchive:
    """Hold a validated descriptor and its confined source locations.

    Attributes:
        description: Administrator-supplied dataset identity and title.
        root: Resolved directory containing the descriptor and GeoTIFFs.
        catalog: Resolved SQLite metadata file inside the archive.
    """

    description: ArchiveDescription
    root: Path
    catalog: Path


@dataclass(frozen=True)
class _TemporalMetadata:
    """Hold validated archive metadata used to construct one temporal Item.

    Attributes:
        variables: Normalized data-cube metadata keyed by variable identifier.
        grid: Common CRS, north-up transform, raster height and width.
        label_start: Earliest published observation timestamp in epoch seconds.
        label_end: Latest published observation timestamp in epoch seconds.
        support_start: Earliest physical interval start in epoch seconds.
        support_end: Latest physical interval end in epoch seconds.
    """

    variables: dict[str, Any]
    grid: tuple[CRS, Affine, int, int]
    label_start: int
    label_end: int
    support_start: int
    support_end: int


def confined_path(root: Path, relative_path: str) -> Path:
    """Resolve one archive member without allowing it to leave the archive.

    Args:
        root: Resolved archive directory.
        relative_path: Member location relative to that directory.

    Returns:
        Confined member path. Opening it reports missing or unreadable files.

    Raises:
        ValueError: If the supplied path is absolute or escapes the archive.
        OSError: If path resolution fails.
    """
    member = Path(relative_path)
    if member.is_absolute():
        raise ValueError("Archive member paths must be relative")
    resolved = (root / member).resolve()
    if not resolved.is_relative_to(root):
        raise ValueError(f"Archive member escapes its directory: {relative_path}")
    return resolved


def prepare_temporal_candidate(
    source_root: Path, candidate: DatasetCandidate
) -> DatasetCandidate:
    """Read a descriptor before discovery checks dataset ID uniqueness.

    Args:
        source_root: Configured read-only source mount.
        candidate: Descriptor file recognized during directory discovery.

    Returns:
        Candidate carrying its validated description and stable catalog key.

    Raises:
        ValueError: If the descriptor or its source path is invalid.
        OSError: If the descriptor cannot be accessed.
        yaml.YAMLError: If the descriptor is not valid YAML.
    """
    descriptor = candidate.path.resolve(strict=True)
    if not descriptor.is_relative_to(source_root.resolve()):
        raise ValueError("Dataset descriptor is outside the source mount")
    description = ArchiveDescription.model_validate(
        yaml.safe_load(descriptor.read_text(encoding="utf-8"))
    )
    archive = AdmittedArchive(
        description,
        descriptor.parent,
        confined_path(descriptor.parent, description.source.catalog),
    )
    return replace(
        candidate,
        item_key=(TEMPORAL_COLLECTION_ID, description.id),
        metadata=archive,
    )


def utc_timestamp(seconds: int) -> str:
    """Format epoch seconds, including dates before 1970, as a STAC timestamp.

    Args:
        seconds: Observation or interval time since the Unix epoch.

    Returns:
        RFC3339 timestamp ending in ``Z``.
    """
    return (
        (datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=seconds))
        .isoformat()
        .replace("+00:00", "Z")
    )


def _parse_observation_grid(
    variable: Any, crs_value: Any, transform_value: Any, height: Any, width: Any
) -> tuple[CRS, Affine, int, int]:
    """Validate and normalize the grid fields of one external observation.

    Args:
        variable: Raw variable name used in admission errors.
        crs_value: SQLite CRS value accepted by Rasterio.
        transform_value: JSON-encoded GDAL transform from SQLite.
        height: Raw raster row count, required to be a positive integer.
        width: Raw raster column count, required to be a positive integer.

    Returns:
        Canonical CRS, north-up transform, height and width for grid comparison.

    Raises:
        ValueError: If the grid is malformed or unsupported.
        TypeError: If external values cannot be parsed as grid metadata.
        rasterio.errors.CRSError: If Rasterio cannot parse the CRS.
    """
    crs = CRS.from_user_input(crs_value)
    transform = Affine.from_gdal(*json.loads(transform_value))
    if (
        not isinstance(height, int)
        or height <= 0
        or not isinstance(width, int)
        or width <= 0
        or not all(math.isfinite(value) for value in transform)
        or transform.a <= 0
        or transform.e >= 0
        or transform.b != 0
        or transform.d != 0
    ):
        raise ValueError(f"Unsupported raster grid for {variable}")
    return crs, transform, height, width


def _parse_variable_metadata(
    variable: Any, name: Any, units: Any, dtype: Any, nodata: Any, temporal_type: Any
) -> dict[str, Any]:
    """Validate external variable fields and normalize their Catalog metadata.

    Args:
        variable: Raw variable identifier, required to be a nonempty string.
        name: Raw descriptive name, required to be a nonempty string.
        units: Raw unit label, required to be a nonempty string.
        dtype: NumPy numeric dtype supplied by the observation catalog.
        nodata: Optional numeric NoData value, including the published NaN string.
        temporal_type: Published instant, mean or accumulation semantics.

    Returns:
        The variable's normalized data-cube metadata, preserving its native dtype.

    Raises:
        ValueError: If metadata is unsupported or NoData cannot be parsed.
        TypeError: If the external dtype or NoData value cannot be interpreted.
    """
    supports = {
        "instant": "instantaneous",
        "mean": "mean_rate",
        "accumulation": "accumulation",
    }
    if (
        not isinstance(variable, str)
        or not variable.strip()
        or not isinstance(name, str)
        or not name.strip()
        or not isinstance(units, str)
        or not units.strip()
        or numpy.dtype(dtype).kind not in "iuf"
        or temporal_type not in supports
    ):
        raise ValueError(f"Unsupported variable metadata: {variable}")
    if nodata is not None:
        float(nodata)
    return {
        "dimensions": ["time", "y", "x"],
        "type": "data",
        "description": name,
        "unit": units,
        "data_type": dtype,
        "nodata": "nan" if nodata == "NaN" else nodata,
        "eolab:time_support": supports[temporal_type],
    }


def _read_observation_summary(
    connection: sqlite3.Connection,
) -> _TemporalMetadata | None:
    """Read certified metadata groups without traversing individual observations.

    The producer certifies each observation's integer times, valid intervals and
    unique variable/time identity when publishing this relation. Admission still
    validates its metadata groups, repeated variable totals and time bounds.

    Args:
        connection: Read-only connection to the confined producer catalog.

    Returns:
        Validated metadata, or None when the relation is absent or empty. Empty
        summaries explicitly request the ordinary observation reader, including
        while a producer has an unfinished ready publication.

    Raises:
        ValueError: Summary metadata, counts or extents violate the contract.
        sqlite3.Error: An advertised summary cannot be queried.
        TypeError: External grid or variable values cannot be interpreted.
    """
    relation = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') "
        "AND name = 'observation_summary'"
    ).fetchone()
    if relation is None:
        return None
    rows = connection.execute(
        "SELECT variable, name, units, band, dtype, nodata, temporal_type, crs, "
        "transform, height, width, group_observation_count, observation_count, "
        "valid_time_min, valid_time_max, interval_start_min, interval_end_max "
        "FROM observation_summary ORDER BY variable"
    )
    first = rows.fetchone()
    if first is None:
        return None
    variables: dict[str, Any] = {}
    grid: tuple[CRS, Affine, int, int] | None = None
    totals: dict[str, tuple[int, int, int, int, int]] = {}
    grouped_counts: dict[str, int] = {}
    for (
        variable,
        name,
        units,
        band,
        dtype,
        nodata,
        temporal_type,
        crs_value,
        transform_value,
        height,
        width,
        group_count,
        observation_count,
        label_start,
        label_end,
        support_start,
        support_end,
    ) in chain((first,), rows):
        current_grid = _parse_observation_grid(
            variable, crs_value, transform_value, height, width
        )
        if band != 1:
            raise ValueError(f"Unsupported raster grid for {variable}")
        if grid is not None and current_grid != grid:
            raise ValueError("Temporal observations must share one raster grid")
        grid = current_grid
        metadata = _parse_variable_metadata(
            variable, name, units, dtype, nodata, temporal_type
        )
        if variable in variables and variables[variable] != metadata:
            raise ValueError(
                f"Variable metadata differs between observations: {variable}"
            )
        variables[variable] = metadata
        if (
            not isinstance(group_count, int)
            or group_count <= 0
            or not isinstance(observation_count, int)
            or observation_count <= 0
        ):
            raise ValueError(f"Invalid observation summary count for {variable}")
        if (
            not all(
                isinstance(value, int)
                for value in (label_start, label_end, support_start, support_end)
            )
            or label_start > label_end
            or support_end != label_end
        ):
            raise ValueError(
                f"Invalid time or interval for {variable} in observation summary"
            )
        current_totals = (
            observation_count,
            label_start,
            label_end,
            support_start,
            support_end,
        )
        if variable in totals and totals[variable] != current_totals:
            raise ValueError(
                f"Observation summary totals or time bounds differ for {variable}"
            )
        totals[variable] = current_totals
        grouped_counts[variable] = grouped_counts.get(variable, 0) + group_count
    for variable, (
        count,
        label_start,
        label_end,
        support_start,
        support_end,
    ) in totals.items():
        instantaneous = variables[variable]["eolab:time_support"] == "instantaneous"
        if (instantaneous and support_start != label_start) or (
            not instantaneous and support_start >= label_start
        ):
            raise ValueError(
                f"Invalid time or interval for {variable} in observation summary"
            )
        if grouped_counts[variable] != count:
            raise ValueError(
                f"Observation summary group counts do not match total for {variable}"
            )
    return _TemporalMetadata(
        variables=variables,
        grid=cast(tuple[CRS, Affine, int, int], grid),
        label_start=min(values[1] for values in totals.values()),
        label_end=max(values[2] for values in totals.values()),
        support_start=min(values[3] for values in totals.values()),
        support_end=max(values[4] for values in totals.values()),
    )


def build_temporal_items(
    source_root: Path, candidate: DatasetCandidate
) -> tuple[dict[str, Any], ...]:
    """Build one Item from published observation metadata without opening TIFFs.

    Admission checks the external catalog's common north-up grid,
    variable metadata and observation intervals. The producer owns TIFF
    publication integrity; native file errors are reported when an observation
    is used. Partial coverage is valid and no missing observations are invented.
    Every scan reads the current producer summary when available, trusting its
    publication-time certification of individual times and identities. Absent or
    empty summaries use the full observation reader. That reader reuses parsed
    consecutive identical grid and variable descriptions within this call only;
    changed descriptions are validated and compared in their normalized form.

    Args:
        source_root: Source mount; confinement was established during preparation.
        candidate: Prepared descriptor with an unambiguous catalog identity.

    Returns:
        One STAC Item describing actual observation and physical-time extents.
        Its private descriptor asset is removed at public response boundaries.

    Raises:
        ValueError: If external metadata violates the temporal raster contract.
        OSError: If the catalog cannot be opened.
        sqlite3.Error: If the read-only observation catalog cannot be read.
    """
    del source_root
    archive = cast(AdmittedArchive, candidate.metadata)
    variables: dict[str, Any] = {}
    grid: tuple[CRS, Affine, int, int] | None = None
    label_start: int | None = None
    label_end: int | None = None
    support_start: int | None = None
    support_end: int | None = None
    previous: tuple[str, int] | None = None
    parse_grid = lru_cache(maxsize=1, typed=True)(_parse_observation_grid)
    parse_variable = lru_cache(maxsize=1, typed=True)(_parse_variable_metadata)
    catalog_uri = archive.catalog.as_uri()
    if archive.catalog.drive.startswith("\\\\"):
        catalog_uri = catalog_uri.replace("file://", "file:////", 1)
    with closing(sqlite3.connect(f"{catalog_uri}?mode=ro", uri=True)) as connection:
        summary = _read_observation_summary(connection)
        if summary is None:
            rows = connection.execute(
                "SELECT variable, name, units, band, valid_time, reference_time, "
                "interval_start, interval_end, temporal_type, dtype, nodata, crs, "
                "transform, height, width FROM observations ORDER BY variable, valid_time"
            )
        else:
            variables, grid = summary.variables, summary.grid
            label_start, label_end = summary.label_start, summary.label_end
            support_start, support_end = summary.support_start, summary.support_end
            rows = ()
        for (
            variable,
            name,
            units,
            band,
            time,
            reference_time,
            start,
            end,
            temporal_type,
            dtype,
            nodata,
            crs_value,
            transform_value,
            height,
            width,
        ) in rows:
            current_grid = parse_grid(
                variable, crs_value, transform_value, height, width
            )
            if band != 1:
                raise ValueError(f"Unsupported raster grid for {variable}")
            if grid is not None and current_grid != grid:
                raise ValueError("Temporal observations must share one raster grid")
            grid = current_grid
            metadata = parse_variable(
                variable,
                name,
                units,
                dtype,
                nodata,
                temporal_type,
            )
            if (
                not isinstance(time, int)
                or not isinstance(start, int)
                or not isinstance(end, int)
                or (reference_time is not None and not isinstance(reference_time, int))
                or (temporal_type == "instant" and (start != time or end != time))
                or (temporal_type != "instant" and (start >= end or end != time))
            ):
                raise ValueError(f"Invalid time or interval for {variable} at {time}")
            identity = (variable, time)
            if identity == previous:
                raise ValueError(f"Duplicate observation for {variable} at {time}")
            previous = identity
            if variable in variables and variables[variable] != metadata:
                raise ValueError(
                    f"Variable metadata differs between observations: {variable}"
                )
            variables[variable] = metadata
            label_start = time if label_start is None else min(label_start, time)
            label_end = time if label_end is None else max(label_end, time)
            support_start = (
                start if support_start is None else min(support_start, start)
            )
            support_end = end if support_end is None else max(support_end, end)
    if grid is None:
        raise ValueError("The archive has no published observations")
    crs, transform, height, width = grid
    bounds = transform_bounds_to_wgs84(crs, array_bounds(height, width, transform))
    if covers_full_longitude_turn(crs, width * transform.a):
        # A datum transformation can map both native longitude edges to the same meridian.
        bounds = (-180.0, bounds[1], 180.0, bounds[3])
    bbox = list(normalize_wgs84_bounds(bounds))
    west, south, east, north = bbox
    reference_system = crs.to_epsg() or crs.to_wkt()
    return (
        {
            "type": "Feature",
            "stac_version": "1.0.0",
            "stac_extensions": [
                "https://stac-extensions.github.io/datacube/v2.3.0/schema.json"
            ],
            "id": archive.description.id,
            "collection": TEMPORAL_COLLECTION_ID,
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [
                        [west, south],
                        [east, south],
                        [east, north],
                        [west, north],
                        [west, south],
                    ]
                ],
            },
            "bbox": bbox,
            "properties": {
                "title": archive.description.title,
                "datetime": None,
                "start_datetime": utc_timestamp(cast(int, support_start)),
                "end_datetime": utc_timestamp(cast(int, support_end)),
                "eolab:calendar": "proleptic_gregorian",
                **(
                    {"eolab:time_labels": archive.description.time_labels}
                    if archive.description.time_labels
                    else {}
                ),
                "cube:dimensions": {
                    "time": {
                        "type": "temporal",
                        "extent": [
                            utc_timestamp(cast(int, label_start)),
                            utc_timestamp(cast(int, label_end)),
                        ],
                    },
                    "x": {
                        "type": "spatial",
                        "axis": "x",
                        "extent": [
                            transform.c + transform.a / 2,
                            transform.c + transform.a * (width - 0.5),
                        ],
                        "step": transform.a,
                        "reference_system": reference_system,
                    },
                    "y": {
                        "type": "spatial",
                        "axis": "y",
                        "extent": [
                            transform.f + transform.e * (height - 0.5),
                            transform.f + transform.e / 2,
                        ],
                        "step": transform.e,
                        "reference_system": reference_system,
                    },
                },
                "cube:variables": variables,
            },
            "links": [],
            "assets": {
                "eolab:temporal-source": {
                    "href": (archive.root / candidate.path.name).as_uri(),
                    "type": "application/yaml",
                    "roles": ["metadata"],
                }
            },
        },
    )
