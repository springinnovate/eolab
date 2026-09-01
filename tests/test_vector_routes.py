"""Test vector HTTP delivery and application-error translation."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.routes.vectors import create_vector_feature
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.models import AppliedVectorStyle, PublishedVector
from eolab_app.vector.sources import PublishedVectorRegistry
from eolab_app.vector.styles import default_vector_style


class _VectorRouteService:
    """Return fixed assessment and publication documents."""

    async def assess(self, request: object) -> dict[str, object]:
        """Return one assessed Item document.

        Args:
            request: Validated Item identity.

        Returns:
            Minimal assessed Item fixture.
        """
        return {"id": request.item_id, "type": "Feature"}

    async def publish(self, request: object) -> PublishedVector:
        """Return one fixed bounded WMS contract.

        Args:
            request: Validated Item identity.

        Returns:
            Fixed vector publication fixture.
        """
        return PublishedVector(
            layerName=f"eolab:{request.item_id}",
            bbox=(-123, 48, -122, 49),
            geometryKind="polygon",
            styleName="vector-polygon",
            style=default_vector_style("polygon"),
        )

    async def apply(self, request: object) -> AppliedVectorStyle:
        """Return the requested normalized vector style.

        Args:
            request: Validated Item identity and style.

        Returns:
            Fixed applied style fixture.
        """
        return AppliedVectorStyle(
            styleName="vector-single-0123456789abcdef01234567",
            style=request.style,
        )


class _VectorConflictService:
    """Raise one controlled application conflict."""

    async def assess(self, request: object) -> None:
        """Reject reassessment.

        Args:
            request: Validated Item identity.

        Raises:
            VectorConflictError: Always, with browser-safe detail.
        """
        raise VectorConflictError("controlled vector conflict")

    async def publish(self, request: object) -> None:
        """Reject publication.

        Args:
            request: Validated Item identity.

        Raises:
            VectorConflictError: Always, with browser-safe detail.
        """
        raise VectorConflictError("controlled vector conflict")

    async def apply(self, request: object) -> None:
        """Reject vector styling.

        Args:
            request: Validated Item identity and style.

        Raises:
            VectorConflictError: Always, with browser-safe detail.
        """
        raise VectorConflictError("controlled vector conflict")


def _vector_test_client(service: object) -> TestClient:
    """Build a vector-only FastAPI test client.

    Args:
        service: Assessment and publication service fake.

    Returns:
        Client around the vector delivery boundary.
    """
    feature = create_vector_feature(
        service,
        service,
        service,
        PublishedVectorRegistry(),
    )
    application = FastAPI()
    application.include_router(feature.router)
    return TestClient(application)


def test_vector_routes_preserve_identity_and_fixed_style_contract() -> None:
    """Serialize assessment and bounded publication documents."""
    client = _vector_test_client(_VectorRouteService())
    identity = {
        "collectionId": "eolab-mounted-vectors",
        "itemId": "geopackage-0123456789abcdef01234567",
    }

    assessment = client.post("/api/vector-rendering/assessments", json=identity)
    publication = client.post("/api/vector-rendering/layers", json=identity)
    style = client.post("/api/vector-rendering/styles", json={
        **identity,
        "style": {
            "geometryKind": "line",
            "strokeColor": "#F97316",
            "strokeOpacity": 0.75,
            "strokeWidth": 4,
        },
    })

    assert assessment.status_code == 200
    assert assessment.json()["id"] == identity["itemId"]
    assert publication.status_code == 200
    assert publication.json() == {
        "layerName": f"eolab:{identity['itemId']}",
        "bbox": [-123.0, 48.0, -122.0, 49.0],
        "geometryKind": "polygon",
        "styleName": "vector-polygon",
        "style": {
            "geometryKind": "polygon",
            "fillColor": "#a855f7",
            "fillOpacity": 0.38,
            "strokeColor": "#581c87",
            "strokeOpacity": 1.0,
            "strokeWidth": 2.0,
            "pointSize": None,
        },
    }
    assert style.status_code == 200
    assert style.json() == {
        "styleName": "vector-single-0123456789abcdef01234567",
        "style": {
            "geometryKind": "line",
            "fillColor": None,
            "fillOpacity": None,
            "strokeColor": "#f97316",
            "strokeOpacity": 0.75,
            "strokeWidth": 4.0,
            "pointSize": None,
        },
    }


def test_vector_routes_translate_application_conflicts() -> None:
    """Keep HTTP conflict semantics at the vector delivery boundary."""
    response = _vector_test_client(_VectorConflictService()).post(
        "/api/vector-rendering/layers",
        json={
            "collectionId": "eolab-mounted-vectors",
            "itemId": "shapefile-0123456789abcdef01234567",
        },
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "controlled vector conflict"}


def test_vector_style_route_rejects_geometry_inconsistent_state() -> None:
    """Reject line styles carrying point or fill controls at validation."""
    response = _vector_test_client(_VectorRouteService()).post(
        "/api/vector-rendering/styles",
        json={
            "collectionId": "eolab-mounted-vectors",
            "itemId": "shapefile-0123456789abcdef01234567",
            "style": {
                "geometryKind": "line",
                "fillColor": "#ffffff",
                "fillOpacity": 1,
                "strokeColor": "#000000",
                "strokeOpacity": 1,
                "strokeWidth": 2,
            },
        },
    )

    assert response.status_code == 422
