"""Supply owned immutable run files to the ordinary vector services."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
import math
from pathlib import Path
import re

import fiona
from rasterio.warp import transform_bounds
from rasterio.errors import RasterioError

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    ProcessResultWriter,
    run_bounded_process,
)
from eolab_app.source_files import LeasedSourceFiles, SourceFileError
from eolab_app.vector.models import ResolvedVectorSource, VectorLayer
from eolab_app.vector_field_values import (
    FieldValueInventory,
    read_field_value_inventory,
)


def parse_artifact_vector_name(layer_name: str) -> tuple[str, str] | None:
    """Read run and file IDs from an ordinary generated-vector publication name.

    Args:
        layer_name: Qualified WMS name or unqualified GeoServer datastore name.

    Returns:
        Opaque run and artifact IDs, or None for another publication namespace.
    """
    match = re.fullmatch(
        r"(?:eolab:)?vector_result_([a-f0-9]{32})_([a-f0-9]{32})", layer_name
    )
    return (match[1], match[2]) if match else None


@dataclass(frozen=True)
class ArtifactVectorLayer:
    """Original vector metadata and prepared text choices for one immutable result.

    Attributes:
        layer: Authorized file and metadata used by ordinary vector services.
        field_values: Prepared string suggestions, independent of map publication.
    """

    layer: VectorLayer
    field_values: FieldValueInventory


def read_artifact_vector_metadata(writer: ProcessResultWriter, path: Path) -> None:
    """Inspect a single-layer result GeoPackage and prepare ordinary field choices.

    Args:
        writer: Native-process channel receiving metadata or a readable error.
        path: Confined immutable file held by the source owner's read lease.
    """
    try:
        names = fiona.listlayers(path)
        if len(names) != 1:
            raise ValueError("Choose a result containing one vector layer.")
        layer_name = names[0]
        with fiona.open(path, layer=layer_name, enabled_drivers=["GPKG"]) as source:
            geometry = source.schema["geometry"]
            kinds = {
                "Point": "point",
                "MultiPoint": "point",
                "LineString": "line",
                "MultiLineString": "line",
                "Polygon": "polygon",
                "MultiPolygon": "polygon",
            }
            kind = kinds.get(geometry.removeprefix("3D "))
            if kind is None or not source.crs:
                raise ValueError(
                    "This result has no supported map geometry or projection."
                )
            fields = dict(source.schema["properties"])
            count = len(source)
            bounds = transform_bounds(source.crs_wkt, "EPSG:4326", *source.bounds)
            if not count or not all(math.isfinite(value) for value in bounds):
                raise ValueError("This result contains no features with a map extent.")
        inventory = read_field_value_inventory(str(path), layer_name, fields)
        writer.put((layer_name, fields, count, bounds, kind, inventory))
    except (OSError, ValueError, RuntimeError, RasterioError, fiona.errors.FionaError):
        writer.put("This vector result could not be opened for display.")


class ArtifactVectorSourceResolver:
    """Authorize run files and supply their metadata to existing vector services."""

    def __init__(self, files: LeasedSourceFiles) -> None:
        """Use the source owner's existing authorization and renewable read leases.

        Args:
            files: Neutral access port injected by application composition.
        """
        self.files = files
        self._metadata: dict[tuple[str, str], ArtifactVectorLayer] = {}
        self._read_lock = asyncio.Lock()

    @asynccontextmanager
    async def open_layer(
        self, owner: str, job_id: str, artifact_id: str
    ) -> AsyncIterator[ArtifactVectorLayer]:
        """Keep an owned vector file available throughout a complete consumer read.

        Cached metadata bypasses unrelated cold scans after source authorization.
        Cache misses remain serialized and recheck the cache before native work.

        Args:
            owner: Server-derived browser identity.
            job_id: Opaque run ID.
            artifact_id: Opaque immutable file ID within that run.

        Yields:
            Original source metadata and prepared field choices. Native callers
            must stop before leaving this scope; successful delivery rechecks access.

        Raises:
            SourceFileError: If ownership, expiry, format, or native inspection fails.
            asyncio.CancelledError: After native work stops and the lease is released.
        """
        async with self.files.open(owner, job_id, artifact_id) as source:
            if source.media_type != "application/geopackage+sqlite3":
                raise SourceFileError(
                    "This result is not a supported vector file.", 422
                )
            key = (job_id, artifact_id)
            metadata = self._metadata.get(key)
            if metadata is None:
                async with self._read_lock:
                    metadata = self._metadata.get(key)
                    if metadata is None:
                        try:
                            result = await run_bounded_process(
                                read_artifact_vector_metadata, (source.path,), 60
                            )
                        except ProcessDeadlineError as error:
                            raise SourceFileError(
                                "This vector result's map metadata took too long to read.",
                                422,
                            ) from error
                        if isinstance(result, str):
                            raise SourceFileError(result, 422)
                        name, fields, count, bounds, kind, inventory = result
                        metadata = ArtifactVectorLayer(
                            VectorLayer(
                                resource_name=f"vector_result_{job_id}_{artifact_id}",
                                source=ResolvedVectorSource(
                                    source_kind="mounted",
                                    source_format="geopackage",
                                    source_path=source.path,
                                    asset_key="data",
                                    layer_name=name,
                                ),
                                fields=fields,
                                feature_count=count,
                                bbox=bounds,
                                geometry_kind=kind,
                            ),
                            inventory,
                        )
                        self._metadata[key] = metadata
            yield metadata

    def forget_metadata(self, job_id: str, artifact_id: str) -> None:
        """Release cached metadata after its source lifetime ends.

        Args:
            job_id: Expired or deleted run ID.
            artifact_id: File ID whose publication is being removed.
        """
        self._metadata.pop((job_id, artifact_id), None)

    def list_cached_references(self) -> tuple[tuple[str, str], ...]:
        """Return cached identities for expiry cleanup, including unpublished results.

        Returns:
            Immutable run/file ID pairs without file paths or ownership credentials.
        """
        return tuple(self._metadata)
