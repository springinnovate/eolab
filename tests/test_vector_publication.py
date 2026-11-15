"""Test stable service and convergent GeoServer vector publication."""

import asyncio
import json
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

import httpx2
import pytest

from eolab_app.catalog.geopackage import build_stac_items as build_geopackage_items
from eolab_app.catalog.geopackage_overviews import GeoPackageOverview
from eolab_app.catalog.shapefile import build_stac_item as build_shapefile_item
from eolab_app.vector.assessment import VectorAssessmentFinalizer
from eolab_app.vector.errors import VectorPublicationError
from eolab_app.vector.geoserver import GeoServerVectorPublisher
from eolab_app.vector.models import (
    CatalogVectorRequest,
    original_vector_resource_name,
)
from eolab_app.vector.publication import VectorPublicationService
from eolab_app.vector.sources import (
    MountedVectorResolver,
    PublishedVectorRegistry,
)
from tests.test_vector_assessment import (
    RecordingVectorAssessor,
    compatible_reader,
    write_geopackage,
    write_point_shapefile,
)


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
        self.display_levels: list[tuple[GeoPackageOverview, ...]] = []

    async def publish(
        self,
        resource_name: str,
        source_format: str,
        source_path: Path,
        layer_name: str,
        geometry_kind: str,
        *,
        display_levels: tuple[GeoPackageOverview, ...] = (),
    ) -> str:
        """Record one publication and return its fixed style.

        Args:
            resource_name: Stable configured feature type name.
            source_format: Explicit mounted source format.
            source_path: Canonical mounted source file.
            layer_name: Exact native layer name.
            geometry_kind: Default style family.
            display_levels: Admitted display tables associated with this source.

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
        self.display_levels.append(display_levels)
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
        if request.method == "PUT" and request.url.path.endswith(
            f"/gwc/rest/layers/eolab:{self.resource_name}.xml"
        ):
            return httpx2.Response(200)
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


class OverviewGeoServerScenario:
    """Route one overview publication to its public and original REST resources."""

    def __init__(self, resource_name: str) -> None:
        """Create empty public, original and generated-configuration state.

        Args:
            resource_name: Public overview datastore and layer identity.
        """
        self.public = VectorGeoServerScenario(resource_name)
        self.original = VectorGeoServerScenario(
            original_vector_resource_name(resource_name)
        )
        self.configuration: bytes | None = None
        self.configuration_writes = 0
        self.reject_display_feature_type = False

    def __call__(self, request: httpx2.Request) -> httpx2.Response:
        """Dispatch real adapter calls and optionally reject wrapper publication.

        Args:
            request: HTTP request emitted by the production publisher.

        Returns:
            Simulated REST response from the selected owned resource.
        """
        if "/resource/eolab-vector-overviews/" in request.url.path:
            if request.method == "PUT":
                self.configuration = request.content
                self.configuration_writes += 1
                return httpx2.Response(201)
            if request.method == "DELETE":
                self.configuration = None
                return httpx2.Response(200)
        if request.method == "POST" and request.url.path.endswith("/datastores"):
            name = json.loads(request.content)["dataStore"]["name"]
            scenario = (
                self.original if name == self.original.resource_name else self.public
            )
        else:
            scenario = (
                self.original
                if self.original.resource_name in request.url.path
                else self.public
            )
        if (
            self.reject_display_feature_type
            and scenario is self.public
            and request.method == "POST"
            and request.url.path.endswith("/featuretypes")
        ):
            return httpx2.Response(500)
        return scenario(request)


def test_geoserver_publishes_stored_levels_and_reuses_original(tmp_path: Path) -> None:
    """Generate one stock selector while keeping an unadvertised exact layer.

    Args:
        tmp_path: Isolated source-file directory.
    """
    name = "geopackage-0123456789abcdef01234567"
    scenario = OverviewGeoServerScenario(name)
    levels = (
        GeoPackageOverview("display & 10", 10.0, "shape"),
        GeoPackageOverview("display_100", 100.0, "shape"),
    )

    async def publish_twice() -> None:
        """Exercise creation and subsequent immutable publication reuse."""
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(scenario)
        ) as client:
            publisher = GeoServerVectorPublisher(client, "http://geoserver/geoserver")
            for _ in range(2):
                assert (
                    await publisher.publish(
                        name,
                        "geopackage",
                        tmp_path / "source.gpkg",
                        "selected & source",
                        "polygon",
                        display_levels=levels,
                    )
                    == "vector-polygon"
                )

    asyncio.run(publish_twice())
    assert scenario.configuration_writes == 1
    assert scenario.configuration is not None
    root = ElementTree.fromstring(scenario.configuration)
    assert root.attrib == {
        "version": "1.0",
        "dataSourceName": original_vector_resource_name(name),
        "dataSourceNameSpace": "eolab",
    }
    feature = root.find("GeneralizationInfo")
    assert feature is not None
    assert feature.attrib == {
        "featureName": "selected & source",
        "baseFeatureName": "selected & source",
        "geomPropertyName": "shape",
    }
    assert [entry.attrib for entry in feature] == [
        {
            "distance": "10.0",
            "featureName": "display & 10",
            "geomPropertyName": "shape",
        },
        {
            "distance": "100.0",
            "featureName": "display_100",
            "geomPropertyName": "shape",
        },
    ]
    stores = [
        json.loads(request.content)["dataStore"]
        for request in scenario.public.requests
        if request.method == "POST" and request.url.path.endswith("/datastores")
    ]
    assert len(stores) == 1
    assert {
        entry["@key"]: entry["$"]
        for entry in stores[0]["connectionParameters"]["entry"]
    } == {
        "RepositoryClassName": "org.geoserver.data.gen.DSFinderRepository",
        "GeneralizationInfosProviderClassName": "org.geoserver.data.gen.info.GeneralizationInfosProviderImpl",
        "GeneralizationInfosProviderParam": f"eolab-vector-overviews/{name}.xml",
    }
    assert any(
        json.loads(request.content) == {"layer": {"advertised": False}}
        for request in scenario.original.requests
        if request.method == "PUT" and request.url.path.endswith(".json")
    )
    assert (
        scenario.public.native_name
        == scenario.original.native_name
        == "selected & source"
    )


def test_failed_overview_publication_cleans_configuration_and_retries(
    tmp_path: Path,
) -> None:
    """Remove an incomplete wrapper while retaining its complete reusable original.

    Args:
        tmp_path: Isolated source-file directory.
    """
    name = "geopackage-0123456789abcdef01234567"
    scenario = OverviewGeoServerScenario(name)
    levels = (GeoPackageOverview("display_10", 10.0, "geom"),)

    async def publish_with_retry() -> None:
        """Fail wrapper creation once, then recover through the public contract."""
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(scenario)
        ) as client:
            publisher = GeoServerVectorPublisher(client, "http://geoserver/geoserver")
            scenario.reject_display_feature_type = True
            with pytest.raises(VectorPublicationError):
                await publisher.publish(
                    name,
                    "geopackage",
                    tmp_path / "source.gpkg",
                    "selected",
                    "polygon",
                    display_levels=levels,
                )
            assert scenario.configuration is None
            assert not scenario.public.datastore
            assert scenario.original.datastore and scenario.original.layer
            scenario.reject_display_feature_type = False
            await publisher.publish(
                name,
                "geopackage",
                tmp_path / "source.gpkg",
                "selected",
                "polygon",
                display_levels=levels,
            )

    asyncio.run(publish_with_retry())
    assert scenario.public.layer
    assert scenario.configuration_writes == 2
    assert (
        len(
            [
                request
                for request in scenario.original.requests
                if request.method == "POST" and request.url.path.endswith("/datastores")
            ]
        )
        == 1
    )


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
    item = asyncio.run(VectorAssessmentFinalizer(
        resolver,
        RecordingVectorAssessor(compatible_reader("polygon")),
    ).finalize(item))
    return item, source_path


def assessed_shapefile_item(tmp_path: Path) -> tuple[dict[str, Any], Path]:
    """Build one eligible assessed Shapefile Item fixture end to end.

    Args:
        tmp_path: Isolated mounted scan source.

    Returns:
        Assessed Item and canonical `.shp` source path.
    """
    source_path = tmp_path / "roads.shp"
    components = write_point_shapefile(source_path)
    item = build_shapefile_item(tmp_path, source_path, components)
    resolver = MountedVectorResolver(tmp_path)
    item = asyncio.run(VectorAssessmentFinalizer(
        resolver,
        RecordingVectorAssessor(compatible_reader("point")),
    ).finalize(item))
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
    assert authorization.is_style_authorized("vector-polygon")


def test_shapefile_flows_from_handler_assessment_to_publication(
    tmp_path: Path,
) -> None:
    """Preserve Shapefile components and native name through publication.

    Args:
        tmp_path: Isolated mounted scan source.
    """
    item, source_path = assessed_shapefile_item(tmp_path)
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

    publication = asyncio.run(service.publish(request))

    assert publisher.requests == [(
        item["id"],
        "shapefile",
        source_path,
        "roads",
        "point",
    )]
    assert publication.style_name == "vector-point"
    authorization = registry.require_current(publication.layer_name)
    assert authorization.source.component_paths
    assert authorization.source.layer_name == "roads"


def test_geoserver_vector_publisher_converges_clean_and_complete_states(
    tmp_path: Path,
) -> None:
    """Publish a filename with spaces as a path, then reuse the exact layer.

    Args:
        tmp_path: Isolated directory containing the mounted source path.
    """
    resource_name = "geopackage-0123456789abcdef01234567"
    source_path = tmp_path / "catalog data" / "Selected areas 100%.gpkg"
    scenario = VectorGeoServerScenario(resource_name)
    geoserver_client = httpx2.AsyncClient(
        transport=httpx2.MockTransport(scenario)
    )
    publisher = GeoServerVectorPublisher(
        geoserver_client,
        "http://geoserver/geoserver",
    )

    first_style = asyncio.run(publisher.publish(
        resource_name,
        "geopackage",
        source_path,
        "selected",
        "polygon",
    ))
    second_style = asyncio.run(publisher.publish(
        resource_name,
        "geopackage",
        source_path,
        "selected",
        "polygon",
    ))
    asyncio.run(geoserver_client.aclose())

    assert first_style == second_style == "vector-polygon"
    assert scenario.datastore and scenario.feature_type and scenario.layer
    datastore_requests = [
        request for request in scenario.requests
        if request.method == "POST" and request.url.path.endswith("/datastores")
    ]
    assert len(datastore_requests) == 1
    parameters = json.loads(datastore_requests[0].content)["dataStore"][
        "connectionParameters"
    ]["entry"]
    assert {entry["@key"]: entry["$"] for entry in parameters} == {
        "dbtype": "geopkg",
        "database": str(source_path),
        "read_only": "true",
        "immutable": "true",
    }
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
    geoserver_client = httpx2.AsyncClient(
        transport=httpx2.MockTransport(scenario)
    )
    publisher = GeoServerVectorPublisher(
        geoserver_client,
        "http://geoserver/geoserver",
    )

    style_name = asyncio.run(publisher.publish(
        resource_name,
        "shapefile",
        tmp_path / "roads.shp",
        "roads",
        "polygon",
    ))
    asyncio.run(geoserver_client.aclose())

    assert style_name == "vector-polygon"
    assert any(request.method == "DELETE" for request in scenario.requests)
    assert scenario.native_name == "roads"
