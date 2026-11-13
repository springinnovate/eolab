"""Expose owned run vectors through the ordinary vector rendering services."""

from collections.abc import Awaitable, Callable
from typing import Annotated, Any, TypeVar

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, Response

from eolab_app.routes.http_disconnect import (
    HttpClientDisconnectedError,
    run_until_http_disconnect,
)
from eolab_app.routes.vector_http import PrivateVectorRoute
from eolab_app.source_files import SourceFileError
from eolab_app.vector.artifact_sources import (
    ArtifactVectorLayer,
    ArtifactVectorSourceResolver,
)
from eolab_app.vector.filters import (
    AppliedVectorFilter,
    VectorFilterCount,
    VectorFilterRequest,
)
from eolab_app.vector.models import (
    ArtifactVectorDescription,
    AppliedVectorStyle,
    PublishedVector,
    VectorCategoryRequest,
    VectorCategorySummary,
    VectorNumericClassificationRequest,
    VectorNumericClassificationSummary,
    VectorStyleRequest,
)
from eolab_app.vector.publication import VectorPublicationService
from eolab_app.vector.styling import VectorStyleService
from eolab_app.vector.extent_operation import FeatureExtent
from eolab_app.vector_field_values import (
    VectorFieldValuePage,
    VectorFieldValueQuery,
    VectorFieldValuesUnavailable,
    page_field_values,
)

ArtifactId = Annotated[str, Path(pattern=r"^[a-f0-9]{32}$")]
Result = TypeVar("Result")


def create_artifact_vector_router(
    sources: ArtifactVectorSourceResolver,
    publication: VectorPublicationService,
    styles: VectorStyleService,
    read_owner: Callable[[Request, Response], str],
) -> APIRouter:
    """Connect private result identities to existing vector map and field operations.

    Args:
        sources: Neutral owned-file access and immutable vector metadata.
        publication: Existing GeoServer publication and filter owner.
        styles: Existing vector style and numeric/category field reader.
        read_owner: Composition-supplied Processing session and mutation boundary.

    Returns:
        Private routes using run/file IDs; no catalog registration or analysis selection.
    """
    router = APIRouter(
        prefix="/api/vector-rendering/artifacts/{job_id}/{artifact_id}",
        tags=["rendering"],
        route_class=PrivateVectorRoute,
    )

    def identify(
        job_id: ArtifactId,
        artifact_id: ArtifactId,
        request: Request,
        response: Response,
    ) -> tuple[str, str, str]:
        """Read the browser identity accompanying a path-free result request.

        Args:
            job_id: Validated run ID from the route path.
            artifact_id: Validated file ID from the route path.
            request: HTTP credentials and mutation headers.
            response: Response receiving the renewed private session cookie.

        Returns:
            Server-derived owner, run ID and file ID.

        Raises:
            HTTPException: If the mutation lacks same-origin authorization.
        """
        return read_owner(request, response), job_id, artifact_id

    Identity = Annotated[tuple[str, str, str], Depends(identify)]

    async def apply_to_layer(
        identity: tuple[str, str, str],
        request: Request,
        action: Callable[[ArtifactVectorLayer], Awaitable[Result]],
    ) -> Result:
        """Retain an owned original file until its requested operation stops.

        Args:
            identity: Server-derived owner and opaque run/file IDs.
            request: Browser connection whose departure cancels native work.
            action: Existing vector operation using the authorized metadata.

        Returns:
            Operation result after source ownership and expiry are rechecked.

        Raises:
            SourceFileError: If ownership, expiry or native source access fails.
            HTTPException: If the browser disconnects.
        """

        async def read() -> Result:
            """Run the supplied operation within its renewable original-file lease.

            Returns:
                Completed vector operation result after successful authorization.

            Raises:
                SourceFileError: If source access fails before or after the operation.
            """
            async with sources.open_layer(*identity) as metadata:
                return await action(metadata)

        try:
            return await run_until_http_disconnect(request, read())
        except HttpClientDisconnectedError as error:
            raise HTTPException(499, "Vector request cancelled") from error

    @router.get("", response_model=ArtifactVectorDescription)
    async def describe(
        identity: Identity, request: Request
    ) -> ArtifactVectorDescription:
        """Return owned result fields and bounds for the ordinary vector controls.

        Args:
            identity: Authorized browser and requested run/file IDs.
            request: Disconnect observer.

        Returns:
            Path-free source identity, native layer name, schema, count and bounds.

        Raises:
            SourceFileError: If the result cannot be read by this browser.
        """

        async def metadata(value: ArtifactVectorLayer) -> ArtifactVectorDescription:
            """Describe the immutable layer without copying file paths or credentials.

            Args:
                value: Original layer metadata supplied by its source owner.

            Returns:
                Public vector metadata used by the ordinary map adapter.
            """
            layer = value.layer
            return ArtifactVectorDescription(
                job_id=identity[1],
                artifact_id=identity[2],
                layer_name=layer.source.layer_name,
                fields=layer.fields,
                feature_count=layer.feature_count,
                bbox=layer.bbox,
                geometry_kind=layer.geometry_kind,
            )

        return await apply_to_layer(identity, request, metadata)

    @router.post("/layers", response_model=PublishedVector)
    async def publish(identity: Identity, request: Request) -> PublishedVector:
        """Publish the owned result through the ordinary GeoServer vector renderer.

        Args:
            identity: Browser and opaque source IDs.
            request: Disconnect observer.

        Returns:
            Ordinary WMS identity, bounds and default appearance.

        Raises:
            SourceFileError: If the source expires or access is denied.
            VectorFeatureError: If GeoServer publication fails.
        """
        return await apply_to_layer(
            identity, request, lambda value: publication.publish_layer(value.layer)
        )

    @router.post("/styles", response_model=AppliedVectorStyle)
    async def style(
        identity: Identity, body: VectorStyleRequest, request: Request
    ) -> AppliedVectorStyle:
        """Apply ordinary vector appearance to the owned immutable result.

        Args:
            identity: Browser and opaque source IDs.
            body: Complete appearance requested by the user.
            request: Disconnect observer.

        Returns:
            Validated appearance and signed style identity.

        Raises:
            SourceFileError: If the original result is unavailable.
            VectorFeatureError: If the requested appearance is invalid.
        """
        return await apply_to_layer(
            identity,
            request,
            lambda value: styles.apply_layer_style(value.layer, body.style),
        )

    @router.post("/category-summaries", response_model=VectorCategorySummary)
    async def categories(
        identity: Identity, body: VectorCategoryRequest, request: Request
    ) -> VectorCategorySummary:
        """Read original attribute category counts through the ordinary bounded reader.

        Args:
            identity: Browser and opaque source IDs.
            body: Selected attribute field.
            request: Disconnect observer.

        Returns:
            Category values, counts and completeness.

        Raises:
            SourceFileError: If the result is unavailable.
            VectorFeatureError: If field validation or reading fails.
        """
        return await apply_to_layer(
            identity,
            request,
            lambda value: styles.summarize_layer_categories(value.layer, body.field),
        )

    @router.post(
        "/numeric-classifications", response_model=VectorNumericClassificationSummary
    )
    async def numbers(
        identity: Identity, body: VectorNumericClassificationRequest, request: Request
    ) -> VectorNumericClassificationSummary:
        """Classify a result's numeric field using the existing vector classing rules.

        Args:
            identity: Browser and opaque source IDs.
            body: Field, method and class count.
            request: Disconnect observer.

        Returns:
            Numeric classes, observed counts and completeness.

        Raises:
            SourceFileError: If the result is unavailable.
            VectorFeatureError: If field validation or reading fails.
        """
        return await apply_to_layer(
            identity,
            request,
            lambda value: styles.classify_layer_numeric(
                value.layer, body.field, body.method, body.class_count
            ),
        )

    @router.post("/filters", response_model=AppliedVectorFilter)
    async def filter_layer(
        identity: Identity, body: VectorFilterRequest, request: Request
    ) -> AppliedVectorFilter:
        """Apply ordinary attribute rules without modifying the generated result.

        Args:
            identity: Browser and opaque source IDs.
            body: Complete attribute predicate.
            request: Disconnect observer.

        Returns:
            Filtered display identity and accepted predicate.

        Raises:
            SourceFileError: If the result is unavailable.
            VectorFeatureError: If the filter is invalid.
        """
        return await apply_to_layer(
            identity,
            request,
            lambda value: publication.apply_layer_filter(value.layer, body.filter),
        )

    @router.post("/filter-counts", response_model=VectorFilterCount)
    async def count(
        identity: Identity, body: VectorFilterRequest, request: Request
    ) -> VectorFilterCount:
        """Count matching result features using the ordinary cancellable count queue.

        Args:
            identity: Browser and opaque source IDs.
            body: Complete attribute predicate.
            request: Disconnect observer.

        Returns:
            Matching and total feature counts, with explicit completeness.

        Raises:
            SourceFileError: If the result is unavailable.
            VectorFeatureError: If the predicate, queue or read fails.
        """
        return await apply_to_layer(
            identity,
            request,
            lambda value: publication.count_layer_filter(value.layer, body.filter),
        )

    @router.post("/extent", response_model=FeatureExtent)
    async def extent(
        identity: Identity, body: VectorFilterRequest, request: Request
    ) -> dict[str, Any]:
        """Measure filtered result bounds for the ordinary map zoom action.

        Args:
            identity: Browser and opaque source IDs.
            body: Complete attribute predicate.
            request: Disconnect observer.

        Returns:
            Matching count and WGS84 bounds without creating analysis inputs.

        Raises:
            SourceFileError: If the result or its bounded extent is unavailable.
        """
        return await apply_to_layer(
            identity,
            request,
            lambda value: sources.measure_layer_extent(value.layer, body.filter),
        )

    @router.get("/field-values", response_model=VectorFieldValuePage)
    async def field_values(
        identity: Identity,
        request: Request,
        query: Annotated[VectorFieldValueQuery, Query()],
    ) -> VectorFieldValuePage:
        """Page prepared string suggestions for the ordinary attribute filter editor.

        Args:
            identity: Browser and opaque source IDs.
            request: Disconnect observer.
            query: Field, search text and bounded page.

        Returns:
            Exact prepared values, continuation offset and truncation status.

        Raises:
            SourceFileError: If the result or requested field is unavailable.
        """

        async def page(value: ArtifactVectorLayer) -> VectorFieldValuePage:
            """Search prepared field choices without rereading the original vector.

            Args:
                value: Immutable original layer and its prepared text inventory.

            Returns:
                Matching page of string values.

            Raises:
                SourceFileError: If this field has no prepared string inventory.
            """
            try:
                return page_field_values(value.field_values, query)
            except VectorFieldValuesUnavailable as error:
                raise SourceFileError(str(error), 422) from error

        return await apply_to_layer(identity, request, page)

    return router
