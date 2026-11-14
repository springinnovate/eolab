"""Exercise registered submission checks through real model binding and queueing."""

import asyncio
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest

import eolab_app.processing.model_definitions as definitions
import eolab_app.processing.model_operations as operations
from eolab_app.processing.clip_models import ClipJobRequest
from eolab_app.processing.model_definitions import ModelRegistry
from eolab_app.processing.model_run_contracts import ModelRunRequest
from eolab_app.processing.models import PreparedJobPlan, ProcessingError
from eolab_app.processing.ports import JobStore
from eolab_app.processing.service import ProcessingService
from eolab_app.raster.models import AuthorizedRaster
from eolab_app.raster.source_identity import RasterSourceIdentity
from model_recipe_support import custom_recipe
from raster_source_support import SOURCE


@dataclass
class SubmissionBoundary:
    """Keep the real model service and doubles for its external dependencies.

    Attributes:
        service: Actual model binding, retry and submission implementation.
        request: Unfamiliar recipe using the registered clip operation.
        hook: Operation-owned asynchronous callback supplied by this test.
        dependency: Opaque binding belonging only to the selected operation.
        events: Observed recovery, check, authorization and queue ordering.
        jobs: Recording job storage preserving the accepted request.
        authorizer: Original raster-source authorization boundary.
    """

    service: ProcessingService
    request: ModelRunRequest
    hook: AsyncMock
    dependency: object
    events: list[str]
    jobs: Mock
    authorizer: Mock


@pytest.fixture
def submission_boundary(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> SubmissionBoundary:
    """Install a fake check on a real operation without adding service branches.

    Args:
        monkeypatch: Isolate operation registration to the current test.
        tmp_path: Private source location returned by the authorization double.

    Returns:
        A service using real recipe binding, queued plans and response serialization.
    """
    events: list[str] = []
    dependency = object()

    async def check(request: ClipJobRequest, supplied: object | None) -> None:
        """Observe the operation-bound request and only its own dependency.

        Args:
            request: Validated calculation produced by the registered binder.
            supplied: Selected operation's server-only dependency, or None.
        """
        assert isinstance(request, ClipJobRequest)
        events.append("check")

    hook = AsyncMock(side_effect=check)
    original = operations.get_model_operation("raster.clip.v1")
    registered = {
        **operations.OPERATIONS,
        original.id: replace(original, before_queue=hook),
    }
    monkeypatch.setattr(operations, "OPERATIONS", registered)
    monkeypatch.setattr(definitions, "OPERATIONS", registered)
    definition = custom_recipe("raster-clip")
    registry = ModelRegistry((definition,))
    request = ModelRunRequest.model_validate(
        {
            "requestId": uuid4().hex,
            "model": {
                "id": definition.id,
                "version": definition.version,
                "definitionSha256": definition.digest,
            },
            "label": "Registered submission check",
            "utcOffsetMinutes": 0,
            "inputs": {
                "habitat": SOURCE,
                "region": {
                    "kind": "selectedArea",
                    "selectedBounds": {"west": 0, "south": 0, "east": 2, "north": 2},
                },
            },
            "parameters": {},
        }
    )
    rows: dict[tuple[str, str], dict[str, Any]] = {}

    def recover(owner: str, request_id: str) -> dict[str, Any] | None:
        """Observe retry recovery before any operation-specific work.

        Args:
            owner: Session owning the submission.
            request_id: Stable public retry identity.

        Returns:
            Previously accepted row, or None for a new request.
        """
        events.append("recover")
        return rows.get((owner, request_id))

    def submit(
        owner: str, request_id: str, plan: PreparedJobPlan, request_hash: str
    ) -> dict[str, Any]:
        """Retain the actual admitted plan for ordinary serialization and retries.

        Args:
            owner: Session owning the submission.
            request_id: Stable public retry identity.
            plan: Actual model plan supplied to storage.
            request_hash: Canonical request identity computed by the service.

        Returns:
            Complete queued row containing the original admitted plan.
        """
        events.append("queue")
        now = datetime.now(timezone.utc)
        row = {
            "id": uuid4().hex,
            "operation": plan.operation,
            "request_hash": request_hash,
            "status": "queued",
            "specification": plan.specification,
            "summary": plan.summary,
            "presentation": plan.presentation,
            "retained_metadata": plan.retained_metadata,
            "created_at": now,
            "updated_at": now,
            "expires_at": now + timedelta(days=7),
            "metadata_expires_at": now + timedelta(days=7),
            "progress": {},
            "artifact": None,
            "error": None,
        }
        rows[owner, request_id] = row
        return row

    jobs = Mock(spec=JobStore)
    jobs.find_request.side_effect = recover
    jobs.submit.side_effect = submit

    async def authorize(source: object) -> AuthorizedRaster:
        """Authorize a source after its operation's submission check completes.

        Args:
            source: Original Catalog source extracted by the operation.

        Returns:
            Authorized immutable source with its admitted Catalog metadata.
        """
        events.append("authorize")
        return AuthorizedRaster(
            tmp_path / "authorized.tif", RasterSourceIdentity(1, 20, 30, 40)
        )

    authorizer = Mock()
    authorizer.authorize = AsyncMock(side_effect=authorize)
    service = ProcessingService(
        jobs,
        Mock(),
        model_registry=registry,
        model_authorizer=authorizer,
        operation_submission_dependencies={
            original.id: dependency,
            "unrelated.operation.v1": object(),
        },
    )
    return SubmissionBoundary(
        service, request, hook, dependency, events, jobs, authorizer
    )


def test_registered_check_precedes_queue_and_accepted_retry_skips_it(
    submission_boundary: SubmissionBoundary,
) -> None:
    """Run a registered check once, then recover its accepted request unchanged.

    Args:
        submission_boundary: Actual submission pipeline with a fake operation check.
    """
    boundary = submission_boundary
    result = asyncio.run(boundary.service.submit_model_run("owner", boundary.request))
    assert result["status"] == "queued"
    assert boundary.events == ["recover", "check", "authorize", "queue"]
    boundary.hook.assert_awaited_once()
    assert boundary.hook.await_args.args[1] is boundary.dependency

    boundary.hook.side_effect = ProcessingError("not_available", "Unavailable", 409)
    boundary.events.clear()
    retried = asyncio.run(boundary.service.submit_model_run("owner", boundary.request))
    assert retried["jobId"] == result["jobId"]
    assert boundary.events == ["recover"]
    assert boundary.jobs.submit.call_count == 1


def test_registered_check_receives_missing_binding_and_owns_rejection(
    submission_boundary: SubmissionBoundary,
) -> None:
    """Delegate absent configuration to the operation and preserve its useful error.

    Args:
        submission_boundary: Actual service with no binding for the selected operation.
    """
    boundary = submission_boundary
    boundary.service.operation_submission_dependencies.pop("raster.clip.v1")
    rejection = ProcessingError("configuration_missing", "Configure this model.", 503)
    boundary.hook.side_effect = rejection
    with pytest.raises(ProcessingError) as caught:
        asyncio.run(boundary.service.submit_model_run("owner", boundary.request))
    assert caught.value is rejection
    assert boundary.hook.await_args.args[1] is None
    boundary.authorizer.authorize.assert_not_awaited()
    boundary.jobs.submit.assert_not_called()


def test_operation_without_check_uses_ordinary_submission(
    submission_boundary: SubmissionBoundary, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Leave ordinary models independent of optional submission integrations.

    Args:
        submission_boundary: Actual service with a registered operation.
        monkeypatch: Replace that operation with its normal hook-free contract.
    """
    boundary = submission_boundary
    operation = operations.get_model_operation("raster.clip.v1")
    monkeypatch.setitem(
        operations.OPERATIONS, operation.id, replace(operation, before_queue=None)
    )
    result = asyncio.run(boundary.service.submit_model_run("owner", boundary.request))
    assert result["status"] == "queued"
    assert boundary.events == ["recover", "authorize", "queue"]
    boundary.hook.assert_not_awaited()


def test_cancelled_check_finishes_its_cleanup_without_queueing(
    submission_boundary: SubmissionBoundary,
) -> None:
    """Await operation-owned cancellation cleanup before submission terminates.

    Args:
        submission_boundary: Actual service whose check awaits explicit cleanup.
    """
    boundary = submission_boundary

    async def scenario() -> None:
        """Cancel a running check and observe its cleanup before propagation."""
        started = asyncio.Event()
        cancelling = asyncio.Event()
        cleanup_finished = asyncio.Event()

        async def check(request: ClipJobRequest, dependency: object | None) -> None:
            """Hold cancellation until this operation's cleanup is released.

            Args:
                request: Bound calculation supplied by the generic service.
                dependency: Selected operation's server-only binding.

            Raises:
                asyncio.CancelledError: After the simulated native cleanup finishes.
            """
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelling.set()
                await cleanup_finished.wait()
                raise

        boundary.hook.side_effect = check
        task = asyncio.create_task(
            boundary.service.submit_model_run("owner", boundary.request)
        )
        try:
            await asyncio.wait_for(started.wait(), 5)
            task.cancel()
            await asyncio.wait_for(cancelling.wait(), 5)
            assert not task.done()
            boundary.jobs.submit.assert_not_called()
            cleanup_finished.set()
            with pytest.raises(asyncio.CancelledError):
                await task
            boundary.authorizer.authorize.assert_not_awaited()
        finally:
            cleanup_finished.set()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())
