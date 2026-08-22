"""Test raster HTTP delivery and application-error translation."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.sources import PublishedRasterRegistry
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


def test_raster_routes_translate_application_errors_at_http_boundary() -> None:
    """Keep HTTP status semantics out of raster application services."""
    service = _ConflictService()
    registry = PublishedRasterRegistry()
    feature = create_raster_feature(
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
