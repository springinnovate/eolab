"""Bounded Fiona attribute reads for categorical vector styling."""

from collections.abc import Mapping
from math import isfinite
from threading import Event
from typing import Any

import fiona
from fiona.errors import FionaError

from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.models import (
    ResolvedVectorSource,
    VECTOR_CATEGORY_TEXT_LIMIT,
    VectorCategoryRead,
    VectorCategoryScalar,
)


_UNSUPPORTED = object()


class FionaVectorCategoryReader:
    """Read only bounded scalar properties from exact mounted vector layers."""

    def read(
        self,
        source: ResolvedVectorSource,
        field: str,
        feature_limit: int,
        cancel_event: Event,
    ) -> VectorCategoryRead:
        """Count safe typed values without loading geometry or extra fields.

        Args:
            source: Catalog-derived exact mounted source and native layer.
            field: Authoritative attribute field identity.
            feature_limit: Maximum features whose values may be counted.
            cancel_event: Cooperative cancellation signal checked per feature.

        Returns:
            Deterministically ordered bounded counts and completion metadata.

        Raises:
            VectorConflictError: If the source format, layer, or field cannot
                satisfy the category-summary contract.
        """
        if (
            source.source_kind != "mounted"
            or source.source_path is None
            or source.source_format not in {"shapefile", "geopackage"}
        ):
            raise VectorConflictError(
                "Category summary unavailable: this vector source is not a "
                "supported mounted layer."
            )
        if feature_limit < 1:
            raise ValueError("feature_limit must be positive")

        open_options: dict[str, Any] = {
            "include_fields": [field],
            "ignore_geometry": True,
        }
        if source.layer_name is not None:
            open_options["layer"] = source.layer_name
        try:
            with fiona.open(source.source_path, **open_options) as collection:
                properties = collection.schema.get("properties", {})
                if field not in properties:
                    raise VectorConflictError(
                        "Category summary unavailable: the selected field is "
                        "not present in the current source layer."
                    )
                return self._read_collection(
                    collection,
                    field,
                    feature_limit,
                    cancel_event,
                )
        except VectorConflictError:
            raise
        except (FionaError, OSError, ValueError) as error:
            raise VectorConflictError(
                "Category summary unavailable: the current vector source "
                "could not be read safely."
            ) from error

    def _read_collection(
        self,
        collection: Any,
        field: str,
        feature_limit: int,
        cancel_event: Event,
    ) -> VectorCategoryRead:
        """Count one already-open collection with cooperative cancellation.

        Args:
            collection: Open Fiona collection restricted to the selected field.
            field: Exact property name in the collection schema.
            feature_limit: Maximum features included in counts.
            cancel_event: Cooperative cancellation signal.

        Returns:
            Typed observed counts with source-exhaustion state.
        """
        counts: dict[tuple[type[Any], Any], list[Any]] = {}
        scanned_feature_count = 0
        null_count = 0
        unsupported_value_count = 0
        iterator = iter(collection)
        exhausted = False
        while scanned_feature_count < feature_limit and not cancel_event.is_set():
            try:
                feature = next(iterator)
            except StopIteration:
                exhausted = True
                break
            scanned_feature_count += 1
            properties = feature.get("properties")
            value = properties.get(field) if isinstance(properties, Mapping) else None
            if value is None:
                null_count += 1
                continue
            bounded_value = _bounded_category_value(value)
            if bounded_value is _UNSUPPORTED:
                unsupported_value_count += 1
                continue
            identity = (type(bounded_value), bounded_value)
            entry = counts.get(identity)
            if entry is None:
                counts[identity] = [bounded_value, 1]
            else:
                entry[1] += 1

        if (
            not exhausted
            and not cancel_event.is_set()
            and scanned_feature_count == feature_limit
        ):
            try:
                next(iterator)
            except StopIteration:
                exhausted = True
        ordered_counts = sorted(
            ((entry[0], entry[1]) for entry in counts.values()),
            key=lambda entry: (-entry[1], _category_sort_key(entry[0])),
        )
        return VectorCategoryRead(
            counts=tuple(ordered_counts),
            scanned_feature_count=scanned_feature_count,
            null_count=null_count,
            unsupported_value_count=unsupported_value_count,
            complete=exhausted and not cancel_event.is_set(),
        )


def _bounded_category_value(value: Any) -> VectorCategoryScalar | object:
    """Return one safe strict JSON scalar or the unsupported sentinel.

    Args:
        value: Fiona property value from the selected source field.

    Returns:
        A bounded bool, int, float, or string; otherwise ``_UNSUPPORTED``.
    """
    if type(value) is bool:
        return value
    if type(value) is int:
        return value
    if type(value) is float:
        return value if isfinite(value) else _UNSUPPORTED
    if type(value) is str:
        if len(value) > VECTOR_CATEGORY_TEXT_LIMIT:
            return _UNSUPPORTED
        if any(
            ord(character) < 32 and character not in "\t\n\r"
            for character in value
        ):
            return _UNSUPPORTED
        return value
    return _UNSUPPORTED


def _category_sort_key(value: VectorCategoryScalar) -> tuple[int, str]:
    """Build a deterministic type-aware tie-break key for one category.

    Args:
        value: Validated scalar category value.

    Returns:
        Type rank and stable textual representation.
    """
    type_rank = {bool: 0, int: 1, float: 2, str: 3}[type(value)]
    if type(value) is bool:
        serialized = "1" if value else "0"
    elif type(value) is float:
        serialized = format(value, ".17g")
    else:
        serialized = str(value)
    return type_rank, serialized
