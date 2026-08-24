"""Test vector assessment HTTP delivery and application-error translation."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.routes.vectors import create_vector_assessment_router
from eolab_app.vector.errors import VectorConflictError


class _VectorAssessmentService:
    """Return one fixed assessment document."""

    async def assess(self, request: object) -> dict[str, object]:
        """Return one assessed Item document.

        Args:
            request: Validated Item identity.

        Returns:
            Minimal assessed Item fixture.
        """
        return {"id": request.item_id, "type": "Feature"}


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


def _vector_test_client(service: object) -> TestClient:
    """Build a vector-assessment-only FastAPI test client.

    Args:
        service: Assessment service fake.

    Returns:
        Client around the vector assessment delivery boundary.
    """
    application = FastAPI()
    application.include_router(create_vector_assessment_router(service))
    return TestClient(application)


def test_vector_assessment_route_preserves_catalog_identity() -> None:
    """Serialize the selected Catalog Item assessment document."""
    client = _vector_test_client(_VectorAssessmentService())
    identity = {
        "collectionId": "eolab-mounted-vectors",
        "itemId": "geopackage-0123456789abcdef01234567",
    }

    response = client.post("/api/vector-rendering/assessments", json=identity)

    assert response.status_code == 200
    assert response.json()["id"] == identity["itemId"]


def test_vector_assessment_route_translates_application_conflicts() -> None:
    """Keep HTTP conflict semantics at the vector delivery boundary."""
    response = _vector_test_client(_VectorConflictService()).post(
        "/api/vector-rendering/assessments",
        json={
            "collectionId": "eolab-mounted-vectors",
            "itemId": "shapefile-0123456789abcdef01234567",
        },
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "controlled vector conflict"}
