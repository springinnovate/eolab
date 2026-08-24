"""FastAPI delivery boundary for catalog vector assessment."""

from fastapi import APIRouter, HTTPException

from eolab_app.routes.vector_http import vector_http_exception
from eolab_app.vector.assessment import VectorAssessmentService
from eolab_app.vector.errors import VectorFeatureError
from eolab_app.vector.models import CatalogVectorRequest


def create_vector_assessment_router(
    assessment_service: VectorAssessmentService,
) -> APIRouter:
    """Create the selected-Item vector assessment route.

    Args:
        assessment_service: Authoritative selected-Item reassessment workflow.

    Returns:
        Router exposing only read-only assessment and catalog metadata update.
    """
    router = APIRouter(prefix="/api/vector-rendering", tags=["rendering"])

    @router.post("/assessments", response_model=dict[str, object])
    async def assess_vector(
        request: CatalogVectorRequest,
    ) -> dict[str, object]:
        """Assess and update one selected catalog vector Item.

        Args:
            request: Authoritative Collection and Item identity.

        Returns:
            Updated browser-safe vector visualization assessment.

        Raises:
            HTTPException: If the Item or exact source layer cannot be assessed.
        """
        try:
            return await assessment_service.assess(request)
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error

    return router
