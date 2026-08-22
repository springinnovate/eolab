"""Application workflow for authoritative raster reassessment."""

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

import rasterio

from eolab_app.geotiff import build_stac_item
from eolab_app.raster.eligibility import (
    RENDERING_METADATA_KEY,
    RENDERING_POLICY,
)
from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.ports import RasterCatalog
from eolab_app.raster.sources import MountedRasterResolver


class RasterAssessmentService:
    """Refresh one catalog Item's structural rendering assessment."""

    def __init__(
        self,
        scan_mount_path: Path,
        catalog: RasterCatalog,
        source_resolver: MountedRasterResolver,
        item_builder: Callable[[Path, Path], dict[str, Any]] = build_stac_item,
    ) -> None:
        """Create the assessment workflow from focused collaborators.

        Args:
            scan_mount_path: Read-only root containing cataloged GeoTIFFs.
            catalog: Authoritative raster catalog port.
            source_resolver: Resolver confined to the scan mount.
            item_builder: Synchronous GeoTIFF-to-STAC boundary.
        """
        self._scan_mount_path = scan_mount_path
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._item_builder = item_builder

    async def assess(
        self,
        request: CatalogRasterRequest,
    ) -> dict[str, Any]:
        """Update one Item with its current visualization assessment.

        Existing assessments under the current policy are returned unchanged.
        Otherwise the source Item is rebuilt and upserted without scanning
        sibling datasets.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Existing or newly assessed authoritative STAC Item.

        Raises:
            RasterFeatureError: If the Item or mounted Asset is unavailable.
            RasterConflictError: If metadata cannot be read or the mounted
                source no longer matches the Item.
        """
        item = await self._catalog.get_item(request)
        source_path = self._source_resolver.resolve(item)
        existing_assessment = item["assets"]["data"].get(
            RENDERING_METADATA_KEY
        )
        if (
            existing_assessment is not None
            and existing_assessment.get("policy") == RENDERING_POLICY
        ):
            return item

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
        await self._catalog.upsert_item(request, updated_item)
        return updated_item
