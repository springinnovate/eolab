"""Read the original vector files retained for an accepted Processing job."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from typing import Any
from contextlib import asynccontextmanager
from pathlib import Path

from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.catalog_selection import (
    CatalogSelection,
    ArtifactVectorSelection,
    CatalogSelectionReader,
    ResolvedCatalogSelection,
    SelectionUnavailableError,
    VectorSelection,
)
from eolab_app.vector_uploads import VectorUploadError, VectorUploadStore
from eolab_app.bounded_vector import resolve_vector_file_selection
from eolab_app.polygon_areas import SummaryPolygon
from eolab_app.feature_predicate import DrawingSelection
from eolab_app.feature_intersection import bind_intersections

class RetainedVectorSelectionReader:
    """Read private vector inputs retained until an accepted Processing job stops.

    Catalog selections use their ordinary reader. Uploads use retained original
    files; run results use the job's accepted input-file authorization. Parent
    deletion or expiry cannot interrupt an already accepted calculation.
    """

    def __init__(
        self,
        catalog: CatalogSelectionReader,
        uploads: VectorUploadStore | None,
        input_uploads: Mapping[str, str],
        retained_file: Callable[[str, str], Awaitable[Path]] | None = None,
        drawings: Mapping[str, list[dict[str, Any]]] | None = None,
    ) -> None:
        """Bind vector reading to original upload and result files retained for one job.

        Args:
            catalog: Existing reader for catalog vectors and configured sources.
            uploads: Store that locates retained original GeoPackages.
            input_uploads: Accepted upload UUID strings mapped to their private
                retention tokens, supplied by job storage.
            retained_file: Resolve a published result under the current job's retained
                input authorization, including when its parent has expired.
            drawings: Selected drawing polygons captured at submission, keyed by the exact source reference.
        """
        self.catalog = catalog
        self.uploads = uploads
        self.input_uploads = input_uploads
        self.retained_file = retained_file
        self.drawings = drawings or {}

    @asynccontextmanager
    async def open_selection(
        self, selection: VectorSelection, source_owner: str | None = None
    ) -> AsyncIterator[ResolvedCatalogSelection]:
        """Open a selection whose private file is retained for this accepted job.

        Args:
            selection: Accepted original source and field definitions.
            source_owner: Unused; the job's retention authorization owns access.

        Yields:
            Resolved file protected by the job until native work has stopped.

        Raises:
            SelectionUnavailableError: If the accepted source cannot be read.
        """
        yield await self.resolve_for_sampling(selection)

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
        self, selection: VectorSelection, source_owner: str | None = None
    ) -> ResolvedCatalogSelection:
        """Return the exact source and predicate for an accepted job's selection.

        Args:
            selection: Descriptor whose source and filter were accepted at admission.
            source_owner: Unused reader-interface argument; accepted jobs use
                their retained files instead of a browser session.

        Returns:
            Original dataset path and the selected feature predicate.

        Raises:
            SelectionUnavailableError: If the retained file or catalog source
                cannot be read.
        """
        original = await self._resolve_original(selection)
        if not selection.filter.intersections:
            return original
        return await bind_intersections(original, self._read_polygon_view, limits=None)

    async def _read_polygon_view(
        self, source: VectorSelection | DrawingSelection,
    ) -> ResolvedCatalogSelection | tuple[SummaryPolygon, ...]:
        """Open a job's captured polygon view, following its own active conditions.

        Args:
            source: Captured vector selection or device drawing input.

        Returns:
            Selected original vector or committed drawing polygons.

        Raises:
            SelectionUnavailableError: If the job lacks the required original input.
        """
        if isinstance(source, DrawingSelection):
            if source.polygonArea is None:
                return ()
            try:
                polygons = self.drawings[source.polygonArea.model_dump_json()]
            except KeyError as error:
                raise SelectionUnavailableError("The drawing was not captured for this calculation.") from error
            return tuple(SummaryPolygon.model_validate(polygon) for polygon in polygons)
        return await self.resolve_for_sampling(source)

    async def _resolve_original(self, selection: VectorSelection) -> ResolvedCatalogSelection:
        """Locate the job's original vector before binding right-hand spatial conditions.

        Args:
            selection: Accepted path-free identity, fields and filter.

        Returns:
            Authorized catalog or retained private original.

        Raises:
            SelectionUnavailableError: If job retention cannot supply the file.
        """
        if isinstance(selection, CatalogSelection):
            if not selection.filter.intersections:
                return await self.catalog.resolve_for_sampling(selection)
            return await self.catalog.resolve_original_selection(selection)
        if isinstance(selection, ArtifactVectorSelection):
            if self.retained_file is None:
                raise SelectionUnavailableError(
                    "Retained vector result access is unavailable."
                )
            path = await self.retained_file(selection.jobId, selection.artifactId)
            return await asyncio.to_thread(
                resolve_vector_file_selection, path, selection
            )
        if self.uploads is None:
            raise SelectionUnavailableError(
                "Retained vector upload access is unavailable."
            )
        try:
            path = await asyncio.to_thread(
                self.uploads.get_retained_source,
                self.input_uploads[str(selection.uploadId)],
            )
        except VectorUploadError as error:
            raise SelectionUnavailableError(
                "The uploaded vector retained for this job is unavailable. Submit a new job."
            ) from error
        return await asyncio.to_thread(resolve_vector_file_selection, path, selection)
