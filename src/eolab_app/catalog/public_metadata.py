"""Keep server-only source locations out of public Catalog responses."""

from typing import TypeAlias

JsonValue: TypeAlias = (
    dict[str, "JsonValue"] | list["JsonValue"] | str | int | float | bool | None
)


def copy_public_catalog_metadata(value: JsonValue) -> JsonValue:
    """Copy Catalog JSON without private source locations or field inventories.

    Apply this at public response boundaries, including STAC field projections
    that may omit an Item's collection or other identifying fields. The reserved
    key ``eolab:temporal-source`` contains the descriptor's server-side location;
    ``eolab:vector-field-values`` holds complete server-only string inventories.

    Args:
        value: Catalog JSON from the internal STAC service or database.

    Returns:
        JSON with every private source/inventory entry omitted. The original
        value and all other metadata remain unchanged.
    """
    if isinstance(value, dict):
        return {
            key: copy_public_catalog_metadata(child)
            for key, child in value.items()
            if key not in {"eolab:temporal-source", "eolab:vector-field-values"}
        }
    if isinstance(value, list):
        return [copy_public_catalog_metadata(child) for child in value]
    return value
