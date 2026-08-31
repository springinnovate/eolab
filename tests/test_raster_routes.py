"""Test raster HTTP delivery and application-error translation."""

import asyncio
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.raster.errors import (
    RasterConflictError,
    RasterStatisticsCapacityError,
    RasterPublicationError,
    RasterPublicationFailureCategory,
)
from eolab_app.raster.sources import PublishedRasterRegistry
from eolab_app.routes.raster_analysis import create_raster_analysis_router
from eolab_app.routes.raster_http import raster_http_exception
from eolab_app.routes.rasters import create_raster_feature


class _ConflictService:
    """Raise one controlled application-level conflict."""

    async def assess(self, _: object) -> None:
        """Fail assessment with a browser-safe conflict."""
        raise RasterConflictError("controlled raster conflict")

    async def publish(self, _: object) -> None:
        """Fail publication with a browser-safe conflict."""
        raise RasterConflictError("controlled raster conflict")

    async def get(self, _: object) -> None:
        """Fail analysis with a browser-safe conflict."""
        raise RasterConflictError("controlled raster conflict")

    async def get_paired(self, _: object) -> None:
        """Fail paired analysis with the same browser-safe conflict.

        Args:
            _: Ignored validated paired-statistics request.

        Returns:
            None because the controlled request always fails.

        Raises:
            RasterConflictError: Always, with the controlled conflict.
        """
        raise RasterConflictError("controlled raster conflict")


@pytest.mark.parametrize("paired", [False, True])
def test_statistics_capacity_conflicts_have_a_retryable_code(paired: bool) -> None:
    """Expose admission conflicts distinctly on both analysis routes.

    Args:
        paired: Exercise the two-raster endpoint when true.
    """
    class CapacityService:
        """Simulate an occupied read slot without touching raster data."""

        async def get(self, _request: object) -> None:
            """Reject a read with a classified, transient admission failure."""
            raise RasterStatisticsCapacityError("Statistics reader occupied")

        get_paired = get

    service = CapacityService()
    application = FastAPI()
    application.include_router(create_raster_analysis_router(service, service))
    item = {"collectionId": "eolab-mounted-geotiffs", "itemId": "geotiff-0123456789abcdef01234567"}
    body = {"xRaster": item, "yRaster": {**item, "itemId": "geotiff-abcdef0123456789abcdef01"}} if paired else item
    endpoint = "paired-statistics" if paired else "statistics"
    response = TestClient(application).post(f"/api/raster-analysis/{endpoint}", json=body)
    assert response.status_code == 409
    assert response.json() == {"detail": {
        "code": "statistics_capacity_busy", "message": "Statistics reader occupied",
    }}

class _PublicationFailureService:
    """Raise one controlled categorized publication failure."""

    async def publish(self, request: object) -> None:
        """Fail publication with a browser-safe reader category.

        Args:
            request: Ignored validated publication request.

        Raises:
            RasterPublicationError: Always, with controlled public detail.
        """
        raise RasterPublicationError(
            "reader_rejection",
            "Check this raster's CRS and GeoTIFF compatibility.",
        )


def test_raster_routes_translate_application_errors_at_http_boundary() -> None:
    """Keep HTTP status semantics out of raster application services."""
    service = _ConflictService()
    registry = PublishedRasterRegistry()
    feature = create_raster_feature(
        service,
        service,
        service,
        registry,
    )
    application = FastAPI()
    application.include_router(create_raster_analysis_router(service, service))
    application.include_router(feature.router)

    response = TestClient(application).post(
        "/api/rendering/layers",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        },
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "controlled raster conflict"}
    assert feature.registry is registry

    detail_response = TestClient(application).post(
        "/api/rendering/detail-previews",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
            "viewBounds": {
                "west": -123.0,
                "south": 37.0,
                "east": -122.0,
                "north": 38.0,
            },
        },
    )
    assert detail_response.status_code == 409
    assert detail_response.json() == {"detail": "controlled raster conflict"}

    pixel_response = TestClient(application).post(
        "/api/raster-analysis/pixels",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
            "longitude": -122.5,
            "latitude": 37.5,
        },
    )
    assert pixel_response.status_code == 409
    assert pixel_response.json() == {
        "detail": "controlled raster conflict"
    }
    retired_rendering_pixel_response = TestClient(application).post(
        "/api/rendering/pixels",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
            "longitude": -122.5,
            "latitude": 37.5,
        },
    )
    assert retired_rendering_pixel_response.status_code == 404

    statistics_response = TestClient(application).post(
        "/api/raster-analysis/statistics",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
            "selectedBounds": {
                "west": -123.0,
                "south": 37.0,
                "east": -122.0,
                "north": 38.0,
            },
        },
    )
    assert statistics_response.status_code == 409
    assert statistics_response.json() == {
        "detail": "controlled raster conflict"
    }
    paired_response = TestClient(application).post(
        "/api/raster-analysis/paired-statistics",
        json={
            "xRaster": {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": "geotiff-0123456789abcdef01234567",
            },
            "yRaster": {
                "collectionId": "eolab-mounted-geotiffs",
                "itemId": "geotiff-abcdef0123456789abcdef01",
            },
        },
    )
    assert paired_response.status_code == 409
    assert paired_response.json() == {
        "detail": "controlled raster conflict"
    }
    assert TestClient(application).post(
        "/api/rendering/statistics",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        },
    ).status_code == 404
    assert TestClient(application).post(
        "/api/rendering/detail-statistics",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        },
    ).status_code == 404


def test_detail_preview_disconnect_cancels_the_service_waiter() -> None:
    """Propagate an abandoned browser fetch into preview service ownership."""

    class BlockingDetailPreviewService:
        """Expose cancellation of one controlled preview waiter."""

        def __init__(self) -> None:
            """Create unset lifecycle events."""
            self.started = asyncio.Event()
            self.canceled = asyncio.Event()

        async def get(self, _request: object) -> None:
            """Wait until the HTTP boundary cancels this caller.

            Args:
                _request: Ignored validated preview request.

            Returns:
                Never returns normally.

            Raises:
                asyncio.CancelledError: When the browser disconnects.
            """
            self.started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.canceled.set()
                raise

    detail_service = BlockingDetailPreviewService()
    conflict_service = _ConflictService()
    feature = create_raster_feature(
        conflict_service,
        conflict_service,
        detail_service,
        PublishedRasterRegistry(),
    )
    application = FastAPI()
    application.include_router(feature.router)
    request_body = json.dumps({
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": "geotiff-0123456789abcdef01234567",
    }).encode()
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/api/rendering/detail-previews",
        "raw_path": b"/api/rendering/detail-previews",
        "query_string": b"",
        "headers": [
            (b"host", b"testserver"),
            (b"content-type", b"application/json"),
            (b"content-length", str(len(request_body)).encode()),
        ],
        "client": ("127.0.0.1", 12345),
        "server": ("testserver", 80),
        "root_path": "",
        "state": {},
    }

    async def exercise_disconnect() -> list[dict[str, object]]:
        """Send one valid body followed by an explicit disconnect.

        Returns:
            ASGI response messages emitted around cancellation.
        """
        request_messages: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        await request_messages.put({
            "type": "http.request",
            "body": request_body,
            "more_body": False,
        })
        response_messages: list[dict[str, object]] = []

        async def receive() -> dict[str, object]:
            """Return the next controlled ASGI request message.

            Returns:
                Next queued request or disconnect event.
            """
            return await request_messages.get()

        async def send(message: dict[str, object]) -> None:
            """Retain one application response message for assertions.

            Args:
                message: ASGI response event emitted by FastAPI.

            Returns:
                None.
            """
            response_messages.append(message)

        request_task = asyncio.create_task(application(scope, receive, send))
        await asyncio.wait_for(detail_service.started.wait(), 1)
        await request_messages.put({"type": "http.disconnect"})
        await asyncio.wait_for(request_task, 1)
        return response_messages

    response_messages = asyncio.run(exercise_disconnect())

    assert detail_service.canceled.is_set()
    assert next(
        message["status"]
        for message in response_messages
        if message["type"] == "http.response.start"
    ) == 499


@pytest.mark.parametrize(
    "request_overrides",
    [
        {"density": "arbitrary"},
        {
            "viewBounds": {
                "west": -122.0,
                "south": 37.0,
                "east": -123.0,
                "north": 38.0,
            }
        },
        {
            "viewBounds": {
                "west": -123.0,
                "south": 37.0,
                "east": -122.0,
                "north": 38.0,
                "path": "/browser-controlled/source.tif",
            }
        },
        {"width": 25},
        {"path": "/browser-controlled/source.tif"},
        {
            "sourceWindow": {
                "columnOffset": 0,
                "rowOffset": 0,
                "width": 25,
                "height": 10,
            }
        },
    ],
    ids=[
        "unknown-density",
        "reversed-view-bounds",
        "nested-view-bounds-path",
        "browser-width",
        "browser-path",
        "browser-source-window",
    ],
)
def test_detail_preview_route_rejects_unowned_sampling_parameters(
    request_overrides: dict[str, object],
) -> None:
    """Reject invalid bounds and browser-controlled read parameters.

    Args:
        request_overrides: Invalid fields merged into an otherwise valid
            sampled-grid preview request.

    Returns:
        None.
    """
    service = _ConflictService()
    feature = create_raster_feature(
        service,
        service,
        service,
        PublishedRasterRegistry(),
    )
    application = FastAPI()
    application.include_router(feature.router)
    request_body: dict[str, object] = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": "geotiff-0123456789abcdef01234567",
        "mode": "representativeSample",
        "density": "coarse",
    }
    request_body.update(request_overrides)

    response = TestClient(application).post(
        "/api/rendering/detail-previews",
        json=request_body,
    )

    assert response.status_code == 422


@pytest.mark.parametrize(
    "request_overrides",
    [
        {"path": "/browser-controlled/source.tif"},
        {
            "selectedBounds": {
                "west": -123.0,
                "south": 37.0,
                "east": -122.0,
                "north": 38.0,
                "sourceWindow": [0, 0, 127, 127],
            }
        },
        {
            "selectedBounds": {
                "west": -123.0,
                "south": 37.0,
                "east": -122.0,
                "north": 38.0,
            },
            "temporaryAoiId": "temporaryAoiIdentity012345678901",
        },
    ],
    ids=["browser-path", "nested-source-window", "mixed-area-union"],
)
def test_analysis_statistics_route_rejects_unowned_sampling_parameters(
    request_overrides: dict[str, object],
) -> None:
    """Reject browser-controlled reads outside the strict sampling union.

    Args:
        request_overrides: Missing or unsafe fields applied to base identity.

    Returns:
        None.
    """
    service = _ConflictService()
    feature = create_raster_feature(
        service,
        service,
        service,
        PublishedRasterRegistry(),
    )
    application = FastAPI()
    application.include_router(create_raster_analysis_router(service, service))
    application.include_router(feature.router)
    request_body: dict[str, object] = {
        "collectionId": "eolab-mounted-geotiffs",
        "itemId": "geotiff-0123456789abcdef01234567",
    }
    request_body.update(request_overrides)

    response = TestClient(application).post(
        "/api/raster-analysis/statistics",
        json=request_body,
    )

    assert response.status_code == 422


def test_publication_route_returns_actionable_category_document() -> None:
    """Serialize the reader category and guidance through FastAPI.

    Returns:
        None.
    """
    service = _PublicationFailureService()
    registry = PublishedRasterRegistry()
    feature = create_raster_feature(
        service,
        service,
        service,
        registry,
    )
    application = FastAPI()
    application.include_router(feature.router)

    response = TestClient(application).post(
        "/api/rendering/layers",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
        },
    )

    assert response.status_code == 422
    assert response.json() == {
        "detail": {
            "category": "reader_rejection",
            "message": "Check this raster's CRS and GeoTIFF compatibility.",
        }
    }


@pytest.mark.parametrize(
    ("category", "status_code"),
    [
        ("reader_rejection", 422),
        ("connectivity", 503),
        ("authentication", 502),
        ("timeout", 504),
        ("configuration", 503),
        ("upstream_failure", 502),
    ],
)
def test_publication_errors_expose_stable_category_documents(
    category: RasterPublicationFailureCategory,
    status_code: int,
) -> None:
    """Preserve categorized publication failures at the HTTP boundary.

    Args:
        category: Stable application-level publication failure category.
        status_code: Expected public HTTP status for the category.

    Returns:
        None.
    """
    exception = raster_http_exception(
        RasterPublicationError(category, "Actionable publication guidance")
    )

    assert exception.status_code == status_code
    assert exception.detail == {
        "category": category,
        "message": "Actionable publication guidance",
    }
