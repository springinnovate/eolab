"""Application service for bounded, authorized composite map render plans."""

import asyncio
import json
from collections import OrderedDict
from dataclasses import dataclass
from hashlib import sha256
from threading import Lock

from eolab_app.rendering.errors import (
    PublishedLayerChangedError,
    PublishedLayerNotAuthorizedError,
    PublishedLayerRequestError,
)
from eolab_app.rendering.models import (
    CompositeMapLayerRequest,
    CompositeMapPlanRequest,
    PublishedCompositeMapPlan,
)
from eolab_app.rendering.ports import (
    PublishedLayerAuthorization,
    PublishedLayerRegistry,
)
from eolab_app.rendering.sld import combine_sld_layers


MAX_RETAINED_COMPOSITE_PLANS = 256


class CompositeMapPlanUnavailableError(Exception):
    """Signal that a requested process-local render plan is unavailable."""


@dataclass(frozen=True)
class AuthorizedCompositeMapPlan:
    """One immutable plan and its complete server-owned SLD document."""

    request: CompositeMapPlanRequest
    sld_document: bytes


class CompositeMapPlanStore:
    """Bound process-local composite plans by recent use."""

    def __init__(self, maximum_plans: int = MAX_RETAINED_COMPOSITE_PLANS) -> None:
        """Create an empty least-recently-used plan store.

        Args:
            maximum_plans: Maximum immutable plans retained by this process.

        Raises:
            ValueError: If the configured bound is not positive.
        """
        if maximum_plans < 1:
            raise ValueError("Composite plan capacity must be positive")
        self._maximum_plans = maximum_plans
        self._plans: OrderedDict[str, AuthorizedCompositeMapPlan] = OrderedDict()
        self._lock = Lock()

    def put(self, plan_id: str, plan: AuthorizedCompositeMapPlan) -> None:
        """Retain one immutable plan and evict the least-recently-used entry.

        Args:
            plan_id: Content-addressed lowercase hexadecimal identity.
            plan: Authorized plan value.
        """
        with self._lock:
            self._plans[plan_id] = plan
            self._plans.move_to_end(plan_id)
            while len(self._plans) > self._maximum_plans:
                self._plans.popitem(last=False)

    def get(self, plan_id: str) -> AuthorizedCompositeMapPlan:
        """Return and touch one retained plan.

        Args:
            plan_id: Content-addressed lowercase hexadecimal identity.

        Returns:
            Matching authorized plan.

        Raises:
            CompositeMapPlanUnavailableError: If the plan was never registered,
                was evicted, or belonged to a previous app process.
        """
        with self._lock:
            plan = self._plans.get(plan_id)
            if plan is None:
                raise CompositeMapPlanUnavailableError(
                    "The composite map plan is unavailable; refresh the map"
                )
            self._plans.move_to_end(plan_id)
            return plan


class CompositeMapRenderingService:
    """Authorize feature-owned styles and retain immutable composite plans."""

    def __init__(
        self,
        published_layers: tuple[PublishedLayerRegistry, ...],
        store: CompositeMapPlanStore | None = None,
    ) -> None:
        """Create the neutral plan service.

        Args:
            published_layers: Feature-owned current layer registries.
            store: Optional bounded process-local plan store.
        """
        self._published_layers = published_layers
        self._store = store or CompositeMapPlanStore()

    async def create_plan(
        self,
        request: CompositeMapPlanRequest,
    ) -> PublishedCompositeMapPlan:
        """Authorize and retain one complete top-first browser plan.

        Args:
            request: Bounded published layers and feature-owned appearances.

        Returns:
            Content-addressed plan identity and browser-facing WMS URL.

        Raises:
            PublishedLayerNotAuthorizedError: If any layer is not current.
            PublishedLayerChangedError: If a mounted source changed.
            PublishedLayerRequestError: If any requested style is not current.
        """
        sld_document = await asyncio.to_thread(
            self._build_authorized_sld,
            request,
        )
        canonical_request = json.dumps(
            request.model_dump(by_alias=True, mode="json"),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        plan_id = sha256(canonical_request).hexdigest()
        self._store.put(
            plan_id,
            AuthorizedCompositeMapPlan(request, sld_document),
        )
        return PublishedCompositeMapPlan(
            planId=plan_id,
            wmsUrl=f"/api/map-rendering/plans/{plan_id}/wms",
        )

    async def require_current(
        self,
        plan_id: str,
    ) -> AuthorizedCompositeMapPlan:
        """Require a retained plan whose layers and styles are still current.

        Args:
            plan_id: Content-addressed plan identity.

        Returns:
            Current immutable plan and its authorized SLD.

        Raises:
            CompositeMapPlanUnavailableError: If this process lacks the plan.
            PublishedLayerChangedError: If a mounted source changed.
            PublishedLayerRequestError: If an authorized style was superseded.
        """
        plan = self._store.get(plan_id)
        await asyncio.to_thread(self._require_current_plan, plan.request)
        return plan

    def _build_authorized_sld(self, request: CompositeMapPlanRequest) -> bytes:
        """Build one bottom-first SLD after current authorization checks.

        Args:
            request: Validated top-first composite plan.

        Returns:
            Complete multi-layer SLD document.
        """
        documents = [
            self._build_layer_sld(layer)
            for layer in reversed(request.layers)
        ]
        return combine_sld_layers(documents)

    def _require_current_plan(self, request: CompositeMapPlanRequest) -> None:
        """Recheck every source and style without rebuilding the SLD.

        Args:
            request: Previously authorized immutable plan.

        Raises:
            PublishedLayerNotAuthorizedError: If a layer is no longer known.
            PublishedLayerChangedError: If a mounted source changed.
            PublishedLayerRequestError: If a style was superseded.
        """
        for layer in request.layers:
            authorization = self._require_authorization(layer.layer_name)
            if authorization.style_name != layer.style_name:
                raise PublishedLayerRequestError(
                    f"Composite style must be {authorization.style_name}"
                )

    def _build_layer_sld(self, layer: CompositeMapLayerRequest) -> bytes:
        """Delegate one requested appearance to its feature authorization.

        Args:
            layer: Validated generic composite layer request.

        Returns:
            One complete single-layer SLD document.

        Raises:
            PublishedLayerRequestError: If its current style does not match.
        """
        authorization = self._require_authorization(layer.layer_name)
        if authorization.style_name != layer.style_name:
            raise PublishedLayerRequestError(
                f"Composite style must be {authorization.style_name}"
            )
        return authorization.build_composite_sld(
            layer.layer_name,
            layer.style_name,
            layer.style_environment,
            layer.style_definition,
            layer.opacity,
        )

    def _require_authorization(
        self,
        layer_name: str,
    ) -> PublishedLayerAuthorization:
        """Resolve one layer through the configured feature-owned registries.

        Args:
            layer_name: Workspace-qualified GeoServer layer identity.

        Returns:
            Current owning feature authorization.

        Raises:
            PublishedLayerNotAuthorizedError: If no feature owns the layer.
            PublishedLayerChangedError: If the owning mounted source changed.
        """
        for registry in self._published_layers:
            try:
                return registry.require_current(layer_name)
            except PublishedLayerNotAuthorizedError:
                continue
        raise PublishedLayerNotAuthorizedError(
            "The WMS layer has not been approved for visualization"
        )
