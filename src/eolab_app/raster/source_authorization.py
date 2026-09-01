"""Catalog-owned source authorization for rendering-independent analysis."""

import asyncio
from collections.abc import Callable
from pathlib import Path
from eolab_app.raster.catalog_metadata import cataloged_source_signature
from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogRasterRequest,
)
from eolab_app.raster.ports import RasterCatalog, RasterSourceResolver
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.raster.sources import source_signature


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
            source_signature=cataloged_source_signature(item),
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
