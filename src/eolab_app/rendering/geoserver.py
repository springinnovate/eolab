"""Shared strict GeoServer REST transport for publication adapters."""

import logging
import re
from collections.abc import Callable
from typing import Any

import httpx2

from eolab_app.rendering.errors import PublicationFailureCategory


GEOSERVER_WORKSPACE_NAME = "eolab"
GEOSERVER_ERROR_EXCERPT_LIMIT = 512
PublicationErrorFactory = Callable[[PublicationFailureCategory, str], Exception]

_SECRET_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)(\b(?:authorization|credential|password|secret|token)s?\b"
    r"\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;}<]+)"
)
_SECRET_XML_PATTERN = re.compile(
    r"(?is)(<(?:authorization|credential|password|secret|token)>).*?"
    r"(</(?:authorization|credential|password|secret|token)>)"
)
_AUTH_VALUE_PATTERN = re.compile(r"(?i)\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+")
_URL_CREDENTIAL_PATTERN = re.compile(r"(?i)(https?://)[^\s/:@]+:[^\s/@]+@")
_FILE_URL_PATTERN = re.compile(r"(?i)\bfile:(?:/{1,3})?[^\s<>'\"]+")
_CONTROL_PATTERN = re.compile(r"[\x00-\x1f\x7f]+")
_WHITESPACE_PATTERN = re.compile(r"\s+")


def geoserver_layer_path(resource_name: str) -> str:
    """Build the workspace-relative REST path for one WMS layer.

    Args:
        resource_name: Stable unqualified GeoServer resource name.

    Returns:
        REST path for the layer inside EOLab's workspace.
    """
    return f"/workspaces/{GEOSERVER_WORKSPACE_NAME}/layers/{resource_name}"


def sanitize_geoserver_error_excerpt(response_content: bytes) -> str:
    """Return a bounded, single-line, secret-redacted response excerpt.

    Args:
        response_content: Raw GeoServer response bytes.

    Returns:
        Log-safe response excerpt of at most the configured limit plus an
        optional ellipsis.
    """
    bounded_content = response_content[: GEOSERVER_ERROR_EXCERPT_LIMIT + 1]
    was_truncated = len(bounded_content) > GEOSERVER_ERROR_EXCERPT_LIMIT
    excerpt = bounded_content[:GEOSERVER_ERROR_EXCERPT_LIMIT].decode(
        "utf-8", errors="replace"
    )
    excerpt = _URL_CREDENTIAL_PATTERN.sub(r"\1[redacted]@", excerpt)
    excerpt = _AUTH_VALUE_PATTERN.sub(r"\1 [redacted]", excerpt)
    excerpt = _SECRET_ASSIGNMENT_PATTERN.sub(r"\1[redacted]", excerpt)
    excerpt = _SECRET_XML_PATTERN.sub(r"\1[redacted]\2", excerpt)
    excerpt = _FILE_URL_PATTERN.sub("file:[redacted]", excerpt)
    excerpt = _WHITESPACE_PATTERN.sub(" ", _CONTROL_PATTERN.sub(" ", excerpt)).strip()
    if not excerpt:
        excerpt = "<empty>"
    if was_truncated or len(excerpt) > GEOSERVER_ERROR_EXCERPT_LIMIT:
        excerpt = f"{excerpt[:GEOSERVER_ERROR_EXCERPT_LIMIT]}…"
    return excerpt


class GeoServerPublicationGateway:
    """Enforce transport, status, sanitization, and failure-category contracts."""

    def __init__(
        self,
        geoserver_client: httpx2.AsyncClient,
        geoserver_internal_url: str,
        publication_kind: str,
        error_factory: PublicationErrorFactory,
        failure_classifier: Callable[
            [str, int, str], tuple[PublicationFailureCategory, str]
        ],
    ) -> None:
        """Create the shared transport boundary.

        Args:
            geoserver_client: Authenticated GeoServer REST client.
            geoserver_internal_url: Internal GeoServer base URL.
            publication_kind: Stable diagnostic domain name.
            error_factory: Builds the owning domain's publication error.
            failure_classifier: Maps rejected responses to public failures.
        """
        self._client = geoserver_client
        self._rest_url = f"{geoserver_internal_url.rstrip('/')}/rest"
        self._publication_kind = publication_kind
        self._error_factory = error_factory
        self._failure_classifier = failure_classifier
        self._logger = logging.getLogger(f"eolab_app.{publication_kind}.geoserver")

    async def resource_exists(self, operation: str, path: str) -> bool:
        """Inspect one resource through the exact 200-or-404 contract.

        Args:
            operation: Stable diagnostic operation name.
            path: Path below the GeoServer REST endpoint.

        Returns:
            True for 200 and false for 404.
        """
        response = await self.request(
            operation, "GET", path, accepted_statuses=frozenset({200, 404})
        )
        return response.status_code == 200

    async def request(
        self,
        operation: str,
        method: str,
        path: str,
        accepted_statuses: frozenset[int],
        **request_arguments: Any,
    ) -> httpx2.Response:
        """Issue one REST operation and require an explicitly accepted status.

        Args:
            operation: Stable diagnostic operation name.
            method: GeoServer REST HTTP method.
            path: Path below the GeoServer REST endpoint.
            accepted_statuses: Complete accepted response-status set.
            **request_arguments: HTTPX request arguments owned by the adapter.

        Returns:
            Accepted GeoServer response.

        Raises:
            Exception: The owning domain's categorized publication error.
        """
        try:
            response = await self._client.request(
                method, f"{self._rest_url}{path}", **request_arguments
            )
        except httpx2.TimeoutException as error:
            self._logger.warning(
                "GeoServer %s publication failed: operation=%s status=unavailable detail=request timed out",
                self._publication_kind,
                operation,
            )
            raise self._error_factory(
                "timeout", "The rendering service timed out. Retry the publication."
            ) from error
        except httpx2.RequestError as error:
            self._logger.warning(
                "GeoServer %s publication failed: operation=%s status=unavailable detail=connection failed",
                self._publication_kind,
                operation,
            )
            raise self._error_factory(
                "connectivity",
                "The rendering service is unavailable. Retry when the service is reachable.",
            ) from error
        if response.status_code not in accepted_statuses:
            raise self.response_error(operation, response)
        return response

    def response_error(
        self, operation: str, response: httpx2.Response
    ) -> Exception:
        """Classify, log, and build one rejected response error.

        Args:
            operation: Stable diagnostic operation name.
            response: Rejected GeoServer response.

        Returns:
            Owning domain's categorized publication error.
        """
        excerpt = sanitize_geoserver_error_excerpt(response.content)
        self._logger.warning(
            "GeoServer %s publication failed: operation=%s status=%s detail=%s",
            self._publication_kind,
            operation,
            response.status_code,
            excerpt,
        )
        category, detail = self._failure_classifier(
            operation, response.status_code, excerpt
        )
        return self._error_factory(category, detail)
