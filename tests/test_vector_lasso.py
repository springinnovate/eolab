"""Check exact lasso membership, whole-feature highlights and private source access."""

import asyncio
import json
from dataclasses import replace
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx2
import pytest
from pydantic import ValidationError
from pyproj import Transformer
from shapely import transform
from shapely.geometry import LineString, Point, box, mapping, shape

from eolab_app.attribute_filter import VectorFilter
from eolab_app.bounded_vector import VectorReadLimits
from eolab_app.feature_intersection import iter_original_features, match_features
from eolab_app.polygon_areas import SummaryPolygon
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.routes.vector_uploads import create_vector_uploads_router
from eolab_app.source_files import SourceFileError
from eolab_app.vector import lasso, selection_operation
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.feature_attributes import collect_feature_attributes
from eolab_app.vector.lasso import LassoSelectionRequest, encode_lasso_highlights
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.sources import MountedVectorResolver
from eolab_app.vector_uploads import VectorUploadStore
from tests.test_raster_source_access import _vector_result_sampler
from tests.test_vector_intersections import _write_layer
from tests.test_vector_publication import StaticCatalog
from tests.test_vector_uploads import BASE, HEADERS, write_layer


@pytest.mark.parametrize(
    ("crs", "spatial_index", "limits"),
    [
        ("EPSG:4326", True, VectorReadLimits(features=5)),
        ("EPSG:3857", True, VectorReadLimits(features=5)),
        ("EPSG:6933", True, VectorReadLimits(features=5)),
        ("EPSG:6933", False, VectorReadLimits()),
    ],
)
def test_lasso_reads_only_candidates_when_the_source_index_is_usable(
    tmp_path: Path, crs: str, spatial_index: bool, limits: VectorReadLimits
) -> None:
    """Nearby candidates fit the read budget and are checked against the exact outline.

    Args:
        tmp_path: Directory for the original indexed or unindexed GeoPackage.
        crs: Native coordinate system of the original features.
        spatial_index: Whether to create the GeoPackage's spatial index.
        limits: Feature read budget for this case.
    """
    project = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
    features = [
        *((Point(-20, latitude), "forest") for latitude in range(5)),
        (Point(1, 1), "forest"),
        (LineString([(0, 0), (0, -1)]), "study"),
        (Point(3, 3), "forest"),
        (box(-1, -1, 5, 5), "study"),
        (Point(1, 1), "urban"),
    ]
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
            (transform(geometry, project, interleaved=False), group)
            for geometry, group in features
        ],
        crs=crs,
        predicate=predicate,
        spatial_index=spatial_index,
    )
    outline = SummaryPolygon(coordinates=(((0, 0), (4, 0), (0, 4), (0, 0)),))
    matches = match_features(
        target,
        {},
        VectorFilter(),
        limits=limits,
        required_area=shape(outline.model_dump()),
    )
    assert matches.ids == {6, 7, 9}


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
    ids = tuple(
        sorted(
            match_features(
                target, {}, VectorFilter(), required_area=shape(polygon.model_dump())
            ).ids
        )
    )
    assert ids == (1, 2, 4)
    original = replace(
        target,
        where=None,
        selection=target.selection.model_copy(update={"filter": VectorFilter()}),
    )
    combined = match_features(
        original, {}, predicate, required_area=shape(polygon.model_dump())
    )
    assert combined.ids == frozenset(ids)
    assert combined.total == 6
    highlights = json.loads(encode_lasso_highlights(target, ids, VectorReadLimits()))
    assert highlights is not None
    assert [feature["id"] for feature in highlights["features"]] == [1, 2, 4]
    assert shape(highlights["features"][-1]["geometry"]).equals(box(-1, -1, 5, 5))
    assert all(feature["properties"] == {} for feature in highlights["features"])
    assert target.selection.filter == predicate
    empty = tuple(
        match_features(
            target, {}, VectorFilter(), required_area=box(30, 30, 31, 31)
        ).ids
    )
    assert empty == ()
    assert json.loads(encode_lasso_highlights(target, empty, VectorReadLimits())) == {
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


def test_small_and_large_lassos_identify_every_feature(tmp_path: Path) -> None:
    """Keep small selections exact and draw every selected polygon at reduced detail.

    Args:
        tmp_path: Disposable GeoPackage shared by both lasso selections.
    """
    polygons = [Point(x, 0).buffer(0.4, quad_segs=60) for x in range(50)]
    target = _write_layer(
        tmp_path / "parcels.gpkg",
        [(geometry, f"parcel {x}") for x, geometry in enumerate(polygons)],
    )
    for count in (14, 50):
        ids = tuple(
            sorted(
                match_features(
                    target,
                    {},
                    VectorFilter(),
                    required_area=box(-1, -1, count - 0.5, 1),
                ).ids
            )
        )
        assert ids == tuple(range(1, count + 1))
        rows = collect_feature_attributes(target, ids, VectorReadLimits()).features
        assert [(row.id, row.properties["group"]) for row in rows] == [
            (str(x + 1), f"parcel {x}") for x in range(count)
        ]
        encoded = encode_lasso_highlights(target, ids, VectorReadLimits())
        assert encoded is not None, "Every selected parcel should have a map highlight"
        assert len(encoded) <= lasso.MAX_DISPLAY_BYTES
        highlights = json.loads(encoded)
        assert highlights.get("simplified", False) is (count == 50)
        assert [f["id"] for f in highlights["features"]] == list(ids)
        shapes = [shape(f["geometry"]) for f in highlights["features"]]
        coordinate_count = sum(len(geometry.exterior.coords) for geometry in shapes)
        assert coordinate_count <= lasso.MAX_DISPLAY_COORDINATES
        for x, display in enumerate(shapes):
            original = polygons[x]
            assert display.geom_type == "Polygon" and display.covers(Point(x, 0))
            if count == 14:
                assert original.equals(display)
            else:
                assert len(display.exterior.coords) < len(original.exterior.coords)


def test_highlight_budget_does_not_change_membership(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Show a point when only one coordinate fits, and preserve IDs when none fits.

    Args:
        tmp_path: Disposable original GeoPackage.
        monkeypatch: Reduce only the optional display coordinate budget.
    """
    target = _write_layer(tmp_path / "targets.gpkg", [(box(0, 0, 2, 2), "forest")])
    ids = tuple(
        match_features(target, {}, VectorFilter(), required_area=box(1, 1, 3, 3)).ids
    )
    monkeypatch.setattr(lasso, "MAX_DISPLAY_COORDINATES", 1)
    assert ids == (1,)
    marker = json.loads(encode_lasso_highlights(target, ids, VectorReadLimits()))
    assert marker["simplified"] is True
    (feature,) = marker["features"]
    assert feature["id"] == ids[0]
    point = shape(feature["geometry"])
    assert point.geom_type == "Point" and box(0, 0, 2, 2).covers(point)
    monkeypatch.setattr(lasso, "MAX_DISPLAY_COORDINATES", 0)
    assert encode_lasso_highlights(target, ids, VectorReadLimits()) is None


def test_lasso_highlight_reads_the_matching_feature_by_id(tmp_path: Path) -> None:
    """Read a late feature's highlight and attributes under a one-feature budget.

    Args:
        tmp_path: Directory for the original GeoPackage.
    """
    original = box(10, 10, 12, 12)
    target = _write_layer(
        tmp_path / "targets.gpkg",
        [(box(0, 0, 1, 1), "earlier"), (original, "selected")],
    )
    highlights = json.loads(
        encode_lasso_highlights(target, (2,), VectorReadLimits(features=1))
    )

    assert highlights is not None
    assert [feature["id"] for feature in highlights["features"]] == [2]
    assert shape(highlights["features"][0]["geometry"]).equals(original)
    attributes = list(
        iter_original_features(
            target,
            VectorReadLimits(features=1, coordinates_per_feature=1),
            None,
            feature_ids=(2,),
            read_geometry=False,
        )
    )
    assert attributes == [(2, {"group": "selected"}, None)]


def test_private_lasso_uses_original_source_jobs_without_geoserver(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Read exact Lasso membership and attributes through the real owned-source APIs.

    Args:
        tmp_path: Private browser upload and worker mount directory.
        monkeypatch: Point the installed worker at that same original source mount.
    """
    uploads = VectorUploadStore(tmp_path / "uploads", None)
    app = FastAPI()
    monkeypatch.setattr(selection_operation, "UPLOAD_MOUNT", uploads.root)

    async def run_job(token: str, execution_seconds: int) -> None:
        """Execute the production comparison operation against the authorized source route.

        Args:
            token: One expiring comparison capability held by the request owner.
            execution_seconds: Hard deadline covering comparison, attributes and outlines.
        """
        assert execution_seconds == 50
        async with httpx2.AsyncClient(
            mounts={"http://app:8000": httpx2.ASGITransport(app=app)}, trust_env=False
        ) as client:
            await selection_operation.deliver_intersection_result(
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
        attributes = owner.post(
            "/api/vector-sampling/features",
            json={"selection": selection, "featureIds": value["featureIds"]},
            headers=HEADERS,
        )
        assert attributes.status_code == 200, attributes.text
        assert value["features"] == attributes.json()["features"]
        assert attributes.json()["features"] == [
            {
                "id": value["featureIds"][0],
                "properties": {"label": "Café wetlands", "count": 7, "weight": 2.5},
            }
        ]
        assert attributes.json()["selection"]["uploadId"] == identifier
        assert attributes.headers["Cache-Control"] == "private, no-store"
        assert "geometry" not in attributes.json()["features"][0]
        attribute_request = {"selection": selection, "featureIds": value["featureIds"]}
        assert other.post(
            "/api/vector-sampling/features", json=attribute_request, headers=HEADERS
        ).status_code == 404
        assert owner.post(
            "/api/vector-sampling/features", json=attribute_request
        ).status_code == 403
        empty = owner.post(
            "/api/vector-sampling/features",
            json={"selection": selection, "featureIds": []},
            headers=HEADERS,
        )
        assert empty.status_code == 200 and empty.json()["features"] == []
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
        assert owner.post(
            "/api/vector-sampling/features", json=attribute_request, headers=HEADERS
        ).status_code == 404
        assert (
            owner.post(
                "/api/vector-sampling/lasso", json=body, headers=HEADERS
            ).status_code
            == 404
        )


@pytest.mark.parametrize(
    "outcome",
    [
        "required_timeout",
        "optional_timeout",
        "optional_failure",
        "cancel",
        "source_expired",
    ],
)
def test_lasso_delivery_waits_for_native_exit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, outcome: str
) -> None:
    """Keep completed rows on outline failure and withhold results after cancellation or lease loss.

    Args:
        tmp_path: Immutable original result file.
        monkeypatch: Shorten the stage deadlines for the controlled worker.
        outcome: The worker, caller or source transition to exercise.
    """
    service, authority, selection = _vector_result_sampler(tmp_path)
    polygon = SummaryPolygon.model_validate(mapping(box(0, 0, 1, 1)))
    label = "x" * (520 * 1024) if outcome == "optional_timeout" else "Marsh"
    rows = [{"id": "9007199254740993", "properties": {"label": label}}]
    monkeypatch.setattr(lasso, "READ_SECONDS", 0.15)
    app = FastAPI()
    app.include_router(create_vector_sampling_router(service))

    async def exercise() -> None:
        """Keep both the lease and private exchange alive through controlled native cleanup."""
        entered, stopping, exit_allowed = (
            asyncio.Event(),
            asyncio.Event(),
            asyncio.Event(),
        )
        credentials = []

        async def run_job(token: str, execution_seconds: int) -> None:
            """Use the worker HTTP handoff and delay terminal cleanup until observed by the test.

            Args:
                token: Only credential authorized to deliver this selection.
                execution_seconds: Outer Jobs execution deadline.

            Raises:
                VectorConflictError: The optional native read fails.
                asyncio.CancelledError: A stage times out or the caller cancels.
            """
            credentials.append(token)
            headers = {"Authorization": f"Bearer {token}"}
            url = "/api/vector-sampling/spatial-read"
            async with httpx2.AsyncClient(
                transport=httpx2.ASGITransport(app=app), base_url="http://app"
            ) as client:
                assert (await client.get(url, headers=headers)).is_success
                assert (
                    await client.put(
                        url, headers=headers, params={"stage": "highlights"}, json={}
                    )
                ).status_code == 409
                assert (
                    await client.put(
                        url, headers=headers, params={"stage": "attributes"}
                    )
                ).is_success
                if outcome != "required_timeout":
                    assert (
                        await client.put(
                            url,
                            headers=headers,
                            params={"stage": "features"},
                            json=rows,
                        )
                    ).is_success
            entered.set()
            try:
                if outcome == "optional_failure":
                    raise VectorConflictError("The native worker stopped.")
                if outcome == "source_expired":
                    authority.ready = False
                    return
                await asyncio.Event().wait()
            finally:
                stopping.set()
                await exit_allowed.wait()

        monkeypatch.setattr(service, "_comparison_executor", run_job)
        async with asyncio.timeout(5):
            pending = asyncio.create_task(service.lasso(selection, polygon, "owner"))
            await entered.wait()
            if outcome == "cancel":
                pending.cancel()
            await stopping.wait()
            assert (
                authority.leases
                and service.spatial_reads.get(credentials[0]) is not None
            )
            assert not pending.done()
            exit_allowed.set()
            if outcome == "required_timeout":
                with pytest.raises(VectorConflictError, match="too long"):
                    await pending
            elif outcome == "cancel":
                with pytest.raises(asyncio.CancelledError):
                    await pending
            elif outcome == "source_expired":
                with pytest.raises(SourceFileError):
                    await pending
            else:
                result = await pending
                assert (
                    result.featureIds == ("9007199254740993",)
                    and result.geometry is None
                )
                assert result.model_dump(mode="json")["features"] == rows
            assert (
                not authority.leases
                and service.spatial_reads.get(credentials[0]) is None
            )

    asyncio.run(exercise())
