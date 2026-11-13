"""Exercise generated vectors through ordinary services and private map delivery."""

import asyncio
from dataclasses import replace
import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx2
import pytest
from fastapi.testclient import TestClient

import eolab_app.main as application_module
from eolab_app.routes.processing import COOKIE
from eolab_app.source_files import ResolvedSourceFile, SourceFileError
from eolab_app.vector.geoserver import GeoServerVectorPublisher
from eolab_app.vector.models import VectorFormat, VectorGeometryKind
from eolab_app.vector.publication import VectorPublicationService
from tests.test_raster_source_access import FileAuthority, FileLease, PRIVATE
from tests.test_uploaded_vector_rendering import RecordingRenderer, FILTER
from tests.test_vector_publication import VectorGeoServerScenario
from tests.test_vector_uploads import write_layer

HEADERS = {"X-EOLab-Processing": "1"}
BASE = f"/api/vector-rendering/artifacts/{PRIVATE['jobId']}/{PRIVATE['artifactId']}"


class VectorFileAuthority(FileAuthority):
    """Supply an immutable GeoPackage through the existing leased-file boundary."""

    async def acquire(self, owner: str, run: str, file: str) -> FileLease:
        """Authorize and retain the real GeoPackage.

        Args:
            owner: Server-derived browser identity.
            run: Requested opaque run ID.
            file: Requested opaque artifact ID.

        Returns:
            Original file with a renewable read lease.

        Raises:
            SourceFileError: If the browser or result lifetime rejects access.
        """
        return replace(
            await super().acquire(owner, run, file),
            media_type="application/geopackage+sqlite3",
        )

    async def resolve(self, owner: str, run: str, file: str) -> ResolvedSourceFile:
        """Authorize original-file lookup for private WMS access.

        Args:
            owner: Server-derived browser identity.
            run: Requested run ID.
            file: Requested artifact ID.

        Returns:
            Immutable original metadata without acquiring a transfer.

        Raises:
            SourceFileError: If ownership or result lifetime rejects access.
        """
        return replace(
            await super().resolve(owner, run, file),
            media_type="application/geopackage+sqlite3",
        )


class ResultRenderer(RecordingRenderer):
    """Record external rendering calls and result unpublication."""

    def __init__(self) -> None:
        """Start with empty ordinary publication and removal records."""
        super().__init__()
        self.names: set[str] = set()
        self.removed: list[str] = []

    async def publish(
        self,
        resource_name: str,
        source_format: VectorFormat,
        source_path: Path,
        layer_name: str,
        geometry_kind: VectorGeometryKind,
        *,
        advertised: bool = True,
    ) -> str:
        """Record ordinary rendering while requiring private capability metadata.

        Args:
            resource_name: Opaque result publication name.
            source_format: Original file format.
            source_path: Authorized original file.
            layer_name: Exact native layer.
            geometry_kind: Ordinary vector style family.
            advertised: Public capability visibility; false for this fixture.

        Returns:
            Existing default geometry style.
        """
        assert advertised is False
        self.names.add(resource_name)
        return await super().publish(
            resource_name, source_format, source_path, layer_name, geometry_kind
        )

    async def temporary_layers(self) -> tuple[str, ...]:
        """Return external publications independently of the application registry.

        Returns:
            All retained result datastore names.
        """
        return tuple(self.names)

    async def remove(self, resource_name: str) -> None:
        """Remove external publication metadata without deleting its original file.

        Args:
            resource_name: Generated datastore being cleaned.
        """
        self.removed.append(resource_name)
        self.names.discard(resource_name)


@pytest.fixture
def result_boundary(
    configured_environment: None,
    version_file_path: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[
    TestClient,
    TestClient,
    VectorFileAuthority,
    ResultRenderer,
    VectorPublicationService,
    list[httpx2.Request],
]:
    """Compose actual result routes, vector services and private map delivery.

    Args:
        configured_environment: Isolated application configuration.
        version_file_path: Application build fixture.
        tmp_path: Original result file directory.
        monkeypatch: Replace external file authority and GeoServer transports.

    Returns:
        Owner, unrelated browser, file authority, renderer, publication and upstream log.
    """
    path = tmp_path / "summary.gpkg"
    write_layer(path, layer="summary")
    authority = VectorFileAuthority(path)
    token = "c" * 64
    authority.owners = {hashlib.sha256(token.encode()).hexdigest()}
    renderer = ResultRenderer()
    forwarded: list[httpx2.Request] = []
    services: list[VectorPublicationService] = []
    monkeypatch.setattr(
        application_module,
        "create_model_source_files",
        lambda service: authority.files(),
    )
    monkeypatch.setattr(
        application_module, "GeoServerVectorPublisher", lambda *_: renderer
    )

    async def available(service: Any, job_id: str, artifact_id: str) -> bool:
        """Report source lifetime to cleanup without authorizing a browser.

        Args:
            service: Composed source owner, unused by the controlled authority.
            job_id: Registered run ID.
            artifact_id: Registered artifact ID.

        Returns:
            Current fixture lifetime for exactly its result identity.
        """
        return authority.ready and (job_id, artifact_id) == (
            PRIVATE["jobId"],
            PRIVATE["artifactId"],
        )

    def publication(*args: Any, **kwargs: Any) -> VectorPublicationService:
        """Capture the production service composed around external boundary fixtures.

        Args:
            args: Ordinary publication collaborators.
            kwargs: Source/lifetime collaborators.

        Returns:
            Production vector publication service.
        """
        service = VectorPublicationService(*args, **kwargs)
        services.append(service)
        return service

    monkeypatch.setattr(
        application_module.ProcessingService, "model_artifact_is_available", available
    )
    monkeypatch.setattr(application_module, "VectorPublicationService", publication)

    def reject_catalog(request: httpx2.Request) -> httpx2.Response:
        """Reject accidental catalog registration or lookup of a private result.

        Args:
            request: Unexpected external catalog request.

        Raises:
            AssertionError: Always; result sources do not use the shared catalog.
        """
        raise AssertionError(str(request.url))

    def render(request: httpx2.Request) -> httpx2.Response:
        """Return external WMS responses only while the original file is retained.

        Args:
            request: Authorized upstream rendering request.

        Returns:
            Private tile bytes or public capabilities for filtering.
        """
        forwarded.append(request)
        if request.url.params.get("request", "").lower() == "getcapabilities":
            names = "".join(
                f"<Layer><Name>eolab:{name}</Name></Layer>" for name in renderer.names
            )
            return httpx2.Response(
                200,
                text=f"<WMS_Capabilities><Capability><Layer><Layer><Name>eolab:public</Name></Layer>{names}</Layer></Capability></WMS_Capabilities>",
                headers={"Content-Type": "application/xml"},
            )
        assert authority.leases, "Upstream reads must retain the original result file"
        return httpx2.Response(
            200, content=b"tile", headers={"Content-Type": "image/png"}
        )

    app = application_module.create_app(
        version_file_path,
        catalog_transport=httpx2.MockTransport(reject_catalog),
        geoserver_transport=httpx2.MockTransport(render),
    )
    owner, other = TestClient(app, base_url="https://testserver"), TestClient(
        app, base_url="https://testserver"
    )
    owner.cookies.set(COOKIE, token)
    return owner, other, authority, renderer, services[0], forwarded


def test_result_uses_ordinary_vector_fields_filters_and_owned_original(
    result_boundary: tuple[Any, ...],
) -> None:
    """Reuse original-source vector operations without catalog or preview dependencies.

    Args:
        result_boundary: Real application services with external ownership and renderer fixtures.
    """
    owner, other, authority, renderer, _, _ = result_boundary
    described = owner.get(BASE)
    assert described.status_code == 200, described.text
    metadata = described.json()
    assert metadata["fields"] == {"label": "str", "count": "int", "weight": "float"}
    assert metadata["layerName"] == "summary" and metadata["geometryKind"] == "polygon"
    assert str(authority.path) not in described.text
    assert other.get(BASE).status_code == 404
    assert owner.post(BASE + "/layers").status_code == 403
    published = owner.post(BASE + "/layers", headers=HEADERS)
    assert published.status_code == 200, published.text
    operations = [
        ("category-summaries", {"field": "label"}),
        (
            "numeric-classifications",
            {"field": "count", "method": "equal-interval", "classCount": 3},
        ),
        ("filters", {"filter": FILTER}),
        ("filter-counts", {"filter": FILTER}),
        ("extent", {"filter": FILTER}),
        ("styles", {"style": published.json()["style"]}),
    ]
    for action, body in operations:
        response = owner.post(BASE + "/" + action, json=body, headers=HEADERS)
        assert response.status_code == 200, (action, response.text)
        assert response.headers["Cache-Control"] == "private, no-store"
        assert (
            other.post(BASE + "/" + action, json=body, headers=HEADERS).status_code
            == 404
        )
        assert not authority.leases
    values = owner.get(BASE + "/field-values", params={"field": "label"}).json()
    assert values["values"] == ["Café wetlands"]
    assert renderer.requests[0][2] == authority.path
    authority.ready = False
    assert owner.get(BASE).status_code == 409
    assert (
        owner.get(BASE + "/field-values", params={"field": "label"}).status_code == 409
    )
    assert not authority.leases


def test_result_wms_and_cached_composite_recheck_ownership_and_expiry(
    result_boundary: tuple[Any, ...],
) -> None:
    """Keep ordinary rendered and cached results private until their source expires.

    Args:
        result_boundary: Real application services and ownership fixture.
    """
    owner, other, authority, _, _, forwarded = result_boundary
    published = owner.post(BASE + "/layers", headers=HEADERS).json()
    filtered = owner.post(
        BASE + "/filters", json={"filter": FILTER}, headers=HEADERS
    ).json()
    params = {
        "service": "WMS",
        "version": "1.3.0",
        "request": "GetMap",
        "layers": filtered["layerName"],
        "styles": published["styleName"],
        "vector_style": json.dumps(published["style"]),
        "crs": "EPSG:3857",
        "bbox": "0,0,1000,1000",
        "width": 256,
        "height": 256,
        "format": "image/png",
    }
    for method in ("GET", "POST"):
        transport = (
            {"params": params}
            if method == "GET"
            else {"data": params, "headers": HEADERS}
        )
        response = owner.request(method, "/geoserver/eolab/wms", **transport)
        assert response.status_code == 200, response.text
        assert response.headers["Cache-Control"] == "private, no-store"
        assert (
            other.request(method, "/geoserver/eolab/wms", **transport).status_code
            == 404
        )
    plan = owner.post(
        "/api/map-rendering/plans",
        json={
            "layers": [
                {
                    "layerName": filtered["layerName"],
                    "styleName": published["styleName"],
                    "styleDefinition": published["style"],
                    "opacity": 1,
                }
            ]
        },
        headers=HEADERS,
    )
    assert plan.status_code == 200, plan.text
    tile = (
        plan.json()["wmsUrl"]
        + "?"
        + urlencode(
            {
                "service": "WMS",
                "version": "1.1.1",
                "request": "GetMap",
                "layers": "composite",
                "styles": "",
                "srs": "EPSG:3857",
                "bbox": "0,0,1000,1000",
                "width": 256,
                "height": 256,
                "format": "image/png",
                "transparent": "true",
            }
        )
    )
    first = owner.get(tile)
    assert first.status_code == 200, first.text
    before = len(forwarded)
    assert owner.get(tile).content == first.content
    assert other.get(tile).status_code == 404
    assert len(forwarded) == before
    capabilities = other.get("/geoserver/eolab/wms?service=WMS&request=GetCapabilities")
    assert published["layerName"] not in capabilities.text
    assert "eolab:public" in capabilities.text
    authority.ready = False
    assert owner.get(tile).status_code == 409
    assert owner.get("/geoserver/eolab/wms", params=params).status_code == 409
    assert not authority.leases


def test_result_cleanup_waits_for_active_reads_and_removes_restart_publications(
    result_boundary: tuple[Any, ...],
) -> None:
    """Retain active native reads while expiry revokes new access and cleanup can retry.

    Args:
        result_boundary: Real publication service, renderer and source authority.
    """
    owner, _, authority, renderer, publication, _ = result_boundary
    name = owner.post(BASE + "/layers", headers=HEADERS).json()["layerName"]

    async def exercise() -> None:
        """Expire a source during an active render and then reconcile its publication."""
        with pytest.raises(SourceFileError, match="expired"):
            async with publication.use_artifact_layers(
                (name,), next(iter(authority.owners))
            ):
                assert authority.leases
                authority.ready = False
                await publication.cleanup_artifact_layers()
                assert not renderer.removed
        assert not authority.leases
        await publication.cleanup_artifact_layers()
        assert renderer.removed == [name.split(":", 1)[1]]
        assert authority.path.exists()
        orphan = "vector_result_" + "d" * 32 + "_" + "e" * 32
        renderer.names.add(orphan)
        await publication.cleanup_artifact_layers()
        assert orphan in renderer.removed

    asyncio.run(exercise())


class BlockingFieldReader:
    """Keep a native reader alive after cancellation until the test releases it."""

    def __init__(self) -> None:
        """Create observable start, cancellation and native-exit controls."""
        from threading import Event

        self.started = Event()
        self.release = Event()
        self.cancelled = None

    def read_categories(
        self, source: Any, field: str, limit: int, cancelled: Any
    ) -> Any:
        """Keep the actual thread alive after it receives a cancellation signal.

        Args:
            source: Authorized original file.
            field: Selected string field.
            limit: Ordinary feature budget.
            cancelled: Service-owned cooperative stop signal.

        Returns:
            One complete category read after native release.
        """
        from eolab_app.vector.models import VectorCategoryRead

        self.cancelled = cancelled
        self.started.set()
        assert self.release.wait(5), "Native fixture was not released"
        return VectorCategoryRead((("Café wetlands", 1),), 1, 0, 0, True)

    def count_filter(
        self, source: Any, candidate: Any, limit: int, cancelled: Any
    ) -> Any:
        """Keep a filter count alive until native exit is explicitly allowed.

        Args:
            source: Authorized original file.
            candidate: Checked source predicate.
            limit: Ordinary count budget.
            cancelled: Service-owned cooperative stop signal.

        Returns:
            Complete matching and total counts.
        """
        from eolab_app.vector.filters import VectorFilterCount

        self.read_categories(source, "label", limit, cancelled)
        return VectorFilterCount(matched=1, total=1, complete=True)


@pytest.mark.parametrize("action", ["categories", "count-cancel", "count-timeout"])
def test_cancelled_native_field_reads_keep_result_lease_until_exit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    """Retain the original result during native cancellation and count timeout cleanup.

    Args:
        tmp_path: Completed GeoPackage storage.
        monkeypatch: Shorten only the count's 21-second wait for the timeout case.
        action: Category cancellation, count cancellation or count timeout.
    """
    from eolab_app.vector.artifact_sources import ArtifactVectorSourceResolver
    from eolab_app.vector.filters import VectorFilter
    from eolab_app.vector.sources import PublishedVectorRegistry
    from eolab_app.vector.styling import VectorStyleService

    path = tmp_path / "summary.gpkg"
    write_layer(path, layer="summary")
    authority = VectorFileAuthority(path)
    sources = ArtifactVectorSourceResolver(authority.files())
    reader = BlockingFieldReader()
    registry = PublishedVectorRegistry()
    renderer = ResultRenderer()
    publication = VectorPublicationService(
        None, None, renderer, registry, field_reader=reader
    )
    styles = VectorStyleService(None, None, renderer, registry, reader)

    if action == "count-timeout":
        original_wait = asyncio.wait_for

        async def short_count_wait(awaitable: Any, timeout: float | None) -> Any:
            """Shorten the count response timeout while retaining its running native task.

            Args:
                awaitable: Existing wait's task or future.
                timeout: Configured timeout; only the 21-second count wait is shortened.

            Returns:
                The original wait result or its ordinary timeout exception.
            """
            return await original_wait(awaitable, 0.02 if timeout == 21 else timeout)

        monkeypatch.setattr(asyncio, "wait_for", short_count_wait)

    async def exercise() -> None:
        """Cancel a real service call while checking that its source lease remains live."""

        async def operation() -> Any:
            """Read the owned source under the same lease used by private HTTP operations.

            Returns:
                Ordinary category or filter-count result.
            """
            async with sources.open_layer(
                "owner", PRIVATE["jobId"], PRIVATE["artifactId"]
            ) as metadata:
                if action == "categories":
                    return await styles.summarize_layer_categories(
                        metadata.layer, "label"
                    )
                await publication.publish_layer(metadata.layer)
                return await publication.count_layer_filter(
                    metadata.layer, VectorFilter.model_validate(FILTER)
                )

        task = asyncio.create_task(operation())
        try:
            async with asyncio.timeout(4):
                while not reader.started.is_set():
                    await asyncio.sleep(0.01)
            assert authority.leases
            if action != "count-timeout":
                task.cancel()
            async with asyncio.timeout(2):
                while not reader.cancelled.is_set():
                    await asyncio.sleep(0.01)
            assert not task.done()
            assert authority.leases
            reader.release.set()
            if action == "count-timeout":
                assert not (await task).complete
            else:
                with pytest.raises(asyncio.CancelledError):
                    await task
            assert not authority.leases
        finally:
            reader.release.set()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(exercise())


def test_geoserver_result_publication_hides_capabilities_and_cleans_datastore(
    tmp_path: Path,
) -> None:
    """Use actual GeoServer adapter requests to hide and remove result resources.

    Args:
        tmp_path: Confined original-file test directory.
    """
    name = "vector_result_" + "a" * 32 + "_" + "b" * 32
    scenario = VectorGeoServerScenario(name)

    def upstream(request: httpx2.Request) -> httpx2.Response:
        """Supply external REST state and record cleanup requests.

        Args:
            request: GeoServer adapter request.

        Returns:
            Simulated external resource discovery or lifecycle response.
        """
        if request.url.path.endswith("/datastores.json"):
            return httpx2.Response(
                200,
                json={
                    "dataStores": {"dataStore": [{"name": name}, {"name": "public"}]}
                },
            )
        if request.method == "DELETE" and "/gwc/" in request.url.path:
            scenario.requests.append(request)
            return httpx2.Response(200)
        return scenario(request)

    async def exercise() -> None:
        """Publish privately and remove GeoServer state while preserving the source."""
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(upstream)
        ) as client:
            publisher = GeoServerVectorPublisher(client, "http://geoserver/geoserver")
            await publisher.publish(
                name,
                "geopackage",
                tmp_path / "source.gpkg",
                "summary",
                "polygon",
                advertised=False,
            )
            assert await publisher.temporary_layers() == (name,)
            assert any(
                request.method == "PUT"
                and request.content == b'{"layer":{"advertised":false}}'
                for request in scenario.requests
            )
            await publisher.remove(name)
            assert not scenario.datastore

    asyncio.run(exercise())
