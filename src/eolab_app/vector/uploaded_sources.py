"""Supply browser-owned polygon files and display metadata to vector rendering."""

import asyncio
import math
from pathlib import Path
from uuid import UUID

import fiona
from rasterio.errors import RasterioError
from rasterio.warp import transform_bounds

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    ProcessResultWriter,
    run_bounded_process,
)
from eolab_app.vector.models import VectorLayer
from eolab_app.vector.sources import resolve_uploaded_vector
from eolab_app.vector_uploads import VectorUploadError, VectorUploadStore


def read_upload_bounds(
    result: ProcessResultWriter, path: Path, layer_name: str, crs_wkt: str
) -> None:
    """Read the feature count and map extent of an admitted GeoPackage layer.

    Args:
        result: Pipe receiving (feature count, WGS84 bounds) or a safe error.
        path: Authorized original GeoPackage file.
        layer_name: Native layer recorded during upload admission.
        crs_wkt: Coordinate reference system recorded during admission.
    """
    try:
        with fiona.open(path, layer=layer_name, enabled_drivers=["GPKG"]) as dataset:
            count = len(dataset)
            bounds = transform_bounds(crs_wkt, "EPSG:4326", *dataset.bounds)
            if not all(math.isfinite(value) for value in bounds):
                raise ValueError("The layer has no finite map extent")
    except (fiona.errors.FionaError, RasterioError, ValueError, OSError):
        result.put("The uploaded layer's map extent could not be read.")
    else:
        result.put((count, bounds))


class UploadedVectorSourceResolver:
    """Locate an owned upload and read the metadata needed by vector rendering."""

    def __init__(self, store: VectorUploadStore) -> None:
        """Use the existing upload store and serialize native metadata reads.

        Args:
            store: Storage authorizing access to each browser's original files.
        """
        self._store = store
        self._read_lock = asyncio.Lock()

    async def prepare_publication(self, layer: VectorLayer) -> None:
        """Make an authorized upload readable through GeoServer's read-only mount.

        Args:
            layer: Upload previously authorized by get_layer.

        Raises:
            VectorUploadError: If published-file permissions cannot be set.
        """
        await asyncio.to_thread(
            self._store.prepare_rendering_source, layer.source.source_path
        )

    async def get_layer(self, owner: str, identifier: UUID) -> VectorLayer:
        """Return an owned upload's original source, fields, count and map extent.

        Args:
            owner: Browser identity established by the HTTP boundary.
            identifier: Opaque upload ID validated by the HTTP boundary.

        Returns:
            Metadata for the ordinary vector publication, styling and filtering
            services. No catalog Item or filtered file is created.

        Raises:
            VectorUploadError: If ownership, file access or native metadata reading
                fails. Each native read has a 60-second deadline and stops on
                cancellation before the next reader starts.
        """
        metadata, source = await asyncio.to_thread(
            resolve_uploaded_vector, self._store, owner, identifier
        )
        try:
            async with self._read_lock:
                extent = await run_bounded_process(
                    read_upload_bounds,
                    (source.source_path, source.layer_name, metadata.crs_wkt),
                    60,
                )
        except ProcessDeadlineError as error:
            raise VectorUploadError(
                422,
                "The uploaded layer's map extent could not be read within 60 seconds.",
            ) from error
        if isinstance(extent, str):
            raise VectorUploadError(422, extent)
        count, bounds = extent
        return VectorLayer(
            resource_name=f"upload_{identifier.hex}",
            source=source,
            fields=metadata.fields,
            feature_count=count,
            bbox=bounds,
            geometry_kind="polygon",
        )
