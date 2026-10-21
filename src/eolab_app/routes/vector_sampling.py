"""HTTP routes for filtered vector analysis areas and optional display outlines."""

from fastapi import APIRouter, HTTPException, Request, Response
from typing import Any

from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)
from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.routes.vector_http import PrivateVectorRoute, vector_http_exception
from eolab_app.catalog_selection import (
    SelectionUnavailableError,
    UploadedVectorFilterRequest,
    VectorSelection,
)
from eolab_app.vector.errors import VectorFeatureError
from eolab_app.vector.filters import CatalogVectorFilterRequest
from eolab_app.vector.sampling import VectorSamplingService


def create_vector_sampling_router(service: VectorSamplingService) -> APIRouter:
    """Create selection routes that cancel source reads when the client disconnects.

    Args:
        service: Authorizes vector sources and measures their filtered polygons.

    Returns:
        Router accepting catalog or upload identity and typed filters.
    """
    router = APIRouter(
        prefix="/api/vector-sampling",
        tags=["sampling"],
        route_class=PrivateVectorRoute,
    )

    @router.post("/areas")
    async def select_area(
        payload: CatalogVectorFilterRequest | UploadedVectorFilterRequest,
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        """Measure filtered polygons and return their reusable selection descriptor.

        Args:
            payload: Catalog or upload source and complete filter snapshot.
            request: HTTP disconnect observer.
            response: Renews the browser cookie when selecting an uploaded layer.

        Returns:
            Feature counts, geographic bounds and a descriptor containing the
            source identity and feature filter, without file paths or credentials.

        Raises:
            HTTPException: For cancellation, invalid source, or bounded-read failure.
        """
        upload_owner = (
            get_browser_owner_hash(request, response, mutation_header="X-EOLab-Uploads")
            if isinstance(payload, UploadedVectorFilterRequest)
            else None
        )
        try:
            return await run_until_http_disconnect(
                request, service.select(payload, upload_owner)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Selection canceled") from error
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error
        except SelectionUnavailableError as error:
            raise HTTPException(409, error.detail) from error

    @router.post("/outline")
    async def outline(
        payload: VectorSelection, request: Request, response: Response
    ) -> dict[str, Any]:
        """Return optional display geometry independently of analysis.

        Args:
            payload: Immutable catalog or upload selection descriptor.
            request: HTTP disconnect observer.
            response: Renews the browser cookie when outlining an uploaded layer.

        Returns:
            Display-only approximate polygon outline.

        Raises:
            HTTPException: For cancellation, unavailable source or display capacity.
        """
        upload_owner = (
            get_browser_owner_hash(request, response, mutation_header="X-EOLab-Uploads")
            if isinstance(payload, UploadedVectorFilterRequest)
            else None
        )
        try:
            return await run_until_http_disconnect(
                request, service.outline(payload, upload_owner)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Outline canceled") from error
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error
        except SelectionUnavailableError as error:
            raise HTTPException(409, error.detail) from error

    return router
