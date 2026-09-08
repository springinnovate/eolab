"""Raster clip planning, explicit admission, ownership, and download workflows."""

import asyncio
import hashlib
from datetime import datetime, timezone
from typing import Any

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    run_bounded_process,
)
from eolab_app.processing.models import (
    ArtifactDownload,
    ClipArea,
    ClipPlanRequest,
    ClipSpec,
    ClipSubmitRequest,
    PreparedJobPlan,
    ProcessingError,
    ProcessingLimits,
)
from eolab_app.processing.ports import ClipArtifactStore, JobStore
from eolab_app.processing.raster_clip import clip_process_target
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.ports import RasterSourceAuthorizer
from eolab_app.sampling_area import (
    SamplingAreaUnavailableError,
    TemporaryAoiSamplingAreaReader,
)


def prepare_clip_job(spec: ClipSpec) -> PreparedJobPlan:
    """Project a validated clip specification onto operation-neutral storage data.

    Args:
        spec: Immutable native grid and source/area snapshot checked by clipping.

    Returns:
        Serialized specification, bounded public summary, and storage reservation.
    """
    return PreparedJobPlan(
        specification=spec.model_dump(mode="json", by_alias=True),
        summary={
            "source": spec.source.model_dump(by_alias=True),
            "grid": spec.grid.model_dump(mode="json"),
            "area": {"kind": spec.area.kind, "bounds": list(spec.area.bounds)},
        },
        reserved_bytes=spec.grid.reservedBytes,
    )


def public_job(row: dict[str, Any]) -> dict[str, Any]:
    """Project a durable row onto the path-free, owner-safe HTTP result contract.

    Args:
        row: An already-authorized owned job record.

    Returns:
        Public lifecycle, grid, source, and result links without storage metadata.
    """
    identifier = row["id"]
    spec = row.get("spec") or {}
    status = row["status"]
    if status == "ready" and row["expires_at"] <= datetime.now(timezone.utc):
        status = "expired"
    ready = status == "ready"
    return {
        "jobId": identifier,
        "operation": "raster.clip.v1",
        "status": status,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "expiresAt": row["expires_at"],
        "source": spec.get("source"),
        "grid": spec.get("grid"),
        "area": (
            {"kind": spec["area"]["kind"], "bounds": spec["area"]["bounds"]}
            if spec
            else None
        ),
        "progress": row["progress"],
        "error": row["error"],
        "result": (
            {
                "url": f"/api/processing/jobs/{identifier}/result",
                "provenanceUrl": f"/api/processing/jobs/{identifier}/provenance",
                "filename": row["artifact"]["filename"],
                "bytes": row["artifact"]["size"],
                "sha256": row["artifact"]["sha256"],
                "validPixels": row["artifact"]["valid_pixels"],
            }
            if ready and row["artifact"]
            else None
        ),
    }


class RasterClipService:
    """Own the external clip workflow while storage and native I/O remain lower-level."""

    def __init__(
        self,
        authorizer: RasterSourceAuthorizer,
        areas: TemporaryAoiSamplingAreaReader,
        jobs: JobStore,
        artifacts: ClipArtifactStore,
        limits: ProcessingLimits,
    ) -> None:
        """Compose clip capabilities without acquiring peer-service implementation state.

        Args:
            authorizer: Catalog-owned current-source authorization port.
            areas: Neutral reader of ready immutable temporary AOI geometry.
            jobs: Durable job and admission adapter.
            artifacts: Confined result-file adapter.
            limits: Deployment-owned resource and lifecycle policy.
        """
        self.authorizer = authorizer
        self.areas = areas
        self.jobs = jobs
        self.artifacts = artifacts
        self.limits = limits

    async def _area(self, request: ClipPlanRequest) -> ClipArea:
        """Snapshot an explicit area and apply the job-owned serialization limit.

        Args:
            request: Strict one-of area selection.

        Returns:
            Independent geometry value with no file or AOI storage dependency.

        Raises:
            ProcessingError: If the AOI expired or is too complex for clipping.
        """
        if request.selectedBounds is not None:
            bounds = request.selectedBounds
            area = ClipArea(
                kind="bounds",
                bounds=(bounds.west, bounds.south, bounds.east, bounds.north),
            )
        else:
            try:
                resolved = await self.areas.resolve_for_sampling(request.temporaryAoiId)
            except SamplingAreaUnavailableError as error:
                raise ProcessingError("aoi_unavailable", error.detail, 409) from error
            area = ClipArea(
                kind="aoi",
                bounds=resolved.bounds,
                geometries=tuple(value.as_geojson() for value in resolved.geometries),
            )
        if len(area.model_dump_json().encode()) > self.limits.max_geometry_bytes:
            raise ProcessingError(
                "aoi_too_large",
                "This AOI is too complex for a clip. Simplify its geometry and try again.",
                413,
            )
        return area

    async def plan(self, owner: str, request: ClipPlanRequest) -> dict[str, Any]:
        """Create a bounded metadata plan; this does not accept an export job.

        Args:
            owner: Hash of the current opaque session cookie.
            request: Catalog source and exactly one explicit area.

        Returns:
            Reviewable grid, native byte estimate, limits, and expiring plan ID.

        Raises:
            ProcessingError: For unsupported sources, size, area, or capacity.
            RasterFeatureError: If catalog source authorization fails.
        """
        identifier = await asyncio.to_thread(
            self.jobs.reserve_plan,
            owner,
            request.model_dump(mode="json", by_alias=True),
        )
        completed = False
        try:
            async with asyncio.timeout(self.limits.plan_timeout_seconds):
                source = CatalogRasterRequest(
                    collectionId=request.collection_id, itemId=request.item_id
                )
                authorized = await self.authorizer.authorize(source)
                area = await self._area(request)
                signature = tuple(authorized.source_signature.to_catalog())
                status, value = await run_bounded_process(
                    clip_process_target,
                    ("plan", (authorized.source_path, signature, area, self.limits)),
                    self.limits.plan_timeout_seconds,
                )
                if status != "ok":
                    raise ProcessingError(*value)
                await self.authorizer.require_current(authorized)
                spec = ClipSpec(
                    source=source, sourceSignature=signature, area=area, grid=value
                )
            plan = await asyncio.to_thread(
                self.jobs.finish_plan, identifier, owner, prepare_clip_job(spec)
            )
            if plan is None:
                raise ProcessingError(
                    "plan_expired",
                    "This clip plan expired. Please create a new one.",
                    409,
                )
            completed = True
            return {
                "planId": identifier,
                "operation": spec.operation,
                "source": source.model_dump(by_alias=True),
                "area": {"kind": area.kind, "bounds": area.bounds},
                "grid": value.model_dump(),
                "expiresAt": plan["expires_at"],
                "format": "COG",
                "resolution": "native",
                "allTouched": True,
                "limits": {
                    "maxRawBytes": self.limits.max_raw_bytes,
                    "runtimeSeconds": self.limits.runtime_seconds,
                    "downloadLifetimeSeconds": self.limits.result_ttl_seconds,
                },
            }
        except (TimeoutError, ProcessDeadlineError) as error:
            raise ProcessingError(
                "planning_timeout",
                "Clip planning exceeded its time limit. Try a simpler area or try again.",
                422,
            ) from error
        finally:
            if not completed:
                # Supervisor has already joined its child before releasing this
                # slot. A DB outage leaves a bounded expiring reservation.
                await asyncio.shield(
                    asyncio.to_thread(self.jobs.finish_plan, identifier, owner, None)
                )

    async def submit(self, owner: str, request: ClipSubmitRequest) -> dict[str, Any]:
        """Revalidate the plan, then durably accept an idempotent clip job.

        Args:
            owner: Current session hash.
            request: Reviewed plan ID and client idempotency key.

        Returns:
            Public queued or previously accepted job.

        Raises:
            ProcessingError: If a lifecycle changed, the plan expired, or limits are full.
        """
        existing = await asyncio.to_thread(
            self.jobs.find_request, owner, request.requestId
        )
        if existing:
            if existing["plan_id"] != request.planId:
                raise ProcessingError(
                    "request_conflict",
                    "That request ID already belongs to another plan.",
                    409,
                )
            return public_job(existing)
        plan = await asyncio.to_thread(self.jobs.get_plan, request.planId, owner)
        spec = ClipSpec.model_validate(plan["spec"])
        authorized = await self.authorizer.authorize(spec.source)
        if tuple(authorized.source_signature.to_catalog()) != spec.sourceSignature:
            raise ProcessingError(
                "source_changed",
                "The raster changed since planning. Create a new clip plan.",
                409,
            )
        area = await self._area(ClipPlanRequest.model_validate(plan["request"]))
        if area != spec.area:
            raise ProcessingError(
                "area_changed",
                "The AOI changed since planning. Create a new clip plan.",
                409,
            )
        row = await asyncio.to_thread(
            self.jobs.submit, owner, request.planId, request.requestId,
            prepare_clip_job(spec),
        )
        return public_job(row)

    async def get(self, owner: str, identifier: str) -> dict[str, Any]:
        """Read one owner's public job state.

        Args:
            owner: Current session hash.
            identifier: Opaque job ID.

        Returns:
            Public lifecycle and ready download links.
        """
        return public_job(await asyncio.to_thread(self.jobs.get, identifier, owner))

    async def list_owned(self, owner: str) -> list[dict[str, Any]]:
        """Recover bounded recent jobs for the current browser session.

        Args:
            owner: Current session hash.

        Returns:
            At most 50 public job summaries, newest first.
        """
        return [
            public_job(row)
            for row in await asyncio.to_thread(self.jobs.list_owned, owner)
        ]

    async def cancel(
        self, owner: str, identifier: str, delete: bool = False
    ) -> dict[str, Any]:
        """Request explicit cancellation or remove a terminal job's result.

        Args:
            owner: Current session hash.
            identifier: Owned opaque job ID.
            delete: Revoke a terminal result rather than cancel active work.

        Returns:
            Updated public state; running cancellation completes after child exit.
        """
        return public_job(
            await asyncio.to_thread(self.jobs.cancel, identifier, owner, delete)
        )

    async def download(
        self, owner: str, identifier: str, provenance: bool = False
    ) -> ArtifactDownload:
        """Authorize a finished artifact and acquire its transfer lifetime.

        Args:
            owner: Current session hash.
            identifier: Owned job ID.
            provenance: Download JSON provenance instead of its GeoTIFF.

        Returns:
            Confined file, response metadata, and opaque transfer lease.

        Raises:
            ProcessingError: If unavailable, expired, or transfer capacity is full.
        """
        row, lease = await asyncio.to_thread(
            self.jobs.acquire_transfer, identifier, owner
        )
        try:
            path = await asyncio.to_thread(
                self.artifacts.result_path, row["attempt_id"], provenance
            )
            artifact = row["artifact"]
            if provenance:
                data = await asyncio.to_thread(path.read_bytes)
                size = len(data)
                sha256 = hashlib.sha256(data).hexdigest()
                filename = artifact["filename"].removesuffix(".tif") + ".json"
            else:
                size, sha256, filename = (
                    artifact["size"],
                    artifact["sha256"],
                    artifact["filename"],
                )
                if path.stat().st_size != size:
                    raise ProcessingError(
                        "result_changed",
                        "This clip file is no longer intact. Create a new clip.",
                        410,
                    )
            return ArtifactDownload(path, filename, size, sha256, lease)
        except BaseException:
            await asyncio.to_thread(self.jobs.transfer_heartbeat, lease, True)
            raise

    async def transfer_heartbeat(self, lease: str, release: bool = False) -> bool:
        """Renew or release a response-owned download lease.

        Args:
            lease: Opaque transfer capability from download authorization.
            release: Release after the response ends or disconnects.

        Returns:
            Whether the transfer lease existed.
        """
        return await asyncio.to_thread(self.jobs.transfer_heartbeat, lease, release)
