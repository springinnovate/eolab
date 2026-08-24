"""Deployed-reader adapter for catalog vector assessment."""

from pathlib import Path

import httpx2

from eolab_app.vector.errors import VectorUpstreamError
from eolab_app.vector.models import VectorFormat, VectorReaderAssessment


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
                json={
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
