"""Extract STAC metadata from GeoTIFF files."""

import hashlib
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import rasterio
from rasterio.warp import transform_geom


GEOTIFF_MEDIA_TYPE = "image/tiff; application=geotiff"
PROJECTION_EXTENSION = (
    "https://stac-extensions.github.io/projection/v1.1.0/schema.json"
)
RASTER_EXTENSION = "https://stac-extensions.github.io/raster/v1.1.0/schema.json"
FALLBACK_DATETIME_DESCRIPTION = (
    "No observation or acquisition time was found in the GeoTIFF metadata. "
    "The Item datetime uses the source file's filesystem modification time."
)
ACQUISITION_DATETIME_DESCRIPTION = (
    "The Item datetime uses ACQUISITIONDATETIME from the GeoTIFF's GDAL "
    "IMAGERY metadata domain."
)
RFC3339_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


def build_stac_item(source_root: Path, geotiff_path: Path) -> dict[str, Any]:
    """Build a STAC Item from one GeoTIFF.

    Args:
        source_root: Root directory mounted for scanning.
        geotiff_path: GeoTIFF below the mounted root.

    Returns:
        A STAC Item containing the raster footprint and spatial metadata.

    Raises:
        ValueError: If the path escapes the source root, raster spatial metadata
            is incomplete, or an embedded acquisition time is malformed.
        rasterio.errors.RasterioError: If GDAL cannot read the file.
    """
    relative_path = geotiff_path.relative_to(source_root)
    relative_path_text = relative_path.as_posix()
    filesystem_modified_at = datetime.fromtimestamp(
        geotiff_path.stat().st_mtime,
        tz=timezone.utc,
    )

    with rasterio.open(geotiff_path) as dataset:
        if dataset.crs is None:
            raise ValueError("GeoTIFF has no coordinate reference system")
        if dataset.width < 1 or dataset.height < 1:
            raise ValueError("GeoTIFF has invalid raster dimensions")

        source_footprint = {
            "type": "Polygon",
            "coordinates": [
                [
                    dataset.transform * (0, 0),
                    dataset.transform * (dataset.width, 0),
                    dataset.transform * (dataset.width, dataset.height),
                    dataset.transform * (0, dataset.height),
                    dataset.transform * (0, 0),
                ]
            ],
        }
        footprint = transform_geom(dataset.crs, "EPSG:4326", source_footprint)
        coordinates = footprint["coordinates"][0]
        if not coordinates or not all(
            math.isfinite(coordinate)
            for position in coordinates
            for coordinate in position[:2]
        ):
            raise ValueError("GeoTIFF footprint could not be transformed to WGS 84")

        longitudes = [position[0] for position in coordinates]
        latitudes = [position[1] for position in coordinates]
        bbox = [
            min(longitudes),
            min(latitudes),
            max(longitudes),
            max(latitudes),
        ]

        acquisition_datetime = dataset.tags(ns="IMAGERY").get(
            "ACQUISITIONDATETIME"
        )
        if acquisition_datetime is None:
            item_datetime = filesystem_modified_at
            description = FALLBACK_DATETIME_DESCRIPTION
        else:
            item_datetime = _parse_acquisition_datetime(acquisition_datetime)
            description = ACQUISITION_DATETIME_DESCRIPTION

        properties: dict[str, Any] = {
            "datetime": _format_datetime(item_datetime),
            "title": relative_path_text,
            "description": description,
            "proj:shape": [dataset.height, dataset.width],
            "proj:transform": list(dataset.transform)[:6],
        }
        if epsg_code := dataset.crs.to_epsg():
            properties["proj:epsg"] = epsg_code
        else:
            properties["proj:wkt2"] = dataset.crs.to_wkt()

        raster_bands = []
        for data_type, nodata_value in zip(
            dataset.dtypes,
            dataset.nodatavals,
            strict=True,
        ):
            band: dict[str, Any] = {"data_type": data_type}
            if nodata_value is not None:
                band["nodata"] = _serialize_nodata(nodata_value)
            raster_bands.append(band)

    item_identifier = hashlib.sha256(relative_path_text.encode("utf-8")).hexdigest()
    return {
        "type": "Feature",
        "stac_version": "1.0.0",
        "stac_extensions": [PROJECTION_EXTENSION, RASTER_EXTENSION],
        "id": f"geotiff-{item_identifier[:24]}",
        "collection": "eolab-mounted-geotiffs",
        "geometry": footprint,
        "bbox": bbox,
        "properties": properties,
        "links": [],
        "assets": {
            "data": {
                "href": geotiff_path.resolve().as_uri(),
                "type": GEOTIFF_MEDIA_TYPE,
                "title": relative_path_text,
                "roles": ["data"],
                "updated": _format_datetime(filesystem_modified_at),
                "raster:bands": raster_bands,
            }
        },
    }


def _parse_acquisition_datetime(value: str) -> datetime:
    """Parse an unambiguous acquisition timestamp.

    Args:
        value: RFC 3339 timestamp read from GDAL metadata.

    Returns:
        The timestamp normalized to UTC.

    Raises:
        ValueError: If the timestamp is malformed or has no UTC offset.
    """
    if RFC3339_TIMESTAMP.fullmatch(value) is None:
        raise ValueError(
            f"ACQUISITIONDATETIME is not a valid RFC 3339 timestamp: {value}"
        )
    normalized_value = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        acquisition_datetime = datetime.fromisoformat(normalized_value)
    except ValueError as error:
        raise ValueError(
            f"ACQUISITIONDATETIME is not a valid RFC 3339 timestamp: {value}"
        ) from error
    if acquisition_datetime.tzinfo is None:
        raise ValueError(
            "ACQUISITIONDATETIME must include a UTC offset: " f"{value}"
        )
    return acquisition_datetime.astimezone(timezone.utc)


def _format_datetime(value: datetime) -> str:
    """Format a UTC timestamp for STAC."""
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _serialize_nodata(value: float) -> float | str:
    """Serialize a GDAL nodata value using STAC Raster extension values."""
    if math.isnan(value):
        return "nan"
    if math.isinf(value):
        return "inf" if value > 0 else "-inf"
    return value
