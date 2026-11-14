"""Resolve catalog attachment identities to original files inside the scan mount."""

from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

ASSET_SOURCE_KEY = "eolab:asset-source"


class CatalogAttachmentNotFound(ValueError):
    """The requested catalog Asset is not an admitted local downloadable file."""


class CatalogAttachmentUnavailable(OSError):
    """A cataloged attachment is missing or cannot currently be read."""


@dataclass(frozen=True)
class CatalogAttachment:
    """An original local file authorized for download through its catalog identity.

    Attributes:
        path: Canonical file path confined to the configured scan mount.
    """

    path: Path


def get_asset_source_href(asset: dict[str, Any]) -> str | None:
    """Read an Asset's internal source URI without interpreting its public URL.

    Args:
        asset: Authoritative persisted STAC Asset. Described local Assets carry
            a private source URI; ordinary Assets retain their existing href.

    Returns:
        The original source URI, or None when the persisted source contract is
        malformed. A malformed private source never falls back to a public URL.
    """
    source = asset.get(ASSET_SOURCE_KEY, asset)
    href = source.get("href") if isinstance(source, dict) else None
    return href if isinstance(href, str) else None


def resolve_catalog_attachment(asset: object, scan_mount: Path) -> CatalogAttachment:
    """Resolve an admitted local Asset to a downloadable file within its mount.

    Args:
        asset: Stored Asset selected by Collection, Item and Asset identity.
            Only Assets explicitly published with catalog access are admitted.
        scan_mount: Configured read-only root containing the source files.

    Returns:
        The canonical original file, without reading or hashing its payload.

    Raises:
        CatalogAttachmentNotFound: If the Asset is absent, external, malformed,
            outside the mount, or a directory rather than a downloadable file.
        CatalogAttachmentUnavailable: If its formerly admitted file is missing
            or filesystem access fails.
    """
    if (
        not isinstance(asset, dict)
        or asset.get("eolab:access") != {"kind": "catalog"}
        or ASSET_SOURCE_KEY not in asset
    ):
        raise CatalogAttachmentNotFound(
            "This catalog Asset has no local file download."
        )
    href = get_asset_source_href(asset)
    if href is None:
        raise CatalogAttachmentNotFound("This catalog Asset has no valid local file.")
    try:
        mount = scan_mount.resolve(strict=True)
        mount_uri = urlsplit(mount.as_uri())
        source_uri = urlsplit(href)
        mount_path = unquote(mount_uri.path).rstrip("/")
        source_path = unquote(source_uri.path)
        if (
            source_uri.scheme != "file"
            or source_uri.netloc != mount_uri.netloc
            or source_uri.query
            or source_uri.fragment
            or not source_path.startswith(mount_path + "/")
        ):
            raise CatalogAttachmentNotFound(
                "This file is outside the catalog source mount."
            )
        path = (mount / source_path[len(mount_path) + 1 :]).resolve(strict=True)
        if not path.is_relative_to(mount) or not path.is_file():
            raise CatalogAttachmentNotFound(
                "This catalog Asset is not a downloadable file."
            )
        return CatalogAttachment(path=path)
    except OSError as error:
        raise CatalogAttachmentUnavailable(
            "The cataloged file is unavailable. Refresh the Catalog after restoring the source."
        ) from error
