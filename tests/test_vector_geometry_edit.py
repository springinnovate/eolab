"""Exercise polygon edits through the real HTTP and immutable upload boundaries."""

import asyncio
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import fiona
import pytest
from osgeo import gdal, ogr, osr
from pyproj import Transformer
from shapely import from_wkb, get_coordinates, transform
from shapely.geometry import MultiPolygon, Point, Polygon, box, shape

from eolab_app.routes.vector_edits import create_vector_edit_router
from eolab_app.routes.vector_uploads import create_vector_uploads_router
from eolab_app.bounded_vector import polygon_features
from eolab_app.catalog.vector_contract import (
    CatalogVectorRequest,
    MOUNTED_VECTOR_COLLECTION_ID,
)
from eolab_app.catalog_selection import UploadedSelection
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.sources import MountedVectorResolver
from eolab_app.vector_uploads import VectorUploadStore

_HEADERS = {"X-EOLab-Uploads": "1"}


def _write_parcels(path: Path, first_id: int) -> None:
    """Create projected native features with a hole and a separate part.

    Args:
        path: New temporary GeoPackage path.
        first_id: Native ID for the first parcel.
    """
    projection = Transformer.from_crs(4326, 3857, always_xy=True)
    crs = osr.SpatialReference()
    crs.ImportFromEPSG(3857)
    park = Polygon(
        [(0, 0), (8, 0), (8, 8), (0, 8)],
        [[(3, 3), (4, 3), (4, 4), (3, 4)]],
    )
    with gdal.GetDriverByName("GPKG").Create(
        str(path), 0, 0, 0, gdal.GDT_Unknown
    ) as dataset:
        layer = dataset.CreateLayer(
            "parcels",
            crs,
            ogr.wkbMultiPolygon,
            ["FID=parcel_id", "GEOMETRY_NAME=outline"],
        )
        layer.CreateField(ogr.FieldDefn("district", ogr.OFTString))
        for fid, label, geometry in [
            (first_id, "keep", MultiPolygon([park, box(10, 10, 11, 11)])),
            (first_id + 2, "other", MultiPolygon([box(0, 0, 9, 9)])),
        ]:
            feature = ogr.Feature(layer.GetLayerDefn())
            feature.SetFID(fid)
            feature.SetField("district", label)
            feature.SetGeometry(
                ogr.CreateGeometryFromWkb(
                    transform(geometry, projection.transform, interleaved=False).wkb
                )
            )
            assert layer.CreateFeature(feature) == 0


@pytest.mark.parametrize("from_catalog", [True, False], ids=["catalog", "upload"])
def test_edit_reopens_a_private_snapshot_and_keeps_other_features(
    tmp_path: Path,
    from_catalog: bool,
) -> None:
    """Keep exact native coordinates and other features while saving and rereading one edit.

    Args:
        tmp_path: Temporary upload volume and input.
        from_catalog: Exercise mounted Catalog admission or a private 64-bit-ID upload.
    """
    original = tmp_path / "source.gpkg"
    first_id = 27 if from_catalog else 9007199254740995
    overlap_id = first_id + 2
    _write_parcels(original, first_id)
    store = VectorUploadStore(tmp_path / "uploads", max_bytes=None)
    original_bytes = original.read_bytes()

    class FixtureCatalog:
        """Supply the Catalog authority for this mounted test GeoPackage."""

        async def get_item(self, request: CatalogVectorRequest) -> dict[str, Any]:
            """Return the admitted Item and its internal asset binding.

            Args:
                request: Collection and Item requested by the original-source reader.

            Returns:
                STAC Item with the exact mounted GeoPackage layer and field.
            """
            assert from_catalog and request.item_id == "test-parcels"
            return {
                "collection": MOUNTED_VECTOR_COLLECTION_ID,
                "id": "test-parcels",
                "properties": {
                    "eolab:vector_source": {
                        "kind": "mounted",
                        "format": "geopackage",
                        "asset_key": "data",
                        "layer_name": "parcels",
                    },
                    "table:columns": [{"name": "district", "type": "str"}],
                },
                "assets": {
                    "data": {
                        "href": original.as_uri(),
                        "type": "application/geopackage+sqlite3",
                        "roles": ["data"],
                    }
                },
            }

    service = VectorSamplingService(
        FixtureCatalog(), MountedVectorResolver(tmp_path), uploads=store
    )
    app = FastAPI()
    app.include_router(create_vector_uploads_router(store))
    app.include_router(
        create_vector_edit_router(service.open_selection, store, lambda *_: "unused")
    )
    with TestClient(app, base_url="https://eolab.test") as client:
        assert client.get("/api/vector-uploads").json() == []
        initial_count = 0
        if from_catalog:
            reference = {
                "collectionId": MOUNTED_VECTOR_COLLECTION_ID,
                "itemId": "test-parcels",
                "assetKey": "data",
                "layerName": "parcels",
            }
        else:
            uploaded = client.post(
                "/api/vector-uploads",
                params={"name": "parcel-copy.gpkg"},
                content=original_bytes,
                headers={**_HEADERS, "Content-Type": "application/geopackage+sqlite3"},
            )
            assert uploaded.status_code == 201, uploaded.text
            reference = {"uploadId": uploaded.json()["id"], "layerName": "parcels"}
            initial_count = 1
        chosen = {
            **reference,
            "filter": {
                "rules": [{"field": "district", "operator": "eq", "value": "keep"}]
            },
        }

        def pick(source: dict, point: tuple[float, float]) -> dict:
            """Read polygon choices and original rings from the selected layer.

            Args:
                source: Exact upload and applied view filter.
                point: Clicked longitude and latitude.

            Returns:
                Path-free polygon choices and optional editable rings.
            """
            response = client.post(
                "/api/vector-edits/feature",
                json={"source": source, "target": {"point": point}},
                headers=_HEADERS,
            )
            assert response.status_code == 200, response.text
            return response.json()

        assert pick({**reference, "filter": {}}, (1, 1))["featureIds"] == [
            str(first_id),
            str(overlap_id),
        ]
        assert pick(chosen, (3.5, 3.5))["featureIds"] == []
        edit = pick(chosen, (1, 1))
        assert edit["featureIds"] == [str(first_id)]
        parts = edit["feature"]["parts"]
        assert [len(part) for part in parts] == [2, 1]
        assert parts[0][0][0] == [0, 0]

        changes = {
            "source": chosen,
            "featureId": str(first_id),
            "name": "Restoration parcels",
            "saveId": str(uuid4()),
            "parts": [[[[-1, -1], [4, 0], 1, 2, 3], [0, 1, 2, 3]], [[0, 1, 2, 3]]],
        }
        invalid = {
            **changes,
            "parts": [[[[10, 2], 1, 2, 3], [0, 1, 2, 3]], [[0, 1, 2, 3]]],
        }
        rejected = client.post("/api/vector-edits/save", json=invalid, headers=_HEADERS)
        assert rejected.status_code == 422, rejected.text
        assert "edges" in rejected.json()["detail"]
        assert len(client.get("/api/vector-uploads").json()) == initial_count

        too_large = client.post(
            "/api/vector-edits/save", content=b"x" * (1024 * 1024 + 1), headers=_HEADERS
        )
        assert too_large.status_code == 413
        store.max_bytes = 16 * 1024
        too_large = client.post(
            "/api/vector-edits/save", json=changes, headers=_HEADERS
        )
        assert too_large.status_code == 413, too_large.text
        assert len(client.get("/api/vector-uploads").json()) == initial_count
        assert not list((tmp_path / "uploads").glob("*/.pending-*"))
        store.max_bytes = None

        response = client.post("/api/vector-edits/save", json=changes, headers=_HEADERS)
        assert response.status_code == 200, response.text
        saved_id = response.json()["id"]
        assert saved_id != reference.get("uploadId")
        assert (
            client.post(
                "/api/vector-edits/save", json=changes, headers=_HEADERS
            ).json()["id"]
            == saved_id
        )
        assert len(client.get("/api/vector-uploads").json()) == initial_count + 1
        saved_reference = {
            "uploadId": saved_id,
            "layerName": "parcels",
            "filter": chosen["filter"],
        }
        reopened = pick(saved_reference, (-0.25, -0.25))
        assert reopened["featureIds"] == [str(first_id)]
        assert len(reopened["feature"]["parts"][0][0]) == 5
        assert pick(chosen, (-0.25, -0.25))["featureIds"] == []
        assert pick(chosen, (1, 1))["feature"]["parts"] == parts

        owner = next((tmp_path / "uploads").glob("[a-f0-9]" * 64)).name
        # Use the ID-indexed reader for ordinary IDs and the sequential reader
        # for the large-ID fixture. Some Fiona builds truncate indexed IDs.
        analysis_reference = (
            saved_reference if from_catalog else {**saved_reference, "filter": {}}
        )
        resolved = asyncio.run(
            service.resolve_for_sampling(
                UploadedSelection.model_validate(analysis_reference),
                owner,
            )
        )
        with polygon_features(resolved) as features:
            saved_polygons = [shape(feature) for feature in features]
        assert len(saved_polygons) == (1 if from_catalog else 2)
        assert (
            sum(geometry.covers(Point(-0.25, -0.25)) for geometry in saved_polygons)
            == 1
        )
        _, output = store.get_upload_source(owner, UUID(saved_id))
        with fiona.open(original) as source, fiona.open(output) as saved:
            assert source.crs == saved.crs
            assert source.schema == saved.schema
        with (
            gdal.OpenEx(str(original), gdal.OF_VECTOR) as source,
            gdal.OpenEx(str(output), gdal.OF_VECTOR) as saved,
        ):
            old_layer, new_layer = source.GetLayerByName(
                "parcels"
            ), saved.GetLayerByName("parcels")
            assert [feature.GetFID() for feature in new_layer] == [
                first_id,
                overlap_id,
            ]
            assert new_layer.GetFIDColumn() == "parcel_id"
            assert new_layer.GetGeometryColumn() == "outline"
            untouched = old_layer.GetFeature(overlap_id)
            copied = new_layer.GetFeature(overlap_id)
            assert copied.items() == untouched.items()
            assert (
                copied.GetGeometryRef().ExportToIsoWkb()
                == untouched.GetGeometryRef().ExportToIsoWkb()
            )
            source_feature = old_layer.GetFeature(first_id)
            edited_feature = new_layer.GetFeature(first_id)
            assert edited_feature.items() == source_feature.items()
            old = from_wkb(bytes(source_feature.GetGeometryRef().ExportToIsoWkb()))
            new = from_wkb(bytes(edited_feature.GetGeometryRef().ExportToIsoWkb()))
            assert (
                get_coordinates(old.geoms[1]) == get_coordinates(new.geoms[1])
            ).all()
            assert list(old.geoms[0].interiors[0].coords) == list(
                new.geoms[0].interiors[0].coords
            )
        assert original.read_bytes() == original_bytes
        foreign = TestClient(app, base_url="https://eolab.test")
        denied = foreign.post(
            "/api/vector-edits/feature",
            json={
                "source": saved_reference,
                "target": {"point": (1, 1)},
            },
            headers=_HEADERS,
        )
        assert denied.status_code == 404
