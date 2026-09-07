"""FastAPI delivery boundary for catalog vector visualization."""

from dataclasses import dataclass

from fastapi import APIRouter, HTTPException, Request
from eolab_app.routes.http_disconnect import HttpClientDisconnectedError, run_until_http_disconnect
from eolab_app.vector.filters import AppliedVectorFilter, CatalogVectorFilterRequest, VectorFilterCount

from eolab_app.routes.vector_http import vector_http_exception
from eolab_app.vector.errors import VectorFeatureError
from eolab_app.vector.assessment import VectorAssessmentService
from eolab_app.vector.models import (
    AppliedVectorStyle,
    CatalogVectorCategoryRequest,
    CatalogVectorNumericClassificationRequest,
    CatalogVectorRequest,
    CatalogVectorStyleRequest,
    PublishedVector,
    VectorCategorySummary,
    VectorNumericClassificationSummary,
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
        style_service: Authoritative styling and bounded field-class workflow.
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
        """Apply one validated style to a current published vector layer.

        Args:
            request: Authoritative catalog identity and complete style state.

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

    @router.post(
        "/numeric-classifications",
        response_model=VectorNumericClassificationSummary,
    )
    async def classify_vector_numeric_field(
        request: CatalogVectorNumericClassificationRequest,
    ) -> VectorNumericClassificationSummary:
        """Classify one current numeric field through a bounded source read.

        Args:
            request: Catalog identity, numeric field, method, and class count.

        Returns:
            Open-ended numeric classes, counts, extent, completeness, and
            server-advertised class-count limits.

        Raises:
            HTTPException: If the Item, source signature, numeric field, or
                bounded reader cannot safely satisfy the operation.
        """
        try:
            return await style_service.classify_numeric(request)
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error

    @router.post("/filters", response_model=AppliedVectorFilter)
    async def filter_vector(request: CatalogVectorFilterRequest) -> AppliedVectorFilter:
        """Authorize one per-map attribute filter.

        Args:
            request: Authoritative Catalog identity and bounded rules.

        Returns:
            Browser-safe rendering identity and validated rules.

        Raises:
            HTTPException: If validation or current source authorization fails.
        """
        try:
            return await publication_service.apply_filter(request)
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error

    @router.post("/filter-counts", response_model=VectorFilterCount)
    async def count_vector_filter(request: CatalogVectorFilterRequest, http_request: Request) -> VectorFilterCount:
        """Count a filtered layer independently of viewport rendering.

        Args:
            request: Authoritative Catalog identity and bounded rules.
            http_request: Connection owning cancellable count work.

        Returns:
            Exact matched/total counts or explicit unavailable counts.

        Raises:
            HTTPException: If validation fails or the browser disconnects.
        """
        try:
            return await run_until_http_disconnect(http_request, publication_service.count_filter(request))
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error
        except HttpClientDisconnectedError as error:
            raise HTTPException(status_code=499, detail="The filter count request was canceled") from error

    return VectorFeature(router=router, registry=registry)
