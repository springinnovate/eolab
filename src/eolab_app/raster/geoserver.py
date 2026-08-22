"""Recoverable GeoServer REST adapter for raster publication."""

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx2

from eolab_app.raster.errors import (
    RasterPublicationError,
    RasterPublicationFailureCategory,
    RasterUpstreamError,
)
from eolab_app.raster.models import RasterReaderAssessment


GEOSERVER_WORKSPACE_NAME = "eolab"
GEOSERVER_RASTER_STYLE_NAME = "dynamic-raster"
GEOSERVER_ERROR_EXCERPT_LIMIT = 512
LOGGER = logging.getLogger(__name__)

_SECRET_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)(\b(?:authorization|credential|password|secret|token)s?\b"
    r"\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;}<]+)"
)
_SECRET_XML_PATTERN = re.compile(
    r"(?is)(<(?:authorization|credential|password|secret|token)>).*?"
    r"(</(?:authorization|credential|password|secret|token)>)"
)
_AUTH_VALUE_PATTERN = re.compile(
    r"(?i)\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+"
)
_URL_CREDENTIAL_PATTERN = re.compile(
    r"(?i)(https?://)[^\s/:@]+:[^\s/@]+@"
)
_FILE_URL_PATTERN = re.compile(r"(?i)\bfile:(?:/{1,3})?[^\s<>'\"]+")
_CONTROL_PATTERN = re.compile(r"[\x00-\x1f\x7f]+")
_WHITESPACE_PATTERN = re.compile(r"\s+")
_READER_REJECTION_PATTERN = re.compile(
    r"(?i)(could not acquire reader|unable to (?:find|determine).*crs|"
    r"coordinate reference system|coverage.*(?:reader|crs)|"
    r"(?:reader|crs|projection).*coverage)"
)


class GeoServerRasterReaderAssessor:
    """Probe mounted GeoTIFFs with the deployed GeoTools reader.

    The adapter owns only the authenticated, read-only assessment protocol. It
    never creates or updates GeoServer catalog resources.
    """

    def __init__(
        self,
        geoserver_client: httpx2.AsyncClient,
        geoserver_internal_url: str,
    ) -> None:
        """Create the read-only reader-assessment adapter.

        Args:
            geoserver_client: Authenticated internal GeoServer client.
            geoserver_internal_url: Internal GeoServer base URL.

        Returns:
            None.
        """
        self._geoserver_client = geoserver_client
        self._assessment_url = (
            f"{geoserver_internal_url.rstrip('/')}/rest/eolab/"
            "reader-assessments"
        )

    async def assess(self, source_path: Path) -> RasterReaderAssessment:
        """Acquire one source through GeoServer without changing its catalog.

        Args:
            source_path: Canonical mounted GeoTIFF path shared with GeoServer.

        Returns:
            Validated deployed-reader compatibility result.

        Raises:
            RasterUpstreamError: If GeoServer is unavailable, rejects the
                request, or returns an invalid assessment document.
        """
        try:
            response = await self._geoserver_client.post(
                self._assessment_url,
                content=source_path.as_uri(),
                headers={
                    "Accept": "application/json",
                    "Content-Type": "text/plain",
                },
            )
        except httpx2.RequestError as error:
            raise RasterUpstreamError(
                "The rendering service is unavailable"
            ) from error
        if response.status_code != 200:
            raise RasterUpstreamError(
                "GeoServer could not assess the selected GeoTIFF"
            )
        try:
            return RasterReaderAssessment.model_validate(response.json())
        except ValueError as error:
            raise RasterUpstreamError(
                "GeoServer returned an invalid raster assessment"
            ) from error


@dataclass(frozen=True)
class GeoServerPublicationState:
    """Snapshot the GeoServer resources required by one raster publication.

    Attributes:
        workspace_exists: Whether EOLab's initialized workspace exists.
        style_exists: Whether the shared raster style exists in the workspace.
        coverage_store_exists: Whether the raster's coverage store exists.
        coverage_exists: Whether the store's configured coverage exists.
        layer_exists: Whether the workspace layer exists.
    """

    workspace_exists: bool
    style_exists: bool
    coverage_store_exists: bool
    coverage_exists: bool
    layer_exists: bool


def sanitize_geoserver_error_excerpt(response_content: bytes) -> str:
    """Return a bounded log-safe excerpt of a GeoServer response body.

    Args:
        response_content: Raw upstream response bytes already read by HTTPX.

    Returns:
        A single-line excerpt with common secret forms and file URLs redacted.
    """
    bounded_content = response_content[: GEOSERVER_ERROR_EXCERPT_LIMIT + 1]
    was_truncated = len(bounded_content) > GEOSERVER_ERROR_EXCERPT_LIMIT
    excerpt = bounded_content[:GEOSERVER_ERROR_EXCERPT_LIMIT].decode(
        "utf-8",
        errors="replace",
    )
    excerpt = _URL_CREDENTIAL_PATTERN.sub(r"\1[redacted]@", excerpt)
    excerpt = _AUTH_VALUE_PATTERN.sub(r"\1 [redacted]", excerpt)
    excerpt = _SECRET_ASSIGNMENT_PATTERN.sub(r"\1[redacted]", excerpt)
    excerpt = _SECRET_XML_PATTERN.sub(r"\1[redacted]\2", excerpt)
    excerpt = _FILE_URL_PATTERN.sub("file:[redacted]", excerpt)
    excerpt = _WHITESPACE_PATTERN.sub(
        " ",
        _CONTROL_PATTERN.sub(" ", excerpt),
    ).strip()
    if not excerpt:
        excerpt = "<empty>"
    if was_truncated or len(excerpt) > GEOSERVER_ERROR_EXCERPT_LIMIT:
        excerpt = excerpt[:GEOSERVER_ERROR_EXCERPT_LIMIT]
        excerpt = f"{excerpt}…"
    return excerpt


class GeoServerRasterPublisher:
    """Converge mounted GeoTIFFs to healthy private GeoServer publications."""

    def __init__(
        self,
        geoserver_client: httpx2.AsyncClient,
        geoserver_internal_url: str,
    ) -> None:
        """Create an adapter over an authenticated shared GeoServer client.

        Args:
            geoserver_client: Authenticated GeoServer REST client.
            geoserver_internal_url: Internal GeoServer base URL.

        Returns:
            None.
        """
        self._geoserver_client = geoserver_client
        self._geoserver_rest_url = (
            f"{geoserver_internal_url.rstrip('/')}/rest"
        )

    async def publish(self, resource_name: str, source_path: Path) -> None:
        """Converge and style one mounted GeoTIFF publication.

        Clean resources are created, complete resources are preserved, and a
        coverage-store-only orphan is deleted before one clean retry. Mixed
        states that could contain a useful coverage or layer are preserved for
        administrator inspection. A failure after successful layer creation
        also preserves the healthy store, coverage, and layer so a later call
        can retry only style reconciliation.

        Args:
            resource_name: Stable GeoServer coverage and layer name.
            source_path: Canonical mounted GeoTIFF path.

        Returns:
            None after the store, coverage, layer, and style are reconciled.

        Raises:
            RasterPublicationError: If GeoServer is unavailable, its
                initialized prerequisites are missing, its resource state is
                unsafe to reconcile, or it rejects publication or styling.
        """
        state = await self._inspect_publication_state(resource_name)
        self._require_initialized_prerequisites(state)

        if self._is_coverage_store_only(state):
            await self._delete_coverage_store(
                resource_name,
                "delete orphan coverage store",
            )
            state = await self._inspect_publication_state(resource_name)
            self._require_initialized_prerequisites(state)

        if self._is_clean(state):
            await self._create_publication(resource_name, source_path)
        elif not self._is_complete(state):
            raise self._state_error(
                "configuration",
                (
                    "The rendering service has an inconsistent existing "
                    "publication. Ask an administrator to inspect the raster "
                    "resources, then retry."
                ),
                "reconcile raster resources",
                state,
            )

        await self._assign_style(resource_name)

    async def _inspect_publication_state(
        self,
        resource_name: str,
    ) -> GeoServerPublicationState:
        """Inspect the initialized resources and one raster publication.

        Args:
            resource_name: Stable GeoServer coverage and layer name.

        Returns:
            Exact existence snapshot derived only from accepted 200 and 404
            responses.

        Raises:
            RasterPublicationError: If any inspection request fails or returns
                a response outside the explicit 200-or-404 contract.
        """
        workspace_exists = await self._resource_exists(
            "inspect workspace",
            (
                f"/workspaces/{GEOSERVER_WORKSPACE_NAME}.json"
                "?quietOnNotFound=true"
            ),
        )
        if not workspace_exists:
            return GeoServerPublicationState(False, False, False, False, False)

        style_exists = await self._resource_exists(
            "inspect raster style",
            (
                f"/workspaces/{GEOSERVER_WORKSPACE_NAME}/styles/"
                f"{GEOSERVER_RASTER_STYLE_NAME}.sld?quietOnNotFound=true"
            ),
        )
        coverage_store_exists = await self._resource_exists(
            "inspect coverage store",
            f"{self._coverage_store_url(resource_name)}.json"
            "?quietOnNotFound=true",
        )
        coverage_exists = await self._resource_exists(
            "inspect coverage",
            f"{self._coverage_url(resource_name)}.json?quietOnNotFound=true",
        )
        layer_exists = await self._resource_exists(
            "inspect raster layer",
            f"{self._layer_url(resource_name)}.json?quietOnNotFound=true",
        )
        return GeoServerPublicationState(
            workspace_exists,
            style_exists,
            coverage_store_exists,
            coverage_exists,
            layer_exists,
        )

    async def _resource_exists(self, operation: str, path: str) -> bool:
        """Inspect one GeoServer resource through an exact response contract.

        Args:
            operation: Stable diagnostic name for the REST operation.
            path: Path below the configured GeoServer REST endpoint.

        Returns:
            ``True`` for 200 or ``False`` for 404.

        Raises:
            RasterPublicationError: If transport fails or GeoServer returns
                any other response status.
        """
        response = await self._request(
            operation,
            "GET",
            path,
            accepted_statuses=frozenset({200, 404}),
        )
        return response.status_code == 200

    async def _create_publication(
        self,
        resource_name: str,
        source_path: Path,
    ) -> None:
        """Create a clean external GeoTIFF store and verify its layer.

        Args:
            resource_name: Stable GeoServer coverage and layer name.
            source_path: Canonical mounted GeoTIFF path.

        Returns:
            None after GeoServer returns 201 and exposes the complete resource
            set.

        Raises:
            RasterPublicationError: If creation fails, returns a status other
                than 201, or does not produce a complete publication.
        """
        try:
            await self._request(
                "create external GeoTIFF publication",
                "PUT",
                f"{self._coverage_store_url(resource_name)}/external.geotiff",
                accepted_statuses=frozenset({201}),
                params={
                    "configure": "first",
                    "coverageName": resource_name,
                },
                content=source_path.as_uri(),
                headers={
                    "Accept": "application/json",
                    "Content-Type": "text/plain",
                },
            )
        except RasterPublicationError:
            await self._rollback_new_publication(resource_name)
            raise

        state = await self._inspect_publication_state(resource_name)
        self._require_initialized_prerequisites(state)
        if self._is_complete(state):
            return

        await self._rollback_new_publication(resource_name)
        raise self._state_error(
            "upstream_failure",
            (
                "The rendering service returned an incomplete raster "
                "publication. Retry the request; if it persists, ask an "
                "administrator to inspect GeoServer."
            ),
            "verify created raster resources",
            state,
        )

    async def _rollback_new_publication(self, resource_name: str) -> None:
        """Best-effort remove resources created by the current failed attempt.

        The caller invokes this only after the pre-request snapshot proved that
        no store, coverage, or layer existed. A later style failure does not
        use this path, so an otherwise healthy publication is retained.

        Args:
            resource_name: Stable GeoServer coverage and layer name.

        Returns:
            None after cleanup succeeds or is safely skipped. Cleanup failures
            are logged without replacing the original publication error.
        """
        try:
            state = await self._inspect_publication_state(resource_name)
            if state.coverage_store_exists:
                await self._delete_coverage_store(
                    resource_name,
                    "roll back new coverage store",
                )
            elif state.coverage_exists or state.layer_exists:
                LOGGER.warning(
                    "GeoServer raster publication cleanup preserved an "
                    "unexpected resource without its coverage store"
                )
        except RasterPublicationError:
            LOGGER.warning(
                "GeoServer raster publication cleanup could not confirm or "
                "remove the new coverage store"
            )

    async def _delete_coverage_store(
        self,
        resource_name: str,
        operation: str,
    ) -> None:
        """Delete one known-recoverable coverage store recursively.

        Args:
            resource_name: Stable GeoServer coverage and layer name.
            operation: Stable diagnostic name describing why deletion is safe.

        Returns:
            None only when GeoServer returns its documented 200 response.

        Raises:
            RasterPublicationError: If transport fails or GeoServer returns
                any status other than 200.
        """
        await self._request(
            operation,
            "DELETE",
            self._coverage_store_url(resource_name),
            accepted_statuses=frozenset({200}),
            params={"recurse": "true"},
            headers={"Accept": "application/json"},
        )

    async def _assign_style(self, resource_name: str) -> None:
        """Idempotently assign the initialized shared style to one layer.

        Args:
            resource_name: Stable GeoServer coverage and layer name.

        Returns:
            None only when GeoServer returns its documented 200 response.

        Raises:
            RasterPublicationError: If transport fails or GeoServer returns
                any status other than 200.
        """
        await self._request(
            "assign raster style",
            "PUT",
            f"{self._layer_url(resource_name)}.xml",
            accepted_statuses=frozenset({200}),
            content=(
                "<layer><defaultStyle>"
                f"<name>{GEOSERVER_RASTER_STYLE_NAME}</name>"
                f"<workspace>{GEOSERVER_WORKSPACE_NAME}</workspace>"
                "</defaultStyle></layer>"
            ),
            headers={"Content-Type": "application/xml"},
        )

    async def _request(
        self,
        operation: str,
        method: str,
        path: str,
        accepted_statuses: frozenset[int],
        **request_arguments: Any,
    ) -> httpx2.Response:
        """Issue one REST operation and enforce its exact accepted statuses.

        Args:
            operation: Stable diagnostic name for the REST operation.
            method: HTTP method accepted by GeoServer for the operation.
            path: Path below the configured GeoServer REST endpoint.
            accepted_statuses: Complete set of successful response statuses.
            **request_arguments: HTTPX request parameters, body, and safe
                content headers required by the operation.

        Returns:
            GeoServer response whose status is explicitly accepted.

        Raises:
            RasterPublicationError: If transport fails or the response status
                is outside ``accepted_statuses``.
        """
        try:
            response = await self._geoserver_client.request(
                method,
                f"{self._geoserver_rest_url}{path}",
                **request_arguments,
            )
        except httpx2.TimeoutException as error:
            LOGGER.warning(
                "GeoServer raster publication failed: operation=%s "
                "status=unavailable detail=request timed out",
                operation,
            )
            raise RasterPublicationError(
                "timeout",
                "The rendering service timed out. Retry the publication.",
            ) from error
        except httpx2.RequestError as error:
            LOGGER.warning(
                "GeoServer raster publication failed: operation=%s "
                "status=unavailable detail=connection failed",
                operation,
            )
            raise RasterPublicationError(
                "connectivity",
                (
                    "The rendering service is unavailable. Retry when the "
                    "service is reachable."
                ),
            ) from error

        if response.status_code not in accepted_statuses:
            raise self._response_error(operation, response)
        return response

    def _response_error(
        self,
        operation: str,
        response: httpx2.Response,
    ) -> RasterPublicationError:
        """Classify, log, and return one rejected GeoServer response.

        Args:
            operation: Stable diagnostic name for the failed REST operation.
            response: GeoServer response outside the accepted status contract.

        Returns:
            Browser-safe categorized publication error for the caller to raise.
        """
        excerpt = sanitize_geoserver_error_excerpt(response.content)
        LOGGER.warning(
            "GeoServer raster publication failed: operation=%s status=%s "
            "detail=%s",
            operation,
            response.status_code,
            excerpt,
        )
        category, detail = self._classify_response_failure(
            operation,
            response.status_code,
            excerpt,
        )
        return RasterPublicationError(category, detail)

    @staticmethod
    def _classify_response_failure(
        operation: str,
        status_code: int,
        excerpt: str,
    ) -> tuple[RasterPublicationFailureCategory, str]:
        """Map a rejected response to the stable public failure contract.

        Args:
            operation: Stable diagnostic name for the failed REST operation.
            status_code: Rejected GeoServer HTTP response status.
            excerpt: Bounded sanitized response excerpt used for classification.

        Returns:
            Stable category and concise actionable browser message.
        """
        if status_code in {401, 403}:
            return (
                "authentication",
                (
                    "Rendering service authentication failed. Ask an "
                    "administrator to verify its internal credentials."
                ),
            )
        if (
            operation == "create external GeoTIFF publication"
            and _READER_REJECTION_PATTERN.search(excerpt) is not None
        ):
            return (
                "reader_rejection",
                (
                    "GeoServer could not read this raster. Check its CRS and "
                    "GeoTIFF compatibility, then retry."
                ),
            )
        return (
            "upstream_failure",
            (
                "The rendering service could not complete raster publication. "
                "Retry the request; if it persists, check the application log."
            ),
        )

    @staticmethod
    def _require_initialized_prerequisites(
        state: GeoServerPublicationState,
    ) -> None:
        """Require the initializer-owned workspace and shared raster style.

        Args:
            state: Current GeoServer publication resource snapshot.

        Returns:
            None when both initialized prerequisites exist.

        Raises:
            RasterPublicationError: If the workspace or shared style is absent.
        """
        if not state.workspace_exists:
            LOGGER.warning(
                "GeoServer raster publication failed: operation=inspect "
                "workspace status=404 detail=workspace is missing"
            )
            raise RasterPublicationError(
                "configuration",
                (
                    "The rendering workspace is not initialized. Ask an "
                    "administrator to redeploy the rendering service."
                ),
            )
        if not state.style_exists:
            LOGGER.warning(
                "GeoServer raster publication failed: operation=inspect "
                "raster style status=404 detail=style is missing"
            )
            raise RasterPublicationError(
                "configuration",
                (
                    "The raster rendering style is not initialized. Ask an "
                    "administrator to redeploy the rendering service."
                ),
            )

    @staticmethod
    def _state_error(
        category: RasterPublicationFailureCategory,
        detail: str,
        operation: str,
        state: GeoServerPublicationState,
    ) -> RasterPublicationError:
        """Log and return a failure derived from an unsafe resource snapshot.

        Args:
            category: Stable public publication failure category.
            detail: Concise actionable browser message.
            operation: Stable diagnostic name for the failed transition.
            state: Current GeoServer publication resource snapshot.

        Returns:
            Categorized publication error for the caller to raise.
        """
        LOGGER.warning(
            "GeoServer raster publication failed: operation=%s status=state "
            "detail=workspace:%s style:%s store:%s coverage:%s layer:%s",
            operation,
            state.workspace_exists,
            state.style_exists,
            state.coverage_store_exists,
            state.coverage_exists,
            state.layer_exists,
        )
        return RasterPublicationError(category, detail)

    @staticmethod
    def _is_clean(state: GeoServerPublicationState) -> bool:
        """Return whether no raster-specific GeoServer resource exists.

        Args:
            state: Current GeoServer publication resource snapshot.

        Returns:
            Whether the coverage store, coverage, and layer are all absent.
        """
        return not (
            state.coverage_store_exists
            or state.coverage_exists
            or state.layer_exists
        )

    @staticmethod
    def _is_complete(state: GeoServerPublicationState) -> bool:
        """Return whether every raster-specific GeoServer resource exists.

        Args:
            state: Current GeoServer publication resource snapshot.

        Returns:
            Whether the coverage store, coverage, and layer are all present.
        """
        return (
            state.coverage_store_exists
            and state.coverage_exists
            and state.layer_exists
        )

    @staticmethod
    def _is_coverage_store_only(state: GeoServerPublicationState) -> bool:
        """Return whether the exact recoverable orphan-store state exists.

        Args:
            state: Current GeoServer publication resource snapshot.

        Returns:
            Whether only the coverage store exists for the raster.
        """
        return (
            state.coverage_store_exists
            and not state.coverage_exists
            and not state.layer_exists
        )

    @staticmethod
    def _coverage_store_url(resource_name: str) -> str:
        """Build the workspace-relative coverage store REST path.

        Args:
            resource_name: Stable GeoServer coverage store name.

        Returns:
            Path below the configured GeoServer REST endpoint.
        """
        return (
            f"/workspaces/{GEOSERVER_WORKSPACE_NAME}/coveragestores/"
            f"{resource_name}"
        )

    @classmethod
    def _coverage_url(cls, resource_name: str) -> str:
        """Build the workspace-relative configured coverage REST path.

        Args:
            resource_name: Stable GeoServer coverage and store name.

        Returns:
            Path below the configured GeoServer REST endpoint.
        """
        return (
            f"{cls._coverage_store_url(resource_name)}/coverages/"
            f"{resource_name}"
        )

    @staticmethod
    def _layer_url(resource_name: str) -> str:
        """Build the workspace-relative layer REST path.

        Args:
            resource_name: Stable GeoServer layer name.

        Returns:
            Path below the configured GeoServer REST endpoint.
        """
        return (
            f"/workspaces/{GEOSERVER_WORKSPACE_NAME}/layers/{resource_name}"
        )
