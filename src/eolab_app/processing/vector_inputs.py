"""Read the original vector files retained for an accepted Processing job."""

import asyncio
from collections.abc import Mapping

from eolab_app.attribute_filter import ogr_predicate
from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.catalog_selection import (
    CatalogSelection,
    CatalogSelectionReader,
    ResolvedCatalogSelection,
    SelectionUnavailableError,
    VectorSelection,
)
from eolab_app.vector_uploads import VectorUploadError, VectorUploadStore


class RetainedVectorSelectionReader:
    """Resolve a job's uploaded selections even after their owner deletes the uploads.

    Catalog selections still use the ordinary catalog reader. Uploaded selections
    use files retained and filters validated when the job was admitted; model
    calculations receive the same exact-source contract for either source.
    """

    def __init__(
        self,
        catalog: CatalogSelectionReader,
        uploads: VectorUploadStore,
        input_uploads: Mapping[str, str],
    ) -> None:
        """Bind vector reading to the uploaded files retained for one job.

        Args:
            catalog: Existing reader for catalog vectors and configured sources.
            uploads: Store that locates retained original GeoPackages.
            input_uploads: Accepted upload UUID strings mapped to their private
                retention tokens, supplied by job storage.
        """
        self.catalog = catalog
        self.uploads = uploads
        self.input_uploads = input_uploads

    async def resolve_source(
        self, source: CatalogVectorRequest
    ) -> ResolvedCatalogSelection:
        """Read a configured catalog layer through the existing source authority.

        Args:
            source: Configured catalog collection and item.

        Returns:
            Full-layer descriptor and authorized original file path.

        Raises:
            SelectionUnavailableError: If the configured source is unavailable.
        """
        return await self.catalog.resolve_source(source)

    async def resolve_for_sampling(
        self, selection: VectorSelection, upload_owner: str | None = None
    ) -> ResolvedCatalogSelection:
        """Return the exact source and predicate for an accepted job's selection.

        Args:
            selection: Descriptor whose source and filter were accepted at admission.
            upload_owner: Unused reader-interface argument; accepted jobs use
                their retained files instead of a browser session.

        Returns:
            Original dataset path and the selected feature predicate.

        Raises:
            SelectionUnavailableError: If the retained file or catalog source
                cannot be read.
        """
        if isinstance(selection, CatalogSelection):
            return await self.catalog.resolve_for_sampling(selection)
        try:
            path = await asyncio.to_thread(
                self.uploads.get_retained_source,
                self.input_uploads[str(selection.uploadId)],
            )
        except VectorUploadError as error:
            raise SelectionUnavailableError(
                "The uploaded vector retained for this job is unavailable. Submit a new job."
            ) from error
        return ResolvedCatalogSelection(
            selection, path, "GPKG", ogr_predicate(selection.filter)
        )
