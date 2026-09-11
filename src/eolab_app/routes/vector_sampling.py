"""HTTP boundary for vector-owned sampling selections."""

from fastapi import APIRouter, HTTPException, Request
from typing import Any

from eolab_app.routes.http_disconnect import HttpClientDisconnectedError, run_until_http_disconnect
from eolab_app.routes.vector_http import vector_http_exception
from eolab_app.catalog_selection import CatalogSelection, SelectionUnavailableError
from eolab_app.vector.errors import VectorFeatureError
from eolab_app.vector.filters import CatalogVectorFilterRequest
from eolab_app.vector.sampling import VectorSamplingService


def create_vector_sampling_router(service: VectorSamplingService) -> APIRouter:
    """Wrap the injected selection workflow in disconnect-aware HTTP delivery.

    Args:
        service: Composed Catalog identity and direct-source selection owner.

    Returns:
        Router accepting only Catalog identity and typed filters.
    """
    router = APIRouter(prefix="/api/vector-sampling", tags=["sampling"])

    @router.post("/areas")
    async def select_area(
        payload: CatalogVectorFilterRequest, request: Request
    ) -> dict[str, Any]:
        """Create a bounded selection while its requesting client is connected.

        Args:
            payload: Catalog source and complete filter snapshot.
            request: HTTP disconnect observer.

        Returns:
            Exact counts/bounds and immutable path-free Catalog descriptor.

        Raises:
            HTTPException: For cancellation, invalid source, or bounded-read failure.
        """
        try:
            return await run_until_http_disconnect(request, service.select(payload))
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Selection canceled") from error
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error
        except SelectionUnavailableError as error:
            raise HTTPException(409, error.detail) from error

    @router.post("/outline")
    async def outline(payload: CatalogSelection, request: Request) -> dict[str, Any]:
        """Return optional display geometry independently of analysis.

        Args:
            payload: Immutable catalog selection descriptor.
            request: HTTP disconnect observer.

        Returns:
            Display-only approximate polygon outline.

        Raises:
            HTTPException: For cancellation, stale source or display capacity.
        """
        try:
            return await run_until_http_disconnect(request, service.outline(payload))
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Outline canceled") from error
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error
        except SelectionUnavailableError as error:
            raise HTTPException(409, error.detail) from error

    return router
