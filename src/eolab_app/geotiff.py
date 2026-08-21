"""Extract STAC metadata from GeoTIFF files."""

import hashlib
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import rasterio
from rasterio.transform import array_bounds
from rasterio.warp import calculate_default_transform, transform_bounds


GEOTIFF_MEDIA_TYPE = "image/tiff; application=geotiff"
COG_MEDIA_TYPE = (
    "image/tiff; application=geotiff; profile=cloud-optimized"
)
GEOTIFF_MEDIA_TYPES = frozenset({GEOTIFF_MEDIA_TYPE, COG_MEDIA_TYPE})
MOUNTED_GEOTIFF_COLLECTION_ID = "eolab-mounted-geotiffs"
MOUNTED_GEOTIFF_ITEM_ID_PATTERN = r"^geotiff-[0-9a-f]{24}$"
RENDERING_METADATA_KEY = "eolab:rendering"
RENDERING_POLICY = "raster-v2"
DIRECT_RENDERING_MAX_BYTES = 64 * 1024 * 1024
OVERVIEW_RENDERING_MAX_BYTES = 64 * 1024 * 1024
OVERVIEW_RENDERING_MAX_DIMENSION = 8192
RENDERING_MAX_BLOCK_EDGE = 1024
SUPPORTED_RENDERING_DATA_TYPES = frozenset(
    {"uint8", "uint16", "int16", "int32", "float32", "float64"}
)
RASTER_DATA_TYPE_BYTES = {
    "int8": 1,
    "uint8": 1,
    "float16": 2,
    "int16": 2,
    "uint16": 2,
    "complex_int16": 4,
    "float32": 4,
    "int32": 4,
    "uint32": 4,
    "complex64": 8,
    "float64": 8,
    "int64": 8,
    "uint64": 8,
    "complex128": 16,
}
STAC_RASTER_DATA_TYPES = {
    "complex_int16": "cint16",
    # Rasterio combines GDAL CInt32, CFloat16, and CFloat32 under this name.
    "complex64": "other",
    "complex128": "cfloat64",
}
PROJECTION_EXTENSION = (
    "https://stac-extensions.github.io/projection/v1.1.0/schema.json"
)
RASTER_EXTENSION = "https://stac-extensions.github.io/raster/v1.1.0/schema.json"
FILE_EXTENSION = "https://stac-extensions.github.io/file/v2.1.0/schema.json"
FALLBACK_DATETIME_DESCRIPTION = (
    "No observation or acquisition time was found in the GeoTIFF metadata. "
    "The Item datetime uses the source file's filesystem modification time."
)
ACQUISITION_DATETIME_DESCRIPTION = (
    "The Item datetime uses ACQUISITIONDATETIME from the GeoTIFF's GDAL "
    "IMAGERY metadata domain."
)
SUGGESTED_WARP_BOUNDS_DESCRIPTION = (
    "The spatial footprint is a conservative WGS 84 destination envelope "
    "suggested by GDAL because the raster's rectangular outer boundary "
    "could not be transformed."
)
RFC3339_TIMESTAMP = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


def assess_raster_renderability(
    dataset: rasterio.io.DatasetReader,
) -> dict[str, Any]:
    """Assess a raster's eligibility under the raster-v2 policy.

    The assessment reads only dataset structure and overview metadata. It does
    not sample or decode raster pixels.

    Args:
        dataset: Open raster dataset.

    Returns:
        Versioned EOLab rendering metadata for the STAC data Asset.
    """
    data_types = tuple(dataset.dtypes)
    bytes_per_pixel = sum(
        RASTER_DATA_TYPE_BYTES[data_type] for data_type in data_types
    )
    estimated_uncompressed_bytes = (
        dataset.width * dataset.height * bytes_per_pixel
    )
    block_shapes = [list(block_shape) for block_shape in dataset.block_shapes]
    overview_factors = [
        dataset.overviews(band_index) for band_index in dataset.indexes
    ]
    has_overviews = any(overview_factors)
    external_overviews = any(
        str(dataset_file).lower().endswith((".ovr", ".aux", ".rrd"))
        for dataset_file in dataset.files
    )
    if not has_overviews:
        overview_storage = "none"
    elif external_overviews:
        overview_storage = "external"
    else:
        overview_storage = "internal"
    compression = (
        dataset.compression.value
        if dataset.compression is not None
        else None
    )

    bounded_blocks = all(
        max(block_height, block_width) <= RENDERING_MAX_BLOCK_EDGE
        for block_height, block_width in block_shapes
    )

    if dataset.count != 1:
        eligible = False
        reason = (
            "Visualization unavailable: the current raster style supports "
            "one-band rasters."
        )
    elif data_types[0] not in SUPPORTED_RENDERING_DATA_TYPES:
        eligible = False
        reason = (
            "Visualization unavailable: the current rendering path does not "
            f"support {data_types[0]} pixels."
        )
    elif estimated_uncompressed_bytes <= DIRECT_RENDERING_MAX_BYTES:
        eligible = True
        reason = None
    elif not bounded_blocks:
        eligible = False
        reason = (
            "Visualization unavailable: this raster needs smaller internal "
            "blocks."
        )
    elif overview_storage != "internal":
        eligible = False
        reason = (
            "Visualization unavailable: this raster needs an internal "
            "overview pyramid."
        )
    else:
        factors = overview_factors[0]
        complete_overview_pyramid = (
            bool(factors)
            and factors[0] == 2
            and all(
                previous_factor < current_factor <= previous_factor * 2
                for previous_factor, current_factor in zip(
                    factors,
                    factors[1:],
                )
            )
        )
        if not complete_overview_pyramid:
            eligible = False
            reason = (
                "Visualization unavailable: this raster needs an internal "
                "overview pyramid beginning at 2x without skipped levels."
            )
        else:
            coarsest_factor = factors[-1]
            coarsest_width = math.ceil(dataset.width / coarsest_factor)
            coarsest_height = math.ceil(dataset.height / coarsest_factor)
            coarsest_bytes = (
                coarsest_width * coarsest_height * bytes_per_pixel
            )
            if (
                max(coarsest_width, coarsest_height)
                > OVERVIEW_RENDERING_MAX_DIMENSION
            ):
                eligible = False
                reason = (
                    "Visualization unavailable: the coarsest internal "
                    "overview is wider or taller than "
                    f"{OVERVIEW_RENDERING_MAX_DIMENSION} pixels."
                )
            elif coarsest_bytes > OVERVIEW_RENDERING_MAX_BYTES:
                eligible = False
                reason = (
                    "Visualization unavailable: the coarsest internal "
                    "overview exceeds "
                    f"{OVERVIEW_RENDERING_MAX_BYTES // (1024 * 1024)} MiB "
                    "of decoded pixel data."
                )
            else:
                eligible = True
                reason = None

    rendering_metadata = {
        "policy": RENDERING_POLICY,
        "eligible": eligible,
        "bounded_blocks": bounded_blocks,
        "block_shapes": block_shapes,
        "overview_factors": overview_factors,
        "overview_storage": overview_storage,
        "compression": compression,
        "estimated_uncompressed_bytes": estimated_uncompressed_bytes,
    }
    if reason is not None:
        rendering_metadata["reason"] = reason
    return rendering_metadata


def inspect_geotiff_renderability(geotiff_path: Path) -> dict[str, Any]:
    """Open one GeoTIFF at the synchronous metadata-inspection boundary."""
    with rasterio.open(geotiff_path) as dataset:
        return assess_raster_renderability(dataset)


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
    file_status = geotiff_path.stat()
    filesystem_modified_at = datetime.fromtimestamp(
        file_status.st_mtime,
        tz=timezone.utc,
    )

    with rasterio.open(geotiff_path) as dataset:
        if dataset.crs is None:
            raise ValueError("GeoTIFF has no coordinate reference system")
        if dataset.width < 1 or dataset.height < 1:
            raise ValueError("GeoTIFF has invalid raster dimensions")

        bbox, used_suggested_warp_bounds = _derive_wgs84_bbox(dataset)

        west, south, east, north = bbox
        footprint = {
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
        }

        acquisition_datetime = dataset.tags(ns="IMAGERY").get(
            "ACQUISITIONDATETIME"
        )
        if acquisition_datetime is None:
            item_datetime = filesystem_modified_at
            description = FALLBACK_DATETIME_DESCRIPTION
        else:
            item_datetime = _parse_acquisition_datetime(acquisition_datetime)
            description = ACQUISITION_DATETIME_DESCRIPTION
        if used_suggested_warp_bounds:
            description = f"{description} {SUGGESTED_WARP_BOUNDS_DESCRIPTION}"

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
            band: dict[str, Any] = {
                "data_type": STAC_RASTER_DATA_TYPES.get(data_type, data_type)
            }
            if nodata_value is not None:
                band["nodata"] = _serialize_nodata(nodata_value)
            raster_bands.append(band)
        rendering_metadata = assess_raster_renderability(dataset)
        media_type = (
            COG_MEDIA_TYPE
            if dataset.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") == "COG"
            else GEOTIFF_MEDIA_TYPE
        )

    item_identifier = hashlib.sha256(relative_path_text.encode("utf-8")).hexdigest()
    return {
        "type": "Feature",
        "stac_version": "1.0.0",
        "stac_extensions": [
            PROJECTION_EXTENSION,
            RASTER_EXTENSION,
            FILE_EXTENSION,
        ],
        "id": f"geotiff-{item_identifier[:24]}",
        "collection": MOUNTED_GEOTIFF_COLLECTION_ID,
        "geometry": footprint,
        "bbox": bbox,
        "properties": properties,
        "links": [],
        "assets": {
            "data": {
                "href": geotiff_path.resolve().as_uri(),
                "type": media_type,
                "title": relative_path_text,
                "roles": ["data"],
                "updated": _format_datetime(filesystem_modified_at),
                "file:size": file_status.st_size,
                "raster:bands": raster_bands,
                RENDERING_METADATA_KEY: rendering_metadata,
            }
        },
    }


def _derive_wgs84_bbox(
    dataset: rasterio.io.DatasetReader,
) -> tuple[list[float], bool]:
    """Derive a WGS 84 bounding box without reading raster pixels.

    Args:
        dataset: Open raster dataset with a coordinate reference system.

    Returns:
        The WGS 84 bounding box and whether GDAL's suggested warp output was
        required.

    Raises:
        ValueError: If GDAL cannot produce a valid WGS 84 destination extent.
    """
    bbox = list(
        transform_bounds(
            dataset.crs,
            "EPSG:4326",
            *dataset.bounds,
        )
    )
    used_suggested_warp_bounds = False
    if not all(math.isfinite(coordinate) for coordinate in bbox):
        destination_transform, destination_width, destination_height = (
            calculate_default_transform(
                dataset.crs,
                "EPSG:4326",
                dataset.width,
                dataset.height,
                *dataset.bounds,
            )
        )

        if (
            destination_width < 1
            or destination_height < 1
            or not all(
                math.isfinite(coefficient)
                for coefficient in destination_transform
            )
        ):
            raise ValueError("GeoTIFF bounds could not be transformed to WGS 84")

        bbox = list(
            array_bounds(
                destination_height,
                destination_width,
                destination_transform,
            )
        )
        used_suggested_warp_bounds = True

    west, south, east, north = bbox
    normalized_bbox = [
        max(west, -180),
        max(south, -90),
        min(east, 180),
        min(north, 90),
    ]
    if not (
        all(math.isfinite(coordinate) for coordinate in normalized_bbox)
        and normalized_bbox[0] < normalized_bbox[2]
        and normalized_bbox[1] < normalized_bbox[3]
    ):
        raise ValueError("GeoTIFF bounds could not be transformed to WGS 84")

    return normalized_bbox, used_suggested_warp_bounds


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
