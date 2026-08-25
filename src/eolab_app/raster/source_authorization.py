"""Catalog-owned source authorization for rendering-independent analysis."""

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

from eolab_app.raster.catalog_metadata import (
    RASTER_ASSET_METADATA_KEY,
    RASTER_SOURCE_SIGNATURE_FIELD,
)
from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogRasterRequest,
)
from eolab_app.raster.ports import RasterCatalog, RasterSourceResolver
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.raster.sources import source_signature


def _cataloged_source_signature(item: dict[str, Any]) -> RasterSourceIdentity:
    """Read the scanner-owned source identity from one catalog Item.

    The signature currently lives in the versioned rendering metadata for
    schema compatibility, but it identifies the scanned file itself and does
    not imply rendering eligibility or a live GeoServer publication.

    Args:
        item: Authoritative scanner-owned STAC Item.

    Returns:
        Filesystem identity recorded by the scanner.

    Raises:
        RasterConflictError: If the Item predates or violates the source
            identity contract.
    """
    assets = item.get("assets")
    data_asset = assets.get("data") if isinstance(assets, dict) else None
    metadata = (
        data_asset.get(RASTER_ASSET_METADATA_KEY)
        if isinstance(data_asset, dict)
        else None
    )
    signature = (
        metadata.get(RASTER_SOURCE_SIGNATURE_FIELD)
        if isinstance(metadata, dict)
        else None
    )
    try:
        return RasterSourceIdentity.from_catalog(signature)
    except ValueError as error:
        raise RasterConflictError(
            "Raster analysis unavailable: scan this source again to record "
            "its current identity."
        ) from error


class CatalogRasterSourceAuthorizer:
    """Resolve current mounted raster sources without a rendering dependency."""

    def __init__(
        self,
        catalog: RasterCatalog,
        source_resolver: RasterSourceResolver,
        signature_reader: Callable[
            [Path], RasterSourceIdentity
        ] = source_signature,
    ) -> None:
        """Create catalog authorization for independent raster analysis.

        Args:
            catalog: Authoritative scanner-owned Item reader.
            source_resolver: Resolver confined to the configured scan mount.
            signature_reader: Current filesystem identity reader.
        """
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._signature_reader = signature_reader

    async def authorize(
        self,
        request: CatalogRasterRequest,
    ) -> AuthorizedRaster:
        """Authorize one current catalog source for analysis.

        This boundary deliberately does not inspect WMS publication state,
        visualization eligibility, overview policy, or GeoServer health.

        Args:
            request: Validated Collection and Item identity.

        Returns:
            Mounted source path and scanner-approved source identity.

        Raises:
            RasterFeatureError: If the catalog Item or mounted Asset cannot be
                resolved.
            RasterConflictError: If the scanned source identity is missing or
                stale.
        """
        item = await self._catalog.get_item(request)
        source_path = self._source_resolver.resolve(item)
        authorized_raster = AuthorizedRaster(
            source_path=source_path,
            source_signature=_cataloged_source_signature(item),
        )
        await self.require_current(authorized_raster)
        return authorized_raster

    async def require_current(
        self,
        authorized_raster: AuthorizedRaster,
    ) -> None:
        """Require an authorized source to retain its exact identity.

        Args:
            authorized_raster: Source identity established at request start.

        Returns:
            None when the mounted source remains current.

        Raises:
            RasterConflictError: If the source disappeared or changed.
        """
        try:
            current_signature = await asyncio.to_thread(
                self._signature_reader,
                authorized_raster.source_path,
            )
        except OSError as error:
            raise RasterConflictError(
                "The cataloged raster source can no longer be read."
            ) from error
        if current_signature != authorized_raster.source_signature:
            raise RasterConflictError(
                "The cataloged raster changed; scan it again before analysis."
            )
