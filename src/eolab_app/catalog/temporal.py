"""Admit a cataloged GeoTIFF stack as one searchable temporal dataset."""

import json
import math
import sqlite3
from contextlib import closing
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, cast

import numpy
import yaml
from affine import Affine
from pydantic import BaseModel, ConfigDict, Field
from rasterio.crs import CRS
from rasterio.transform import array_bounds
from rasterio.warp import transform_bounds

from eolab_app.catalog.collections import TEMPORAL_COLLECTION_ID
from eolab_app.catalog.models import DatasetCandidate


class ArchiveSource(BaseModel):
    """Identify a GeoTIFF stack and its relative SQLite observation catalog."""

    model_config = ConfigDict(extra="forbid", strict=True)

    format: Literal["temporal_cog"]
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
        description: Administrator-supplied dataset identity and title.
        root: Resolved directory containing the descriptor and GeoTIFFs.
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


def build_temporal_items(
    source_root: Path, candidate: DatasetCandidate
) -> tuple[dict[str, Any], ...]:
    """Build one Item from published observation metadata without opening TIFFs.

    Admission checks the external catalog's common north-up grid,
    variable metadata and observation intervals. The producer owns TIFF
    publication integrity; native file errors are reported when an observation
    is used. Partial coverage is valid and no missing observations are invented.
    Every scan reads the current published rows. Consecutive identical grid and
    variable descriptions reuse one parsed result each within this call only;
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
        rows = connection.execute(
            "SELECT variable, name, units, band, valid_time, reference_time, "
            "interval_start, interval_end, temporal_type, dtype, nodata, crs, "
            "transform, height, width FROM observations ORDER BY variable, valid_time"
        )
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
    west, south, east, north = array_bounds(height, width, transform)
    if crs.is_geographic:
        bbox = [max(-180, west), max(-90, south), min(180, east), min(90, north)]
        if math.isclose(width * transform.a, 360):
            bbox[0], bbox[2] = -180, 180
    else:
        bbox = list(transform_bounds(crs, "EPSG:4326", west, south, east, north))
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
