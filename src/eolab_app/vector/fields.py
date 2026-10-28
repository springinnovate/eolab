"""Bounded geometry-free OGR batch field reads for vector styling."""

from collections.abc import Callable, Mapping
from time import monotonic
from eolab_app.vector.filters import VectorFilter, VectorFilterCount, matches_filter
from dataclasses import dataclass
from math import isfinite
from threading import Event
from typing import Any

from eolab_app.vector_fields import VectorFieldMissingError, visit_vector_fields
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
class _FieldReadResult:
    """Values read from one vector field and whether every feature was visited.

    Attributes:
        values: Property values in source feature order.
        complete: Whether the source was exhausted before a read limit or cancellation.
    """

    values: tuple[Any, ...]
    complete: bool


class OgrVectorFieldReader:
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
        field_read = self._read_values(source, field, feature_limit, cancel_event)
        counts: dict[tuple[type[Any], Any], list[Any]] = {}
        null_count = 0
        unsupported_value_count = 0
        for value in field_read.values:
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
            scanned_feature_count=len(field_read.values),
            null_count=null_count,
            unsupported_value_count=unsupported_value_count,
            complete=field_read.complete,
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
        field_read = self._read_values(source, field, feature_limit, cancel_event)
        values: list[float] = []
        null_count = 0
        unsupported_value_count = 0
        for value in field_read.values:
            if value is None:
                null_count += 1
            elif type(value) in {int, float} and isfinite(value):
                values.append(float(value))
            else:
                unsupported_value_count += 1
        return VectorNumericRead(
            values=tuple(values),
            scanned_feature_count=len(field_read.values),
            null_count=null_count,
            unsupported_value_count=unsupported_value_count,
            complete=field_read.complete,
        )

    def _read_values(
        self,
        source: ResolvedVectorSource,
        field: str,
        feature_limit: int,
        cancel_event: Event,
    ) -> _FieldReadResult:
        """Read one vector field until completion, cancellation or the feature limit.

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
        values: list[Any] = []
        complete = self._visit_properties(
            source, (field,), feature_limit, cancel_event,
            lambda properties: values.append(properties.get(field)),
        )
        return _FieldReadResult(values=tuple(values), complete=complete)

    def count_filter(
        self, source: ResolvedVectorSource, candidate: VectorFilter,
        feature_limit: int, cancel_event: Event,
    ) -> VectorFilterCount:
        """Count an entire filtered view without retaining feature data.

        Args:
            source: Exact Catalog-derived mounted source.
            candidate: Validated scalar predicate.
            feature_limit: Maximum rows visited, plus one exhaustion probe.
            cancel_event: Cooperative cancellation checked per row.

        Returns:
            Exact matched/total counts only when the bounded read is complete.
        """
        total = matched = 0
        deadline = monotonic() + 20

        def visit(properties: Mapping[str, Any]) -> None:
            """Accumulate counts and enforce the time budget.

            Args:
                properties: Selected scalar properties from one row.

            Returns:
                None.
            """
            nonlocal total, matched
            total += 1
            matched += int(matches_filter(candidate, properties))
            if monotonic() >= deadline:
                cancel_event.set()

        complete = self._visit_properties(
            source, tuple(dict.fromkeys(rule.field for rule in candidate.rules)),
            feature_limit, cancel_event, visit,
        )
        return VectorFilterCount(matched=matched, total=total, complete=True) if complete else VectorFilterCount()

    def _visit_properties(
        self,
        source: ResolvedVectorSource,
        fields: tuple[str, ...],
        feature_limit: int,
        cancel_event: Event,
        visit: Callable[[Mapping[str, Any]], None],
    ) -> bool:
        """Visit scalar properties in bounded, geometry-free OGR batches.

        The callback sees at most feature_limit rows in native source order.
        One additional row determines exhaustion. Native reads may prefetch the
        rest of that row's batch, bounded by 4,096 rows; only one batch is held.
        Cancellation is checked before each native read and each callback.

        Args:
            source: Catalog-derived mounted file and exact native layer.
            fields: Unique authoritative non-geometry fields.
            feature_limit: Maximum visited rows.
            cancel_event: Cooperative cancellation signal.
            visit: Owner-provided scalar accumulator; must not retain geometry.

        Returns:
            Whether the source was exhausted without cancellation.

        Raises:
            ValueError: If the feature limit is not positive.
            VectorConflictError: If the source, layer, or fields cannot be read.
        """
        if (
            source.source_kind != "mounted"
            or source.source_path is None
            or source.source_format not in {"shapefile", "geopackage"}
        ):
            raise VectorConflictError(
                "Field summary unavailable: unsupported mounted layer."
            )
        if feature_limit < 1:
            raise ValueError("feature_limit must be positive")
        try:
            return visit_vector_fields(
                str(source.source_path), source.layer_name, fields,
                feature_limit, cancel_event, visit,
            )
        except VectorFieldMissingError as error:
            raise VectorConflictError(
                "Field summary unavailable: the selected field is "
                "not present in the current source layer."
            ) from error
        except (RuntimeError, OSError, ValueError) as error:
            raise VectorConflictError(
                "Field summary unavailable: the current vector source "
                "could not be read safely."
            ) from error



def _bounded_category_value(value: Any) -> VectorCategoryScalar | object:
    """Return one safe strict JSON scalar or the unsupported sentinel.

    Args:
        value: Normalized property value from the selected source field.

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
