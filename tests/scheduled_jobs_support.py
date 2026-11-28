"""Compose the restricted Jobs HTTP service with a real PostgreSQL scheduler for tests."""

from collections.abc import Callable, Iterator
from dataclasses import replace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx2
import pytest

from eolab_app.processing.job_store import PostgresJobStore
from eolab_app.routes.job_executor import create_executor_router
from job_service.app import create_app
from job_service.configuration import Settings, load_settings

ScheduledJobsApp = Callable[..., FastAPI]
SCHEDULER_TOKEN = "private-scheduler-" + "a" * 40


@pytest.fixture
def scheduler_api(store: PostgresJobStore) -> Iterator[FastAPI]:
    """Serve the production control interface against the test's shared queue.

    Args:
        store: Migrated disposable Processing database.

    Yields:
        Private, service-authenticated application with an open connection pool.
    """
    api = FastAPI()
    api.include_router(
        create_executor_router(
            token=SCHEDULER_TOKEN,
            scope="jobs",
            operation="diagnostic.v1",
            worker_count=store.limits.worker_count,
            lease_seconds=store.limits.lease_seconds,
            conninfo=store.conninfo,
        )
    )
    with TestClient(api):
        yield api


@pytest.fixture
def scheduled_jobs_app(scheduler_api: FastAPI) -> ScheduledJobsApp:
    """Create Jobs with its production HTTP client pointed at the shared test scheduler.

    Args:
        scheduler_api: Live scheduler backed by the same database as the Processing worker.

    Returns:
        Factory supporting isolated caller credentials and an optional fault-injection transport.
    """

    def build(
        settings: Settings | None = None,
        *,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> FastAPI:
        """Compose a Jobs supervisor and its real isolated child executor.

        Args:
            settings: Public caller and service limits. Defaults to deployment settings.
            transport: Optional decorated transport for testing interrupted scheduler replies.

        Returns:
            Jobs HTTP application ready for lifespan startup.
        """
        configured = replace(
            settings or load_settings(), scheduler_token=SCHEDULER_TOKEN
        )
        return create_app(
            configured,
            scheduler_transport=transport or httpx2.ASGITransport(app=scheduler_api),
        )

    return build
