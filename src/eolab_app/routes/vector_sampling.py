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
    FeatureMatches,
    SelectionUnavailableError,
    ArtifactVectorSelection,
    UploadedVectorFilterRequest,
    VectorSelection,
    DrawingSelection,
    UploadedSelection,
    VectorSourceOwners,
    referenced_layers,
)
from eolab_app.vector.errors import VectorFeatureError
from eolab_app.vector.extent_operation import FeatureExtent
from eolab_app.vector.lasso import LassoSelectionRequest, LassoSelectionResult
from eolab_app.vector.filters import CatalogVectorFilterRequest
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.parcel_models import (
    ParcelIdRequest,
    ParcelIdValidationResponse,
    ParcelRowsRequest,
    ParcelRowsResponse,
)
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

    @router.post("/parcels/validate-id", response_model=ParcelIdValidationResponse)
    async def validate_parcel_ids(
        payload: ParcelIdRequest, request: Request
    ) -> ParcelIdValidationResponse:
        """Validate one original parcel ID field across an entire Catalog layer.

        Args:
            payload: Catalog identity and one original field; filters are not accepted.
            request: HTTP disconnect observer for the supervised native read.

        Returns:
            Complete-layer validation and the authoritative source descriptor.

        Raises:
            HTTPException: The client disconnected or the source/read is unavailable.
            VectorFeatureError: Safe source, validation or Jobs error translated by the route.
        """
        try:
            return await run_until_http_disconnect(
                request, service.validate_parcel_ids(payload)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Parcel ID validation cancelled") from error
        except SelectionUnavailableError as error:
            raise HTTPException(409, error.detail) from error

    @router.post("/parcels/rows", response_model=ParcelRowsResponse)
    async def parcel_rows(
        payload: ParcelRowsRequest, request: Request, response: Response
    ) -> ParcelRowsResponse:
        """Return original parcel IDs and display attributes after exact filtering.

        Args:
            payload: Catalog source, ordinary filter, original fields and page bounds.
            request: HTTP disconnect observer for the supervised native read.
            response: Renews private ownership cookies when the filter uses private sources.

        Returns:
            One complete page, including empty success, with source and next offset.

        Raises:
            HTTPException: The client disconnected or the source/read is unavailable.
            VectorFeatureError: Safe source, field or Jobs error translated by the route.
        """
        try:
            read = (service.read_parcel_rows(payload, read_source_owner(payload, request, response))
                    if payload.filter.intersections else service.read_parcel_rows(payload))
            return await run_until_http_disconnect(request, read)
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Parcel reading cancelled") from error
        except SelectionUnavailableError as error:
            raise HTTPException(409, error.detail) from error

    def read_source_owner(
        payload: CatalogVectorFilterRequest | VectorSelection | UploadedVectorFilterRequest, request: Request, response: Response
    ) -> str | VectorSourceOwners | None:
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
        if payload.filter.intersections:
            sources = (payload, *referenced_layers(payload.filter))
            upload = get_browser_owner_hash(request, response, mutation_header="X-EOLab-Uploads") if any(isinstance(source, UploadedVectorFilterRequest) for source in sources) else None
            processing = None
            if any(isinstance(source, (ArtifactVectorSelection, DrawingSelection)) for source in sources):
                if read_artifact_owner is None:
                    raise HTTPException(404, "This polygon layer is unavailable.")
                processing = read_artifact_owner(request, response)
            return VectorSourceOwners(upload, processing)
        if isinstance(payload, ArtifactVectorSelection):
            if read_artifact_owner is None:
                raise HTTPException(404, "This vector result is unavailable.")
            return read_artifact_owner(request, response)
        if isinstance(payload, UploadedVectorFilterRequest):
            return get_browser_owner_hash(
                request, response, mutation_header="X-EOLab-Uploads"
            )
        return None

    @router.api_route("/spatial-read", methods=["GET", "PUT"], include_in_schema=False)
    async def spatial_read(request: Request) -> Response:
        """Exchange original sources or matching feature IDs with the authorized Jobs worker.

        The submitting request owns the bearer token and holds every source until the worker stops.
        """
        from fastapi.responses import JSONResponse

        scheme, _, token = request.headers.get("Authorization", "").partition(" ")
        read = service.spatial_reads.get(token) if scheme.lower() == "bearer" else None
        if read is None:
            raise HTTPException(404, "This polygon filter is unavailable.")
        if request.method == "GET":
            return JSONResponse(read.inputs)
        read.result = FeatureMatches.model_validate_json(await request.body())
        return Response(status_code=204)

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

    @router.post("/lasso", response_model=LassoSelectionResult)
    async def lasso(
        payload: LassoSelectionRequest, request: Request, response: Response
    ) -> LassoSelectionResult:
        """Select original features intersecting the drawn polygon, without WMS.

        Args:
            payload: Path-free filtered target and validated WGS84 lasso.
            request: Browser ownership and disconnect observer.
            response: Renews the selected private source's browser cookie.

        Returns:
            Exact matching IDs and count, plus optional whole-feature highlights.

        Raises:
            HTTPException: For invalid ownership, unavailable sources or failed reads.
        """
        source_owner = read_source_owner(payload.selection, request, response)
        try:
            return await run_until_http_disconnect(
                request, service.lasso(payload.selection, payload.polygon, source_owner)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Lasso selection cancelled") from error
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
