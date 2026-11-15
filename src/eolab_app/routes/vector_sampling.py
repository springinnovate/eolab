"""HTTP routes for original-source vector selections, bounds and display outlines."""

from fastapi import APIRouter, HTTPException, Request, Response
from typing import Any
from collections.abc import Callable

from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)
from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.routes.vector_http import PrivateVectorRoute, vector_http_exception
from eolab_app.catalog_selection import (
    SelectionUnavailableError,
    ArtifactVectorSelection,
    UploadedVectorFilterRequest,
    VectorSelection,
)
from eolab_app.vector.errors import VectorFeatureError
from eolab_app.vector.extent_operation import FeatureExtent
from eolab_app.vector.filters import CatalogVectorFilterRequest
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.source_files import SourceFileError


def create_vector_sampling_router(
    service: VectorSamplingService,
    read_artifact_owner: Callable[[Request, Response], str] | None = None,
) -> APIRouter:
    """Create selection routes that cancel source reads when the client disconnects.

    Args:
        service: Authorizes vector sources and counts their matching features.
        read_artifact_owner: Composition-supplied Processing session authority.

    Returns:
        Router accepting original source identity and typed filters.
    """
    router = APIRouter(
        prefix="/api/vector-sampling",
        tags=["sampling"],
        route_class=PrivateVectorRoute,
    )

    def read_source_owner(
        payload: object, request: Request, response: Response
    ) -> str | None:
        """Read the private identity required by an upload or immutable run result.

        Args:
            payload: Validated source request or selection.
            request: Incoming same-origin request.
            response: Response renewing the relevant private session cookie.

        Returns:
            Source-appropriate browser identity, or None for a Catalog source.

        Raises:
            HTTPException: If private result access is unavailable or unauthorized.
        """
        if isinstance(payload, ArtifactVectorSelection):
            if read_artifact_owner is None:
                raise HTTPException(404, "This vector result is unavailable.")
            return read_artifact_owner(request, response)
        if isinstance(payload, UploadedVectorFilterRequest):
            return get_browser_owner_hash(
                request, response, mutation_header="X-EOLab-Uploads"
            )
        return None

    @router.post("/areas")
    async def select_area(
        payload: (
            CatalogVectorFilterRequest
            | UploadedVectorFilterRequest
            | ArtifactVectorSelection
        ),
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        """Count filtered features and return their reusable selection descriptor.

        Args:
            payload: Original vector source source and complete filter snapshot.
            request: HTTP disconnect observer.
            response: Renews the browser cookie for the selected private layer.

        Returns:
            Feature counts and a descriptor containing the
            source identity and feature filter, without file paths or credentials.

        Raises:
            HTTPException: For cancellation, invalid source, or bounded-read failure.
        """
        source_owner = read_source_owner(payload, request, response)
        try:
            return await run_until_http_disconnect(
                request, service.select(payload, source_owner)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Selection canceled") from error
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error
        except SelectionUnavailableError as error:
            raise HTTPException(409, error.detail) from error
        except SourceFileError as error:
            raise HTTPException(error.status, str(error)) from error

    @router.post("/extent", response_model=FeatureExtent)
    async def extent(
        payload: (
            CatalogVectorFilterRequest
            | UploadedVectorFilterRequest
            | ArtifactVectorSelection
        ),
        request: Request,
        response: Response,
    ) -> dict[str, Any]:
        """Return matching original-source bounds without changing an analysis area.

        Args:
            payload: Original vector source identity and complete accepted filter.
            request: HTTP disconnect observer and private source ownership.
            response: Renews the browser cookie for the selected private layer.

        Returns:
            Exact matching count and WGS84 bounds; null bounds when none exist.

        Raises:
            HTTPException: For cancellation, invalid source or bounded-read failure.
        """
        source_owner = read_source_owner(payload, request, response)
        try:
            return await run_until_http_disconnect(
                request, service.extent(payload, source_owner)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Vector zoom cancelled") from error
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error
        except SelectionUnavailableError as error:
            raise HTTPException(409, error.detail) from error
        except SourceFileError as error:
            raise HTTPException(error.status, str(error)) from error

    @router.post("/outline")
    async def outline(
        payload: VectorSelection, request: Request, response: Response
    ) -> dict[str, Any]:
        """Return optional display geometry independently of analysis.

        Args:
            payload: Immutable catalog or upload selection descriptor.
            request: HTTP disconnect observer.
            response: Renews the browser cookie for the selected private layer.

        Returns:
            Display-only approximate polygon outline.

        Raises:
            HTTPException: For cancellation, unavailable source or display capacity.
        """
        source_owner = read_source_owner(payload, request, response)
        try:
            return await run_until_http_disconnect(
                request, service.outline(payload, source_owner)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Outline canceled") from error
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error
        except SelectionUnavailableError as error:
            raise HTTPException(409, error.detail) from error
        except SourceFileError as error:
            raise HTTPException(error.status, str(error)) from error

    return router
