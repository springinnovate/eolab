"""Installed outline algorithm and its path-free operation contract."""

import asyncio
import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, FiniteFloat, JsonValue, model_validator

from eolab_app.catalog_selection import CatalogSelection, SelectionUnavailableError

# Fixed Compose service/mount contracts; job callers cannot redirect source access.
# Public hostnames do not affect the Catalog's internal DNS name. Deployments
# choose the host data directory with EOLAB_SCAN_MOUNT_PATH; Compose mounts it
# at /scan-source in both the application and Jobs containers.
CATALOG_URL = "http://stac-api:8080"
SCAN_MOUNT = Path("/scan-source")
# Maximum compact UTF-8 GeoJSON bytes in a returned map outline. Kept at the
# display_geometry producer's MAX_DISPLAY_BYTES contract without importing its
# native GIS dependencies during operation discovery. A contract test ties them.
MAX_OUTLINE_GEOMETRY_BYTES = 256 * 1024


class OutlineInput(BaseModel):
    """Immutable Catalog identity and filter; never a path or geometry snapshot."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    selection: CatalogSelection


class OutlineResult(BaseModel):
    """Bounded approximate display geometry, never an analysis mask."""

    model_config = ConfigDict(extra="forbid")
    geometry: dict[str, JsonValue]
    bbox: tuple[FiniteFloat, FiniteFloat, FiniteFloat, FiniteFloat]

    @model_validator(mode="after")
    def check_display(self) -> "OutlineResult":
        """Enforce the existing serialized outline boundary.

        Returns:
            The validated display result.

        Raises:
            ValueError: If the output is not a bounded FeatureCollection.
        """
        if (
            self.geometry.get("type") != "FeatureCollection"
            or not isinstance(self.geometry.get("features"), list)
            or len(
                json.dumps(
                    self.geometry, allow_nan=False, separators=(",", ":")
                ).encode()
            )
            > MAX_OUTLINE_GEOMETRY_BYTES
            or self.bbox[0] > self.bbox[2]
            or self.bbox[1] > self.bbox[3]
        ):
            raise ValueError("Invalid bounded outline result")
        return self


def outline(inputs: OutlineInput) -> OutlineResult:
    """Execute Catalog-authorized outline computation in the Jobs child.

    GIS imports are lazy so service discovery and diagnostic jobs do not load
    native libraries. No scheduler or application service is constructed here.

    Args:
        inputs: Validated path-free immutable selection.

    Returns:
        The existing display algorithm's bounded result.

    Raises:
        SelectionUnavailableError: If Catalog/source identity changed.
        ValueError: If source reading or display validation fails.
    """
    return asyncio.run(_outline(inputs))


async def _outline(inputs: OutlineInput) -> OutlineResult:
    """Resolve before and after native work using the authoritative Catalog.

    Args:
        inputs: Validated operation inputs.

    Returns:
        Source-rechecked display result.

    Raises:
        SelectionUnavailableError: For a changed identity or source.
        ValueError: For invalid polygons or exceeded work budgets.
    """
    import httpx2
    from eolab_app.vector.catalog import StacVectorCatalog
    from eolab_app.vector.geometry import build_outline
    from eolab_app.vector.selection_source import resolve_selection
    from eolab_app.vector.sources import MountedVectorResolver

    async with httpx2.AsyncClient(
        timeout=5, trust_env=False, follow_redirects=False
    ) as client:
        catalog = StacVectorCatalog(client, CATALOG_URL)
        resolver = MountedVectorResolver(SCAN_MOUNT)
        resolved = await resolve_selection(catalog, resolver, inputs.selection)
        if resolved.selection != inputs.selection:
            raise SelectionUnavailableError(
                "The catalog vector identity changed; select it again."
            )
        result = OutlineResult.model_validate_json(
            json.dumps(build_outline(resolved), allow_nan=False)
        )
        current = await resolve_selection(catalog, resolver, inputs.selection)
        if current.selection != inputs.selection:
            raise SelectionUnavailableError(
                "The catalog vector identity changed; select it again."
            )
        return result
