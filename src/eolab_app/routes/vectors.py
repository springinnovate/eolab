"""FastAPI delivery boundary for catalog vector visualization."""

from dataclasses import dataclass

from fastapi import APIRouter, HTTPException

from eolab_app.routes.vector_http import vector_http_exception
from eolab_app.vector.errors import VectorFeatureError
from eolab_app.vector.assessment import VectorAssessmentService
from eolab_app.vector.models import (
    AppliedVectorStyle,
    CatalogVectorCategoryRequest,
    CatalogVectorRequest,
    CatalogVectorStyleRequest,
    PublishedVector,
    VectorCategorySummary,
)
from eolab_app.vector.publication import VectorPublicationService
from eolab_app.vector.sources import PublishedVectorRegistry
from eolab_app.vector.styling import VectorStyleService


@dataclass(frozen=True)
class VectorFeature:
    """Explicit vector feature boundary wired into the application.

    Attributes:
        router: HTTP routes for assessment and publication.
        registry: Process-local authorization consulted by the WMS proxy.
    """

    router: APIRouter
    registry: PublishedVectorRegistry


def create_vector_feature(
    assessment_service: VectorAssessmentService,
    publication_service: VectorPublicationService,
    style_service: VectorStyleService,
    registry: PublishedVectorRegistry,
) -> VectorFeature:
    """Create vector routes around fully constructed application services.

    Args:
        assessment_service: Authoritative selected-Item reassessment workflow.
        publication_service: Serialized exact-layer publication workflow.
        style_service: Serialized authoritative vector styling workflow.
        registry: Process-local vector WMS authorization registry.

    Returns:
        Router and registry forming the vector feature boundary.
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

    @router.post("/layers", response_model=PublishedVector)
    async def publish_vector(
        request: CatalogVectorRequest,
    ) -> PublishedVector:
        """Publish one exact mounted vector layer as bounded WMS.

        Args:
            request: Authoritative Collection and Item identity.

        Returns:
            Published WMS layer identity, bounds, and fixed default style.

        Raises:
            HTTPException: If catalog, source, or GeoServer publication fails.
        """
        try:
            return await publication_service.publish(request)
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error

    @router.post("/styles", response_model=AppliedVectorStyle)
    async def style_vector(
        request: CatalogVectorStyleRequest,
    ) -> AppliedVectorStyle:
        """Apply one validated symbol to a current published vector layer.

        Args:
            request: Authoritative catalog identity and complete symbol state.

        Returns:
            Applied per-layer style identity and normalized state.

        Raises:
            HTTPException: If the Item, publication, or GeoServer style is not
                current and authorized.
        """
        try:
            return await style_service.apply(request)
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error

    @router.post(
        "/category-summaries",
        response_model=VectorCategorySummary,
    )
    async def summarize_vector_categories(
        request: CatalogVectorCategoryRequest,
    ) -> VectorCategorySummary:
        """Summarize one current scalar field through a bounded source read.

        Args:
            request: Authoritative Catalog identity and attribute field.

        Returns:
            Typed top values, observed counts, completeness, and server limits.

        Raises:
            HTTPException: If the Item, source signature, field, or bounded
                reader is not current and authorized for this operation.
        """
        try:
            return await style_service.summarize_categories(request)
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error

    return VectorFeature(router=router, registry=registry)
