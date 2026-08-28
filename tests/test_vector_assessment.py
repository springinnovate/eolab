"""Test exact catalog vector source and assessment contracts."""

import asyncio
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import fiona
import httpx2

from eolab_app.catalog.geojson import build_stac_item as build_geojson_item
from eolab_app.catalog.geopackage import build_stac_items as build_geopackage_items
from eolab_app.catalog.shapefile import build_stac_item as build_shapefile_item
from eolab_app.vector.assessment import (
    VectorAssessmentFinalizer,
    VectorAssessmentService,
)
from eolab_app.vector.geoserver import GeoServerVectorReaderAssessor
from eolab_app.vector.models import (
    CatalogVectorRequest,
    VECTOR_READER_CONTRACT,
    VECTOR_RENDERING_METADATA_KEY,
    VECTOR_SOURCE_METADATA_KEY,
    VectorReaderAssessment,
)
from eolab_app.vector.sources import MountedVectorResolver


def write_point_shapefile(path: Path) -> tuple[Path, ...]:
    """Write a complete one-feature WGS 84 Shapefile fixture.

    Args:
        path: Primary `.shp` path to create.

    Returns:
        Recognized component paths in deterministic filename order.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with fiona.open(
        path,
        mode="w",
        driver="ESRI Shapefile",
        crs="EPSG:4326",
        schema={"geometry": "Point", "properties": {"name": "str"}},
    ) as dataset:
        dataset.write({
            "geometry": {"type": "Point", "coordinates": (1.0, 2.0)},
            "properties": {"name": "site"},
        })
    return tuple(sorted(path.parent.glob(f"{path.stem}.*")))


def write_geopackage(path: Path, layer_name: str = "areas") -> None:
    """Write one polygon layer to a GeoPackage fixture.

    Args:
        path: GeoPackage container path.
        layer_name: Exact native layer name.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with fiona.open(
        path,
        mode="w",
        driver="GPKG",
        layer=layer_name,
        crs="EPSG:4326",
        schema={"geometry": "Polygon", "properties": {"name": "str"}},
    ) as dataset:
        dataset.write({
            "geometry": {
                "type": "Polygon",
                "coordinates": [[(0, 0), (2, 0), (2, 2), (0, 0)]],
            },
            "properties": {"name": "area"},
        })


class RecordingVectorAssessor:
    """Return one planned reader result while recording exact identities."""

    def __init__(self, assessment: VectorReaderAssessment) -> None:
        """Create a recording reader boundary.

        Args:
            assessment: Result returned for every request.
        """
        self.assessment = assessment
        self.requests: list[tuple[str, Path, str]] = []

    async def assess(
        self,
        source_format: str,
        source_path: Path,
        layer_name: str,
    ) -> VectorReaderAssessment:
        """Record and return one exact-layer assessment.

        Args:
            source_format: Explicit source format.
            source_path: Canonical mounted source path.
            layer_name: Exact native layer name.

        Returns:
            Planned reader result.
        """
        self.requests.append((source_format, source_path, layer_name))
        return self.assessment


class MemoryVectorCatalog:
    """Keep one authoritative Item for selected-assessment tests."""

    def __init__(self, item: dict[str, Any]) -> None:
        """Create the single-Item catalog.

        Args:
            item: Initial authoritative Item.
        """
        self.item = item
        self.upserted_item: dict[str, Any] | None = None

    async def get_item(self, request: CatalogVectorRequest) -> dict[str, Any]:
        """Return the Item after checking its selected identity.

        Args:
            request: Validated selected Item identity.

        Returns:
            Authoritative Item.
        """
        assert request.item_id == self.item["id"]
        return self.item

    async def upsert_item(
        self,
        request: CatalogVectorRequest,
        item: dict[str, Any],
    ) -> None:
        """Record the replacement Item.

        Args:
            request: Validated selected Item identity.
            item: Complete replacement Item.
        """
        assert request.item_id == item["id"]
        self.upserted_item = item


def compatible_reader(geometry_kind: str) -> VectorReaderAssessment:
    """Build one compatible deployed-reader result.

    Args:
        geometry_kind: Point, line, or polygon style family.

    Returns:
        Validated compatible assessment.
    """
    return VectorReaderAssessment.model_validate({
        "contract": VECTOR_READER_CONTRACT,
        "compatible": True,
        "reasonCode": None,
        "geometryKind": geometry_kind,
    })


def test_geoserver_assessment_uses_form_parameters_without_json_binding(
    tmp_path: Path,
) -> None:
    """Avoid GeoServer's XStream decoder for exact-layer assessment."""
    source_path = tmp_path / "habitats.gpkg"
    captured_requests: list[httpx2.Request] = []

    def assessment_response(request: httpx2.Request) -> httpx2.Response:
        captured_requests.append(request)
        return httpx2.Response(200, json={
            "contract": VECTOR_READER_CONTRACT,
            "compatible": True,
            "reasonCode": None,
            "geometryKind": "polygon",
        })

    async def assess() -> VectorReaderAssessment:
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(assessment_response)
        ) as client:
            return await GeoServerVectorReaderAssessor(
                client,
                "http://geoserver:8080/geoserver",
            ).assess("geopackage", source_path, "Chosen Areas")

    result = asyncio.run(assess())

    assert result.compatible is True
    assert len(captured_requests) == 1
    request = captured_requests[0]
    assert request.url.path == (
        "/geoserver/rest/eolab/vector-reader-assessments"
    )
    assert request.headers["content-type"] == (
        "application/x-www-form-urlencoded"
    )
    assert parse_qs(request.content.decode()) == {
        "sourceUri": [source_path.as_uri()],
        "sourceFormat": ["geopackage"],
        "layerName": ["Chosen Areas"],
    }


def test_shapefile_assessment_preserves_all_components_and_native_layer(
    tmp_path: Path,
) -> None:
    """Persist an explicit mounted contract and complete source signature.

    Args:
        tmp_path: Isolated mounted scan source.
    """
    shapefile_path = tmp_path / "nested" / "Road Sites.shp"
    component_paths = write_point_shapefile(shapefile_path)
    item = build_shapefile_item(tmp_path, shapefile_path, component_paths)
    assessor = RecordingVectorAssessor(compatible_reader("point"))
    finalizer = VectorAssessmentFinalizer(
        MountedVectorResolver(tmp_path),
        assessor,
    )

    finalized = asyncio.run(finalizer.finalize(item))

    assert assessor.requests == [("shapefile", shapefile_path, "Road Sites")]
    assert finalized["properties"][VECTOR_SOURCE_METADATA_KEY] == {
        "kind": "mounted",
        "format": "shapefile",
        "asset_key": "shp",
        "layer_name": "Road Sites",
    }
    rendering = finalized["properties"][VECTOR_RENDERING_METADATA_KEY]
    assert rendering["eligible"] is True
    assert rendering["geometry_kind"] == "point"
    assert {entry[0] for entry in rendering["source_signature"]} >= {
        "Road Sites.shp",
        "Road Sites.shx",
        "Road Sites.dbf",
        "Road Sites.prj",
    }


def test_geopackage_assessment_uses_the_selected_exact_layer(
    tmp_path: Path,
) -> None:
    """Probe a GeoPackage layer name instead of selecting a container default.

    Args:
        tmp_path: Isolated mounted scan source.
    """
    geopackage_path = tmp_path / "habitats.gpkg"
    write_geopackage(geopackage_path, "Chosen Areas")
    item = build_geopackage_items(tmp_path, geopackage_path)[0]
    assessor = RecordingVectorAssessor(compatible_reader("polygon"))

    finalized = asyncio.run(VectorAssessmentFinalizer(
        MountedVectorResolver(tmp_path),
        assessor,
    ).finalize(item))

    assert assessor.requests == [
        ("geopackage", geopackage_path, "Chosen Areas")
    ]
    assert finalized["properties"][VECTOR_SOURCE_METADATA_KEY][
        "layer_name"
    ] == "Chosen Areas"
    assert finalized["properties"][VECTOR_RENDERING_METADATA_KEY][
        "geometry_kind"
    ] == "polygon"


def test_unsupported_and_remote_sources_return_precise_capabilities(
    tmp_path: Path,
) -> None:
    """Avoid reader calls for unsupported mounted GeoJSON and remote Assets.

    Args:
        tmp_path: Isolated mounted scan source.
    """
    geojson_path = tmp_path / "large.geojson"
    geojson_path.write_text(
        '{"type":"FeatureCollection","features":[{"type":"Feature",'
        '"properties":{},"geometry":{"type":"Point","coordinates":[1,2]}}]}',
        encoding="utf-8",
    )
    mounted_item = build_geojson_item(tmp_path, geojson_path)
    remote_item = build_geojson_item(tmp_path, geojson_path)
    remote_item["assets"]["data"]["href"] = (
        "https://objects.example/private.geojson"
    )
    assessor = RecordingVectorAssessor(compatible_reader("point"))
    finalizer = VectorAssessmentFinalizer(
        MountedVectorResolver(tmp_path),
        assessor,
    )

    mounted = asyncio.run(finalizer.finalize(mounted_item))
    remote = asyncio.run(finalizer.finalize(remote_item))

    assert assessor.requests == []
    assert mounted["properties"][VECTOR_RENDERING_METADATA_KEY][
        "reason_code"
    ] == "geojson_publication_unsupported"
    assert remote["properties"][VECTOR_SOURCE_METADATA_KEY]["kind"] == "remote"
    assert remote["properties"][VECTOR_RENDERING_METADATA_KEY][
        "reason_code"
    ] == "remote_source_unsupported"


def test_selected_assessment_rebuilds_only_the_exact_geopackage_item(
    tmp_path: Path,
) -> None:
    """Rebuild and upsert one selected layer without rescanning siblings.

    Args:
        tmp_path: Isolated mounted scan source.
    """
    geopackage_path = tmp_path / "container.gpkg"
    write_geopackage(geopackage_path, "selected")
    item = build_geopackage_items(tmp_path, geopackage_path)[0]
    catalog = MemoryVectorCatalog(item)
    resolver = MountedVectorResolver(tmp_path)
    assessor = RecordingVectorAssessor(compatible_reader("polygon"))
    finalizer = VectorAssessmentFinalizer(resolver, assessor)
    service = VectorAssessmentService(
        tmp_path,
        catalog,
        resolver,
        finalizer,
    )

    assessed = asyncio.run(service.assess(CatalogVectorRequest(
        collectionId=item["collection"],
        itemId=item["id"],
    )))

    assert assessed is catalog.upserted_item
    assert assessed["id"] == item["id"]
    assert assessor.requests[-1][2] == "selected"
