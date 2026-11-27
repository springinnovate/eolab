"""Check exact scalar observations from original sources without display geometry."""

import asyncio
import sqlite3
from collections.abc import Callable
from pathlib import Path
from typing import Any

import fiona
import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from osgeo import gdal, ogr
from shapely.geometry import box, mapping

from catalog_selection_support import FixtureCatalog
from eolab_app.attribute_filter import VectorFilter
from eolab_app.bounded_vector import VectorReadLimits
from eolab_app.calculated_fields import CalculatedField
from eolab_app.catalog_selection import (
    CatalogSelection,
    ResolvedCatalogSelection,
)
from eolab_app.execution.bounded_process import ProcessDeadlineError
from eolab_app.feature_intersection import iter_original_features, match_features
from eolab_app.routes.vector_sampling import create_vector_sampling_router
from eolab_app.source_files import SourceFileError
from eolab_app.vector import feature_attributes, lasso, selection_operation
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.feature_attributes import (
    FeatureAttributesRequest,
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
        (-(2**53 + 1), 2**31, 2**53 + 1)
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
                "parcel": "int64",
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
                        "parcel": (2**53, 2**53 + 1, -(2**53 + 1))[index],
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
    matches = match_features(
        original, {}, VectorFilter(), required_area=box(-1, -1, 1, 1)
    )
    selected_ids = [str(feature_id) for feature_id in sorted(matches.ids)]
    assert selected_ids == list(wire_ids)
    with TestClient(app) as client:
        round_trip = client.post(
            "/api/vector-sampling/features",
            json={"selection": selection, "featureIds": selected_ids},
        )
        assert round_trip.status_code == 200, round_trip.text
        assert [row["id"] for row in round_trip.json()["features"]] == list(wire_ids)
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
                        "parcel": {"integer": "-9007199254740993"},
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
                        "parcel": {"integer": "9007199254740992"},
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
                        "parcel": {"integer": "9007199254740993"},
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
    """Check complete scalar rows and exact IDs across both public feature-reading routes.

    Args:
        source: Original projected features, including signed-64-bit GeoPackage IDs.
        monkeypatch: Share the fixture Catalog with the worker and omit optional outlines.
    """
    service, original, ids = source
    app = FastAPI()

    async def open_original(
        client: httpx2.AsyncClient,
        inputs: selection_operation.SelectionMeasurementInput,
    ) -> ResolvedCatalogSelection:
        """Resolve the worker's path-free descriptor through the fixture Catalog.

        Args:
            client: Internal worker connection, supplied by the production reader.
            inputs: The source description authorized for this job.

        Returns:
            Fixture original with its applied predicate and calculated fields.
        """
        return await service.resolve_for_sampling(inputs.selection)

    async def run_job(token: str, execution_seconds: int) -> None:
        """Deliver the real comparison and attributes through the private worker routes.

        Args:
            token: One-request credential held by the feature selection service.
            execution_seconds: Outer native deadline supplied by the service.
        """
        async with httpx2.AsyncClient(
            mounts={"http://app:8000": httpx2.ASGITransport(app=app)}, trust_env=False
        ) as client:
            await selection_operation.deliver_intersection_result(
                client, selection_operation.ComparisonInput(spatialRead=token)
            )

    monkeypatch.setattr(selection_operation, "_open_job_selection", open_original)
    monkeypatch.setattr(lasso, "MAX_DISPLAY_COORDINATES", 0)
    reader = VectorSamplingService(
        service.catalog, service.resolver, comparison_executor=run_job
    )
    app.include_router(create_vector_sampling_router(reader))
    selection = original.selection.model_dump(mode="json", by_alias=True)
    with TestClient(app) as client:
        picked = client.post(
            "/api/vector-sampling/lasso",
            json={"selection": selection, "polygon": mapping(box(-1, -1, 1, 1))},
        )
        assert picked.status_code == 200, picked.text
        result = picked.json()
        assert result["matched"] == 3
        assert result["featureIds"] == [str(fid) for fid in ids]
        assert result["geometry"] is None
        inspected = client.post(
            "/api/vector-sampling/features",
            json={"selection": selection, "featureIds": result["featureIds"]},
        )
        assert inspected.status_code == 200, inspected.text
        assert result["features"] == inspected.json()["features"]
        assert [row["properties"]["x"] for row in result["features"]] == [
            1.25,
            2.5,
            -3.0,
        ]
        assert result["features"][-1]["properties"]["parcel"] == {
            "integer": "-9007199254740993"
        }


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
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Keep native and JSON scalars, filter JSON nulls, and omit nonscalar values.

    Args:
        tmp_path: Original GeoPackage directory.
        monkeypatch: Observe whether reading binary fields allocates a hex string.
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
                "empty_blob": "bytes",
                "null_blob": "bytes",
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
                    "empty_blob": b"",
                    "null_blob": None,
                },
            }
        )
    json_values = {
        "json_null": "null",
        "json_number": "2.5",
        "json_boolean": "true",
        "json_string": '"001"',
        "json_object": '{"value":7}',
        "json_array": "[1,2]",
    }
    with (
        gdal.ExceptionMgr(),
        ogr.ExceptionMgr(),
        gdal.OpenEx(str(path), gdal.OF_VECTOR | gdal.OF_UPDATE) as dataset,
    ):
        layer = dataset.GetLayerByName("scalars")
        for name in json_values:
            field = ogr.FieldDefn(name, ogr.OFTString)
            field.SetSubType(ogr.OFSTJSON)
            layer.CreateField(field)
        layer.CreateField(ogr.FieldDefn("text", ogr.OFTString))
        feature = layer.GetFeature(1)
        for name, value in json_values.items():
            feature.SetField(name, value)
        feature.SetField("text", '{"keep":"text"}')
        layer.SetFeature(feature)
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
        "null_blob": None,
        "text": '{"keep":"text"}',
        "json_null": None,
        "json_number": 2.5,
        "json_boolean": True,
        "json_string": "001",
    }
    assert result.features[0].properties["flag"] is True
    assert result.features[0].properties["json_boolean"] is True
    binary_fields_read_as_text = []
    get_field_as_string = ogr.Feature.GetFieldAsString

    def record_string_read(feature: ogr.Feature, index: int) -> str:
        """Record any hex copy produced by the real native accessor.

        Args:
            feature: Original row containing null, empty and populated binary fields.
            index: Native field index being read as text.

        Returns:
            Text from the original GDAL accessor.
        """
        if feature.GetFieldType(index) == ogr.OFTBinary:
            binary_fields_read_as_text.append(feature.GetFieldDefnRef(index).GetName())
        return get_field_as_string(feature, index)

    monkeypatch.setattr(ogr.Feature, "GetFieldAsString", record_string_read)
    original = asyncio.run(service.resolve_for_sampling(selection))
    raw_features = list(
        iter_original_features(
            original, None, None, feature_ids=(1,), read_geometry=False
        )
    )
    properties = raw_features[0][1]
    assert properties["blob"] == b"binary data"
    assert properties["empty_blob"] == b""
    assert properties["null_blob"] is None
    assert binary_fields_read_as_text == []
    for operator, expected_ids in [("present", []), ("missing", [1])]:
        predicate = VectorFilter.model_validate(
            {"rules": [{"field": "json_null", "operator": operator}]}
        )
        original = asyncio.run(
            service.resolve_for_sampling(
                selection.model_copy(update={"filter": predicate})
            )
        )
        assert [
            fid
            for fid, _, _ in iter_original_features(
                original, None, None, feature_ids=(1,), read_geometry=False
            )
        ] == expected_ids


@pytest.mark.parametrize("failure", ["output", "wire-bytes", "features", "deadline"])
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
    service, original, ids = source

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
    if failure == "wire-bytes":
        app = FastAPI()
        app.include_router(create_vector_sampling_router(service))
        selection = original.selection.model_dump(mode="json", by_alias=True)
        selection["filter"] = {
            "rules": [{"field": "x", "operator": "gt", "value": 1e-5}]
        }
        payload = {"selection": selection, "featureIds": [str(ids[0])]}
        with TestClient(app) as client:
            response = client.post("/api/vector-sampling/features", json=payload)
            assert response.status_code == 200, response.text
            size = len(response.content)
            monkeypatch.setattr(feature_attributes, "MAX_FEATURE_ATTRIBUTE_BYTES", size)
            assert (
                client.post("/api/vector-sampling/features", json=payload).content
                == response.content
            )
            monkeypatch.setattr(
                feature_attributes, "MAX_FEATURE_ATTRIBUTE_BYTES", size - 1
            )
            assert (
                client.post("/api/vector-sampling/features", json=payload).status_code
                == 409
            )
        return
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
