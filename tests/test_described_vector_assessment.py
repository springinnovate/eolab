"""Preserve admitted study metadata through the existing vector assessment route."""

import asyncio
from copy import deepcopy
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import fiona
from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
import yaml

from eolab_app.catalog.asset_access import ASSET_SOURCE_KEY
from eolab_app.catalog.descriptors import (
    DESCRIPTOR_SOURCE_KEY,
    annotate_item,
    prepare_descriptor,
    publish_descriptor_assets,
)
from eolab_app.catalog.geopackage import build_stac_items
from eolab_app.routes.vectors import create_vector_feature
from eolab_app.vector.assessment import (
    VectorAssessmentFinalizer,
    VectorAssessmentService,
)
from eolab_app.vector.models import CatalogVectorRequest, VECTOR_RENDERING_METADATA_KEY
from eolab_app.vector.sources import MountedVectorResolver, PublishedVectorRegistry
from tests.test_vector_assessment import (
    MemoryVectorCatalog,
    RecordingVectorAssessor,
    compatible_reader,
)


def admitted_vector(tmp_path: Path) -> tuple[dict[str, Any], Path]:
    """Admit a real GeoPackage with a paper and a local supporting table.

    Args:
        tmp_path: Source mount used by admission and the existing vector reader.

    Returns:
        Stored Item with public identity links/private source records, and the
        descriptor path whose later edits must not affect reassessment.
    """
    path = tmp_path / "survey.gpkg"
    with fiona.open(
        path,
        mode="w",
        driver="GPKG",
        layer="selected",
        crs="EPSG:4326",
        schema={"geometry": "Polygon", "properties": {"count": "int"}},
    ) as dataset:
        dataset.write(
            {
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[(0, 0), (2, 0), (2, 2), (0, 0)]],
                },
                "properties": {"count": 1},
            }
        )
    (tmp_path / "methods.csv").write_text("method,count\nsurvey,0\n", encoding="utf-8")
    document = {
        "schema": "eolab/item/v1",
        "id": "survey-study",
        "kind": "vector",
        "primary_asset": "data",
        "source": {"format": "geopackage", "layer": "selected"},
        "temporal": {
            "mode": "interval",
            "start_datetime": "2020-01-01T00:00:00Z",
            "end_datetime": "2020-12-31T23:59:59Z",
        },
        "metadata": {
            "title": "Admitted survey",
            "description": None,
            "keywords": ["forest"],
            "license": "CC-BY-4.0",
            "publications": [{"id": "paper-1", "title": "Admitted paper"}],
            "annotations": {"reviewed": False, "count": 0, "unknown": None},
        },
        "assets": {
            "data": {
                "location": "local",
                "path": path.name,
                "media_type": "application/geopackage+sqlite3",
                "roles": ["data"],
                "metadata": {
                    "title": "Survey layer",
                    "description": None,
                    "annotations": {"layer_note": "Admitted layer annotation"},
                },
            },
            "methods": {
                "location": "local",
                "path": "methods.csv",
                "media_type": "text/csv",
                "roles": ["metadata"],
                "metadata": {
                    "title": "Methods table",
                    "annotations": {"units": "samples"},
                },
            },
            "paper": {
                "location": "external",
                "href": "https://example.org/paper",
                "media_type": "text/html",
                "roles": ["metadata"],
                "metadata": {"title": "Publication source"},
            },
        },
    }
    descriptor_path = tmp_path / "survey.eolab.yaml"
    descriptor_path.write_text(yaml.safe_dump(document), encoding="utf-8")
    descriptor = prepare_descriptor(tmp_path, descriptor_path)
    item = build_stac_items(tmp_path, path)[0]
    return publish_descriptor_assets(annotate_item(item, descriptor)), descriptor_path


def assessment_service(
    tmp_path: Path, item: dict[str, Any]
) -> tuple[VectorAssessmentService, MemoryVectorCatalog, RecordingVectorAssessor]:
    """Construct the existing source/reader/assessment path with a recording catalog.

    Args:
        tmp_path: Authorized source mount.
        item: Last admitted Item returned by the catalog.

    Returns:
        Service, persisted-Item recorder, and deployed-reader boundary recorder.
    """
    catalog = MemoryVectorCatalog(item)
    resolver = MountedVectorResolver(tmp_path)
    assessor = RecordingVectorAssessor(compatible_reader("polygon"))
    service = VectorAssessmentService(
        tmp_path, catalog, resolver, VectorAssessmentFinalizer(resolver, assessor)
    )
    return service, catalog, assessor


def test_reassessment_keeps_admitted_annotations_while_refreshing_native_metadata(
    tmp_path: Path,
) -> None:
    """Refresh technical facts without applying changed YAML or losing attachments.

    Args:
        tmp_path: Isolated source mount.
    """
    item, descriptor_path = admitted_vector(tmp_path)
    item["properties"]["table:row_count"] = 999
    original = deepcopy(item)
    descriptor_path.write_text("invalid: changed since the last scan", encoding="utf-8")
    service, catalog, assessor = assessment_service(tmp_path, item)
    request = CatalogVectorRequest(collectionId=item["collection"], itemId=item["id"])

    result = asyncio.run(service.assess(request))

    assert result is catalog.upserted_item
    assert item == original
    assert result["id"] == item["id"]
    assert result["collection"] == item["collection"]
    assert result["properties"]["table:row_count"] == 1
    assert (
        result["properties"]["eolab:metadata"]
        == original["properties"]["eolab:metadata"]
    )
    assert result["properties"]["title"] == "Admitted survey"
    assert "description" not in result["properties"]
    for name in (
        "datetime",
        "start_datetime",
        "end_datetime",
        "eolab:time_basis",
        "eolab:descriptor_id",
        "keywords",
        "license",
    ):
        assert result["properties"][name] == original["properties"][name]
    assert result["assets"]["methods"] == original["assets"]["methods"]
    assert result["assets"]["paper"] == original["assets"]["paper"]
    assert (
        result["assets"][DESCRIPTOR_SOURCE_KEY]
        == original["assets"][DESCRIPTOR_SOURCE_KEY]
    )
    for name in ("eolab:metadata", "href", ASSET_SOURCE_KEY, "eolab:access", "title"):
        assert result["assets"]["data"][name] == original["assets"]["data"][name]
    assert "description" not in result["assets"]["data"]
    assert assessor.requests[-1] == (
        "geopackage",
        (tmp_path / "survey.gpkg").resolve(),
        "selected",
    )
    assert result["properties"][VECTOR_RENDERING_METADATA_KEY]["eligible"] is True
    assert (
        MountedVectorResolver(tmp_path).resolve(result).source_path
        == (tmp_path / "survey.gpkg").resolve()
    )


@pytest.mark.parametrize("invalid_source", [False, True])
def test_assessment_route_hides_private_records_for_rebuilt_and_fallback_items(
    tmp_path: Path, invalid_source: bool
) -> None:
    """Return study metadata and public links on both assessment outcomes.

    Args:
        tmp_path: Isolated source mount.
        invalid_source: Whether to take the invalid-source assessment fallback.
    """
    item, _ = admitted_vector(tmp_path)
    if invalid_source:
        item["assets"]["data"][ASSET_SOURCE_KEY] = None
    service, catalog, _ = assessment_service(tmp_path, item)
    feature = create_vector_feature(
        service, AsyncMock(), AsyncMock(), PublishedVectorRegistry()
    )
    app = FastAPI()
    app.include_router(feature.router)
    response = TestClient(app).post(
        "/api/vector-rendering/assessments",
        json={"collectionId": item["collection"], "itemId": item["id"]},
    )

    assert response.status_code == 200
    public = response.json()
    assert (
        public["properties"]["eolab:metadata"] == item["properties"]["eolab:metadata"]
    )
    assert public["assets"]["data"]["href"] == item["assets"]["data"]["href"]
    assert DESCRIPTOR_SOURCE_KEY not in public["assets"]
    assert ASSET_SOURCE_KEY not in response.text
    assert "eolab:vector-field-values" not in response.text
    assert str(tmp_path) not in response.text
    assert "file://" not in response.text
    assert DESCRIPTOR_SOURCE_KEY in catalog.upserted_item["assets"]
    assert ASSET_SOURCE_KEY in catalog.upserted_item["assets"]["data"]
    assert (
        public["properties"][VECTOR_RENDERING_METADATA_KEY]["eligible"]
        is not invalid_source
    )
