"""Application service for click-window sampled-raster histograms."""

from eolab_app.raster.detail_preview_service import RasterDetailPreviewService
from eolab_app.raster.detail_statistics import summarize_raster_detail_preview
from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import (
    CatalogRasterDetailPreviewRequest,
    CatalogRasterDetailStatisticsRequest,
    RasterStatistics,
)
from eolab_app.raster.statistics import NoValidRasterSamplesError


class RasterDetailStatisticsService:
    """Reuse bounded detail-preview work for one selected-area histogram."""

    def __init__(self, preview_service: RasterDetailPreviewService) -> None:
        """Store the authorized bounded-preview service.

        Args:
            preview_service: Existing cached/coalesced detail reader.
        """
        self._preview_service = preview_service

    async def get(
        self,
        request: CatalogRasterDetailStatisticsRequest,
    ) -> RasterStatistics:
        """Return a histogram from fixed center detail over selected bounds.

        Args:
            request: Catalog identity and required click-centered map window.

        Returns:
            Shared selected-area histogram over a sampled proxy or an admitted
            exact bounded source window.

        Raises:
            RasterFeatureError: If detail-preview authorization fails.
            RasterConflictError: If no finite sampled values are available.
        """
        preview_request = CatalogRasterDetailPreviewRequest(
            collectionId=request.collection_id,
            itemId=request.item_id,
            viewBounds=request.selected_bounds,
        )
        preview = await self._preview_service.get(preview_request)
        try:
            return summarize_raster_detail_preview(preview, request)
        except NoValidRasterSamplesError as error:
            raise RasterConflictError(
                "No finite, non-nodata pixels were found in the bounded "
                "selected-area sample grid."
            ) from error
