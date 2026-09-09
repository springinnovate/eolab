"""HTTP boundary for vector-owned sampling selections."""

from fastapi import APIRouter, HTTPException, Request

from eolab_app.routes.http_disconnect import HttpClientDisconnectedError, run_until_http_disconnect
from eolab_app.routes.vector_http import vector_http_exception
from eolab_app.temporary_aoi.errors import TemporaryAoiError
from eolab_app.vector.errors import VectorFeatureError
from eolab_app.vector.filters import CatalogVectorFilterRequest
from eolab_app.vector.sampling import VectorSamplingService


def create_vector_sampling_router(service: VectorSamplingService) -> APIRouter:
    """Wrap the injected selection workflow in disconnect-aware HTTP delivery.

    Args:
        service: Fully composed Catalog selection and AOI retention workflow.

    Returns:
        Router accepting only Catalog identity and typed filters.
    """
    router = APIRouter(prefix="/api/vector-sampling", tags=["sampling"])

    @router.post("/areas")
    async def select_area(payload: CatalogVectorFilterRequest, request: Request) -> dict:
        """Create a bounded selection while its requesting client is connected.

        Args:
            payload: Catalog source and complete filter snapshot.
            request: HTTP disconnect observer.

        Returns:
            Ready geometry, counts and opaque AOI lifecycle reference.
        """
        try:
            return await run_until_http_disconnect(request, service.select(payload))
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Selection canceled") from error
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error
        except TemporaryAoiError as error:
            raise HTTPException(409, error.detail) from error

    return router
