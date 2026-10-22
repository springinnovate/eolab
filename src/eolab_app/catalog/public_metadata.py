"""Keep server-only source locations out of public Catalog responses."""

from typing import TypeAlias

JsonValue: TypeAlias = (
    dict[str, "JsonValue"] | list["JsonValue"] | str | int | float | bool | None
)


def copy_public_catalog_metadata(value: JsonValue) -> JsonValue:
    """Copy Catalog JSON without the private temporal source asset.

    Apply this at public response boundaries, including STAC field projections
    that may omit an Item's collection or other identifying fields. The reserved
    key ``eolab:temporal-source`` contains the descriptor's server-side location.

    Args:
        value: Catalog JSON from the internal STAC service or database.

    Returns:
        JSON with every ``eolab:temporal-source`` entry omitted. The original
        value and all other metadata remain unchanged.
    """
    if isinstance(value, dict):
        return {
            key: copy_public_catalog_metadata(child)
            for key, child in value.items()
            if key != "eolab:temporal-source"
        }
    if isinstance(value, list):
        return [copy_public_catalog_metadata(child) for child in value]
    return value
