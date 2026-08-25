"""Test rendering-independent catalog raster source authorization."""

import asyncio
from pathlib import Path
from typing import Any

import pytest

from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.models import CatalogRasterRequest
from eolab_app.raster.source_identity import RasterSourceIdentity
from eolab_app.raster.source_authorization import (
    CatalogRasterSourceAuthorizer,
)
from eolab_app.raster.sources import source_signature


class _Catalog:
    """Return one controlled authoritative Item."""

    def __init__(self, item: dict[str, Any]) -> None:
        """Store the controlled Item.

        Args:
            item: Item returned to the source authorizer.
        """
        self.item = item

    async def get_item(self, _: CatalogRasterRequest) -> dict[str, Any]:
        """Return the controlled Item.

        Args:
            _: Ignored validated identity.

        Returns:
            Controlled authoritative Item.
        """
        return self.item


class _Resolver:
    """Return one controlled mounted source path."""

    def __init__(self, source_path: Path) -> None:
        """Store the controlled path.

        Args:
            source_path: Path returned for every Item.
        """
        self.source_path = source_path

    def resolve(self, _: dict[str, Any]) -> Path:
        """Return the controlled path.

        Args:
            _: Ignored authoritative Item.

        Returns:
            Controlled mounted source path.
        """
        return self.source_path


def _item(signature: RasterSourceIdentity) -> dict[str, Any]:
    """Build an Item explicitly rejected by the rendering subsystem.

    Args:
        signature: Scanner-owned primary-source identity.

    Returns:
        Item whose source is analyzable despite rendering rejection.
    """
    return {
        "assets": {
            "data": {
                "eolab:rendering": {
                    "source_signature": signature.to_catalog(),
                    "eligible": False,
                    "reader_compatible": False,
                    "reason_code": "geoserver_crs_metadata_incompatible",
                }
            }
        }
    }


def test_source_authorization_ignores_rendering_and_geoprocessor_state(
    tmp_path: Path,
) -> None:
    """Authorize analysis solely from catalog, mount, and source identity.

    Args:
        tmp_path: Temporary controlled source directory.
    """
    source_path = tmp_path / "independent.tif"
    source_path.write_bytes(b"source")
    signature = source_signature(source_path)
    authorizer = CatalogRasterSourceAuthorizer(
        _Catalog(_item(signature)),
        _Resolver(source_path),
    )
    request = CatalogRasterRequest(
        collectionId="eolab-mounted-geotiffs",
        itemId="geotiff-0123456789abcdef01234567",
    )

    authorized = asyncio.run(authorizer.authorize(request))

    assert authorized.source_path == source_path
    assert authorized.source_signature == signature


def test_source_authorization_accepts_legacy_identity_after_remount(
    tmp_path: Path,
) -> None:
    """Keep analysis authorized when only a legacy device number changed.

    Args:
        tmp_path: Temporary controlled source directory.
    """
    source_path = tmp_path / "independent.tif"
    source_path.write_bytes(b"source")
    signature = source_signature(source_path)
    item = _item(signature)
    metadata = item["assets"]["data"]["eolab:rendering"]
    assert isinstance(metadata, dict)
    metadata["source_signature"] = [92, *signature.to_catalog()]
    authorizer = CatalogRasterSourceAuthorizer(
        _Catalog(item),
        _Resolver(source_path),
    )
    request = CatalogRasterRequest(
        collectionId="eolab-mounted-geotiffs",
        itemId="geotiff-0123456789abcdef01234567",
    )

    authorized = asyncio.run(authorizer.authorize(request))

    assert authorized.source_signature == signature


def test_source_authorization_rejects_missing_and_stale_scan_identity(
    tmp_path: Path,
) -> None:
    """Keep stale catalog sources actionable without consulting rendering.

    Args:
        tmp_path: Temporary controlled source directory.
    """
    source_path = tmp_path / "stale.tif"
    source_path.write_bytes(b"first")
    scanned_signature = source_signature(source_path)
    request = CatalogRasterRequest(
        collectionId="eolab-mounted-geotiffs",
        itemId="geotiff-0123456789abcdef01234567",
    )
    source_path.write_bytes(b"replacement source")
    stale_authorizer = CatalogRasterSourceAuthorizer(
        _Catalog(_item(scanned_signature)),
        _Resolver(source_path),
    )

    with pytest.raises(RasterConflictError, match="scan it again"):
        asyncio.run(stale_authorizer.authorize(request))

    missing_signature_item = _item(scanned_signature)
    metadata = missing_signature_item["assets"]["data"][
        "eolab:rendering"
    ]
    assert isinstance(metadata, dict)
    metadata.pop("source_signature")
    missing_authorizer = CatalogRasterSourceAuthorizer(
        _Catalog(missing_signature_item),
        _Resolver(source_path),
    )
    with pytest.raises(RasterConflictError, match="scan this source again"):
        asyncio.run(missing_authorizer.authorize(request))
