"""Test raster HTTP delivery and application-error translation."""

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
