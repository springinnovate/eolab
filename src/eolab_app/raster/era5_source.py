"""Resolve admitted ERA5 selections using published producer coverage."""

import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from affine import Affine
from rasterio.crs import CRS
import yaml

from eolab_app.raster.errors import RasterAssetError, RasterConflictError
from eolab_app.raster.source_models import (
    TemporalIntervalSelection,
    TemporalRasterSelection,
)
from eolab_app.raster.temporal import TemporalObservation


def get_era5_observations(
    item: dict[str, Any],
    selection: TemporalRasterSelection | TemporalIntervalSelection,
    mount: Path,
) -> tuple[TemporalObservation, ...]:
    """Return selected ERA5 observations, their time support and confined arrays.

    Catalog admission establishes this producer's grid, variable metadata and
    published coverage. Read its actual per-variable coverage to distinguish
    missing observations from present observations containing NaN cells. The
    operator keeps the archive unchanged between refresh and calculation.

    Args:
        item: Authoritative Catalog Item for the requested dataset.
        selection: Validated variable and observation label or requested period.
        mount: Source mount enclosing the admitted descriptor and archive.

    Returns:
        Observations in increasing label order. Intervals may have gaps or be
        empty; an exact observation request returns one observation.

    Raises:
        RasterAssetError: If the variable is unknown or a source escapes its mount.
        RasterConflictError: If an observation is absent or metadata cannot be read.
    """
    variables = item["properties"]["cube:variables"]
    if selection.variable not in variables:
        raise RasterAssetError("This dataset does not contain the selected variable.")
    try:
        mount = mount.resolve()
        uri = urlsplit(item["assets"]["eolab:temporal-source"]["href"])
        mount_uri = urlsplit(mount.as_uri())
        prefix = unquote(mount_uri.path).rstrip("/") + "/"
        uri_path = unquote(uri.path)
        if (
            uri.scheme != "file"
            or uri.netloc != mount_uri.netloc
            or uri.query
            or uri.fragment
            or not uri_path.startswith(prefix)
        ):
            raise RasterAssetError("The temporal dataset is outside the source mount.")
        descriptor = (mount / uri_path[len(prefix) :]).resolve()
        if not descriptor.is_relative_to(mount):
            raise RasterAssetError("The temporal dataset is outside the source mount.")
        description = yaml.safe_load(descriptor.read_text(encoding="utf-8"))
        root = descriptor.parent
        catalog = (root / description["source"]["catalog"]).resolve()
        if not catalog.is_relative_to(root):
            raise RasterAssetError("The temporal catalog is outside its archive.")
        with closing(
            sqlite3.connect(f"{catalog.as_uri()}?mode=ro", uri=True)
        ) as connection:
            if isinstance(selection, TemporalRasterSelection):
                condition = "c.valid_time = ?"
                parameters = (selection.time.timestamp(),)
            elif variables[selection.variable]["eolab:time_support"] == "instantaneous":
                condition = "c.valid_time >= ? AND c.valid_time < ?"
                parameters = (
                    selection.start_time.timestamp(),
                    selection.end_time.timestamp(),
                )
            else:
                condition = "c.interval_start < ? AND c.interval_end > ?"
                parameters = (
                    selection.end_time.timestamp(),
                    selection.start_time.timestamp(),
                )
            rows = connection.execute(
                "SELECT m.year, m.month, c.valid_time, c.reference_time, "
                "c.interval_start, c.interval_end, c.revision_id "
                "FROM months m JOIN coverage c ON c.revision_id = m.current_revision_id "
                f"WHERE c.variable = ? AND {condition} ORDER BY c.valid_time",
                (selection.variable, *parameters),
            ).fetchall()
            indices: dict[str, dict[int, int]] = {}
            observations: list[TemporalObservation] = []
            for year, month, time, reference, start, end, revision in rows:
                if revision not in indices:
                    labels = connection.execute(
                        "SELECT DISTINCT valid_time FROM coverage WHERE revision_id = ? ORDER BY valid_time",
                        (revision,),
                    ).fetchall()
                    indices[revision] = {
                        label: index for index, (label,) in enumerate(labels)
                    }
                array_path = (
                    root / f"{year:04d}/{month:02d}/era5.zarr" / selection.variable
                ).resolve()
                if not array_path.is_relative_to(root):
                    raise RasterAssetError("The selected array is outside its archive.")
                observations.append(
                    TemporalObservation(
                        root=root,
                        array_path=array_path,
                        time_index=indices[revision][time],
                        time=datetime.fromtimestamp(time, timezone.utc),
                        reference_time=datetime.fromtimestamp(reference, timezone.utc),
                        interval_start=datetime.fromtimestamp(start, timezone.utc),
                        interval_end=datetime.fromtimestamp(end, timezone.utc),
                        transform=Affine(0.25, 0, -180.125, 0, -0.25, 90.125),
                        crs=CRS.from_epsg(4326),
                        nodata=float("nan"),
                        column_offset=720,
                        cyclic_x=True,
                    )
                )
    except (OSError, sqlite3.Error, yaml.YAMLError, ValueError, OverflowError) as error:
        raise RasterConflictError(
            "The temporal dataset metadata could not be read."
        ) from error
    if isinstance(selection, TemporalRasterSelection) and not observations:
        raise RasterConflictError(
            "No observation is available for this variable at the selected time."
        )
    return tuple(observations)
