"""Admit a described ERA5 archive as one searchable temporal dataset."""

import json
import re
import sqlite3
from calendar import monthrange
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from itertools import groupby
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import quote

import numpy
import rasterio
import yaml
from pydantic import BaseModel, ConfigDict, Field

from eolab_app.catalog.collections import TEMPORAL_COLLECTION_ID
from eolab_app.catalog.models import DatasetCandidate


class ArchiveSource(BaseModel):
    """Identify the supported producer layout and its relative SQLite catalog."""

    model_config = ConfigDict(extra="forbid", strict=True)

    format: Literal["era5_ncar_zarr"]
    catalog: str = Field(min_length=1)


class ArchiveDescription(BaseModel):
    """Supply the stable catalog identity and display title for an archive."""

    model_config = ConfigDict(extra="forbid", strict=True)

    id: str = Field(pattern=r"\S")
    title: str = Field(pattern=r"\S")
    source: ArchiveSource


@dataclass(frozen=True)
class AdmittedArchive:
    """Hold a validated descriptor and its confined source locations.

    Attributes:
        description: Administrator-supplied identity, title and producer format.
        root: Resolved directory containing the descriptor and monthly stores.
        catalog: Resolved SQLite metadata file inside the archive.
    """

    description: ArchiveDescription
    root: Path
    catalog: Path


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
    """Read a descriptor once before discovery checks dataset ID uniqueness.

    Args:
        source_root: Configured read-only source mount.
        candidate: Descriptor file recognized during directory discovery.

    Returns:
        Candidate carrying its validated description and stable catalog key.

    Raises:
        ValueError: If the descriptor or its source path is invalid.
        OSError: If the descriptor or SQLite catalog cannot be accessed.
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


def read_array_metadata(root: Path, member: str) -> dict[str, Any]:
    """Read the Zarr v3 header for one confined archive array.

    Args:
        root: Resolved archive directory.
        member: Relative path to an array directory.

    Returns:
        The array's JSON metadata, without reading its values.

    Raises:
        ValueError: If the member escapes the archive or is not a Zarr v3 array.
        OSError: If its metadata is missing or unreadable.
    """
    metadata = json.loads(
        confined_path(root, f"{member}/zarr.json").read_text(encoding="utf-8")
    )
    if (
        not isinstance(metadata, dict)
        or metadata.get("zarr_format") != 3
        or metadata.get("node_type") != "array"
    ):
        raise ValueError(f"{member} must be a Zarr v3 array")
    return metadata


def read_coordinate(
    root: Path,
    store: str,
    name: str,
    expected: numpy.ndarray,
    attributes: dict[str, str],
) -> None:
    """Check a producer coordinate against the supported ERA5 grid and clock.

    Rasterio reads only this one-dimensional coordinate. The producer stores
    each coordinate in one chunk; confine that chunk as well as its header.

    Args:
        root: Resolved archive directory.
        store: Relative monthly store directory.
        name: Coordinate array name.
        expected: Required coordinate values and dtype.
        attributes: Required coordinate units and time conventions.

    Raises:
        ValueError: If the coordinate layout, attributes or values are unsupported.
        OSError: If metadata is missing or unreadable.
        rasterio.errors.RasterioError: If the coordinate cannot be decoded.
    """
    member = f"{store}/{name}"
    metadata = read_array_metadata(root, member)
    if (
        not isinstance(metadata["attributes"], dict)
        or metadata["shape"] != [len(expected)]
        or metadata["dimension_names"] != [name]
        or metadata["data_type"] != expected.dtype.name
        or metadata["chunk_grid"]
        != {"name": "regular", "configuration": {"chunk_shape": [len(expected)]}}
        or metadata["chunk_key_encoding"]
        != {"name": "default", "configuration": {"separator": "/"}}
        or any(
            metadata["attributes"].get(key) != value
            for key, value in attributes.items()
        )
    ):
        raise ValueError(f"Unsupported {name} coordinate metadata in {store}")
    confined_path(root, f"{member}/c/0")
    with rasterio.Env(GDAL_PAM_ENABLED="NO"):
        with rasterio.open(confined_path(root, member), driver="Zarr") as coordinate:
            values = coordinate.read(1).ravel()
    if not numpy.array_equal(values, expected):
        raise ValueError(f"Unsupported {name} coordinate values in {store}")


def describe_month(
    root: Path, year: int, month: int, rows: list[tuple[str, int, int, int, str]]
) -> tuple[dict[str, Any], tuple[int, int], tuple[int, int]]:
    """Describe covered variables and observation bounds in one published month.

    Args:
        root: Resolved archive directory.
        year: Published calendar year.
        month: Published calendar month.
        rows: SQLite coverage rows ordered by variable and observation time.

    Returns:
        Variable descriptions, observation-label extent and physical-time extent.

    Raises:
        ValueError: If metadata, coordinates or coverage violate the supported layout.
        OSError: If required store metadata is missing or unreadable.
        rasterio.errors.RasterioError: If a coordinate cannot be decoded.
    """
    store = f"{year:04d}/{month:02d}/era5.zarr"
    group = json.loads(
        confined_path(root, f"{store}/zarr.json").read_text(encoding="utf-8")
    )
    if (
        not isinstance(group, dict)
        or group.get("zarr_format") != 3
        or group.get("node_type") != "group"
    ):
        raise ValueError(f"{store} must be a Zarr v3 group")
    month_start = int(datetime(year, month, 1, tzinfo=timezone.utc).timestamp())
    if not rows:
        raise ValueError(f"No published observations in {store}")
    times = numpy.array(sorted({row[1] for row in rows}))
    month_end = month_start + monthrange(year, month)[1] * 86400
    if (
        times.dtype.kind not in "iu"
        or times[0] < month_start
        or times[-1] >= month_end
        or numpy.any((times - month_start) % 3600)
    ):
        raise ValueError(f"Observations must name UTC hours within {store}")
    times = times.astype("int64", copy=False)
    read_coordinate(
        root,
        store,
        "latitude",
        numpy.linspace(90, -90, 721),
        {
            "units": "degrees_north",
        },
    )
    read_coordinate(
        root,
        store,
        "longitude",
        numpy.arange(1440) * 0.25,
        {
            "units": "degrees_east",
        },
    )
    read_coordinate(
        root,
        store,
        "time",
        times,
        {
            "units": "seconds since 1970-01-01 00:00:00",
            "calendar": "proleptic_gregorian",
            "timezone": "UTC",
        },
    )
    variables: dict[str, Any] = {}
    supports = {
        "instant": ("instantaneous", 0),
        "avg": ("mean_rate", 3600),
        "accum": ("accumulation", 3600),
    }
    for variable, coverage in groupby(rows, key=lambda row: row[0]):
        if not re.fullmatch(r"[A-Za-z0-9_]+", variable):
            raise ValueError(f"Unsupported variable name: {variable!r}")
        metadata = read_array_metadata(root, f"{store}/{variable}")
        attributes = metadata["attributes"]
        if (
            not isinstance(attributes, dict)
            or metadata["shape"] != [len(times), 721, 1440]
            or metadata["dimension_names"] != ["time", "latitude", "longitude"]
            or metadata["data_type"] != "float32"
            or metadata["fill_value"] != "NaN"
            or attributes["step_type"] not in supports
            or not isinstance(attributes["units"], str)
            or not attributes["units"].strip()
            or not isinstance(attributes["long_name"], str)
        ):
            raise ValueError(f"Unsupported metadata for {variable} in {store}")
        support, duration = supports[attributes["step_type"]]
        previous = None
        for _, time, start, end, step_type in coverage:
            if previous == time:
                raise ValueError(f"Duplicate observation for {variable} at {time}")
            if (
                start != time - duration
                or end != time
                or step_type != attributes["step_type"]
            ):
                raise ValueError(f"Invalid time or interval for {variable} at {time}")
            previous = time
        variables[variable] = {
            "dimensions": ["time", "latitude", "longitude"],
            "type": "data",
            "description": attributes["long_name"],
            "unit": attributes["units"],
            "data_type": "float32",
            "nodata": "nan",
            "eolab:time_support": support,
        }
    return (
        variables,
        (min(row[1] for row in rows), max(row[1] for row in rows)),
        (min(row[2] for row in rows), max(row[3] for row in rows)),
    )


def utc_timestamp(seconds: int) -> str:
    """Format producer epoch seconds as a UTC STAC timestamp.

    Args:
        seconds: Admitted observation or interval time since the Unix epoch.

    Returns:
        RFC3339 timestamp ending in ``Z``.
    """
    return (
        datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace("+00:00", "Z")
    )


def build_temporal_items(
    source_root: Path, candidate: DatasetCandidate
) -> tuple[dict[str, Any], ...]:
    """Build one Item from published ERA5 months without reading weather pixels.

    Args:
        source_root: Source mount; confinement was established during preparation.
        candidate: Prepared descriptor with an unambiguous catalog identity.

    Returns:
        One STAC Item with monthly assets and actual observation-time bounds.
        Its private descriptor asset is removed at public response boundaries.

    Raises:
        ValueError: If source metadata, coverage or monthly grids are unsupported.
        OSError: If a required source is missing or unreadable.
        sqlite3.Error: If the producer catalog cannot be read.
        rasterio.errors.RasterioError: If a coordinate cannot be decoded.
    """
    del source_root
    archive = cast(AdmittedArchive, candidate.metadata)
    description = archive.description
    assets: dict[str, Any] = {
        "eolab:temporal-source": {
            "href": candidate.path.absolute().as_uri(),
            "type": "application/yaml",
            "roles": ["metadata"],
        }
    }
    variables: dict[str, Any] = {}
    label_extents: list[tuple[int, int]] = []
    support_extents: list[tuple[int, int]] = []
    try:
        connection = sqlite3.connect(f"{archive.catalog.as_uri()}?mode=ro", uri=True)
    except sqlite3.Error as error:
        raise ValueError(
            f"Cannot open archive catalog {description.source.catalog}: {error}"
        ) from error
    try:
        connection.execute("PRAGMA query_only=ON")
        months = connection.execute(
            "SELECT m.year, m.month, r.id, r.status FROM months m "
            "LEFT JOIN revisions r ON r.id = m.current_revision_id "
            "ORDER BY m.year, m.month"
        ).fetchall()
        for year, month, revision_id, status in months:
            key = f"{year:04d}-{month:02d}"
            if key in assets:
                raise ValueError(f"Duplicate published month: {key}")
            if status != "published":
                raise ValueError(f"Month {key} has no published revision")
            rows = connection.execute(
                "SELECT variable, valid_time, interval_start, interval_end, step_type "
                "FROM coverage WHERE revision_id = ? ORDER BY variable, valid_time",
                (revision_id,),
            ).fetchall()
            try:
                month_variables, labels, support = describe_month(
                    archive.root, year, month, rows
                )
            except (
                ValueError,
                KeyError,
                TypeError,
                OSError,
                rasterio.errors.RasterioError,
            ) as error:
                raise ValueError(f"Cannot admit month {key}: {error}") from error
            for variable, metadata in month_variables.items():
                if variable in variables and variables[variable] != metadata:
                    raise ValueError(
                        f"Variable metadata differs between months: {variable}"
                    )
                variables[variable] = metadata
            label_extents.append(labels)
            support_extents.append(support)
            assets[key] = {
                "href": f"urn:eolab:temporal:{quote(description.id, safe='')}:{key}",
                "type": "application/vnd.zarr; version=3",
                "roles": ["data"],
                "start_datetime": utc_timestamp(support[0]),
                "end_datetime": utc_timestamp(support[1]),
            }
    finally:
        connection.close()
    if not label_extents:
        raise ValueError("The archive has no published observations")
    return (
        {
            "type": "Feature",
            "stac_version": "1.0.0",
            "stac_extensions": [
                "https://stac-extensions.github.io/datacube/v2.3.0/schema.json"
            ],
            "id": description.id,
            "collection": TEMPORAL_COLLECTION_ID,
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    [[-180, -90], [180, -90], [180, 90], [-180, 90], [-180, -90]]
                ],
            },
            "bbox": [-180, -90, 180, 90],
            "properties": {
                "title": description.title,
                "datetime": None,
                "start_datetime": utc_timestamp(
                    min(extent[0] for extent in support_extents)
                ),
                "end_datetime": utc_timestamp(
                    max(extent[1] for extent in support_extents)
                ),
                "eolab:calendar": "proleptic_gregorian",
                "cube:dimensions": {
                    "time": {
                        "type": "temporal",
                        "extent": [
                            utc_timestamp(min(extent[0] for extent in label_extents)),
                            utc_timestamp(max(extent[1] for extent in label_extents)),
                        ],
                        "step": "PT1H",
                    },
                    "latitude": {
                        "type": "spatial",
                        "axis": "y",
                        "extent": [-90, 90],
                        "step": -0.25,
                        "unit": "degrees_north",
                        "reference_system": 4326,
                    },
                    "longitude": {
                        "type": "spatial",
                        "axis": "x",
                        "extent": [0, 359.75],
                        "step": 0.25,
                        "unit": "degrees_east",
                        "reference_system": 4326,
                    },
                },
                "cube:variables": variables,
            },
            "links": [],
            "assets": assets,
        },
    )
