"""Verify catalog attachment access, public projection and original-source readers."""

from copy import deepcopy
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx2
import psycopg
import pytest

from eolab_app.catalog.asset_access import (
    ASSET_SOURCE_KEY,
    CatalogAttachment,
    CatalogAttachmentNotFound,
    CatalogAttachmentUnavailable,
    resolve_catalog_attachment,
)
from eolab_app.catalog.descriptor_contract import (
    LocalAsset,
    public_asset_fields,
)
from eolab_app.catalog.shapefile import SHAPEFILE_COMPONENT_TYPES
from eolab_app.catalog.public_metadata import copy_public_catalog_metadata
from eolab_app.raster.errors import RasterAssetError
from eolab_app.raster.sources import MountedRasterResolver
from eolab_app.routes.catalog import create_catalog_router
from eolab_app.routes.stac_proxy import create_stac_proxy_router
from eolab_app.vector.errors import VectorAssetError
from eolab_app.vector.sources import MountedVectorResolver


def admitted_asset(path: Path, *, media_type: str = "text/csv") -> dict[str, Any]:
    """Create the admission-to-reader Asset representation for one local file.

    Args:
        path: Original file selected by validated metadata admission.
        media_type: Source format reported by the existing reader.

    Returns:
        Public identity fields plus the private original source location.
    """
    asset = LocalAsset(
        location="local", path=path.name, media_type=media_type, roles=["data"]
    )
    return {
        **public_asset_fields(asset, "collection", "item", "data"),
        ASSET_SOURCE_KEY: {"href": path.as_uri()},
    }


def attachment_client(lookup: Any) -> TestClient:
    """Create the existing Catalog router with an injected attachment provider.

    Args:
        lookup: Awaitable catalog-identity attachment lookup.

    Returns:
        In-process client with no map, renderer or GeoServer dependency.
    """
    app = FastAPI()
    app.include_router(
        create_catalog_router(AsyncMock(), AsyncMock(), AsyncMock(), lookup)
    )
    return TestClient(app)


def test_download_resolves_only_catalog_identity_and_forces_attachment(
    tmp_path: Path,
) -> None:
    """Serve original bytes safely without accepting filesystem paths from clients.

    Args:
        tmp_path: Isolated source mount.
    """
    source = tmp_path / "notes.html"
    source.write_text("<script>unsafe()</script>", encoding="utf-8")
    asset = admitted_asset(source, media_type="text/html")
    calls: list[tuple[str, str, str]] = []

    async def lookup(collection: str, item: str, key: str) -> CatalogAttachment:
        """Resolve the fixture only after a matching stored identity lookup.

        Args:
            collection: Requested Collection identity.
            item: Requested Item identity.
            key: Requested Asset identity.

        Returns:
            Confined original fixture file.

        Raises:
            CatalogAttachmentNotFound: If the requested identity differs.
            CatalogAttachmentUnavailable: If the fixture file was removed.
        """
        calls.append((collection, item, key))
        stored = (
            asset if (collection, item, key) == ("collection", "item", "data") else None
        )
        return resolve_catalog_attachment(stored, tmp_path)

    client = attachment_client(lookup)
    response = client.get(asset["href"])
    assert response.status_code == 200
    assert response.content == source.read_bytes()
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cache-control"] == "private, no-store"
    assert calls == [("collection", "item", "data")]
    assert (
        client.get("/api/catalog/asset", params={"path": str(source)}).status_code
        == 422
    )
    assert (
        client.get(asset["href"].replace("item=item", "item=missing")).status_code
        == 404
    )
    source.unlink()
    assert client.get(asset["href"]).status_code == 409


def test_attachment_errors_do_not_expose_paths_or_database_details() -> None:
    """Translate database failures at the HTTP boundary without leaking details."""
    lookup = AsyncMock(side_effect=psycopg.OperationalError("private database details"))
    response = attachment_client(lookup).get(
        "/api/catalog/asset", params={"collection": "c", "item": "i", "asset": "a"}
    )
    assert response.status_code == 503
    assert "private database" not in response.text


def test_attachment_resolver_confines_original_file_and_rejects_directories(
    tmp_path: Path,
) -> None:
    """Keep traversal, external files and directory containers outside downloads.

    Args:
        tmp_path: Isolated directory containing a source mount and an outside file.
    """
    mount = tmp_path / "mount"
    mount.mkdir()
    source = mount / "table.csv"
    source.write_text("value\n0\n", encoding="utf-8")
    outside = tmp_path / "outside.csv"
    outside.write_text("private", encoding="utf-8")
    valid = admitted_asset(source)
    assert resolve_catalog_attachment(valid, mount).path == source.resolve()
    for href in (
        outside.as_uri(),
        mount.as_uri() + "/../outside.csv",
        "https://example.org/table.csv",
    ):
        invalid = {**valid, ASSET_SOURCE_KEY: {"href": href}}
        with pytest.raises(CatalogAttachmentNotFound):
            resolve_catalog_attachment(invalid, mount)
    folder = mount / "data.gdb"
    folder.mkdir()
    with pytest.raises(CatalogAttachmentNotFound):
        resolve_catalog_attachment(admitted_asset(folder), mount)
    for invalid in (None, {"href": source.as_uri()}, {**valid, ASSET_SOURCE_KEY: None}):
        with pytest.raises(CatalogAttachmentNotFound):
            resolve_catalog_attachment(invalid, mount)
    source.unlink()
    with pytest.raises(CatalogAttachmentUnavailable):
        resolve_catalog_attachment(valid, mount)


def test_attachment_resolver_rejects_symlink_escape(tmp_path: Path) -> None:
    """Resolve symlinks before authorizing a mounted attachment.

    Args:
        tmp_path: Isolated source files.
    """
    mount = tmp_path / "mount"
    mount.mkdir()
    outside = tmp_path / "private.csv"
    outside.write_text("private", encoding="utf-8")
    link = mount / "link.csv"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("Host does not permit creating symlinks")
    with pytest.raises(CatalogAttachmentNotFound):
        resolve_catalog_attachment(admitted_asset(link), mount)


def test_public_projection_keeps_identity_href_without_any_private_locations(
    tmp_path: Path,
) -> None:
    """Strip private source keys even when upstream field projection omits Item IDs.

    Args:
        tmp_path: Private source location used only in the internal fixture.
    """
    asset = admitted_asset(tmp_path / "notes.csv")
    internal = {
        "assets": {"data": asset, "eolab:descriptor-source": {"href": str(tmp_path)}}
    }
    original = deepcopy(internal)
    public = copy_public_catalog_metadata(internal)
    assert public == {
        "assets": {
            "data": {
                key: value for key, value in asset.items() if key != ASSET_SOURCE_KEY
            }
        }
    }
    assert internal == original
    assert str(tmp_path) not in str(public)
    assert copy_public_catalog_metadata(
        {"assets": {"data": {ASSET_SOURCE_KEY: asset[ASSET_SOURCE_KEY]}}}
    ) == {"assets": {"data": {}}}


def test_described_raster_keeps_original_source_independent_of_public_download(
    tmp_path: Path,
) -> None:
    """Read the immutable original through the existing raster source resolver.

    Args:
        tmp_path: Isolated source mount.
    """
    source = tmp_path / "raster.tif"
    source.write_bytes(b"original")
    asset = admitted_asset(source, media_type="image/tiff; application=geotiff")
    item = {"assets": {"data": asset}}
    resolver = MountedRasterResolver(tmp_path)
    assert resolver.resolve(item) == source.resolve()
    with pytest.raises(RasterAssetError):
        resolver.resolve(copy_public_catalog_metadata(item))
    item["assets"]["data"][ASSET_SOURCE_KEY] = None
    with pytest.raises(RasterAssetError):
        resolver.resolve(item)


def test_described_vector_keeps_native_layer_and_original_source(
    tmp_path: Path,
) -> None:
    """Keep a described GeoPackage on the existing vector source pipeline.

    Args:
        tmp_path: Isolated source mount.
    """
    source = tmp_path / "study.gpkg"
    source.write_bytes(b"original")
    asset = admitted_asset(source, media_type="application/geopackage+sqlite3")
    item = {
        "collection": "eolab-mounted-vectors",
        "properties": {
            "eolab:vector_source": {
                "kind": "mounted",
                "format": "geopackage",
                "asset_key": "data",
                "layer_name": "sites",
            }
        },
        "assets": {"data": asset},
    }
    resolver = MountedVectorResolver(tmp_path)
    result = resolver.resolve(item)
    assert result.source_path == source.resolve()
    assert result.layer_name == "sites"
    assert result.source_kind == "mounted"
    item["assets"]["data"][ASSET_SOURCE_KEY] = None
    with pytest.raises(VectorAssetError):
        resolver.resolve(item)


def test_described_shapefile_keeps_all_original_components(tmp_path: Path) -> None:
    """Resolve multipart vector files using their private original locations.

    Args:
        tmp_path: Isolated source mount.
    """
    assets = {}
    for extension in (".shp", ".shx", ".dbf", ".prj"):
        path = tmp_path / ("sites" + extension)
        path.write_bytes(b"original")
        assets[extension[1:]] = admitted_asset(
            path, media_type=SHAPEFILE_COMPONENT_TYPES[extension]
        )
    item = {
        "collection": "eolab-mounted-vectors",
        "properties": {
            "eolab:vector_source": {
                "kind": "mounted",
                "format": "shapefile",
                "asset_key": "shp",
                "layer_name": "sites",
            }
        },
        "assets": assets,
    }
    result = MountedVectorResolver(tmp_path).resolve(item)
    assert result.source_path == (tmp_path / "sites.shp").resolve()
    assert {path.suffix for path in result.component_paths} == {
        ".shp",
        ".shx",
        ".dbf",
        ".prj",
    }


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_stac_proxy_projects_described_asset_without_item_identity(
    tmp_path: Path, method: str
) -> None:
    """Keep a field-projected Asset usable without exposing its original path.

    Args:
        tmp_path: Private source mount.
        method: Public Item Search HTTP method.
    """
    asset = admitted_asset(tmp_path / "notes.csv")
    payload = {
        "type": "FeatureCollection",
        "numberMatched": 1,
        "features": [
            {
                "assets": {
                    "data": asset,
                    "eolab:descriptor-source": {"href": str(tmp_path)},
                }
            }
        ],
    }

    def respond(request: httpx2.Request) -> httpx2.Response:
        """Return projected internal metadata for an allowed STAC read.

        Args:
            request: Forwarded request to the internal API.

        Returns:
            Internal projected response with deliberately private provenance.
        """
        return httpx2.Response(200, json=payload)

    upstream = httpx2.AsyncClient(transport=httpx2.MockTransport(respond))
    app = FastAPI()
    app.include_router(
        create_stac_proxy_router(
            upstream, "http://stac.test", AsyncMock(return_value=False)
        )
    )
    with TestClient(app) as client:
        response = client.request(
            method, "/stac/search", json={} if method == "POST" else None
        )
    assert response.status_code == 200
    public_asset = response.json()["features"][0]["assets"]["data"]
    assert public_asset["href"] == asset["href"]
    assert ASSET_SOURCE_KEY not in public_asset
    assert "eolab:descriptor-source" not in response.text
    assert str(tmp_path) not in response.text


def test_curated_annotation_keys_remain_public_in_every_metadata_scope() -> None:
    """Preserve arbitrary admitted annotation keys without exposing source records."""
    envelope = {
        "version": 1,
        "annotations": {"eolab:asset-source": {"public curator label": 0}},
        "publications": [{"annotations": {"eolab:descriptor-source": False}}],
    }
    item = {
        "properties": {"eolab:metadata": envelope},
        "assets": {
            "notes": {
                "eolab:metadata": envelope,
                "eolab:asset-source": {"href": "file:///private"},
            }
        },
    }
    projected = copy_public_catalog_metadata(item)
    assert projected["properties"]["eolab:metadata"] == envelope
    assert projected["assets"]["notes"] == {"eolab:metadata": envelope}
    projected["properties"]["eolab:metadata"]["annotations"][
        "eolab:asset-source"
    ] = "changed"
    assert envelope["annotations"]["eolab:asset-source"] == {"public curator label": 0}
