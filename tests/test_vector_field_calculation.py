"""Verify whole-source arithmetic admission and private calculation lifecycles."""

import asyncio
import hashlib
import json
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import fiona
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from eolab_app.calculated_fields import CalculatedField
from eolab_app.routes.processing import COOKIE, get_processing_session_owner_hash
from eolab_app.routes.vector_calculations import (
    FieldCalculationResponse,
    create_vector_calculation_router,
)
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.field_calculation import (
    FieldCalculationJobs,
    FieldCalculationRequest,
)
from eolab_app.vector.field_calculation_operation import (
    ArtifactCalculationSource,
    FieldCalculationInput,
    FieldCalculationOutcome,
    FieldCalculationResult,
    calculate_vector_fields,
    scan_calculated_fields,
)
from tests.test_artifact_vector_rendering import VectorFileAuthority
from tests.test_raster_source_access import PRIVATE


@pytest.fixture
def arithmetic_source(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    """Write original attributes with spaces, apostrophes and missing numeric data.

    Args:
        tmp_path: Isolated fixture directory.

    Returns:
        Original GeoPackage path and its admitted field schema.
    """
    fields = {"Population": "float", "Area km2": "float", "Owner's value": "str"}
    path = tmp_path / "regions.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="regions",
        crs="EPSG:4326",
        schema={"geometry": "Point", "properties": fields},
    ) as dataset:
        for index, values in enumerate(
            ((100.0, 2.0, " 1e2 "), (50.0, 0.0, "12abc"), (None, 5.0, ""))
        ):
            dataset.write(
                {
                    "geometry": {"type": "Point", "coordinates": (index, index)},
                    "properties": dict(zip(fields, values)),
                }
            )
    return path, fields


def test_whole_source_counts_and_chained_fields_leave_original_unchanged(
    arithmetic_source: tuple[Path, dict[str, str]],
) -> None:
    """Accept calculations across all rows and retain original geometry/attributes.

    Args:
        arithmetic_source: Mixed original native attributes.
    """
    path, fields = arithmetic_source
    original = path.read_bytes()
    definitions = (
        CalculatedField(name="Density", expression="'Population' / 'Area km2'"),
        CalculatedField(name="Scaled", expression="'Density' * 10 + 2"),
        CalculatedField(
            name="Converted", expression="'Owner''s value'", numericText=True
        ),
    )
    result = scan_calculated_fields(path, "regions", fields, definitions)
    assert result.featureCount == 3
    assert result.missingCounts == {"Density": 2, "Scaled": 2, "Converted": 2}
    assert result.fields == {
        **fields,
        "Density": "float",
        "Scaled": "float",
        "Converted": "float",
    }
    assert result.calculatedFields == definitions
    assert path.read_bytes() == original


def test_invalid_formula_is_rejected_before_native_read(
    arithmetic_source: tuple[Path, dict[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Do not scan a source or install partial fields after invalid input.

    Args:
        arithmetic_source: Original field metadata.
        monkeypatch: Makes any accidental read fail loudly.
    """
    path, fields = arithmetic_source

    def unexpected_read(*args: Any, **kwargs: Any) -> None:
        """Reject native reading for an expression that cannot be accepted."""
        raise AssertionError("Invalid formula reached native reading")

    monkeypatch.setattr("eolab_app.vector_fields.visit_vector_fields", unexpected_read)
    with pytest.raises(
        VectorConflictError, match="Unknown|unknown|not.*field|not.*available"
    ):
        scan_calculated_fields(
            path,
            "regions",
            fields,
            (CalculatedField(name="Density", expression="'Does not exist' * 10"),),
        )


def test_constant_and_empty_definition_lists_count_features(
    arithmetic_source: tuple[Path, dict[str, str]],
) -> None:
    """Read zero source columns for constants or removal of the last calculated field.

    Args:
        arithmetic_source: Three-feature original file.
    """
    path, fields = arithmetic_source
    result = scan_calculated_fields(
        path,
        "regions",
        fields,
        (CalculatedField(name="Weight", expression="-2 * (3 + 4)"),),
    )
    assert result.featureCount == 3 and result.missingCounts == {"Weight": 0}
    cleared = scan_calculated_fields(path, "regions", fields, ())
    assert cleared.featureCount == 3 and cleared.fields == fields


def test_request_boundary_rejects_paths_and_browser_owned_credentials() -> None:
    """Public inputs contain identities and definitions, never internal read access."""
    for source in ({"path": "/private/source.gpkg"}, {**PRIVATE, "owner": "forged"}):
        with pytest.raises(ValidationError):
            FieldCalculationRequest(source=source, calculatedFields=[])
    with pytest.raises(ValidationError):
        FieldCalculationRequest(source=PRIVATE, calculatedFields=[], readLease="a" * 32)


def test_uploaded_calculation_reads_admitted_fields_without_rendering(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Execute from admitted private-upload identity and deny another browser.

    Args:
        tmp_path: Isolated upload volume and original fixture.
        monkeypatch: Configure only the worker's private mount.
    """
    from collections.abc import AsyncIterator
    from eolab_app.vector_uploads import VectorUploadStore

    path = tmp_path / "uploaded.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="regions",
        crs="EPSG:4326",
        schema={"geometry": "Polygon", "properties": {"value": "float"}},
    ) as dataset:
        dataset.write(
            {
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[(0, 0), (1, 0), (1, 1), (0, 0)]],
                },
                "properties": {"value": 3.0},
            }
        )
    root = tmp_path / "uploads"
    store = VectorUploadStore(root, max_bytes=None)
    store.initialize()

    async def chunks() -> AsyncIterator[bytes]:
        """Stream the fixture's immutable bytes through ordinary admission.

        Yields:
            Complete small GeoPackage fixture.
        """
        yield path.read_bytes()

    upload = asyncio.run(store.create("a" * 64, "Regions", chunks()))
    monkeypatch.setattr(
        "eolab_app.vector.field_calculation_operation.UPLOAD_MOUNT", root
    )
    inputs = FieldCalculationInput(
        source={"uploadId": upload.id},
        uploadOwner="a" * 64,
        calculatedFields=[CalculatedField(name="Doubled", expression="'value' * 2")],
    )
    result = calculate_vector_fields(inputs)
    assert result.error is None and result.result.featureCount == 1
    assert result.result.missingCounts == {"Doubled": 0}
    denied = calculate_vector_fields(
        inputs.model_copy(update={"uploadOwner": "b" * 64})
    )
    assert denied.result is None and "not available" in denied.error


class CompletedCalculationJobs:
    """Return an external Jobs result while recording the exact submitted contract."""

    def __init__(self) -> None:
        """Start with no submitted Jobs inputs."""
        self.submissions: list[dict[str, Any]] = []

    async def run(self, payload: dict[str, Any], **options: Any) -> SimpleNamespace:
        """Return a complete result without running native work in HTTP tests.

        Args:
            payload: Serialized operation and server-only source credentials.
            options: Existing client waiting and cancellation behavior.

        Returns:
            Jobs-shaped result value.
        """
        assert options["timeout_seconds"] is None
        assert options["require_terminal_cleanup"] is True
        self.submissions.append(payload)
        return SimpleNamespace(
            value=FieldCalculationOutcome(
                result=FieldCalculationResult(
                    calculatedFields=(),
                    fields={"score": "float"},
                    featureCount=3,
                    missingCounts={},
                )
            ).model_dump(mode="json")
        )


def test_run_result_authorization_and_leases_enclose_calculation(
    arithmetic_source: tuple[Path, dict[str, str]],
) -> None:
    """The endpoint retains an owned result, rejects other browsers and respects expiry.

    Args:
        arithmetic_source: Immutable file used by the existing source authority fake.
    """
    authority = VectorFileAuthority(arithmetic_source[0])
    authority.owners = {hashlib.sha256(("a" * 64).encode()).hexdigest()}
    jobs = CompletedCalculationJobs()
    app = FastAPI()
    app.include_router(
        create_vector_calculation_router(
            FieldCalculationJobs(jobs),
            authority.files(),
            lambda request, response: get_processing_session_owner_hash(
                request, response, 86400
            ),
        )
    )
    with TestClient(app, base_url="https://app") as client:
        client.cookies.set(COOKIE, "a" * 64)
        response = client.post(
            "/api/vector-calculations",
            json={"source": PRIVATE, "calculatedFields": []},
            headers={"X-EOLab-Processing": "1"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["featureCount"] == 3
        assert response.headers["cache-control"] == "private, no-store"
        assert not authority.leases
        assert jobs.submissions[0]["inputs"]["readLease"]
        client.cookies.clear()
        client.cookies.set(COOKIE, "b" * 64)
        denied = client.post(
            "/api/vector-calculations",
            json={"source": PRIVATE, "calculatedFields": []},
            headers={"X-EOLab-Processing": "1"},
        )
        assert denied.status_code in {404, 409, 410}
        assert len(jobs.submissions) == 1
        client.cookies.clear()
        client.cookies.set(COOKIE, "a" * 64)
        authority.ready = False
        expired = client.post(
            "/api/vector-calculations",
            json={"source": PRIVATE, "calculatedFields": []},
            headers={"X-EOLab-Processing": "1"},
        )
        assert expired.status_code == 409 and "expired" in expired.text
        assert len(jobs.submissions) == 1


def test_cancelled_calculation_waits_for_native_exit_before_releasing_source(
    arithmetic_source: tuple[Path, dict[str, str]],
) -> None:
    """Cancellation cannot release the cleanup lease while native execution is alive.

    Args:
        arithmetic_source: Immutable original result file.
    """
    authority = VectorFileAuthority(arithmetic_source[0])

    async def scenario() -> None:
        """Hold the Jobs response until explicit exit after caller cancellation."""
        started, exit_native = asyncio.Event(), asyncio.Event()

        class HeldJobs:
            """Model the Jobs client's terminal cleanup guarantee."""

            async def run(self, payload: Mapping[str, Any], **options: Any) -> None:
                """Wait for native exit before propagating caller cancellation.

                Args:
                    payload: Submitted source and definitions.
                    options: Caller cleanup contract.

                Raises:
                    asyncio.CancelledError: After the simulated native exit.
                """
                started.set()
                try:
                    await asyncio.Future()
                finally:
                    await exit_native.wait()

        async def calculate() -> None:
            """Retain the source around one cancellation-aware execution call."""
            async with authority.files().open(
                "owner", PRIVATE["jobId"], PRIVATE["artifactId"]
            ) as file:
                await FieldCalculationJobs(HeldJobs()).calculate(
                    FieldCalculationInput(
                        source=ArtifactCalculationSource(**PRIVATE),
                        calculatedFields=(),
                        readLease=file.lease_id,
                    )
                )

        task = asyncio.create_task(calculate())
        await asyncio.wait_for(started.wait(), 1)
        task.cancel()
        await asyncio.sleep(0)
        assert authority.leases and not task.done()
        exit_native.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not authority.leases

    asyncio.run(scenario())


@pytest.mark.parametrize("fails", [False, True])
def test_long_calculation_streams_only_whitespace_before_its_final_result(
    fails: bool,
) -> None:
    """Keep the HTTP connection active without exposing partially calculated fields.

    Args:
        fails: Whether the native work rejects its input after streaming begins.
    """

    async def scenario() -> None:
        """Observe a heartbeat before allowing the controlled calculation to finish."""
        heartbeat, finish = asyncio.Event(), asyncio.Event()
        messages: list[dict[str, Any]] = []

        async def calculate() -> FieldCalculationResult:
            """Wait for the test's completion signal and return the whole result."""
            await finish.wait()
            if fails:
                raise VectorConflictError("Unknown field 'missing'.")
            return FieldCalculationResult(
                calculatedFields=(), fields={}, featureCount=4, missingCounts={}
            )

        async def receive() -> dict[str, Any]:
            """Keep the requesting browser connected throughout the calculation."""
            await asyncio.Future()

        async def send(message: dict[str, Any]) -> None:
            """Record response frames and acknowledge the first whitespace heartbeat."""
            messages.append(message)
            if message.get("body") == b"\n":
                heartbeat.set()

        response = FieldCalculationResponse(calculate, {}, heartbeat_seconds=0.01)
        pending = asyncio.create_task(response({"type": "http"}, receive, send))
        await asyncio.wait_for(heartbeat.wait(), 1)
        assert not pending.done()
        assert messages[0]["status"] == 200
        headers = dict(messages[0]["headers"])
        assert headers[b"x-accel-buffering"] == b"no"
        assert b"no-transform" in headers[b"cache-control"]
        assert b"content-length" not in headers
        assert b"".join(message.get("body", b"") for message in messages).strip() == b""
        finish.set()
        await asyncio.wait_for(pending, 1)
        result = json.loads(b"".join(message.get("body", b"") for message in messages))
        if fails:
            assert result == {"detail": "Unknown field 'missing'."}
        else:
            assert result["featureCount"] == 4

    asyncio.run(scenario())


def test_stream_disconnect_waits_for_calculation_cleanup() -> None:
    """Do not return from a disconnected stream until cancelled native work exits."""

    async def scenario() -> None:
        """Disconnect after a heartbeat and hold the native cleanup acknowledgement."""
        heartbeat, disconnect = asyncio.Event(), asyncio.Event()
        stopping, stopped = asyncio.Event(), asyncio.Event()

        async def calculate() -> FieldCalculationResult:
            """Model an operation that releases its source only after native exit."""
            try:
                await asyncio.Future()
            finally:
                stopping.set()
                await stopped.wait()

        async def receive() -> dict[str, Any]:
            """Signal the browser disconnect after a heartbeat has been observed."""
            await disconnect.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            """Acknowledge the first streamed body without changing task ownership."""
            if message.get("body") == b"\n":
                heartbeat.set()

        response = FieldCalculationResponse(calculate, {}, heartbeat_seconds=0.01)
        pending = asyncio.create_task(response({"type": "http"}, receive, send))
        await asyncio.wait_for(heartbeat.wait(), 1)
        disconnect.set()
        await asyncio.wait_for(stopping.wait(), 1)
        assert not pending.done()
        stopped.set()
        await asyncio.wait_for(pending, 1)

    asyncio.run(scenario())
