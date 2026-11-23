"""Check exact scalar observations from original sources without display geometry."""

import asyncio
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any

import fiona
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from shapely.geometry import box, mapping

from catalog_selection_support import FixtureCatalog
from eolab_app.attribute_filter import VectorFilter
from eolab_app.bounded_vector import VectorReadLimits
from eolab_app.calculated_fields import CalculatedField
from eolab_app.catalog_selection import (
    CatalogSelection,
    FeatureMatches,
    ResolvedCatalogSelection,
)
from eolab_app.execution.bounded_process import ProcessDeadlineError
from eolab_app.feature_intersection import iter_original_features
from eolab_app.polygon_areas import SummaryPolygon
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.source_files import SourceFileError
from eolab_app.vector import feature_attributes, lasso
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.feature_attributes import (
    FeatureAttributesRequest,
    FeatureAttributes,
    FeatureAttributesResult,
    read_feature_attributes,
)
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sampling import VectorSamplingService
from tests.test_raster_source_access import _vector_result_sampler


@pytest.fixture(params=["GPKG", "GPKG-wide-ids", "ESRI Shapefile"])
def source(
    tmp_path: Path, request: pytest.FixtureRequest
) -> tuple[VectorSamplingService, ResolvedCatalogSelection, tuple[int, ...]]:
    """Create three distinguishable original features with a calculated numeric field.

    Args:
        tmp_path: Directory for an immutable original vector.
        request: Supported native format for this case.

    Returns:
        Source owner, authorized original, and its native IDs in original order.
    """
    is_gpkg = request.param.startswith("GPKG")
    ids = (
        (-7, 2**31, 2**53 + 1)
        if request.param == "GPKG-wide-ids"
        else (-7, 2, 3) if is_gpkg else (0, 1, 2)
    )
    path = tmp_path / ("features.gpkg" if is_gpkg else "features.shp")
    with fiona.open(
        path,
        "w",
        driver="GPKG" if is_gpkg else "ESRI Shapefile",
        layer="features",
        crs="EPSG:3857",
        encoding="UTF-8",
        schema={
            "geometry": "Polygon",
            "properties": {
                "label": "str",
                "x": "float",
                "y": "float",
                "count": "int64",
            },
        },
        SPATIAL_INDEX="NO",
    ) as dataset:
        for index, (label, x, y) in enumerate(
            [("First CO2", 1.25, 4.0), ("Second CO2", 2.5, None), ("Café", -3.0, 0.5)]
        ):
            dataset.write(
                {
                    "geometry": mapping(box(index * 1000, 0, index * 1000 + 100, 100)),
                    "properties": {
                        "label": label,
                        "x": x,
                        "y": y,
                        "count": 2**40 + index,
                    },
                }
            )
    if is_gpkg:
        with sqlite3.connect(path) as database:
            for previous_id, native_id in enumerate(ids, 1):
                database.execute(
                    "UPDATE features SET fid = ? WHERE fid = ?",
                    (native_id, previous_id),
                )
    catalog = FixtureCatalog(
        ResolvedVectorSource(
            "mounted",
            "geopackage" if is_gpkg else "shapefile",
            path,
            "data",
            "features",
        )
    )
    service = VectorSamplingService(catalog, catalog)
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="features",
        assetKey="data",
        layerName="features",
        filter=VectorFilter(),
        calculatedFields=(CalculatedField(name="product", expression="'x' * 'y'"),),
    )
    original = asyncio.run(service.resolve_for_sampling(selection))
    return service, original, ids


def test_http_rows_preserve_identity_values_order_and_exact_filters(
    source: tuple[VectorSamplingService, ResolvedCatalogSelection, tuple[int, ...]],
) -> None:
    """Return the same X/Y pairs and nulls under their own native identities.

    Args:
        source: Three original features and their authorized Catalog service.
    """
    service, original, ids = source
    wire_ids = tuple(str(feature_id) for feature_id in ids)
    app = FastAPI()
    app.include_router(create_vector_sampling_router(service))
    selection = original.selection.model_dump(mode="json", by_alias=True)
    with TestClient(app) as client:
        response = client.post(
            "/api/vector-sampling/features",
            json={
                "selection": selection,
                "featureIds": [wire_ids[2], wire_ids[0], wire_ids[1]],
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["features"][0]["id"] == str(ids[2])
        assert response.json() == {
            "selection": selection,
            "features": [
                {
                    "id": wire_ids[2],
                    "properties": {
                        "label": "Café",
                        "x": -3.0,
                        "y": 0.5,
                        "count": 2**40 + 2,
                        "product": -1.5,
                    },
                },
                {
                    "id": wire_ids[0],
                    "properties": {
                        "label": "First CO2",
                        "x": 1.25,
                        "y": 4.0,
                        "count": 2**40,
                        "product": 5.0,
                    },
                },
                {
                    "id": wire_ids[1],
                    "properties": {
                        "label": "Second CO2",
                        "x": 2.5,
                        "y": None,
                        "count": 2**40 + 1,
                        "product": None,
                    },
                },
            ],
        }
        assert str(original.path) not in response.text
        filtered = {
            **selection,
            "filter": {
                "match": "any",
                "rules": [
                    {"field": "product", "operator": "gt", "value": 0},
                    {"field": "label", "operator": "eq", "value": "Café"},
                ],
            },
        }
        allowed = client.post(
            "/api/vector-sampling/features",
            json={"selection": filtered, "featureIds": [wire_ids[2], wire_ids[0]]},
        )
        assert allowed.status_code == 200, allowed.text
        assert [row["id"] for row in allowed.json()["features"]] == [
            wire_ids[2],
            wire_ids[0],
        ]
        for requested in [list(wire_ids), ["99999"]]:
            denied = client.post(
                "/api/vector-sampling/features",
                json={"selection": filtered, "featureIds": requested},
            )
            assert denied.status_code == 409 and "features" not in denied.json()
        for invalid in [
            [True],
            [1.5],
            [1],
            ["01"],
            ["+1"],
            ["-0"],
            ["bad"],
            [str(-(2**63) - 1)],
            [str(2**63)],
            [wire_ids[0], wire_ids[0]],
        ]:
            assert (
                client.post(
                    "/api/vector-sampling/features",
                    json={"selection": selection, "featureIds": invalid},
                ).status_code
                == 422
            )
        assert (
            client.post(
                "/api/vector-sampling/features",
                json={
                    "selection": {**selection, "path": "untrusted.gpkg"},
                    "featureIds": [],
                },
            ).status_code
            == 422
        )


def test_http_round_trip_preserves_native_ids_outside_javascript_integer_range(
    source: tuple[VectorSamplingService, ResolvedCatalogSelection, tuple[int, ...]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Carry exact native IDs through Lasso JSON and the following attribute request.

    Args:
        source: Real source authorization used by both HTTP requests.
        monkeypatch: Supply native reader results at the source-reading boundaries.
    """
    service, original, _ids = source
    native_ids = (-(2**53) - 1, 2**53 + 1)
    wire_ids = [str(feature_id) for feature_id in native_ids]

    async def compare(
        target: ResolvedCatalogSelection,
        boundaries: dict[str, Any],
        predicate: VectorFilter,
        *,
        required_area: SummaryPolygon,
    ) -> FeatureMatches:
        """Supply exact native membership before browser serialization.

        Args:
            target: Authorized original source.
            boundaries: Other polygon sources, empty for this Lasso.
            predicate: Additional field predicate, inactive for this Lasso.
            required_area: Validated user-drawn polygon.

        Returns:
            Two distinct native IDs outside JavaScript's exact numeric range.
        """
        return FeatureMatches(ids=frozenset(native_ids), total=2)

    async def no_highlights(
        target: ResolvedCatalogSelection, ids: tuple[int, ...]
    ) -> None:
        """Leave display geometry unavailable while exact membership remains usable.

        Args:
            target: Authorized original source.
            ids: Unrounded native IDs passed to the optional display reader.
        """
        assert ids == native_ids

    async def attributes(
        target: ResolvedCatalogSelection, ids: tuple[int, ...]
    ) -> FeatureAttributesResult:
        """Verify the JSON round trip restored the exact IDs supplied by native reading.

        Args:
            target: Reauthorized original source.
            ids: Native integers decoded from the validated public ID strings.

        Returns:
            Identified scalar rows for the browser response.
        """
        assert ids == native_ids
        return FeatureAttributesResult(
            selection=target.selection,
            features=tuple(
                FeatureAttributes(id=str(feature_id), properties={"x": index + 0.5})
                for index, feature_id in enumerate(ids)
            ),
        )

    monkeypatch.setattr(service, "compare_layers", compare)
    monkeypatch.setattr(lasso, "read_lasso_highlights", no_highlights)
    monkeypatch.setattr(feature_attributes, "read_feature_attributes", attributes)
    app = FastAPI()
    app.include_router(create_vector_sampling_router(service))
    selection = original.selection.model_dump(mode="json", by_alias=True)
    with TestClient(app) as client:
        picked = client.post(
            "/api/vector-sampling/lasso",
            json={
                "selection": selection,
                "polygon": mapping(box(0, 0, 1, 1)),
            },
        )
        assert picked.status_code == 200, picked.text
        assert picked.json() == {"matched": 2, "featureIds": wire_ids, "geometry": None}
        inspected = client.post(
            "/api/vector-sampling/features",
            json={
                "selection": selection,
                "featureIds": picked.json()["featureIds"],
            },
        )
        assert inspected.status_code == 200, inspected.text
        assert inspected.json()["features"] == [
            {"id": wire_ids[0], "properties": {"x": 0.5}},
            {"id": wire_ids[1], "properties": {"x": 1.5}},
        ]


def test_attribute_reader_does_not_decode_geometry(
    source: tuple[VectorSamplingService, ResolvedCatalogSelection, tuple[int, ...]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Observe native records with geometry omitted and a late ID under a one-row budget.

    Args:
        source: Authorized original features, including projected polygons.
        monkeypatch: Instrument the real native random-access read.
    """
    _service, original, ids = source
    from osgeo import ogr

    get_feature = ogr.Layer.GetFeature
    visited: list[int] = []

    def read_without_geometry(collection: ogr.Layer, feature_id: int) -> ogr.Feature:
        """Observe the native result before the consumer can discard its geometry.

        Args:
            collection: Open native source with geometry disabled.
            feature_id: Exact requested native ID.

        Returns:
            Original record with no decoded geometry.
        """
        feature = get_feature(collection, feature_id)
        assert feature.GetGeometryRef() is None
        visited.append(feature_id)
        return feature

    monkeypatch.setattr(ogr.Layer, "GetFeature", read_without_geometry)
    assert (
        tuple(
            row[0]
            for row in iter_original_features(original, None, None, read_geometry=False)
        )
        == ids
    )
    rows = list(
        iter_original_features(
            original,
            VectorReadLimits(features=1, coordinates_per_feature=1),
            None,
            feature_ids=(ids[-1],),
            read_geometry=False,
        )
    )
    assert visited == [ids[-1]]
    assert (
        rows[0][0] == ids[-1] and rows[0][1]["product"] == -1.5 and rows[0][2] is None
    )


def test_scalar_attributes_preserve_booleans_dates_and_missing_numbers(
    tmp_path: Path,
) -> None:
    """Keep supported native types and omit binary data from plot observations.

    Args:
        tmp_path: Original GeoPackage directory.
    """
    path = tmp_path / "scalars.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="scalars",
        crs="EPSG:4326",
        schema={
            "geometry": "Point",
            "properties": {
                "flag": "bool",
                "missing": "float",
                "infinite": "float",
                "date": "date",
                "blob": "bytes",
            },
        },
    ) as dataset:
        dataset.write(
            {
                "geometry": None,
                "properties": {
                    "flag": True,
                    "missing": float("nan"),
                    "infinite": float("inf"),
                    "date": "2026-11-23",
                    "blob": b"binary data",
                },
            }
        )
    catalog = FixtureCatalog(
        ResolvedVectorSource("mounted", "geopackage", path, "data", "scalars")
    )
    service = VectorSamplingService(catalog, catalog)
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="scalars",
        assetKey="data",
        layerName="scalars",
        filter=VectorFilter(),
    )
    result = asyncio.run(
        service.read_feature_attributes(
            FeatureAttributesRequest(selection=selection, featureIds=("1",))
        )
    )
    assert result.features[0].properties == {
        "flag": True,
        "missing": None,
        "infinite": None,
        "date": "2026-11-23",
    }
    assert result.features[0].properties["flag"] is True


@pytest.mark.parametrize("failure", ["output", "features", "deadline"])
def test_failed_attribute_reads_never_return_partial_rows(
    source: tuple[VectorSamplingService, ResolvedCatalogSelection, tuple[int, ...]],
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    """Reject a complete read when its owning interactive budget cannot be met.

    Args:
        source: Authorized source with three requested rows.
        monkeypatch: Reduce only the relevant read budget.
        failure: The resource boundary exhausted by this case.
    """
    _service, original, ids = source

    async def run_in_process(
        target: Callable[..., None], arguments: tuple[Any, ...], timeout: float
    ) -> Any:
        """Execute the real worker with observable test budgets.

        Args:
            target: Production native-reading operation.
            arguments: Source, IDs and interactive limits.
            timeout: Supervision deadline used by the production process runner.

        Returns:
            The worker's complete result/error pair.

        Raises:
            ProcessDeadlineError: For the controlled deadline case.
        """
        if failure == "deadline":
            raise ProcessDeadlineError()
        results: list[Any] = []

        class Writer:
            """Collect the worker's one complete result or safe error."""

            def put(self, value: Any) -> None:
                """Retain the worker result for the awaiting caller.

                Args:
                    value: Complete success or failure pair.
                """
                results.append(value)

        target(Writer(), *arguments)
        return results[0]

    monkeypatch.setattr(feature_attributes, "run_bounded_process", run_in_process)
    if failure == "output":
        monkeypatch.setattr(feature_attributes, "MAX_FEATURE_ATTRIBUTE_BYTES", 1)
    elif failure == "features":
        monkeypatch.setattr(
            feature_attributes, "VectorReadLimits", lambda: VectorReadLimits(features=1)
        )
    with pytest.raises(VectorConflictError):
        asyncio.run(read_feature_attributes(original, ids))


def test_result_attributes_keep_ownership_expiry_and_cancellation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep the result lease until cancelled native work has stopped.

    Args:
        tmp_path: Original result file and controlled source authority.
        monkeypatch: Pause supervised work while observing the real lease owner.
    """
    service, authority, selection = _vector_result_sampler(tmp_path)
    request = FeatureAttributesRequest(selection=selection, featureIds=("1",))

    async def exercise() -> None:
        """Read a real result, reject other owners, and cancel under its live lease."""
        result = await service.read_feature_attributes(request, "owner")
        assert result.features[0].id == "1" and not authority.leases
        with pytest.raises(SourceFileError):
            await service.read_feature_attributes(request, "other")
        authority.ready = False
        with pytest.raises(SourceFileError):
            await service.read_feature_attributes(request, "owner")
        authority.ready = True
        entered, cleaning, finished = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def supervised_read(*args: Any) -> None:
            """Delay cancellation completion while the source lease must remain live.

            Args:
                args: Production process target, arguments, and deadline.

            Raises:
                asyncio.CancelledError: After the controlled native cleanup completes.
            """
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                cleaning.set()
                await finished.wait()
                assert authority.leases

        monkeypatch.setattr(feature_attributes, "run_bounded_process", supervised_read)
        pending = asyncio.create_task(service.read_feature_attributes(request, "owner"))
        await entered.wait()
        pending.cancel()
        await cleaning.wait()
        assert authority.leases
        finished.set()
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert not authority.leases

    asyncio.run(exercise())
