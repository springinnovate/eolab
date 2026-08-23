"""Test raster HTTP delivery and application-error translation."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.raster.errors import (
    RasterConflictError,
    RasterPublicationError,
    RasterPublicationFailureCategory,
)
from eolab_app.raster.sources import PublishedRasterRegistry
from eolab_app.routes.rasters import create_raster_feature, raster_http_exception


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

    assert response.status_code == 409
    assert response.json() == {"detail": "controlled raster conflict"}
    assert feature.registry is registry

    detail_response = TestClient(application).post(
        "/api/rendering/detail-previews",
        json={
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": "geotiff-0123456789abcdef01234567",
            "mode": "representativeSample",
        },
    )
    assert detail_response.status_code == 409
    assert detail_response.json() == {"detail": "controlled raster conflict"}


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
