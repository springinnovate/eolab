"""Catalog-owned source authorization for rendering-independent analysis."""

import asyncio

from eolab_app.raster.source_models import (
    TemporalRasterSelection,
    TemporalIntervalSelection,
    TemporalTimeChoices,
    TemporalTimeQuery,
)
from eolab_app.raster.temporal import ResolvedTemporalInterval, TemporalObservation

from eolab_app.raster.catalog_metadata import cataloged_source_signature
from eolab_app.raster.models import (
    AuthorizedRaster,
    CatalogRasterRequest,
)
from eolab_app.raster.ports import RasterCatalog, RasterSourceResolver

class CatalogRasterSourceAuthorizer:
    """Resolve current mounted raster sources without a rendering dependency."""

    def __init__(
        self,
        catalog: RasterCatalog,
        source_resolver: RasterSourceResolver,
    ) -> None:
        """Create catalog authorization for independent raster analysis.

        Args:
            catalog: Authoritative scanner-owned Item reader.
            source_resolver: Resolver confined to the configured scan mount.
        """
        self._catalog = catalog
        self._source_resolver = source_resolver

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
            RasterConflictError: If the catalog source identity is missing or invalid.
        """
        item = await self._catalog.get_item(request)
        source_path = self._source_resolver.resolve(item)
        authorized_raster = AuthorizedRaster(
            source_path=source_path,
            source_signature=cataloged_source_signature(item),
        )
        return authorized_raster

    async def get_observations(
        self,
        selection: TemporalRasterSelection | TemporalIntervalSelection,
    ) -> tuple[TemporalObservation, ...]:
        """Return available observations for an authorized temporal selection.

        Args:
            selection: Catalog identity, variable and observation or interval.

        Returns:
            Ordered observation metadata and confined storage locations.

        Raises:
            RasterFeatureError: If the Catalog, archive or selection is unavailable.
        """
        item = await self._catalog.get_item(selection)
        return await asyncio.to_thread(
            self._source_resolver.get_observations, item, selection
        )

    async def get_temporal_interval(
        self, selection: TemporalIntervalSelection
    ) -> ResolvedTemporalInterval:
        """Return available observations with their admitted units and time support.

        Args:
            selection: Catalog variable and requested start-inclusive,
                end-exclusive period.

        Returns:
            Ordered observations with original bounds and variable metadata.
            Missing times remain absent; values are not converted or reduced.

        Raises:
            RasterFeatureError: If the Catalog, archive or selection is unavailable.
        """
        item = await self._catalog.get_item(selection)
        observations = await asyncio.to_thread(
            self._source_resolver.get_observations, item, selection
        )
        variable = item["properties"]["cube:variables"][selection.variable]
        return ResolvedTemporalInterval(
            observations=observations,
            unit=variable["unit"],
            time_support=variable["eolab:time_support"],
        )

    async def get_time_choices(self, query: TemporalTimeQuery) -> TemporalTimeChoices:
        """Return actual time choices for an authoritative Catalog variable.

        Args:
            query: Dataset identity, variable and optional UTC month.

        Returns:
            Available months and exact timestamps for the selected month.

        Raises:
            RasterFeatureError: If the Catalog, archive or variable is unavailable.
        """
        item = await self._catalog.get_item(query)
        return await asyncio.to_thread(
            self._source_resolver.get_time_choices, item, query
        )
