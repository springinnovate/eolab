"""Publish, style and filter catalog vectors and browser-owned polygon uploads."""

from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from eolab_app.routes.browser_identity import get_browser_owner_hash
from eolab_app.routes.http_disconnect import HttpClientDisconnectedError, run_until_http_disconnect
from eolab_app.vector.filters import AppliedVectorFilter, CatalogVectorFilterRequest, VectorFilterCount, VectorFilterRequest

from eolab_app.routes.vector_http import PrivateVectorRoute, vector_http_exception
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
    VectorCategoryRequest,
    VectorLayer,
    VectorNumericClassificationRequest,
    VectorStyleRequest,
)
from eolab_app.vector.publication import VectorPublicationService
from eolab_app.vector.sources import PublishedVectorRegistry
from eolab_app.vector.styling import VectorStyleService
from eolab_app.vector.uploaded_sources import UploadedVectorSourceResolver


@dataclass(frozen=True)
class VectorFeature:
    """Vector rendering routes and the registry authorizing their WMS layers.

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
        style_service: Validates styles and reads field values for classification.
        registry: Process-local vector WMS authorization registry.

    Returns:
        Vector rendering router and its layer-authorization registry.
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
        """Publish the selected catalog vector layer through GeoServer WMS.

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
            HTTPException: If the Item, source binding, field, or bounded
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
            HTTPException: If the Item, source binding, numeric field, or
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
        """Wait for capacity and count a filtered layer independently of rendering.

        Args:
            request: Authoritative Catalog identity and bounded rules.
            http_request: Connection owning cancellable count work.

        Returns:
            Exact matched/total counts or explicit unavailable counts.

        Raises:
            HTTPException: If validation fails, the browser disconnects, the
                count queue is full (429), or its waiting deadline expires (503).
        """
        try:
            return await run_until_http_disconnect(http_request, publication_service.count_filter(request))
        except VectorFeatureError as error:
            raise vector_http_exception(error) from error
        except HttpClientDisconnectedError as error:
            raise HTTPException(status_code=499, detail="The filter count request was canceled") from error

    return VectorFeature(router=router, registry=registry)


def create_uploaded_vector_router(
    sources: UploadedVectorSourceResolver,
    publication_service: VectorPublicationService,
    style_service: VectorStyleService,
) -> APIRouter:
    """Expose ordinary vector rendering operations for browser-owned uploads.

    Args:
        sources: Upload ownership and original-file lookup.
        publication_service: Shared catalog/upload publication and filter service.
        style_service: Shared catalog/upload appearance and field-reading service.

    Returns:
        Private routes addressed by upload ID, without catalog registration.
        POST requests require the same-origin X-EOLab-Uploads: 1 header.
    """
    router = APIRouter(
        prefix="/api/vector-rendering/uploads/{identifier}",
        tags=["rendering"],
        route_class=PrivateVectorRoute,
    )

    async def upload_layer(
        identifier: UUID, request: Request, response: Response
    ) -> VectorLayer:
        """Authorize this browser's upload before any native or GeoServer work.

        Args:
            identifier: Upload ID from the route path.
            request: Request carrying the private browser cookie and upload header.
            response: Response renewing that cookie.

        Returns:
            Original file and metadata for the shared rendering services.

        Raises:
            HTTPException: If the browser request is not same-origin.
            VectorUploadError: If the upload is unavailable or cannot be read.
        """
        owner = get_browser_owner_hash(
            request, response, mutation_header="X-EOLab-Uploads"
        )
        return await sources.get_layer(owner, identifier)

    Layer = Annotated[VectorLayer, Depends(upload_layer)]

    @router.post("/layers", response_model=PublishedVector)
    async def publish_upload(layer: Layer) -> PublishedVector:
        """Publish an owned polygon upload through the ordinary GeoServer renderer.

        Args:
            layer: Upload authorized by the route dependency.

        Returns:
            WMS layer name, map extent and default polygon appearance.

        Raises:
            VectorFeatureError: If GeoServer publication fails.
        """
        await sources.prepare_publication(layer)
        return await publication_service.publish_layer(layer)

    @router.post("/styles", response_model=AppliedVectorStyle)
    async def style_upload(layer: Layer, request: VectorStyleRequest) -> AppliedVectorStyle:
        """Apply the requested appearance to an owned uploaded polygon layer.

        Args:
            layer: Upload authorized by the route dependency.
            request: Complete vector style state.

        Returns:
            Applied style name and normalized appearance.

        Raises:
            VectorFeatureError: If the style or published layer is unavailable.
        """
        return await style_service.apply_layer_style(layer, request.style)

    @router.post("/category-summaries", response_model=VectorCategorySummary)
    async def summarize_upload_categories(
        layer: Layer, request: VectorCategoryRequest
    ) -> VectorCategorySummary:
        """Read category counts from an owned upload's original attribute field.

        Args:
            layer: Upload authorized by the route dependency.
            request: Attribute field to summarize.

        Returns:
            Category values and counts within the ordinary interactive read budget.

        Raises:
            VectorFeatureError: If the field or bounded native read fails.
        """
        return await style_service.summarize_layer_categories(layer, request.field)

    @router.post("/numeric-classifications", response_model=VectorNumericClassificationSummary)
    async def classify_upload_numbers(
        layer: Layer, request: VectorNumericClassificationRequest
    ) -> VectorNumericClassificationSummary:
        """Calculate numeric style classes from an owned upload's attribute field.

        Args:
            layer: Upload authorized by the route dependency.
            request: Numeric field, classification method and class count.

        Returns:
            Class breaks and counts within the ordinary interactive read budget.

        Raises:
            VectorFeatureError: If field validation or bounded native reading fails.
        """
        return await style_service.classify_layer_numeric(
            layer, request.field, request.method, request.class_count
        )

    @router.post("/filters", response_model=AppliedVectorFilter)
    async def filter_upload(layer: Layer, request: VectorFilterRequest) -> AppliedVectorFilter:
        """Apply attribute rules to an owned upload's displayed features.

        Args:
            layer: Upload authorized by the route dependency.
            request: Complete vector filter state.

        Returns:
            Filtered rendering identity without changing the original file.

        Raises:
            VectorFeatureError: If the predicate or published layer is invalid.
        """
        return await publication_service.apply_layer_filter(layer, request.filter)

    @router.post("/filter-counts", response_model=VectorFilterCount)
    async def count_upload_filter(
        layer: Layer, request: VectorFilterRequest, http_request: Request
    ) -> VectorFilterCount:
        """Count an upload's matching features through the ordinary count queue.

        Args:
            layer: Upload authorized by the route dependency.
            request: Complete vector filter state.
            http_request: Browser connection owning cancellable count work.

        Returns:
            Exact matched/total counts or explicit unavailable counts.

        Raises:
            VectorFeatureError: If the predicate, native reader or queue fails.
            HTTPException: If the browser disconnects while waiting for the count.
        """
        try:
            return await run_until_http_disconnect(
                http_request, publication_service.count_layer_filter(layer, request.filter)
            )
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "The filter count request was canceled") from error

    return router
