"""Prepare private string-value inventories and describe their paged lookup."""

from collections.abc import Mapping
from threading import Event
from typing import Any, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

from eolab_app.vector_fields import visit_vector_fields

VECTOR_FIELD_VALUES_KEY = "eolab:vector-field-values"
FieldValueInventory: TypeAlias = dict[str, list[tuple[str, str]]]
INVENTORY_ADAPTER = TypeAdapter(FieldValueInventory)


class VectorFieldValueQuery(BaseModel):
    """Choose a string field and a page of case-insensitive substring suggestions.

    Search uses Unicode casefold without trimming or changing stored strings.
    Offset counts matching distinct values, ordered by exact Unicode code points.
    Empty search includes every value; nulls are excluded, empty strings retained.
    Pages default to 50 values and permit at most 100. Offset and continuation
    fit signed 64-bit database offsets and native iterator positions.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    field: str = Field(min_length=1, max_length=256)
    search: str = Field(default="", max_length=256)
    offset: int = Field(default=0, ge=0, le=(1 << 63) - 101)
    limit: int = Field(default=50, ge=1, le=100)


class VectorFieldValuePage(BaseModel):
    """Return exact stored strings and the next matching-value offset, if any.

    Attributes:
        field: Requested source field name.
        values: Original distinct strings in deterministic Unicode order.
        next_offset: Next matching position, or None when this search is exhausted.
    """

    model_config = ConfigDict(populate_by_name=True)

    field: str
    values: tuple[str, ...]
    next_offset: int | None = Field(alias="nextOffset")


class CatalogVectorFieldValueQuery(VectorFieldValueQuery):
    """Identify a Catalog Item and request its prepared string suggestions."""

    collection_id: str = Field(alias="collectionId", min_length=1, max_length=256)
    item_id: str = Field(alias="itemId", min_length=1, max_length=1024)


class VectorFieldValuesUnavailable(ValueError):
    """A source or string field has no prepared inventory."""


def string_field_names(fields: Mapping[str, str]) -> tuple[str, ...]:
    """Select string fields from Fiona or Catalog JSON-union schema types.

    Args:
        fields: Authoritative field names and type descriptions.

    Returns:
        String fields in schema order, including nullable strings. Mixed
        numeric/string, date, boolean and other non-string fields are excluded.
    """
    return tuple(
        name
        for name, kind in fields.items()
        if kind.split(":", 1)[0].lower() in {"str", "string"}
        or {part.strip() for part in kind.lower().split("|")} == {"string", "null"}
    )


def read_field_value_inventory(
    source_path: str,
    layer_name: str | None,
    fields: Mapping[str, str],
    *,
    open_options: tuple[str, ...] = (),
) -> FieldValueInventory:
    """Read every distinct string once during source admission.

    Args:
        source_path: Authorized native dataset or validated archive-member path.
        layer_name: Exact native layer name, or None for the first layer.
        fields: Admitted source schema; only string fields are read.
        open_options: Format-owned GDAL options preserving literal text values.

    Returns:
        Private per-field arrays of exact value and Unicode-casefold search text,
        sorted by the exact value's Unicode code points. No null entries.

    Raises:
        ValueError: If a selected field is absent or contains a non-string value.
        RuntimeError: If the native source cannot be read completely.
        OSError: If source access fails.
    """
    names = string_field_names(fields)
    values: dict[str, set[str]] = {name: set() for name in names}
    if not names:
        return {}

    def collect(properties: Mapping[str, Any]) -> None:
        """Retain exact non-null strings from one geometry-free row.

        Args:
            properties: Native scalar values for the admitted string fields.

        Raises:
            ValueError: If a string field contains another scalar type.
        """
        for name, value in properties.items():
            if value is not None:
                if not isinstance(value, str):
                    raise ValueError(
                        f"String field {name!r} contains a non-string value"
                    )
                values[name].add(value)

    visit_vector_fields(
        source_path,
        layer_name,
        names,
        None,
        Event(),
        collect,
        open_options=open_options,
    )
    return {
        name: [(value, value.casefold()) for value in sorted(distinct)]
        for name, distinct in values.items()
    }


def page_field_values(
    inventory: FieldValueInventory, query: VectorFieldValueQuery
) -> VectorFieldValuePage:
    """Search prepared metadata without reading source features.

    Args:
        inventory: Validated private admission metadata.
        query: Requested field, case-insensitive search and page bounds.

    Returns:
        Exact strings from one page and a continuation offset when more exist.

    Raises:
        VectorFieldValuesUnavailable: If the field has no prepared string values.
    """
    if query.field not in inventory:
        raise VectorFieldValuesUnavailable(
            "Choose a string field with prepared values."
        )
    search = query.search.casefold()
    matches = (value for value, folded in inventory[query.field] if search in folded)
    from itertools import islice

    page = tuple(islice(matches, query.offset, query.offset + query.limit + 1))
    return VectorFieldValuePage(
        field=query.field,
        values=page[: query.limit],
        nextOffset=query.offset + query.limit if len(page) > query.limit else None,
    )
