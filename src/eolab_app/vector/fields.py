"""Bounded geometry-free Fiona field reads for vector styling."""

from collections.abc import Mapping
from dataclasses import dataclass
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
    VectorNumericRead,
)


_UNSUPPORTED = object()


@dataclass(frozen=True)
class _BoundedFieldValues:
    """Raw values and completion state from one neutral bounded field read."""

    values: tuple[Any, ...]
    complete: bool


class FionaVectorFieldReader:
    """Read bounded scalar properties from exact mounted vector layers."""

    def read_categories(
        self,
        source: ResolvedVectorSource,
        field: str,
        feature_limit: int,
        cancel_event: Event,
    ) -> VectorCategoryRead:
        """Count safe typed category values without reading geometry.

        Args:
            source: Catalog-derived exact mounted source and native layer.
            field: Authoritative attribute field identity.
            feature_limit: Maximum features whose values may be counted.
            cancel_event: Cooperative cancellation signal checked per feature.

        Returns:
            Deterministically ordered bounded counts and completion metadata.

        Raises:
            VectorConflictError: If the source format, layer, or field cannot
                satisfy the field-summary contract.
        """
        bounded = self._read_values(source, field, feature_limit, cancel_event)
        counts: dict[tuple[type[Any], Any], list[Any]] = {}
        null_count = 0
        unsupported_value_count = 0
        for value in bounded.values:
            if value is None:
                null_count += 1
                continue
            category_value = _bounded_category_value(value)
            if category_value is _UNSUPPORTED:
                unsupported_value_count += 1
                continue
            identity = (type(category_value), category_value)
            entry = counts.get(identity)
            if entry is None:
                counts[identity] = [category_value, 1]
            else:
                entry[1] += 1
        ordered_counts = sorted(
            ((entry[0], entry[1]) for entry in counts.values()),
            key=lambda entry: (-entry[1], _category_sort_key(entry[0])),
        )
        return VectorCategoryRead(
            counts=tuple(ordered_counts),
            scanned_feature_count=len(bounded.values),
            null_count=null_count,
            unsupported_value_count=unsupported_value_count,
            complete=bounded.complete,
        )

    def read_numbers(
        self,
        source: ResolvedVectorSource,
        field: str,
        feature_limit: int,
        cancel_event: Event,
    ) -> VectorNumericRead:
        """Collect finite numeric values without reading geometry.

        Args:
            source: Catalog-derived exact mounted source and native layer.
            field: Authoritative numeric attribute field identity.
            feature_limit: Maximum features whose values may be inspected.
            cancel_event: Cooperative cancellation signal checked per feature.

        Returns:
            Bounded finite values, missing/unsupported counts, and completion.

        Raises:
            VectorConflictError: If the source format, layer, or field cannot
                satisfy the field-summary contract.
        """
        bounded = self._read_values(source, field, feature_limit, cancel_event)
        values: list[float] = []
        null_count = 0
        unsupported_value_count = 0
        for value in bounded.values:
            if value is None:
                null_count += 1
            elif type(value) in {int, float} and isfinite(value):
                values.append(float(value))
            else:
                unsupported_value_count += 1
        return VectorNumericRead(
            values=tuple(values),
            scanned_feature_count=len(bounded.values),
            null_count=null_count,
            unsupported_value_count=unsupported_value_count,
            complete=bounded.complete,
        )

    def _read_values(
        self,
        source: ResolvedVectorSource,
        field: str,
        feature_limit: int,
        cancel_event: Event,
    ) -> _BoundedFieldValues:
        """Read one exact property through the shared bounded mechanism.

        Args:
            source: Catalog-derived exact mounted source and native layer.
            field: Authoritative attribute field identity.
            feature_limit: Maximum features whose values may be inspected.
            cancel_event: Cooperative cancellation signal checked per feature.

        Returns:
            Raw bounded property values and source-exhaustion state.

        Raises:
            ValueError: If ``feature_limit`` is not positive.
            VectorConflictError: If the source or selected field cannot be read.
        """
        if (
            source.source_kind != "mounted"
            or source.source_path is None
            or source.source_format not in {"shapefile", "geopackage"}
        ):
            raise VectorConflictError(
                "Field summary unavailable: this vector source is not a "
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
                        "Field summary unavailable: the selected field is not "
                        "present in the current source layer."
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
                "Field summary unavailable: the current vector source could "
                "not be read safely."
            ) from error

    def _read_collection(
        self,
        collection: Any,
        field: str,
        feature_limit: int,
        cancel_event: Event,
    ) -> _BoundedFieldValues:
        """Read one already-open collection with cooperative cancellation.

        Args:
            collection: Open Fiona collection restricted to the selected field.
            field: Exact property name in the collection schema.
            feature_limit: Maximum features included in the result.
            cancel_event: Cooperative cancellation signal.

        Returns:
            Raw selected-property values with source-exhaustion state.
        """
        values: list[Any] = []
        iterator = iter(collection)
        exhausted = False
        while len(values) < feature_limit and not cancel_event.is_set():
            try:
                feature = next(iterator)
            except StopIteration:
                exhausted = True
                break
            properties = feature.get("properties")
            values.append(
                properties.get(field) if isinstance(properties, Mapping) else None
            )
        if (
            not exhausted
            and not cancel_event.is_set()
            and len(values) == feature_limit
        ):
            try:
                next(iterator)
            except StopIteration:
                exhausted = True
        return _BoundedFieldValues(
            values=tuple(values),
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
