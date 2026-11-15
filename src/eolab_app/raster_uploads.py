"""Admit private binary GeoTIFF masks through the shared upload lifecycle."""

from collections.abc import AsyncIterable
from datetime import datetime, timezone
from pathlib import Path
import sys
from typing import Literal
from uuid import uuid4

import numpy
from pydantic import BaseModel
import rasterio

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    ProcessResultWriter,
    run_bounded_process,
)
from eolab_app.raster.geographic_bounds import (
    normalize_wgs84_bounds,
    transform_bounds_to_wgs84,
)
from eolab_app.raster.source_contract import (
    read_native_raster_block,
    require_bounded_source_structure,
    require_raster_analysis_georeferencing,
    require_signed_raster_dependencies,
)
from eolab_app.upload_storage import (
    UploadError,
    UploadRecord,
    UploadStorage,
    finish_upload_disk_operation,
)


class RasterMaskMetadata(BaseModel):
    """Describe the grid and valid reference cells of an admitted binary mask."""

    width: int
    height: int
    crs_wkt: str
    bounds: tuple[float, float, float, float]
    reference_cells: int


class RasterUpload(UploadRecord, RasterMaskMetadata):
    """Identify a private mask and the unchanged GeoTIFF received at admission."""

    kind: Literal["raster"] = "raster"
    sha256: str


def inspect_raster_mask(
    result: ProcessResultWriter,
    path: Path,
    maximum_decoded_bytes: int,
    maximum_block_bytes: int,
) -> None:
    """Validate a self-contained binary mask and return its original grid metadata.

    Admission reads one native block at a time after checking decoded source and
    block sizes. Valid values must be zero or one; NoData and embedded validity
    exclusions are ignored. The original file is never rewritten. Linux limits
    the inspector's address space to 2 GiB independently of model execution.

    Args:
        result: Supervisor pipe receiving metadata or a path-free error string.
        path: Exact server-created staging file.
        maximum_decoded_bytes: Maximum band-one bytes before compression.
        maximum_block_bytes: Maximum native data and validity block allocation.
    """
    try:
        if sys.platform == "linux":
            import resource

            resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
        with rasterio.Env(GDAL_PAM_ENABLED="NO", GDAL_CACHEMAX=32 * 1024**2):
            with rasterio.open(path, driver="GTiff") as dataset:
                if dataset.count != 1 or dataset.dtypes[0] != "uint8":
                    raise ValueError("Upload a single-band Byte GeoTIFF mask.")
                try:
                    require_signed_raster_dependencies(dataset, path)
                except ValueError as error:
                    raise ValueError(
                        "The GeoTIFF must contain its own georeferencing and mask. "
                        "Export a self-contained GeoTIFF and upload it again."
                    ) from error
                try:
                    require_raster_analysis_georeferencing(dataset)
                    bounds = normalize_wgs84_bounds(
                        transform_bounds_to_wgs84(dataset.crs, tuple(dataset.bounds))
                    )
                except ValueError as error:
                    raise ValueError(
                        "The mask needs a valid coordinate reference system and "
                        "location. Set them in your GIS software and upload it again."
                    ) from error
                try:
                    require_bounded_source_structure(
                        dataset, maximum_block_bytes=maximum_block_bytes
                    )
                except ValueError as error:
                    raise ValueError(
                        "This GeoTIFF's data blocks or mask layout cannot be read "
                        "within the upload limit. Save a tiled, single-band Byte "
                        "GeoTIFF with smaller blocks and upload it again."
                    ) from error
                if dataset.width * dataset.height > maximum_decoded_bytes:
                    raise ValueError(
                        "The uncompressed mask exceeds the upload limit. "
                        "Crop it to the area you need before uploading."
                    )
                reference_cells = 0
                for _, window in dataset.block_windows(1):
                    values = read_native_raster_block(dataset, window)
                    valid = values.compressed()
                    if numpy.any((valid != 0) & (valid != 1)):
                        raise ValueError(
                            "Reference masks must use 1 for reference sites and 0 "
                            "for other cells. NoData is ignored."
                        )
                    reference_cells += int(numpy.count_nonzero(valid == 1))
                if reference_cells == 0:
                    raise ValueError(
                        "The mask contains no valid reference cells with value 1."
                    )
                metadata = RasterMaskMetadata(
                    width=dataset.width,
                    height=dataset.height,
                    crs_wkt=dataset.crs.to_wkt(),
                    bounds=bounds,
                    reference_cells=reference_cells,
                )
    except ValueError as error:
        result.put(str(error))
    except (rasterio.errors.RasterioError, RuntimeError, OSError, MemoryError):
        result.put("The file could not be read as a self-contained GeoTIFF mask.")
    else:
        result.put(metadata)


class RasterUploadStore:
    """Inspect raster masks before publishing them in shared private storage."""

    def __init__(
        self,
        storage: UploadStorage,
        maximum_decoded_bytes: int = 256 * 1024**2,
        maximum_block_bytes: int = 16 * 1024**2,
    ) -> None:
        """Connect raster admission to the application's common upload budget.

        Args:
            storage: Sole upload writer shared with polygon admission.
            maximum_decoded_bytes: Maximum uncompressed Byte mask size.
            maximum_block_bytes: Maximum decoded native block allocation.
        """
        self.storage = storage
        self.maximum_decoded_bytes = maximum_decoded_bytes
        self.maximum_block_bytes = maximum_block_bytes

    async def create(
        self, owner: str, name: str, chunks: AsyncIterable[bytes]
    ) -> RasterUpload:
        """Stream, validate and publish one immutable browser-owned reference mask.

        Args:
            owner: Hash supplied by the validated browser ownership boundary.
            name: Display name validated by the HTTP boundary, never a path.
            chunks: Incoming GeoTIFF body without a multipart envelope.

        Returns:
            Admitted mask metadata and the opaque identity for ordinary readers.

        Raises:
            UploadError: If admission, validation or storage rejects the file.
            asyncio.CancelledError: After inspection and staging cleanup stop.
        """
        try:
            async with self.storage.stage(owner, "raster", chunks) as pending:
                metadata = await run_bounded_process(
                    inspect_raster_mask,
                    (
                        pending.source_path,
                        self.maximum_decoded_bytes,
                        self.maximum_block_bytes,
                    ),
                    60,
                )
                if isinstance(metadata, str):
                    raise UploadError(422, metadata)
                upload = RasterUpload(
                    **metadata.model_dump(),
                    id=uuid4(),
                    name=name,
                    size_bytes=pending.size_bytes,
                    created_at=datetime.now(timezone.utc),
                    sha256=pending.sha256,
                )
                await finish_upload_disk_operation(
                    lambda: self.storage.publish(pending, upload)
                )
                return upload
        except ProcessDeadlineError as error:
            raise UploadError(
                422,
                "The mask could not be inspected within 60 seconds. "
                "Crop it to the area you need before uploading.",
            ) from error
        except OSError as error:
            raise UploadError(
                503, "Upload storage is unavailable. Try again shortly."
            ) from error
