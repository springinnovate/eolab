"""Test raster publication orchestration and the GeoServer adapter."""

import asyncio
from pathlib import Path

import httpx2

from eolab_app.raster.geoserver import GeoServerRasterPublisher
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.publication import RasterPublicationService
from eolab_app.raster.sources import PublishedRasterRegistry, source_signature


class _Catalog:
    """Return one controlled eligible Item."""

    def __init__(self, item: dict[str, object]) -> None:
        """Store the Item."""
        self.item = item

    async def get_item(self, _: object) -> dict[str, object]:
        """Return the controlled Item."""
        return self.item


class _Resolver:
    """Return one controlled mounted source."""

    def __init__(self, source_path: Path) -> None:
        """Store the mounted source."""
        self.source_path = source_path

    def resolve(self, _: object) -> Path:
        """Return the mounted source."""
        return self.source_path


class _Publisher:
    """Record one application-level publication call."""

    def __init__(self) -> None:
        """Create an empty call log."""
        self.calls: list[tuple[str, Path]] = []

    async def publish(self, resource_name: str, source_path: Path) -> None:
        """Record the requested resource and source."""
        self.calls.append((resource_name, source_path))


def test_publication_coordinates_eligibility_adapter_and_authorization(
    tmp_path: Path,
) -> None:
    """Authorize exactly the source inspected before publication."""
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")
    item_id = "geotiff-0123456789abcdef01234567"
    item = {
        "id": item_id,
        "bbox": [-123, 48, -122, 49],
        "assets": {
            "data": {
                "eolab:rendering": {
                    "policy": "raster-v2",
                    "eligible": True,
                }
            }
        },
    }
    publisher = _Publisher()
    registry = PublishedRasterRegistry()
    service = RasterPublicationService(
        _Catalog(item),
        _Resolver(source_path),
        publisher,
        registry,
        signature_reader=source_signature,
        eligibility_inspector=lambda _: {"eligible": True},
    )
    request = CatalogRasterRequest.model_validate(
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": item_id,
        }
    )

    result = asyncio.run(service.publish(request))

    assert result.layer_name == f"eolab:{item_id}"
    assert publisher.calls == [(item_id, source_path)]
    assert registry.require_current(result.layer_name).source_path == source_path


def test_geoserver_adapter_owns_request_and_response_contract(
    tmp_path: Path,
) -> None:
    """Construct the external store and style requests inside the adapter."""
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")
    requests: list[httpx2.Request] = []

    def response(request: httpx2.Request) -> httpx2.Response:
        requests.append(request)
        return httpx2.Response(
            201 if request.url.path.endswith("external.geotiff") else 200
        )

    async def publish() -> None:
        async with httpx2.AsyncClient(
            transport=httpx2.MockTransport(response)
        ) as client:
            adapter = GeoServerRasterPublisher(
                client,
                "http://geoserver:8080/geoserver",
            )
            await adapter.publish("geotiff-id", source_path)

    asyncio.run(publish())

    assert [request.method for request in requests] == ["PUT", "PUT"]
    assert requests[0].content.decode() == source_path.as_uri()
    assert b"<name>dynamic-raster</name>" in requests[1].content
