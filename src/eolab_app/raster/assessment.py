"""Application workflow for authoritative raster reassessment."""

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

import rasterio

from eolab_app.catalog.geotiff import build_stac_item
from eolab_app.raster.eligibility import (
    DETAIL_ONLY_PREVIEW_REASON_CODES,
    MOUNTED_GEOTIFF_COLLECTION_ID,
    RENDERING_METADATA_KEY,
    apply_reader_assessment,
)
from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.ports import RasterCatalog, RasterReaderAssessor
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.raster.sources import (
    MountedRasterResolver,
    source_signature,
)


class RasterAssessmentFinalizer:
    """Complete structural raster metadata with deployed-reader evidence.

    The finalizer is shared by catalog scans and selected-Item reassessment so
    both persistence paths apply the same source and reader contracts.
    """

    def __init__(
        self,
        source_resolver: MountedRasterResolver,
        reader_assessor: RasterReaderAssessor,
        signature_reader: Callable[
            [Path], RasterSourceIdentity
        ] = source_signature,
    ) -> None:
        """Create a finalizer over source identity and reader boundaries.

        Args:
            source_resolver: Resolver confined to the shared scan mount.
            reader_assessor: Read-only deployed GeoServer reader boundary.
            signature_reader: Synchronous source identity boundary.
        """
        self._source_resolver = source_resolver
        self._reader_assessor = reader_assessor
        self._signature_reader = signature_reader

    async def finalize(self, item: dict[str, Any]) -> dict[str, Any]:
        """Finalize one freshly built scanner Item assessment.

        Non-raster Items pass through unchanged. Structurally eligible and
        overview-limited detail-preview candidates are acquired once by the
        deployed reader so CRS/reader failures take precedence. Other
        structurally ineligible rasters retain their specific policy reason
        without invoking GeoServer. Every assessed source keeps the identity
        used for its decision.

        Args:
            item: Fresh scanner-owned STAC Item with structural metadata.

        Returns:
            The same Item with a complete, machine-readable assessment.

        Raises:
            OSError: If source identity cannot be read.
            RasterAssetError: If the Item does not resolve to the scan mount.
            RasterConflictError: If the source changes during reader
                assessment.
            RasterUpstreamError: If GeoServer cannot perform the assessment.
            ValueError: If the fresh Item violates the structural assessment
                contract.
        """
        if item.get("collection") != MOUNTED_GEOTIFF_COLLECTION_ID:
            return item

        source_path = self._source_resolver.resolve(item)
        inspected_signature = await asyncio.to_thread(
            self._signature_reader,
            source_path,
        )
        rendering_metadata = item["assets"]["data"].get(
            RENDERING_METADATA_KEY
        )
        if not isinstance(rendering_metadata, dict):
            raise ValueError("Raster Item has no structural rendering metadata")
        try:
            extracted_identity = RasterSourceIdentity.from_catalog(
                rendering_metadata.get("source_signature")
            )
        except ValueError as error:
            raise ValueError(
                "Raster Item has invalid structural source identity"
            ) from error
        if extracted_identity != inspected_signature:
            raise RasterConflictError(
                "The GeoTIFF changed while its metadata was being extracted"
            )

        completed_metadata = dict(rendering_metadata)
        if (
            rendering_metadata.get("eligible")
            or rendering_metadata.get("reason_code")
            in DETAIL_ONLY_PREVIEW_REASON_CODES
        ):
            reader_assessment = await self._reader_assessor.assess(source_path)
            completed_metadata = apply_reader_assessment(
                rendering_metadata,
                reader_contract=reader_assessment.contract,
                reader_compatible=reader_assessment.compatible,
                reader_reason_code=reader_assessment.reason_code,
            )

        current_signature = await asyncio.to_thread(
            self._signature_reader,
            source_path,
        )
        if current_signature != inspected_signature:
            raise RasterConflictError(
                "The GeoTIFF changed while it was being assessed"
            )
        item["assets"]["data"][RENDERING_METADATA_KEY] = completed_metadata
        return item


class RasterAssessmentService:
    """Replace one catalog Item's authoritative rendering assessment."""

    def __init__(
        self,
        scan_mount_path: Path,
        catalog: RasterCatalog,
        source_resolver: MountedRasterResolver,
        reader_assessor: RasterReaderAssessor,
        item_builder: Callable[[Path, Path], dict[str, Any]] = build_stac_item,
        signature_reader: Callable[
            [Path], RasterSourceIdentity
        ] = source_signature,
    ) -> None:
        """Create the assessment workflow from focused collaborators.

        Args:
            scan_mount_path: Read-only root containing cataloged GeoTIFFs.
            catalog: Authoritative raster catalog port.
            source_resolver: Resolver confined to the scan mount.
            reader_assessor: Read-only deployed GeoServer reader boundary.
            item_builder: Synchronous GeoTIFF-to-STAC boundary.
            signature_reader: Synchronous source identity boundary.
        """
        self._scan_mount_path = scan_mount_path
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._item_builder = item_builder
        self._finalizer = RasterAssessmentFinalizer(
            source_resolver,
            reader_assessor,
            signature_reader,
        )

    async def assess(
        self,
        request: CatalogRasterRequest,
    ) -> dict[str, Any]:
        """Update one Item with its current visualization assessment.

        The source Item is always rebuilt, finalized against the deployed
        reader, and upserted without scanning sibling datasets. Repeating this
        operation intentionally replaces a result after source repair or a
        reader-contract change.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Newly assessed authoritative STAC Item.

        Raises:
            RasterFeatureError: If the Item or mounted Asset is unavailable.
            RasterConflictError: If metadata cannot be read or the mounted
                source no longer matches the Item.
        """
        item = await self._catalog.get_item(request)
        source_path = self._source_resolver.resolve(item)
        try:
            updated_item = await asyncio.to_thread(
                self._item_builder,
                self._scan_mount_path,
                source_path,
            )
        except ValueError as error:
            raise RasterConflictError(
                f"Visualization unavailable: {error}"
            ) from error
        except (OSError, rasterio.errors.RasterioError) as error:
            raise RasterConflictError(
                "Visualization unavailable: the raster metadata could not "
                "be read."
            ) from error

        if updated_item["id"] != request.item_id:
            raise RasterConflictError(
                "The mounted GeoTIFF no longer matches the catalog Item"
            )
        try:
            updated_item = await self._finalizer.finalize(updated_item)
        except OSError as error:
            raise RasterConflictError(
                "Visualization unavailable: the raster metadata could not "
                "be read."
            ) from error
        await self._catalog.upsert_item(request, updated_item)
        return updated_item
