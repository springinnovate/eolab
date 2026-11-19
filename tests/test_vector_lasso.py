"""Check exact lasso membership, whole-feature highlights and private source access."""

import asyncio
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx2
import pytest
from pydantic import ValidationError
from shapely.geometry import LineString, Point, box, mapping, shape

from eolab_app.attribute_filter import VectorFilter
from eolab_app.feature_intersection import intersecting_feature_ids
from eolab_app.polygon_areas import SummaryPolygon
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.routes.vector_uploads import create_vector_uploads_router
from eolab_app.vector import lasso, selection_operation
from eolab_app.vector.lasso import LassoSelectionRequest, read_lasso_highlights
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.sources import MountedVectorResolver
from eolab_app.vector_uploads import VectorUploadStore
from tests.test_vector_intersections import _write_layer
from tests.test_vector_publication import StaticCatalog
from tests.test_vector_uploads import BASE, HEADERS, write_layer


def test_lasso_uses_exact_geometry_and_keeps_whole_filtered_features(
    tmp_path: Path,
) -> None:
    """A triangle excludes an envelope hit and includes edge contact and a containing feature.

    Args:
        tmp_path: Disposable original GeoPackage directory.
    """
    predicate = VectorFilter.model_validate(
        {
            "match": "any",
            "rules": [
                {"field": "group", "operator": "eq", "value": "forest"},
                {"field": "group", "operator": "eq", "value": "study"},
            ],
        }
    )
    target = _write_layer(
        tmp_path / "targets.gpkg",
        [
            (Point(1, 1), "forest"),
            (LineString([(4, 0), (5, 0)]), "study"),
            (Point(3, 3), "forest"),
            (box(-1, -1, 5, 5), "study"),
            (Point(1, 1), "urban"),
            (None, "forest"),
        ],
        predicate=predicate,
    )
    polygon = SummaryPolygon(coordinates=(((0, 0), (4, 0), (0, 4), (0, 0)),))
    ids = intersecting_feature_ids(target, (polygon,))
    assert ids == (1, 2, 4)
    highlights = asyncio.run(read_lasso_highlights(target, ids))
    assert highlights is not None
    assert [feature["id"] for feature in highlights["features"]] == [1, 2, 4]
    assert shape(highlights["features"][-1]["geometry"]).equals(box(-1, -1, 5, 5))
    assert all(feature["properties"] == {} for feature in highlights["features"])
    assert target.selection.filter == predicate
    empty = intersecting_feature_ids(
        target, (SummaryPolygon.model_validate(mapping(box(30, 30, 31, 31))),)
    )
    assert empty == ()
    assert asyncio.run(read_lasso_highlights(target, empty)) == {
        "type": "FeatureCollection",
        "features": [],
    }


@pytest.mark.parametrize(
    "invalid",
    [
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [1, 0], [0, 1], [0, 0]]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [1, 0]]]},
        {"type": "Polygon", "coordinates": [[[181, 0], [1, 1], [1, 0], [181, 0]]]},
    ],
)
def test_lasso_rejects_invalid_user_outlines(invalid: dict) -> None:
    """Reject crossing, unclosed and noncanonical polygons at the request boundary.

    Args:
        invalid: Malformed external geometry.
    """
    with pytest.raises(ValidationError):
        SummaryPolygon.model_validate(invalid)


def test_highlight_budget_does_not_change_membership(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A display-capacity failure keeps exact IDs available to the selection owner.

    Args:
        tmp_path: Disposable original GeoPackage.
        monkeypatch: Reduce only the optional display coordinate budget.
    """
    target = _write_layer(tmp_path / "targets.gpkg", [(box(0, 0, 2, 2), "forest")])
    ids = intersecting_feature_ids(
        target, (SummaryPolygon.model_validate(mapping(box(1, 1, 3, 3))),)
    )
    result = []

    class Writer:
        """Collect the native highlight worker's output without spawning a second interpreter."""

        def put(self, value: object) -> None:
            """Collect the optional display result.

            Args:
                value: Complete geometry or the display-unavailable sentinel.
            """
            result.append(value)

    monkeypatch.setattr(lasso, "MAX_DISPLAY_COORDINATES", 1)
    lasso._read_highlights(Writer(), target, ids, lasso.VectorReadLimits())
    assert ids == (1,)
    assert result == [None]


def test_private_lasso_uses_original_source_jobs_without_geoserver(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The real upload, source authority, Jobs operation and HTTP route share exact membership.

    Args:
        tmp_path: Private browser upload and worker mount directory.
        monkeypatch: Point the installed worker at that same original source mount.
    """
    uploads = VectorUploadStore(tmp_path / "uploads", None)
    app = FastAPI()
    monkeypatch.setattr(selection_operation, "UPLOAD_MOUNT", uploads.root)

    async def run_job(token: str) -> None:
        """Execute the production comparison operation against the authorized source route.

        Args:
            token: One expiring comparison capability held by the request owner.
        """
        async with httpx2.AsyncClient(
            mounts={"http://app:8000": httpx2.ASGITransport(app=app)}, trust_env=False
        ) as client:
            await selection_operation.return_intersecting_ids(
                client, selection_operation.ComparisonInput(spatialRead=token)
            )

    reader = VectorSamplingService(
        StaticCatalog({}),
        MountedVectorResolver(tmp_path),
        uploads=uploads,
        comparison_executor=run_job,
    )
    app.include_router(create_vector_sampling_router(reader))
    app.include_router(create_vector_uploads_router(uploads))
    with (
        TestClient(app, base_url="https://testserver") as owner,
        TestClient(app, base_url="https://testserver") as other,
    ):
        uploaded = owner.post(
            BASE,
            params={"name": "Study area"},
            headers=HEADERS,
            content=write_layer(tmp_path / "original.gpkg"),
        )
        assert uploaded.status_code == 201, uploaded.text
        identifier = uploaded.json()["id"]
        selection = {
            "uploadId": identifier,
            "layerName": "areas",
            "filter": {"rules": []},
        }
        body = {"selection": selection, "polygon": mapping(box(-1, -1, 1, 1))}
        response = owner.post("/api/vector-sampling/lasso", json=body, headers=HEADERS)
        assert response.status_code == 200, response.text
        value = response.json()
        assert value["matched"] == 1
        assert len(value["featureIds"]) == 1
        assert value["geometry"]["features"][0]["geometry"]["type"] == "Polygon"
        assert len(value["geometry"]["features"][0]["geometry"]["coordinates"]) == 2
        assert "source_path" not in response.text
        assert (
            other.post(
                "/api/vector-sampling/lasso", json=body, headers=HEADERS
            ).status_code
            == 404
        )
        assert owner.post("/api/vector-sampling/lasso", json=body).status_code == 403
        invalid = {**body, "selection": {**selection, "path": "untrusted.gpkg"}}
        assert (
            owner.post(
                "/api/vector-sampling/lasso", json=invalid, headers=HEADERS
            ).status_code
            == 422
        )
        assert owner.delete(f"{BASE}/{identifier}", headers=HEADERS).status_code == 204
        assert (
            owner.post(
                "/api/vector-sampling/lasso", json=body, headers=HEADERS
            ).status_code
            == 404
        )
