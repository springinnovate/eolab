"""Read and count vector attributes for styling without loading geometry."""

from collections.abc import Callable, Mapping
from contextlib import closing
from dataclasses import dataclass
from math import isfinite
from pathlib import Path
import sqlite3
from threading import Event
from time import monotonic
from typing import Any

from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.filters import (
    VectorFilter,
    VectorFilterCount,
    VectorFilterRule,
    matches_filter,
)
from eolab_app.vector.models import (
    ResolvedVectorSource,
    VECTOR_CATEGORY_TEXT_LIMIT,
    VectorCategoryRead,
    VectorCategoryScalar,
    VectorNumericRead,
)
from eolab_app.vector_fields import VectorFieldMissingError, visit_vector_fields

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
    """Read bounded scalar properties and count matches in mounted vector layers."""

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
        self,
        source: ResolvedVectorSource,
        candidate: VectorFilter,
        feature_limit: int,
        cancel_event: Event,
    ) -> VectorFilterCount:
        """Count matching and total features in the original vector layer.

        A single equality test on a GeoPackage text column can aggregate inside
        SQLite. Other predicates use the bounded OGR attribute scan. Both
        approaches share the same 20-second deadline.

        Args:
            source: Authorized original mounted source.
            candidate: Schema-validated scalar predicate.
            feature_limit: Maximum rows visited by the OGR scan, plus one
                exhaustion probe.
            cancel_event: Signal to stop the scan or interrupt the SQLite query.

        Returns:
            Exact matching and total counts, or an incomplete result if
            cancelled or out of time or row budget.

        Raises:
            VectorConflictError: If a spatial condition requires a separate
                reader, or if the original source or field cannot be read.
            ValueError: If the row budget is not positive.
        """
        if candidate.intersections:
            raise VectorConflictError(
                "Use the layer intersection filter to count these features."
            )
        deadline = monotonic() + 20
        rule = candidate.rules[0] if len(candidate.rules) == 1 else None
        if (
            feature_limit > 0
            and candidate.enabled
            and isinstance(rule, VectorFilterRule)
            and rule.operator == "eq"
            and isinstance(rule.value, str)
            and source.source_kind == "mounted"
            and source.source_format == "geopackage"
            and source.source_path is not None
            and source.layer_name is not None
            and all(
                field.definition.name != rule.field
                for field in source.calculated_fields
            )
        ):
            result = _count_geopackage_text_matches(
                source.source_path,
                source.layer_name,
                rule.field,
                rule.value,
                cancel_event,
                deadline,
            )
            if result is not None:
                return result

        total = matched = 0

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
            source, candidate.fields, feature_limit, cancel_event, visit
        )
        if complete:
            return VectorFilterCount(matched=matched, total=total, complete=True)
        return VectorFilterCount()

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
                str(source.source_path),
                source.layer_name,
                fields,
                feature_limit,
                cancel_event,
                visit,
                calculated_fields=source.calculated_fields,
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


def _count_geopackage_text_matches(
    path: Path,
    layer_name: str,
    field_name: str,
    value: str,
    cancel_event: Event,
    deadline: float,
) -> VectorFilterCount | None:
    """Count one original text column's exact matches with a read-only query.

    Args:
        path: Authorized original GeoPackage file.
        layer_name: Exact layer name from the source descriptor.
        field_name: Attribute name accepted by filter validation.
        value: Case-sensitive text value to match.
        cancel_event: Signal to interrupt SQLite while it scans.
        deadline: Monotonic time at which the query must stop.

    Returns:
        Exact counts, an incomplete result on cancellation or deadline expiry,
        or None when the layer or column needs the OGR scan.

    Raises:
        VectorConflictError: If SQLite cannot read the GeoPackage.
    """

    def should_stop_query() -> bool:
        """Interrupt the database query when its caller cancels or time expires.

        Returns:
            Whether SQLite should interrupt the current statement.
        """
        return cancel_event.is_set() or monotonic() >= deadline

    if should_stop_query():
        return VectorFilterCount()

    try:
        with closing(
            sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True, timeout=0)
        ) as database:
            database.set_progress_handler(should_stop_query, 4096)
            column = database.execute(
                "SELECT columns.type FROM pragma_table_list(?) AS tables "
                "JOIN pragma_table_info(tables.name, 'main') AS columns "
                "WHERE tables.schema = 'main' AND tables.type = 'table' "
                "AND columns.name = ?",
                (layer_name, field_name),
            ).fetchone()
            if column is None or column[0].partition("(")[0].strip().upper() != "TEXT":
                return None

            table_identifier = '"' + layer_name.replace('"', '""') + '"'
            column_identifier = '"' + field_name.replace('"', '""') + '"'
            # OGR converts string columns to text ending at the first NUL.
            total, matched = database.execute(
                "SELECT COUNT(*), COUNT(*) FILTER (WHERE "
                f"substr(CAST(original.{column_identifier} AS TEXT), 1) "
                "COLLATE BINARY = ?) "
                f"FROM main.{table_identifier} AS original",
                (value,),
            ).fetchone()
    except (sqlite3.Error, OSError, ValueError) as error:
        if getattr(error, "sqlite_errorcode", None) == sqlite3.SQLITE_INTERRUPT:
            return VectorFilterCount()
        raise VectorConflictError(
            "Field summary unavailable: the current vector source could not be read safely."
        ) from error

    if should_stop_query():
        return VectorFilterCount()
    return VectorFilterCount(matched=matched, total=total, complete=True)


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
