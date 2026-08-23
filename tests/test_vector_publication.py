"""Test stable service and convergent GeoServer vector publication."""

import asyncio
from pathlib import Path
from typing import Any

import httpx2

from eolab_app.catalog.geopackage import build_stac_items as build_geopackage_items
from eolab_app.vector.geoserver import GeoServerVectorPublisher
from eolab_app.vector.models import (
    CatalogVectorRequest,
    VECTOR_READER_CONTRACT,
    VECTOR_RENDERING_METADATA_KEY,
    VECTOR_RENDERING_POLICY,
)
from eolab_app.vector.publication import VectorPublicationService
from eolab_app.vector.sources import (
    MountedVectorResolver,
    PublishedVectorRegistry,
    vector_source_signature,
)
from tests.test_vector_assessment import write_geopackage


class StaticCatalog:
    """Return one planned authoritative vector Item."""

    def __init__(self, item: dict[str, Any]) -> None:
        """Create the catalog.

        Args:
            item: Item returned for every matching request.
        """
        self.item = item

    async def get_item(self, request: CatalogVectorRequest) -> dict[str, Any]:
        """Return the matching authoritative Item.

        Args:
            request: Validated selected identity.

        Returns:
            Planned authoritative Item.
        """
        assert request.item_id == self.item["id"]
        return self.item


class RecordingPublisher:
    """Record service-owned exact publication identities."""

    def __init__(self) -> None:
        """Create an empty request log."""
        self.requests: list[tuple[str, str, Path, str, str]] = []

    async def publish(
        self,
        resource_name: str,
        source_format: str,
        source_path: Path,
        layer_name: str,
        geometry_kind: str,
    ) -> str:
        """Record one publication and return its fixed style.

        Args:
            resource_name: Stable configured feature type name.
            source_format: Explicit mounted source format.
            source_path: Canonical mounted source file.
            layer_name: Exact native layer name.
            geometry_kind: Default style family.

        Returns:
            Fixed style name.
        """
        self.requests.append((
            resource_name,
            source_format,
            source_path,
            layer_name,
            geometry_kind,
        ))
        return f"vector-{geometry_kind}"


class VectorGeoServerScenario:
    """Simulate vector REST resources and exact response contracts."""

    def __init__(
        self,
        resource_name: str,
        *,
        datastore: bool = False,
        feature_type: bool = False,
        layer: bool = False,
    ) -> None:
        """Create one planned upstream state.

        Args:
            resource_name: Stable datastore, feature type, and layer name.
            datastore: Whether the datastore initially exists.
            feature_type: Whether the feature type initially exists.
            layer: Whether the WMS layer initially exists.
        """
        self.resource_name = resource_name
        self.datastore = datastore
        self.feature_type = feature_type
        self.layer = layer
        self.native_name = "selected"
        self.requests: list[httpx2.Request] = []

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        """Apply one GeoServer REST request to the simulated state.

        Args:
            request: HTTP request from the production adapter.

        Returns:
            Exact simulated GeoServer response.

        Raises:
            AssertionError: If the adapter uses an unexpected operation.
        """
        self.requests.append(request)
        path = request.url.path.removeprefix("/geoserver/rest")
        if request.method == "GET":
            if path == "/workspaces/eolab.json":
                return httpx2.Response(200)
            if path == "/workspaces/eolab/styles/vector-polygon.sld":
                return httpx2.Response(200)
            if path.endswith(f"/datastores/{self.resource_name}.json"):
                return httpx2.Response(200 if self.datastore else 404)
            if path.endswith(
                f"/featuretypes/{self.resource_name}.json"
            ):
                if not self.feature_type:
                    return httpx2.Response(404)
                return httpx2.Response(200, json={
                    "featureType": {
                        "name": self.resource_name,
                        "nativeName": self.native_name,
                    }
                })
            if path.endswith(f"/layers/{self.resource_name}.json"):
                return httpx2.Response(200 if self.layer else 404)
        if request.method == "POST" and path.endswith("/datastores"):
            assert request.headers["content-type"].startswith("application/json")
            document = __import__("json").loads(request.content)
            assert document["dataStore"]["name"] == self.resource_name
            self.datastore = True
            return httpx2.Response(201)
        if request.method == "POST" and path.endswith("/featuretypes"):
            document = __import__("json").loads(request.content)
            self.native_name = document["featureType"]["nativeName"]
            self.feature_type = True
            self.layer = True
            return httpx2.Response(201)
        if request.method == "PUT" and path.endswith(
            f"/layers/{self.resource_name}.json"
        ):
            return httpx2.Response(200)
        if request.method == "DELETE" and path.endswith(
            f"/datastores/{self.resource_name}"
        ):
            self.datastore = False
            self.feature_type = False
            self.layer = False
            return httpx2.Response(200)
        raise AssertionError(f"Unexpected GeoServer request: {request.method} {path}")


def assessed_geopackage_item(tmp_path: Path) -> tuple[dict[str, Any], Path]:
    """Build one eligible assessed GeoPackage Item fixture.

    Args:
        tmp_path: Isolated mounted scan source.

    Returns:
        Assessed Item and canonical source path.
    """
    source_path = tmp_path / "vectors.gpkg"
    write_geopackage(source_path, "selected")
    item = build_geopackage_items(tmp_path, source_path)[0]
    resolver = MountedVectorResolver(tmp_path)
    source = resolver.resolve(item)
    resolver.apply_contract(item, source)
    signature = vector_source_signature(source)
    item["properties"][VECTOR_RENDERING_METADATA_KEY] = {
        "policy": VECTOR_RENDERING_POLICY,
        "eligible": True,
        "reason_code": None,
        "reason": None,
        "source_signature": [list(entry) for entry in signature],
        "reader_contract": VECTOR_READER_CONTRACT,
        "reader_compatible": True,
        "geometry_kind": "polygon",
    }
    return item, source_path


def test_publication_service_uses_stable_exact_layer_identity(
    tmp_path: Path,
) -> None:
    """Reuse the Item ID and exact layer on repeated publication requests.

    Args:
        tmp_path: Isolated mounted scan source.
    """
    item, source_path = assessed_geopackage_item(tmp_path)
    resolver = MountedVectorResolver(tmp_path)
    publisher = RecordingPublisher()
    registry = PublishedVectorRegistry()
    service = VectorPublicationService(
        StaticCatalog(item),
        resolver,
        publisher,
        registry,
    )
    request = CatalogVectorRequest(
        collectionId=item["collection"],
        itemId=item["id"],
    )

    first = asyncio.run(service.publish(request))
    second = asyncio.run(service.publish(request))

    expected_request = (
        item["id"],
        "geopackage",
        source_path,
        "selected",
        "polygon",
    )
    assert publisher.requests == [expected_request, expected_request]
    assert first == second
    assert first.layer_name == f"eolab:{item['id']}"
    authorization = registry.require_current(first.layer_name)
    assert authorization.source.layer_name == "selected"
    assert authorization.style_name == "vector-polygon"


def test_geoserver_vector_publisher_converges_clean_and_complete_states(
    tmp_path: Path,
) -> None:
    """Create once, verify native identity, and reuse complete resources.

    Args:
        tmp_path: Isolated path representable as a local file URI.
    """
    resource_name = "geopackage-0123456789abcdef01234567"
    scenario = VectorGeoServerScenario(resource_name)
    publisher = GeoServerVectorPublisher(
        httpx2.AsyncClient(transport=httpx2.MockTransport(scenario)),
        "http://geoserver/geoserver",
    )

    first_style = asyncio.run(publisher.publish(
        resource_name,
        "geopackage",
        tmp_path / "vectors.gpkg",
        "selected",
        "polygon",
    ))
    second_style = asyncio.run(publisher.publish(
        resource_name,
        "geopackage",
        tmp_path / "vectors.gpkg",
        "selected",
        "polygon",
    ))
    asyncio.run(publisher._geoserver_client.aclose())

    assert first_style == second_style == "vector-polygon"
    assert scenario.datastore and scenario.feature_type and scenario.layer
    assert sum(
        request.method == "POST" and request.url.path.endswith("/datastores")
        for request in scenario.requests
    ) == 1
    assert scenario.native_name == "selected"


def test_geoserver_vector_publisher_recovers_datastore_only_state(
    tmp_path: Path,
) -> None:
    """Delete only the proven orphan datastore before clean recreation.

    Args:
        tmp_path: Isolated path representable as a local file URI.
    """
    resource_name = "shapefile-0123456789abcdef01234567"
    scenario = VectorGeoServerScenario(resource_name, datastore=True)
    scenario.native_name = "roads"
    publisher = GeoServerVectorPublisher(
        httpx2.AsyncClient(transport=httpx2.MockTransport(scenario)),
        "http://geoserver/geoserver",
    )

    style_name = asyncio.run(publisher.publish(
        resource_name,
        "shapefile",
        tmp_path / "roads.shp",
        "roads",
        "polygon",
    ))
    asyncio.run(publisher._geoserver_client.aclose())

    assert style_name == "vector-polygon"
    assert any(request.method == "DELETE" for request in scenario.requests)
    assert scenario.native_name == "roads"
