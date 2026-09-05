"""Deployed-reader and convergent GeoServer adapters for catalog vectors."""

import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx2

from eolab_app.rendering.errors import PublicationFailureCategory
from eolab_app.rendering.geoserver import (
    GEOSERVER_WORKSPACE_NAME,
    GeoServerPublicationGateway,
    geoserver_layer_path,
)
from eolab_app.rendering.geowebcache import GeoWebCacheLayerConfigurator
from eolab_app.vector.errors import VectorPublicationError, VectorUpstreamError
from eolab_app.vector.models import (
    VectorFormat,
    VectorGeometryKind,
    VectorReaderAssessment,
    VectorStyle,
)
from eolab_app.vector.styles import (
    build_vector_sld,
    vector_label_rendering_buffer,
    vector_style_name,
)


GEOSERVER_VECTOR_STYLE_NAMES: dict[VectorGeometryKind, str] = {
    "point": "vector-point",
    "line": "vector-line",
    "polygon": "vector-polygon",
}
LOGGER = logging.getLogger(__name__)
_VECTOR_READER_REJECTION_PATTERN = re.compile(
    r"(?i)(could not|failed|unable|no such|not found|datastore|feature type|crs)"
)


class GeoServerVectorReaderAssessor:
    """Probe exact vector layers with deployed GeoTools datastore factories."""

    def __init__(
        self,
        geoserver_client: httpx2.AsyncClient,
        geoserver_internal_url: str,
    ) -> None:
        """Create the authenticated read-only assessment adapter.

        Args:
            geoserver_client: Authenticated internal GeoServer client.
            geoserver_internal_url: Internal GeoServer base URL.
        """
        self._geoserver_client = geoserver_client
        self._assessment_url = (
            f"{geoserver_internal_url.rstrip('/')}/rest/eolab/"
            "vector-reader-assessments"
        )

    async def assess(
        self,
        source_format: VectorFormat,
        source_path: Path,
        layer_name: str,
    ) -> VectorReaderAssessment:
        """Open one exact source layer without changing GeoServer state.

        Args:
            source_format: Explicit mounted source format.
            source_path: Canonical mounted source file.
            layer_name: Exact native layer selected by the catalog Item.

        Returns:
            Validated deployed-reader result.

        Raises:
            VectorUpstreamError: If GeoServer is unavailable, rejects the
                request, or returns an invalid assessment document.
        """
        try:
            response = await self._geoserver_client.post(
                self._assessment_url,
                data={
                    "sourceUri": source_path.as_uri(),
                    "sourceFormat": source_format,
                    "layerName": layer_name,
                },
                headers={"Accept": "application/json"},
            )
        except httpx2.RequestError as error:
            raise VectorUpstreamError(
                "The rendering service is unavailable"
            ) from error
        if response.status_code != 200:
            raise VectorUpstreamError(
                "GeoServer could not assess the selected vector layer"
            )
        try:
            return VectorReaderAssessment.model_validate(response.json())
        except ValueError as error:
            raise VectorUpstreamError(
                "GeoServer returned an invalid vector assessment"
            ) from error


@dataclass(frozen=True)
class GeoServerVectorPublicationState:
    """Snapshot resources required by one vector publication.

    Attributes:
        workspace_exists: Whether the initializer-owned workspace exists.
        style_exists: Whether the geometry-specific style exists.
        datastore_exists: Whether the stable vector datastore exists.
        feature_type_exists: Whether the exact configured feature type exists.
        layer_exists: Whether the workspace WMS layer exists.
    """

    workspace_exists: bool
    style_exists: bool
    datastore_exists: bool
    feature_type_exists: bool
    layer_exists: bool


class GeoServerVectorPublisher:
    """Converge exact mounted vector layers through the shared REST boundary.

    Transport handling, exact accepted-status enforcement, response
    sanitization, and stable failure categories are supplied by a neutral
    rendering gateway. This adapter owns only vector resource topology and
    transitions.
    """

    _publication_kind = "vector"

    def __init__(
        self,
        geoserver_client: httpx2.AsyncClient,
        geoserver_internal_url: str,
    ) -> None:
        """Create a vector publisher over the shared strict REST gateway.

        Args:
            geoserver_client: Authenticated GeoServer REST client.
            geoserver_internal_url: Internal GeoServer base URL.
        """
        self._gateway = GeoServerPublicationGateway(
            geoserver_client,
            geoserver_internal_url,
            "vector",
            VectorPublicationError,
            self._classify_response_failure,
        )
        self._tile_cache = GeoWebCacheLayerConfigurator(self._gateway)

    async def publish(
        self,
        resource_name: str,
        source_format: VectorFormat,
        source_path: Path,
        layer_name: str,
        geometry_kind: VectorGeometryKind,
    ) -> str:
        """Converge and style one exact vector feature type.

        Args:
            resource_name: Stable configured feature type and WMS layer name.
            source_format: Supported mounted source format.
            source_path: Canonical mounted source file.
            layer_name: Exact native layer selected by the catalog Item.
            geometry_kind: Point, line, or polygon style family.

        Returns:
            Initialized unqualified default style name.

        Raises:
            VectorPublicationError: If GeoServer is unavailable, initialized
                prerequisites are missing, resource state is unsafe, exact
                layer identity differs, or publication/styling is rejected.
        """
        if source_format not in {"shapefile", "geopackage"}:
            raise ValueError(f"Unsupported vector publisher format: {source_format}")
        style_name = GEOSERVER_VECTOR_STYLE_NAMES[geometry_kind]
        state = await self._inspect_vector_state(resource_name, style_name)
        self._require_vector_prerequisites(state, style_name)
        if self._is_datastore_only(state):
            await self._delete_datastore(
                resource_name,
                "delete orphan vector datastore",
            )
            state = await self._inspect_vector_state(resource_name, style_name)
            self._require_vector_prerequisites(state, style_name)
        if self._is_clean_vector(state):
            await self._create_vector_publication(
                resource_name,
                source_format,
                source_path,
                layer_name,
                style_name,
            )
        elif not self._is_complete_vector(state):
            raise self._vector_state_error(
                "configuration",
                (
                    "The rendering service has an inconsistent existing vector "
                    "publication. Ask an administrator to inspect it, then retry."
                ),
                "reconcile vector resources",
                state,
            )
        await self._require_native_layer_identity(resource_name, layer_name)
        await self._assign_vector_style(resource_name, style_name)
        await self._tile_cache.configure(
            resource_name,
            allow_style_environment=False,
        )
        return style_name

    async def apply_style(
        self,
        resource_name: str,
        style: VectorStyle,
    ) -> str:
        """Create or update and assign one validated per-layer vector SLD.

        Args:
            resource_name: Stable server-derived WMS layer resource name.
            style: Complete validated geometry-specific symbol state.

        Returns:
            Deterministic unqualified style name assigned to the layer.

        Raises:
            VectorPublicationError: If the layer is absent or GeoServer rejects
                style persistence or assignment.
        """
        style_name = vector_style_name(resource_name, style)
        layer_exists = await self._gateway.resource_exists(
            "inspect vector layer before styling",
            f"{geoserver_layer_path(resource_name)}.json?quietOnNotFound=true",
        )
        if not layer_exists:
            raise VectorPublicationError(
                "configuration",
                "The published vector layer is no longer available. Add it to "
                "the map again before styling it.",
            )
        style_path = (
            f"/workspaces/{GEOSERVER_WORKSPACE_NAME}/styles/{style_name}"
        )
        style_exists = await self._gateway.resource_exists(
            "inspect per-layer vector style",
            f"{style_path}.sld?quietOnNotFound=true",
        )
        style_document = build_vector_sld(style_name, style)
        if style_exists:
            await self._gateway.request(
                "update per-layer vector style",
                "PUT",
                style_path,
                accepted_statuses=frozenset({200}),
                content=style_document,
                headers={"Content-Type": "application/vnd.ogc.sld+xml"},
            )
        else:
            await self._gateway.request(
                "create per-layer vector style",
                "POST",
                f"/workspaces/{GEOSERVER_WORKSPACE_NAME}/styles",
                accepted_statuses=frozenset({201}),
                params={"name": style_name},
                content=style_document,
                headers={"Content-Type": "application/vnd.ogc.sld+xml"},
            )
        await self._assign_vector_style(
            resource_name, style_name, rendering_buffer=vector_label_rendering_buffer(style)
        )
        return style_name

    async def _inspect_vector_state(
        self,
        resource_name: str,
        style_name: str,
    ) -> GeoServerVectorPublicationState:
        """Inspect initialized and vector-specific resources exactly.

        Args:
            resource_name: Stable feature type and WMS layer name.
            style_name: Required initializer-owned vector style.

        Returns:
            Existence snapshot derived only from 200 and 404 responses.

        Raises:
            VectorPublicationError: If inspection violates its response contract.
        """
        workspace_exists = await self._gateway.resource_exists(
            "inspect workspace",
            f"/workspaces/{GEOSERVER_WORKSPACE_NAME}.json?quietOnNotFound=true",
        )
        if not workspace_exists:
            return GeoServerVectorPublicationState(
                False, False, False, False, False
            )
        style_exists = await self._gateway.resource_exists(
            "inspect vector style",
            (
                f"/workspaces/{GEOSERVER_WORKSPACE_NAME}/styles/"
                f"{style_name}.sld?quietOnNotFound=true"
            ),
        )
        datastore_exists = await self._gateway.resource_exists(
            "inspect vector datastore",
            f"{self._datastore_url(resource_name)}.json?quietOnNotFound=true",
        )
        feature_type_exists = await self._gateway.resource_exists(
            "inspect vector feature type",
            f"{self._feature_type_url(resource_name)}.json?quietOnNotFound=true",
        )
        layer_exists = await self._gateway.resource_exists(
            "inspect vector layer",
            f"{geoserver_layer_path(resource_name)}.json?quietOnNotFound=true",
        )
        return GeoServerVectorPublicationState(
            workspace_exists,
            style_exists,
            datastore_exists,
            feature_type_exists,
            layer_exists,
        )

    async def _create_vector_publication(
        self,
        resource_name: str,
        source_format: VectorFormat,
        source_path: Path,
        layer_name: str,
        style_name: str,
    ) -> None:
        """Create a clean datastore and exact configured feature type.

        Args:
            resource_name: Stable GeoServer resource name.
            source_format: Supported mounted source format.
            source_path: Canonical mounted source file.
            layer_name: Exact native layer name.
            style_name: Initialized geometry-specific default style.

        Raises:
            VectorPublicationError: If creation or verification fails.
        """
        try:
            await self._gateway.request(
                "create vector datastore",
                "POST",
                f"/workspaces/{GEOSERVER_WORKSPACE_NAME}/datastores",
                accepted_statuses=frozenset({201}),
                json=self._datastore_document(
                    resource_name,
                    source_format,
                    source_path,
                ),
                headers={"Accept": "application/json"},
            )
            await self._gateway.request(
                "create exact vector feature type",
                "POST",
                f"{self._datastore_url(resource_name)}/featuretypes",
                accepted_statuses=frozenset({201}),
                params={"recalculate": "nativebbox,latlonbbox"},
                json={
                    "featureType": {
                        "name": resource_name,
                        "nativeName": layer_name,
                        "enabled": True,
                    }
                },
                headers={"Accept": "application/json"},
            )
        except VectorPublicationError:
            await self._rollback_new_vector_publication(resource_name)
            raise
        state = await self._inspect_vector_state(resource_name, style_name)
        self._require_vector_prerequisites(state, style_name)
        if self._is_complete_vector(state):
            return
        await self._rollback_new_vector_publication(resource_name)
        raise self._vector_state_error(
            "upstream_failure",
            (
                "The rendering service returned an incomplete vector "
                "publication. Retry; if it persists, inspect GeoServer."
            ),
            "verify created vector resources",
            state,
        )

    async def _require_native_layer_identity(
        self,
        resource_name: str,
        expected_layer_name: str,
    ) -> None:
        """Verify that a complete publication targets the selected native layer.

        Args:
            resource_name: Stable configured feature type name.
            expected_layer_name: Exact cataloged layer inside the source.

        Raises:
            VectorPublicationError: If GeoServer returns invalid metadata or a
                different native layer.
        """
        response = await self._gateway.request(
            "verify vector feature identity",
            "GET",
            f"{self._feature_type_url(resource_name)}.json",
            accepted_statuses=frozenset({200}),
            headers={"Accept": "application/json"},
        )
        try:
            feature_type = response.json()["featureType"]
            actual_name = feature_type["name"]
            actual_native_name = feature_type["nativeName"]
        except (KeyError, TypeError, ValueError) as error:
            raise VectorPublicationError(
                "configuration",
                "GeoServer returned invalid vector feature identity metadata.",
            ) from error
        if actual_name != resource_name or actual_native_name != expected_layer_name:
            LOGGER.warning(
                "GeoServer vector publication failed: operation=verify vector "
                "feature identity status=state detail=identity mismatch"
            )
            raise VectorPublicationError(
                "configuration",
                (
                    "The existing GeoServer feature type targets a different "
                    "native layer. Ask an administrator to inspect it."
                ),
            )

    async def _rollback_new_vector_publication(self, resource_name: str) -> None:
        """Best-effort remove a datastore created by the current failed attempt.

        Args:
            resource_name: Stable datastore and layer resource name.
        """
        try:
            exists = await self._gateway.resource_exists(
                "inspect new vector datastore for rollback",
                f"{self._datastore_url(resource_name)}.json?quietOnNotFound=true",
            )
            if exists:
                await self._delete_datastore(
                    resource_name,
                    "roll back new vector datastore",
                )
        except VectorPublicationError:
            LOGGER.warning(
                "GeoServer vector publication cleanup could not confirm or "
                "remove the new datastore"
            )

    async def _delete_datastore(
        self,
        resource_name: str,
        operation: str,
    ) -> None:
        """Delete one known recoverable vector datastore recursively.

        Args:
            resource_name: Stable datastore name.
            operation: Stable diagnostic operation name.

        Raises:
            VectorPublicationError: If deletion does not return exactly 200.
        """
        await self._gateway.request(
            operation,
            "DELETE",
            self._datastore_url(resource_name),
            accepted_statuses=frozenset({200}),
            params={"recurse": "true"},
            headers={"Accept": "application/json"},
        )

    async def _assign_vector_style(
        self,
        resource_name: str,
        style_name: str,
        *,
        rendering_buffer: int = 0,
    ) -> None:
        """Idempotently assign one initialized geometry-specific style.

        Args:
            resource_name: Stable WMS layer name.
            style_name: Initialized point, line, or polygon style.
            rendering_buffer: Feature-owned bounded query margin for tile edges.

        Returns:
            None after GeoServer accepts the style and rendering margin.

        Raises:
            VectorPublicationError: If style assignment is rejected.
        """
        await self._gateway.request(
            "assign vector style",
            "PUT",
            f"{geoserver_layer_path(resource_name)}.json",
            accepted_statuses=frozenset({200}),
            json={
                "layer": {
                    "defaultStyle": {
                        "name": style_name,
                        "workspace": GEOSERVER_WORKSPACE_NAME,
                    },
                    "metadata": {"entry": {"@key": "buffer", "$": str(rendering_buffer)}},
                }
            },
            headers={"Accept": "application/json"},
        )

    @staticmethod
    def _datastore_document(
        resource_name: str,
        source_format: VectorFormat,
        source_path: Path,
    ) -> dict[str, Any]:
        """Build one read-only GeoServer datastore request document.

        Args:
            resource_name: Stable datastore name.
            source_format: Supported mounted source format.
            source_path: Canonical mounted source file.

        Returns:
            GeoServer REST JSON preserving format-specific parameters.

        Raises:
            ValueError: If the format is outside this adapter.
        """
        if source_format == "shapefile":
            parameters = {
                "url": source_path.as_uri(),
                "create spatial index": "false",
            }
        elif source_format == "geopackage":
            parameters = {
                "dbtype": "geopkg",
                "database": source_path.as_uri(),
                "read_only": "true",
                "immutable": "true",
            }
        else:
            raise ValueError(f"Unsupported vector datastore: {source_format}")
        return {
            "dataStore": {
                "name": resource_name,
                "enabled": True,
                "connectionParameters": {
                    "entry": [
                        {"@key": key, "$": value}
                        for key, value in parameters.items()
                    ]
                },
            }
        }

    @staticmethod
    def _require_vector_prerequisites(
        state: GeoServerVectorPublicationState,
        style_name: str,
    ) -> None:
        """Require initializer-owned workspace and selected vector style.

        Args:
            state: Current vector publication snapshot.
            style_name: Expected initialized style.

        Raises:
            VectorPublicationError: If either prerequisite is absent.
        """
        if not state.workspace_exists:
            raise VectorPublicationError(
                "configuration",
                "The rendering workspace is not initialized. Redeploy GeoServer.",
            )
        if not state.style_exists:
            raise VectorPublicationError(
                "configuration",
                f"The {style_name} vector style is not initialized. Redeploy GeoServer.",
            )

    @staticmethod
    def _vector_state_error(
        category: PublicationFailureCategory,
        detail: str,
        operation: str,
        state: GeoServerVectorPublicationState,
    ) -> VectorPublicationError:
        """Log and build a categorized unsafe-vector-state failure.

        Args:
            category: Stable public publication failure category.
            detail: Browser-safe actionable detail.
            operation: Stable diagnostic operation.
            state: Current resource snapshot.

        Returns:
            Categorized publication error.
        """
        LOGGER.warning(
            "GeoServer vector publication failed: operation=%s status=state "
            "detail=workspace:%s style:%s datastore:%s feature:%s layer:%s",
            operation,
            state.workspace_exists,
            state.style_exists,
            state.datastore_exists,
            state.feature_type_exists,
            state.layer_exists,
        )
        return VectorPublicationError(category, detail)

    @staticmethod
    def _is_clean_vector(state: GeoServerVectorPublicationState) -> bool:
        """Return whether no vector-specific resource exists.

        Args:
            state: Current vector resource snapshot.

        Returns:
            Whether datastore, feature type, and layer are all absent.
        """
        return not (
            state.datastore_exists
            or state.feature_type_exists
            or state.layer_exists
        )

    @staticmethod
    def _is_complete_vector(state: GeoServerVectorPublicationState) -> bool:
        """Return whether every vector-specific resource exists.

        Args:
            state: Current vector resource snapshot.

        Returns:
            Whether datastore, feature type, and layer are all present.
        """
        return (
            state.datastore_exists
            and state.feature_type_exists
            and state.layer_exists
        )

    @staticmethod
    def _is_datastore_only(state: GeoServerVectorPublicationState) -> bool:
        """Return whether the exact recoverable orphan-datastore state exists.

        Args:
            state: Current vector resource snapshot.

        Returns:
            Whether only the datastore exists.
        """
        return (
            state.datastore_exists
            and not state.feature_type_exists
            and not state.layer_exists
        )

    @staticmethod
    def _datastore_url(resource_name: str) -> str:
        """Build the workspace-relative datastore path.

        Args:
            resource_name: Stable datastore name.

        Returns:
            GeoServer REST path.
        """
        return (
            f"/workspaces/{GEOSERVER_WORKSPACE_NAME}/datastores/{resource_name}"
        )

    @classmethod
    def _feature_type_url(cls, resource_name: str) -> str:
        """Build the exact configured feature type path.

        Args:
            resource_name: Stable datastore and feature type name.

        Returns:
            GeoServer REST path.
        """
        return (
            f"{cls._datastore_url(resource_name)}/featuretypes/{resource_name}"
        )

    @staticmethod
    def _classify_response_failure(
        operation: str,
        status_code: int,
        excerpt: str,
    ) -> tuple[PublicationFailureCategory, str]:
        """Map rejected vector REST responses to the shared failure contract.

        Args:
            operation: Stable failed REST operation.
            status_code: Rejected GeoServer status.
            excerpt: Bounded sanitized response excerpt.

        Returns:
            Stable category and browser-safe actionable detail.
        """
        if status_code in {401, 403}:
            return (
                "authentication",
                "Rendering service authentication failed. Verify credentials.",
            )
        if operation in {
            "create vector datastore",
            "create exact vector feature type",
        } and _VECTOR_READER_REJECTION_PATTERN.search(excerpt):
            return (
                "reader_rejection",
                (
                    "GeoServer could not publish the exact vector layer. Check "
                    "its datastore, layer name, CRS, and geometry, then retry."
                ),
            )
        return (
            "upstream_failure",
            (
                "The rendering service could not complete vector publication. "
                "Retry; if it persists, check the bounded application log."
            ),
        )
