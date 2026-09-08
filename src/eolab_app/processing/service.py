"""Owned processing lifecycle and explicit raster operation commands."""

import asyncio
import hashlib
import json
from datetime import datetime, timezone
from pathlib import PurePath
from typing import Any

from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    run_bounded_process,
)
from eolab_app.processing.models import (
    ArtifactDownload,
    JobSubmitRequest,
    PreparedJobPlan,
    ProcessingError,
)
from eolab_app.processing.clip_models import (
    ClipArea,
    ClipPlanRequest,
    ClipSpec,
    RasterClipLimits,
)
from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregatePlanRequest,
    AggregateSpec,
    RasterAggregateLimits,
)
from eolab_app.processing.raster_aggregate import aggregate_process_target
from eolab_app.processing.ports import JobArtifactStore, JobStore
from eolab_app.processing.raster_clip import clip_process_target
from eolab_app.raster.models import CatalogRasterRequest, Wgs84Bounds
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
        operation=spec.operation,
    )


def prepare_aggregate_job(
    spec: AggregateSpec, limits: RasterAggregateLimits
) -> PreparedJobPlan:
    """Project checked calculation intent onto neutral job storage.

    Args:
        spec: Source-fenced native calculation specification.
        limits: Calculation result reservation policy.

    Returns:
        Path-free specification and summary requiring the operation-aware worker.
    """
    data = spec.model_dump(mode="json", by_alias=True)
    return PreparedJobPlan(
        specification=data,
        summary={
            **{key: data[key] for key in ("sources", "calculations", "grid")},
            "area": {"kind": spec.area.kind, "bounds": spec.area.bounds},
        },
        reserved_bytes=limits.result_reservation_bytes,
        operation=spec.operation,
        minimum_claim_version=2,
    )


def require_operation(row: dict[str, Any], operation: str) -> None:
    """Keep reviewed plans and idempotency retries on their original command.

    Args:
        row: Authorized plan or job row.
        operation: Explicit operation supported by the submitting endpoint.

    Raises:
        ProcessingError: When the supplied plan belongs to a different operation.
    """
    actual = (
        row.get("operation")
        or (row.get("spec") or {}).get("operation")
        or "raster.clip.v1"
    )
    if actual != operation:
        raise ProcessingError(
            "operation_mismatch",
            "This plan belongs to a different processing operation.",
            409,
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
    operation = row.get("operation") or spec.get("operation") or "raster.clip.v1"
    calculation = operation == "raster.aggregate.v1"
    return {
        "jobId": identifier,
        "operation": operation,
        "status": status,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "expiresAt": row["expires_at"],
        **(
            {"sources": spec.get("sources"), "calculations": spec.get("calculations")}
            if calculation
            else {"source": spec.get("source")}
        ),
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
                **(
                    {"rows": row["artifact"]["rows"]}
                    if calculation
                    else {"validPixels": row["artifact"]["valid_pixels"]}
                ),
            }
            if ready and row["artifact"]
            else None
        ),
    }


class ProcessingService:
    """Own job lifecycle and supported operation commands through narrow providers."""

    def __init__(
        self,
        authorizer: RasterSourceAuthorizer,
        areas: TemporaryAoiSamplingAreaReader,
        jobs: JobStore,
        artifacts: JobArtifactStore,
        limits: RasterClipLimits,
    ) -> None:
        """Compose job storage and currently supported raster-operation capabilities.

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
        self.aggregate_limits = RasterAggregateLimits.with_lifecycle(limits)

    async def _area_snapshot(
        self, bounds: Wgs84Bounds | None, aoi_id: str | None
    ) -> dict[str, Any]:
        """Snapshot an explicit area and apply the job-owned serialization limit.

        Args:
            bounds: Explicit box, mutually exclusive with the AOI identifier.
            aoi_id: Ready uploaded AOI when no box is provided.

        Returns:
            Independent geometry value with no file or AOI storage dependency.

        Raises:
            ProcessingError: If the AOI expired or is too complex for clipping.
        """
        if bounds is not None:
            area = {
                "kind": "bounds",
                "bounds": (bounds.west, bounds.south, bounds.east, bounds.north),
            }
        else:
            try:
                resolved = await self.areas.resolve_for_sampling(aoi_id)
            except SamplingAreaUnavailableError as error:
                raise ProcessingError("aoi_unavailable", error.detail, 409) from error
            area = {
                "kind": "aoi",
                "bounds": resolved.bounds,
                "geometries": tuple(
                    value.as_geojson() for value in resolved.geometries
                ),
            }
        if len(json.dumps(area).encode()) > self.limits.max_geometry_bytes:
            raise ProcessingError(
                "aoi_too_large",
                "This AOI is too complex for processing. Simplify its geometry and try again.",
                413,
            )
        return area

    async def _area(self, request: ClipPlanRequest) -> ClipArea:
        """Build clipping's area value from the shared immutable snapshot.

        Args:
            request: Explicit clip area selection.

        Returns:
            Clip-owned geometry and bounds value.
        """
        return ClipArea(
            **await self._area_snapshot(request.selectedBounds, request.temporaryAoiId)
        )

    async def plan_raster_clip(
        self, owner: str, request: ClipPlanRequest
    ) -> dict[str, Any]:
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

    async def submit_raster_clip(
        self, owner: str, request: JobSubmitRequest
    ) -> dict[str, Any]:
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
            require_operation(existing, "raster.clip.v1")
            if existing["plan_id"] != request.planId:
                raise ProcessingError(
                    "request_conflict",
                    "That request ID already belongs to another plan.",
                    409,
                )
            return public_job(existing)
        plan = await asyncio.to_thread(self.jobs.get_plan, request.planId, owner)
        require_operation(plan, "raster.clip.v1")
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
            self.jobs.submit,
            owner,
            request.planId,
            request.requestId,
            prepare_clip_job(spec),
        )
        return public_job(row)

    async def _aggregate_area(self, request: AggregatePlanRequest) -> AggregateArea:
        """Snapshot the shared box/AOI geometry or explicit whole-source intent.

        Args:
            request: Validated single-raster calculation request.

        Returns:
            Independent immutable area for the calculation kernel.
        """
        if request.wholeRaster:
            return AggregateArea(kind="wholeRaster")
        return AggregateArea(
            **await self._area_snapshot(request.selectedBounds, request.temporaryAoiId)
        )

    async def discard_plan(self, owner: str, identifier: str) -> None:
        """Release obsolete review state without cancelling accepted job work.

        Args:
            owner: Current browser-session hash.
            identifier: Opaque plan to discard; missing plans are a safe no-op.
        """
        await asyncio.to_thread(self.jobs.discard_plan, identifier, owner)

    async def plan_raster_calculation(
        self, owner: str, request: AggregatePlanRequest
    ) -> dict[str, Any]:
        """Review native work and expression intent without reading band values.

        Args:
            owner: Current session hash.
            request: Exactly one catalog raster, explicit area, and scalar expressions.

        Returns:
            Expiring immutable calculation plan with native work limits.

        Raises:
            ProcessingError: For resource, source, or area admission failures.
        """
        identifier = await asyncio.to_thread(
            self.jobs.reserve_plan,
            owner,
            request.model_dump(mode="json", by_alias=True),
        )
        completed = False
        limits = self.aggregate_limits
        try:
            async with asyncio.timeout(limits.plan_timeout_seconds):
                alias, source = next(iter(request.sources.items()))
                authorized = await self.authorizer.authorize(source)
                area = await self._aggregate_area(request)
                signature = tuple(authorized.source_signature.to_catalog())
                status, value = await run_bounded_process(
                    aggregate_process_target,
                    (
                        "plan",
                        (
                            authorized.source_path,
                            signature,
                            area,
                            request.calculations,
                            alias,
                            limits,
                        ),
                    ),
                    limits.plan_timeout_seconds,
                )
                if status != "ok":
                    raise ProcessingError(*value)
                await self.authorizer.require_current(authorized)
                spec = AggregateSpec(
                    sources=request.sources,
                    sourceSignature=signature,
                    area=area,
                    calculations=request.calculations,
                    grid=value,
                )
            plan = await asyncio.to_thread(
                self.jobs.finish_plan,
                identifier,
                owner,
                prepare_aggregate_job(spec, limits),
            )
            if plan is None:
                raise ProcessingError(
                    "plan_expired",
                    "This calculation plan expired. Create a new one.",
                    409,
                )
            completed = True
            return {
                "planId": identifier,
                "operation": spec.operation,
                **prepare_aggregate_job(spec, limits).summary,
                "expiresAt": plan["expires_at"],
                "resolution": "native",
                "valueDomain": "stored",
                "inclusion": "cell_center",
                "limits": {
                    "maxDecodedBytes": limits.max_decoded_bytes,
                    "maxNativeBlocks": limits.max_native_blocks,
                    "runtimeSeconds": limits.runtime_seconds,
                    "downloadLifetimeSeconds": limits.result_ttl_seconds,
                },
            }
        except (TimeoutError, ProcessDeadlineError) as error:
            raise ProcessingError(
                "planning_timeout",
                "Calculation planning exceeded its time limit. Try a simpler area or try again.",
                422,
            ) from error
        finally:
            if not completed:
                await asyncio.shield(
                    asyncio.to_thread(self.jobs.finish_plan, identifier, owner, None)
                )

    async def submit_raster_calculation(
        self, owner: str, request: JobSubmitRequest
    ) -> dict[str, Any]:
        """Revalidate and durably admit the reviewed calculation exactly once.

        Args:
            owner: Current session hash.
            request: Reviewed plan ID and client-generated idempotency key.

        Returns:
            Accepted or previously accepted owned calculation job.

        Raises:
            ProcessingError: For expired or changed intent, conflicts, or capacity.
        """
        existing = await asyncio.to_thread(
            self.jobs.find_request, owner, request.requestId
        )
        if existing:
            require_operation(existing, "raster.aggregate.v1")
            if existing["plan_id"] != request.planId:
                raise ProcessingError(
                    "request_conflict",
                    "That request ID already belongs to another plan.",
                    409,
                )
            return public_job(existing)
        plan = await asyncio.to_thread(self.jobs.get_plan, request.planId, owner)
        require_operation(plan, "raster.aggregate.v1")
        spec = AggregateSpec.model_validate(plan["spec"])
        authorized = await self.authorizer.authorize(next(iter(spec.sources.values())))
        if tuple(authorized.source_signature.to_catalog()) != spec.sourceSignature:
            raise ProcessingError(
                "source_changed",
                "The raster changed since planning. Create a new calculation plan.",
                409,
            )
        area = await self._aggregate_area(
            AggregatePlanRequest.model_validate(plan["request"])
        )
        if area != spec.area:
            raise ProcessingError(
                "area_changed",
                "The AOI changed since planning. Create a new calculation plan.",
                409,
            )
        row = await asyncio.to_thread(
            self.jobs.submit,
            owner,
            request.planId,
            request.requestId,
            prepare_aggregate_job(spec, self.aggregate_limits),
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
            artifact = row["artifact"]
            path = await asyncio.to_thread(
                self.artifacts.result_path,
                row["attempt_id"],
                provenance,
                result_name=artifact.get("result_name", "result.tif"),
            )
            if provenance:
                data = await asyncio.to_thread(path.read_bytes)
                size = len(data)
                sha256 = hashlib.sha256(data).hexdigest()
                filename = str(PurePath(artifact["filename"]).with_suffix(".json"))
                media_type = "application/json"
            else:
                size, sha256, filename = (
                    artifact["size"],
                    artifact["sha256"],
                    artifact["filename"],
                )
                # Results created before media types were recorded were all
                # raster clips; preserve their existing download content type.
                media_type = artifact.get("media_type", "image/tiff")
                if path.stat().st_size != size:
                    raise ProcessingError(
                        "result_changed",
                        "This result file is no longer intact. Submit a new job.",
                        410,
                    )
            return ArtifactDownload(path, filename, size, sha256, lease, media_type)
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
