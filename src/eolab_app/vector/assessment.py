"""Authoritative catalog vector visualization assessment workflows."""

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

import fiona
from rasterio.errors import RasterioError

from eolab_app.catalog.filegeodatabase import (
    build_stac_items as build_file_geodatabase_items,
)
from eolab_app.catalog.geojson import build_stac_item as build_geojson_item
from eolab_app.catalog.geopackage import build_stac_items as build_geopackage_items
from eolab_app.catalog.shapefile import build_stac_item as build_shapefile_item
from eolab_app.catalog.zipped_shapefile import (
    build_stac_items as build_zipped_shapefile_items,
)
from eolab_app.catalog.vector import MOUNTED_VECTOR_COLLECTION_ID
from eolab_app.raster.errors import (
    RasterAssetError,
    RasterConflictError,
)
from eolab_app.vector.models import (
    CatalogVectorRequest,
    ResolvedVectorSource,
    VECTOR_READER_CONTRACT,
    VECTOR_RENDERING_METADATA_KEY,
    VECTOR_RENDERING_POLICY,
    VectorGeometryKind,
    VectorReaderAssessment,
    VectorSourceSignature,
)
from eolab_app.vector.ports import VectorCatalog, VectorReaderAssessor
from eolab_app.vector.sources import MountedVectorResolver, vector_source_signature


_UNSUPPORTED_FORMAT_REASONS = {
    "geojson": (
        "geojson_publication_unsupported",
        "Visualization unavailable: the production GeoServer image has no "
        "bounded mounted-GeoJSON datastore adapter.",
    ),
    "zipped-shapefile": (
        "zipped_shapefile_publication_unsupported",
        "Visualization unavailable: ZIP-contained Shapefiles require a "
        "validated extraction or archive datastore adapter that is not "
        "installed in the production GeoServer image.",
    ),
    "file-geodatabase": (
        "file_geodatabase_publication_unsupported",
        "Visualization unavailable: the production GeoServer image has no "
        "OpenFileGDB datastore for mounted File Geodatabase layers.",
    ),
}
_READER_REASON_TEXT = {
    "geoserver_datastore_unavailable": (
        "Visualization unavailable: the required GeoServer datastore is not "
        "installed in the deployed rendering image."
    ),
    "geoserver_layer_missing": (
        "Visualization unavailable: GeoServer could not find the exact "
        "cataloged layer inside this source. Reassess after repairing it."
    ),
    "geoserver_crs_metadata_incompatible": (
        "Visualization unavailable: GeoServer cannot read this layer's "
        "coordinate reference system metadata."
    ),
    "geoserver_geometry_unreadable": (
        "Visualization unavailable: GeoServer cannot identify a supported "
        "point, line, or polygon geometry for this layer."
    ),
    "geoserver_vector_reader_incompatible": (
        "Visualization unavailable: GeoServer cannot open the exact cataloged "
        "vector layer."
    ),
}


def _rendering_metadata(
    *,
    eligible: bool,
    reason_code: str | None,
    reason: str | None,
    source_signature: VectorSourceSignature | None = None,
    reader_assessment: VectorReaderAssessment | None = None,
) -> dict[str, Any]:
    """Build one complete persisted vector rendering decision.

    Args:
        eligible: Whether publication is currently allowed.
        reason_code: Stable capability classification for an ineligible Item.
        reason: Actionable browser message for an ineligible Item.
        source_signature: Mounted source identity inspected during assessment.
        reader_assessment: Optional deployed-reader result.

    Returns:
        JSON-compatible vector rendering metadata.

    Raises:
        ValueError: If eligibility and supplied evidence disagree.
    """
    if eligible != (reason_code is None and reason is None):
        raise ValueError("Vector eligibility must agree with capability reason")
    if eligible and (
        source_signature is None
        or reader_assessment is None
        or not reader_assessment.compatible
    ):
        raise ValueError("Eligible vectors require source and reader evidence")
    return {
        "policy": VECTOR_RENDERING_POLICY,
        "eligible": eligible,
        "reason_code": reason_code,
        "reason": reason,
        "source_signature": (
            [list(entry) for entry in source_signature]
            if source_signature is not None
            else None
        ),
        "reader_contract": (
            reader_assessment.contract
            if reader_assessment is not None
            else None
        ),
        "reader_compatible": (
            reader_assessment.compatible
            if reader_assessment is not None
            else None
        ),
        "geometry_kind": (
            reader_assessment.geometry_kind
            if reader_assessment is not None
            else None
        ),
    }


class VectorAssessmentFinalizer:
    """Complete vector Items with source-kind and deployed-reader evidence."""

    def __init__(
        self,
        source_resolver: MountedVectorResolver,
        reader_assessor: VectorReaderAssessor,
        signature_reader: Callable[
            [ResolvedVectorSource], VectorSourceSignature
        ] = vector_source_signature,
    ) -> None:
        """Create a finalizer over source and deployed-reader boundaries.

        Args:
            source_resolver: Resolver confined to the shared scan mount.
            reader_assessor: Read-only deployed GeoTools vector probe.
            signature_reader: Synchronous complete-source identity boundary.
        """
        self._source_resolver = source_resolver
        self._reader_assessor = reader_assessor
        self._signature_reader = signature_reader

    async def finalize(self, item: dict[str, Any]) -> dict[str, Any]:
        """Attach a complete vector visualization decision to one fresh Item.

        Args:
            item: Fresh scanner-owned STAC Item.

        Returns:
            The same Item with normalized source and rendering contracts.

        Raises:
            RasterConflictError: If a mounted source changes during assessment.
            RasterUpstreamError: If the deployed reader probe is unavailable.
        """
        if item.get("collection") != MOUNTED_VECTOR_COLLECTION_ID:
            return item
        try:
            source = self._source_resolver.resolve(item)
        except RasterAssetError as error:
            item.setdefault("properties", {})[
                VECTOR_RENDERING_METADATA_KEY
            ] = _rendering_metadata(
                eligible=False,
                reason_code="invalid_source_identity",
                reason=f"Visualization unavailable: {error.detail}.",
            )
            return item

        self._source_resolver.apply_contract(item, source)
        if source.source_kind == "remote":
            item["properties"][VECTOR_RENDERING_METADATA_KEY] = (
                _rendering_metadata(
                    eligible=False,
                    reason_code="remote_source_unsupported",
                    reason=(
                        "Visualization unavailable: remote vector Assets are "
                        "not published as mounted files and credentials are "
                        "never forwarded to GeoServer."
                    ),
                )
            )
            return item
        if source.source_format in _UNSUPPORTED_FORMAT_REASONS:
            reason_code, reason = _UNSUPPORTED_FORMAT_REASONS[
                source.source_format
            ]
            item["properties"][VECTOR_RENDERING_METADATA_KEY] = (
                _rendering_metadata(
                    eligible=False,
                    reason_code=reason_code,
                    reason=reason,
                )
            )
            return item
        if source.source_path is None or source.layer_name is None:
            item["properties"][VECTOR_RENDERING_METADATA_KEY] = (
                _rendering_metadata(
                    eligible=False,
                    reason_code="missing_layer_identity",
                    reason=(
                        "Visualization unavailable: the exact native vector "
                        "layer identity is missing."
                    ),
                )
            )
            return item

        try:
            inspected_signature = await asyncio.to_thread(
                self._signature_reader,
                source,
            )
        except OSError as error:
            raise RasterConflictError(
                "Visualization unavailable: the vector source cannot be read."
            ) from error
        assessment = await self._reader_assessor.assess(
            source.source_format,
            source.source_path,
            source.layer_name,
        )
        current_signature = await asyncio.to_thread(
            self._signature_reader,
            source,
        )
        if current_signature != inspected_signature:
            raise RasterConflictError(
                "The vector source changed while it was being assessed"
            )
        if assessment.compatible:
            metadata = _rendering_metadata(
                eligible=True,
                reason_code=None,
                reason=None,
                source_signature=inspected_signature,
                reader_assessment=assessment,
            )
        else:
            metadata = _rendering_metadata(
                eligible=False,
                reason_code=assessment.reason_code,
                reason=_READER_REASON_TEXT[assessment.reason_code],
                source_signature=inspected_signature,
                reader_assessment=assessment,
            )
        item["properties"][VECTOR_RENDERING_METADATA_KEY] = metadata
        return item


class VectorAssessmentService:
    """Rebuild and replace one Item's vector visualization assessment."""

    def __init__(
        self,
        scan_mount_path: Path,
        catalog: VectorCatalog,
        source_resolver: MountedVectorResolver,
        finalizer: VectorAssessmentFinalizer,
    ) -> None:
        """Create the selected-Item assessment workflow.

        Args:
            scan_mount_path: Read-only root containing mounted vector sources.
            catalog: Authoritative vector catalog port.
            source_resolver: Resolver preserving exact source/layer identity.
            finalizer: Shared scan and selected-Item assessment collaborator.
        """
        self._scan_mount_path = scan_mount_path
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._finalizer = finalizer

    async def assess(self, request: CatalogVectorRequest) -> dict[str, Any]:
        """Reassess one Item without scanning sibling datasets.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Newly rebuilt and assessed authoritative STAC Item.

        Raises:
            RasterFeatureError: If catalog, source, or reader boundaries fail.
            RasterConflictError: If rebuilt identity differs from the selected
                Item or source metadata is unreadable.
        """
        item = await self._catalog.get_item(request)
        try:
            source = self._source_resolver.resolve(item)
            if source.source_kind == "remote":
                updated_item = dict(item)
                updated_item["properties"] = dict(item.get("properties", {}))
            else:
                updated_item = await asyncio.to_thread(
                    self._rebuild_item,
                    request.item_id,
                    source,
                )
        except RasterAssetError:
            updated_item = dict(item)
            updated_item["properties"] = dict(item.get("properties", {}))
        except (
            fiona.errors.FionaError,
            OSError,
            OverflowError,
            RasterioError,
            ValueError,
        ) as error:
            raise RasterConflictError(
                "Visualization unavailable: the vector metadata could not be read."
            ) from error
        if updated_item.get("id") != request.item_id:
            raise RasterConflictError(
                "The mounted vector layer no longer matches the catalog Item"
            )
        updated_item = await self._finalizer.finalize(updated_item)
        await self._catalog.upsert_item(request, updated_item)
        return updated_item

    def _rebuild_item(
        self,
        item_id: str,
        source: ResolvedVectorSource,
    ) -> dict[str, Any]:
        """Dispatch exact source identity to its format-owned Item builder.

        Args:
            item_id: Selected stable Item identifier.
            source: Validated mounted container and layer identity.

        Returns:
            Rebuilt Item with exactly the selected identity.

        Raises:
            RasterConflictError: If the exact layer no longer exists.
            Exception: Propagates format-owned metadata failures.
        """
        if source.source_path is None:
            raise RasterConflictError("Remote vectors cannot be rebuilt locally")
        if source.source_format == "shapefile":
            items = (build_shapefile_item(
                self._scan_mount_path,
                source.source_path,
                source.component_paths,
            ),)
        elif source.source_format == "geopackage":
            items = build_geopackage_items(
                self._scan_mount_path,
                source.source_path,
            )
        elif source.source_format == "geojson":
            items = (build_geojson_item(
                self._scan_mount_path,
                source.source_path,
            ),)
        elif source.source_format == "zipped-shapefile":
            items = build_zipped_shapefile_items(
                self._scan_mount_path,
                source.source_path,
            )
        else:
            items = build_file_geodatabase_items(
                self._scan_mount_path,
                source.source_path,
            )
        for item in items:
            if item.get("id") == item_id:
                return item
        raise RasterConflictError(
            "The exact cataloged vector layer is no longer present in its source"
        )
