"""Scanner-owned raster source metadata and its typed identity boundary."""

from typing import Any

from eolab_app.raster.errors import RasterConflictError
from eolab_app.raster.source_identity import RasterSourceIdentity

RASTER_ASSET_METADATA_KEY = "eolab:source"
RASTER_SOURCE_SIGNATURE_FIELD = "source_signature"


def cataloged_source_signature(item: dict[str, Any]) -> RasterSourceIdentity:
    """Return the neutral source identity recorded on one Catalog Item.

    Args:
        item: Authoritative scanner-owned STAC Item.

    Returns:
        Typed filesystem identity recorded during discovery.

    Raises:
        RasterConflictError: If the source identity is absent or malformed.
    """
    assets = item.get("assets")
    data_asset = assets.get("data") if isinstance(assets, dict) else None
    metadata = (
        data_asset.get(RASTER_ASSET_METADATA_KEY)
        if isinstance(data_asset, dict)
        else None
    )
    signature = (
        metadata.get(RASTER_SOURCE_SIGNATURE_FIELD)
        if isinstance(metadata, dict)
        else None
    )
    try:
        return RasterSourceIdentity.from_catalog(signature)
    except ValueError as error:
        raise RasterConflictError(
            "Raster source identity is unavailable; scan this source again."
        ) from error
