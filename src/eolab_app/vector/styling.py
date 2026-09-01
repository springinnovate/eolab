"""Application workflow for authoritative vector styling and field classes."""

import asyncio
from bisect import bisect_right
from collections.abc import Callable
from math import ceil
from threading import Event
from typing import Any, TypeVar

from eolab_app.rendering.errors import (
    PublishedLayerChangedError,
    PublishedLayerNotAuthorizedError,
)
from eolab_app.rendering.geoserver import GEOSERVER_WORKSPACE_NAME
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.models import (
    AppliedVectorStyle,
    CatalogVectorCategoryRequest,
    CatalogVectorNumericClassificationRequest,
    CatalogVectorStyleRequest,
    VECTOR_CATEGORY_DEFAULT_LIMIT,
    VECTOR_CATEGORY_MAXIMUM_LIMIT,
    VECTOR_FIELD_FEATURE_LIMIT,
    VECTOR_NUMERIC_DEFAULT_CLASS_COUNT,
    VECTOR_NUMERIC_MAXIMUM_CLASS_COUNT,
    VECTOR_NUMERIC_MINIMUM_CLASS_COUNT,
    VECTOR_READER_CONTRACT,
    VECTOR_RENDERING_METADATA_KEY,
    VECTOR_RENDERING_POLICY,
    ResolvedVectorSource,
    VectorCategoryRead,
    VectorCategorySummary,
    VectorCategoryValue,
    VectorCategoryValueCount,
    VectorClassificationMethod,
    VectorNumericClass,
    VectorNumericClassificationSummary,
    VectorNumericRead,
)
from eolab_app.vector.ports import (
    VectorCatalog,
    VectorFieldReader,
    VectorStyler,
)
from eolab_app.vector.sources import (
    MountedVectorResolver,
    PublishedVectorRegistry,
    vector_source_signature,
)


_FieldRead = TypeVar("_FieldRead")


class VectorStyleService:
    """Apply styles only to current, published, authoritative vector Items."""

    def __init__(
        self,
        catalog: VectorCatalog,
        source_resolver: MountedVectorResolver,
        styler: VectorStyler,
        vector_registry: PublishedVectorRegistry,
        field_reader: VectorFieldReader,
    ) -> None:
        """Create authoritative vector styling and field-class use cases.

        Args:
            catalog: Authoritative vector catalog port.
            source_resolver: Exact mounted source and layer resolver.
            styler: GeoServer vector style adapter.
            vector_registry: Current public-WMS authorization registry.
            field_reader: Bounded mounted-source attribute reader.
        """
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._styler = styler
        self._vector_registry = vector_registry
        self._field_reader = field_reader
        self._style_lock = asyncio.Lock()
        self._field_slots = asyncio.Semaphore(2)

    async def summarize_categories(
        self,
        request: CatalogVectorCategoryRequest,
    ) -> VectorCategorySummary:
        """Summarize one current Catalog field without requiring GeoServer.

        Args:
            request: Catalog identity and authoritative attribute field.

        Returns:
            At most fifty typed values ranked by observed feature count, with
            explicit scan completeness and server-advertised UI limits.

        Raises:
            VectorFeatureError: If the Catalog Item, exact source, field, or
                bounded reader cannot safely satisfy the request.
            VectorConflictError: If assessment metadata or source identity is
                stale, or if the field type is not categorically styleable.
        """
        item = await self._catalog.get_item(request)
        source = self._source_resolver.resolve(item)
        fields = _catalog_vector_fields(item)
        field_type = fields.get(request.field)
        if field_type is None:
            raise VectorConflictError(
                "Category summary unavailable: the selected field is not a "
                "current attribute of the authoritative vector Item."
            )
        category_kind = _categorical_field_kind(field_type)
        if category_kind is None:
            raise VectorConflictError(
                "Category summary unavailable: choose a text, integer, "
                "number, or boolean field."
            )
        category_read, feature_count = await self._read_current_field(
            item,
            source,
            request.field,
            self._field_reader.read_categories,
            "Category summary",
        )
        if not isinstance(category_read, VectorCategoryRead):
            raise TypeError("Category field reader violated its result contract")
        if any(
            _category_value_kind(value) != category_kind
            for value, _count in category_read.counts
        ):
            raise VectorConflictError(
                "Category summary unavailable: the current source values do "
                "not match the Catalog field type; reassess the vector Item."
            )

        values = tuple(
            VectorCategoryValueCount(
                value=VectorCategoryValue(
                    kind=_category_value_kind(value),
                    value=value,
                ),
                count=count,
            )
            for value, count in category_read.counts[
                :VECTOR_CATEGORY_MAXIMUM_LIMIT
            ]
        )
        observed_distinct_count = len(category_read.counts)
        return VectorCategorySummary(
            field=request.field,
            fieldType=field_type,
            values=values,
            observedDistinctCount=observed_distinct_count,
            distinctCount=(
                observed_distinct_count if category_read.complete else None
            ),
            scannedFeatureCount=category_read.scanned_feature_count,
            featureCount=feature_count,
            nullCount=category_read.null_count,
            unsupportedValueCount=category_read.unsupported_value_count,
            complete=category_read.complete,
            defaultLimit=VECTOR_CATEGORY_DEFAULT_LIMIT,
            maximumLimit=VECTOR_CATEGORY_MAXIMUM_LIMIT,
        )

    async def classify_numeric(
        self,
        request: CatalogVectorNumericClassificationRequest,
    ) -> VectorNumericClassificationSummary:
        """Classify one current numeric Catalog field without GeoServer.

        Args:
            request: Catalog identity, numeric field, method, and class count.

        Returns:
            Server-computed open-ended ranges, counts, extent, completeness,
            and advertised class-count limits.

        Raises:
            VectorFeatureError: If the Catalog Item, source, or bounded reader
                cannot safely satisfy the request.
            VectorConflictError: If the field is non-numeric, metadata is
                stale, or no finite numeric values are available.
        """
        item = await self._catalog.get_item(request)
        source = self._source_resolver.resolve(item)
        return await self._classify_current_numeric(
            item,
            source,
            request.field,
            request.method,
            request.class_count,
        )

    async def _classify_current_numeric(
        self,
        item: dict[str, Any],
        source: ResolvedVectorSource,
        field: str,
        method: VectorClassificationMethod,
        class_count: int,
    ) -> VectorNumericClassificationSummary:
        """Build one authoritative classification from a resolved source.

        Args:
            item: Authoritative Catalog Item.
            source: Exact source identity resolved from ``item``.
            field: Current numeric Catalog field.
            method: Equal-interval or quantile classification.
            class_count: Requested number of classes.

        Returns:
            Validated numeric classification summary.

        Raises:
            VectorConflictError: If the field, source, or finite values cannot
                satisfy the graduated-style contract.
        """
        field_type = _catalog_vector_fields(item).get(field)
        if field_type is None or not _numeric_field_type(field_type):
            raise VectorConflictError(
                "Numeric classification unavailable: choose a current integer "
                "or floating-point Catalog field."
            )
        numeric_read, feature_count = await self._read_current_field(
            item,
            source,
            field,
            self._field_reader.read_numbers,
            "Numeric classification",
        )
        if not isinstance(numeric_read, VectorNumericRead):
            raise TypeError("Numeric field reader violated its result contract")
        if not numeric_read.values:
            raise VectorConflictError(
                "Numeric classification unavailable: this field has no finite "
                "numeric values in the bounded read."
            )
        classes = _classify_numeric_values(
            numeric_read.values,
            method,
            class_count,
        )
        return VectorNumericClassificationSummary(
            field=field,
            fieldType=field_type,
            method=method,
            requestedClassCount=class_count,
            actualClassCount=len(classes),
            classes=classes,
            observedMinimum=min(numeric_read.values),
            observedMaximum=max(numeric_read.values),
            numericValueCount=len(numeric_read.values),
            scannedFeatureCount=numeric_read.scanned_feature_count,
            featureCount=feature_count,
            nullCount=numeric_read.null_count,
            unsupportedValueCount=numeric_read.unsupported_value_count,
            complete=numeric_read.complete,
            defaultClassCount=VECTOR_NUMERIC_DEFAULT_CLASS_COUNT,
            minimumClassCount=VECTOR_NUMERIC_MINIMUM_CLASS_COUNT,
            maximumClassCount=VECTOR_NUMERIC_MAXIMUM_CLASS_COUNT,
        )

    async def _read_current_field(
        self,
        item: dict[str, Any],
        source: ResolvedVectorSource,
        field: str,
        read: Callable[
            [ResolvedVectorSource, str, int, Event],
            _FieldRead,
        ],
        operation: str,
    ) -> tuple[_FieldRead, int]:
        """Execute one capped field read with current-source verification.

        Args:
            item: Authoritative Catalog Item.
            source: Exact source identity resolved from ``item``.
            field: Current authoritative field identity.
            read: Focused field-reader operation.
            operation: User-facing operation name for safe errors.

        Returns:
            Field-reader result and authoritative Catalog feature count.

        Raises:
            VectorConflictError: If assessment metadata or source identity is
                stale, changes during the read, or disagrees with row count.
        """
        feature_count = _catalog_vector_feature_count(item, operation)
        try:
            source_signature = await asyncio.to_thread(
                vector_source_signature,
                source,
            )
        except (OSError, ValueError) as error:
            raise VectorConflictError(
                f"{operation} unavailable: reassess the current vector Item."
            ) from error
        _require_assessed_metadata(item, source_signature, operation)
        cancel_event = Event()
        try:
            async with self._field_slots:
                result = await asyncio.to_thread(
                    read,
                    source,
                    field,
                    VECTOR_FIELD_FEATURE_LIMIT,
                    cancel_event,
                )
        except asyncio.CancelledError:
            cancel_event.set()
            raise
        try:
            final_signature = await asyncio.to_thread(
                vector_source_signature,
                source,
            )
        except (OSError, ValueError) as error:
            raise VectorConflictError(
                f"{operation} unavailable: the vector source changed during "
                "the bounded read."
            ) from error
        if final_signature != source_signature:
            raise VectorConflictError(
                f"{operation} unavailable: the vector source changed during "
                "the bounded read."
            )
        complete = getattr(result, "complete", None)
        scanned_feature_count = getattr(result, "scanned_feature_count", None)
        if complete is True and scanned_feature_count != feature_count:
            raise VectorConflictError(
                f"{operation} unavailable: reassess the vector Item because "
                "its feature count has changed."
            )
        return result, feature_count

    async def apply(
        self,
        request: CatalogVectorStyleRequest,
    ) -> AppliedVectorStyle:
        """Validate ownership and apply one per-layer vector style.

        Args:
            request: Catalog identity and complete validated symbol state.

        Returns:
            Applied style name and normalized style state.

        Raises:
            VectorFeatureError: If catalog, source, authorization, or GeoServer
                boundaries cannot safely complete the operation.
            VectorConflictError: If the layer is unpublished, changed, or the
                requested geometry disagrees with authoritative assessment.
        """
        async with self._style_lock:
            item = await self._catalog.get_item(request)
            source = self._source_resolver.resolve(item)
            layer_name = f"{GEOSERVER_WORKSPACE_NAME}:{request.item_id}"
            try:
                authorization = await asyncio.to_thread(
                    self._vector_registry.require_current,
                    layer_name,
                )
            except (
                PublishedLayerChangedError,
                PublishedLayerNotAuthorizedError,
            ) as error:
                raise VectorConflictError(
                    "Style unavailable: add the current vector Item to the map "
                    "before styling it."
                ) from error
            if source != authorization.source:
                raise VectorConflictError(
                    "Style unavailable: the authoritative vector source no "
                    "longer matches the published layer."
                )
            metadata = item.get("properties", {}).get(
                VECTOR_RENDERING_METADATA_KEY
            )
            if (
                not isinstance(metadata, dict)
                or metadata.get("policy") != VECTOR_RENDERING_POLICY
                or metadata.get("eligible") is not True
                or metadata.get("reader_contract") != VECTOR_READER_CONTRACT
                or metadata.get("reader_compatible") is not True
                or metadata.get("source_signature") != [
                    list(entry) for entry in authorization.source_signature
                ]
            ):
                raise VectorConflictError(
                    "Style unavailable: reassess and add the current vector "
                    "Item to the map before styling it."
                )
            geometry_kind = metadata.get("geometry_kind")
            if geometry_kind != request.style.geometry_kind:
                raise VectorConflictError(
                    "Style unavailable: the requested symbol geometry does not "
                    "match the assessed vector layer."
                )
            fields = _catalog_vector_fields(item)
            if (
                request.style.label is not None
                and request.style.label.field not in fields
            ):
                raise VectorConflictError(
                    "Style unavailable: the selected label field is not a "
                    "current attribute of the authoritative vector Item."
                )
            if request.style.categorical is not None:
                categorical = request.style.categorical
                field_type = fields.get(categorical.field)
                category_kind = (
                    _categorical_field_kind(field_type)
                    if field_type is not None else None
                )
                if category_kind is None:
                    raise VectorConflictError(
                        "Style unavailable: the selected category field is "
                        "not a current scalar attribute of the authoritative "
                        "vector Item."
                    )
                if any(
                    rule.value.kind != category_kind
                    for rule in categorical.rules
                ):
                    raise VectorConflictError(
                        "Style unavailable: a category value type does not "
                        "match the current Catalog field type."
                    )
            if request.style.graduated is not None:
                graduated = request.style.graduated
                field_type = fields.get(graduated.field)
                if field_type is None or not _numeric_field_type(field_type):
                    raise VectorConflictError(
                        "Style unavailable: the selected graduated field is "
                        "not a current numeric attribute of the authoritative "
                        "vector Item."
                    )
                classification = await self._classify_current_numeric(
                    item,
                    source,
                    graduated.field,
                    graduated.method,
                    graduated.class_count,
                )
                expected_ranges = [
                    (numeric_class.minimum, numeric_class.maximum)
                    for numeric_class in classification.classes
                ]
                requested_ranges = [
                    (rule.minimum, rule.maximum)
                    for rule in graduated.rules
                ]
                if requested_ranges != expected_ranges:
                    raise VectorConflictError(
                        "Style unavailable: numeric class ranges no longer "
                        "match the authoritative bounded classification."
                    )
                if (
                    graduated.missing_color is not None
                    and classification.null_count == 0
                ):
                    raise VectorConflictError(
                        "Style unavailable: this numeric field has no missing "
                        "values to style."
                    )
            style_name = await self._styler.apply_style(
                request.item_id,
                request.style,
            )
            try:
                await asyncio.to_thread(
                    self._vector_registry.authorize,
                    layer_name,
                    source,
                    authorization.source_signature,
                    style_name,
                )
            except PublishedLayerChangedError as error:
                raise VectorConflictError(str(error)) from error
            return AppliedVectorStyle(
                styleName=style_name,
                style=request.style,
            )


def _catalog_vector_fields(item: dict[str, Any]) -> dict[str, str]:
    """Return authoritative non-geometry Catalog fields and declared types.

    Args:
        item: Authoritative Catalog Item loaded by the style service.

    Returns:
        Exact bounded attribute field identities and type descriptions declared
        by the STAC Table Extension, excluding its primary geometry column.
    """
    properties = item.get("properties")
    if not isinstance(properties, dict):
        return {}
    columns = properties.get("table:columns")
    primary_geometry = properties.get("table:primary_geometry")
    if not isinstance(columns, list):
        return {}
    return {
        name: field_type
        for column in columns
        if isinstance(column, dict)
        and isinstance((name := column.get("name")), str)
        and 0 < len(name) <= 256
        and name != primary_geometry
        and isinstance((field_type := column.get("type")), str)
        and 0 < len(field_type) <= 128
    }


def _catalog_vector_feature_count(
    item: dict[str, Any],
    operation: str,
) -> int:
    """Return the authoritative non-negative STAC Table row count.

    Args:
        item: Authoritative Catalog Item loaded by the style service.
        operation: User-facing operation name for a safe error.

    Returns:
        Declared feature count.

    Raises:
        VectorConflictError: If current Table metadata has no valid row count.
    """
    value = item.get("properties", {}).get("table:row_count")
    if type(value) is not int or value < 0:
        raise VectorConflictError(
            f"{operation} unavailable: reassess the vector Item because its "
            "feature count is missing."
        )
    return value


def _require_assessed_metadata(
    item: dict[str, Any],
    source_signature: tuple[tuple[str, int, int, int, int, int], ...],
    operation: str,
) -> dict[str, Any]:
    """Require current eligible assessment metadata for a source signature.

    Args:
        item: Authoritative Catalog Item.
        source_signature: Current complete mounted-source signature.
        operation: User-facing operation name for a safe error.

    Returns:
        Current rendering metadata.

    Raises:
        VectorConflictError: If the Item was not successfully assessed against
            the current source and deployed reader contract.
    """
    metadata = item.get("properties", {}).get(VECTOR_RENDERING_METADATA_KEY)
    if (
        not isinstance(metadata, dict)
        or metadata.get("policy") != VECTOR_RENDERING_POLICY
        or metadata.get("eligible") is not True
        or metadata.get("reader_contract") != VECTOR_READER_CONTRACT
        or metadata.get("reader_compatible") is not True
        or metadata.get("source_signature") != [
            list(entry) for entry in source_signature
        ]
    ):
        raise VectorConflictError(
            f"{operation} unavailable: reassess the current vector Item before "
            "styling it."
        )
    return metadata


def _categorical_field_kind(field_type: str) -> str | None:
    """Map one Fiona/STAC type description to a public category value kind.

    Args:
        field_type: Cataloged Fiona field type description.

    Returns:
        Public explicit category kind or ``None`` for unsupported types.
    """
    base_type = field_type.split(":", 1)[0].lower()
    if base_type in {"str", "string"}:
        return "string"
    if base_type in {"int", "int16", "int32", "int64"}:
        return "integer"
    if base_type in {"float", "float32", "float64", "real"}:
        return "number"
    if base_type in {"bool", "boolean"}:
        return "boolean"
    return None


def _numeric_field_type(field_type: str) -> bool:
    """Return whether a Catalog field description is numeric.

    Args:
        field_type: Cataloged Fiona field type description.

    Returns:
        ``True`` only for supported integer and floating-point types.
    """
    return _categorical_field_kind(field_type) in {"integer", "number"}


def _classify_numeric_values(
    values: tuple[float, ...],
    method: VectorClassificationMethod,
    class_count: int,
) -> tuple[VectorNumericClass, ...]:
    """Partition finite values into deterministic open-ended classes.

    Args:
        values: Non-empty bounded finite numeric observations.
        method: Equal-interval or quantile classification method.
        class_count: Requested class count within server limits.

    Returns:
        Adjacent classes covering every numeric value. Repeated quantile breaks
        are collapsed, so the result may contain fewer requested classes.

    Raises:
        ValueError: If inputs violate the internal classification contract.
    """
    if not values:
        raise ValueError("Numeric classification requires at least one value")
    if not (
        VECTOR_NUMERIC_MINIMUM_CLASS_COUNT
        <= class_count
        <= VECTOR_NUMERIC_MAXIMUM_CLASS_COUNT
    ):
        raise ValueError("Numeric class count is outside server limits")
    ordered = sorted(values)
    minimum = ordered[0]
    maximum = ordered[-1]
    boundaries: list[float] = []
    if method == "equal-interval":
        if minimum < maximum:
            span = maximum - minimum
            boundaries = [
                minimum + span * index / class_count
                for index in range(1, class_count)
            ]
    elif method == "quantile":
        for index in range(1, class_count):
            boundary = ordered[ceil(index * len(ordered) / class_count) - 1]
            if boundary < maximum and (
                not boundaries or boundary > boundaries[-1]
            ):
                boundaries.append(boundary)
    else:
        raise ValueError("Unknown numeric classification method")

    classes: list[VectorNumericClass] = []
    previous_boundary: float | None = None
    previous_index = 0
    for boundary in boundaries:
        next_index = bisect_right(ordered, boundary)
        classes.append(VectorNumericClass(
            minimum=previous_boundary,
            maximum=boundary,
            count=next_index - previous_index,
        ))
        previous_boundary = boundary
        previous_index = next_index
    classes.append(VectorNumericClass(
        minimum=previous_boundary,
        maximum=None,
        count=len(ordered) - previous_index,
    ))
    return tuple(classes)


def _category_value_kind(value: Any) -> str:
    """Return the explicit public kind for one reader-validated scalar.

    Args:
        value: Strict scalar emitted by the vector category reader.

    Returns:
        One of the closed public category value kinds.

    Raises:
        TypeError: If a category reader violates its scalar contract.
    """
    kinds = {bool: "boolean", int: "integer", float: "number", str: "string"}
    try:
        return kinds[type(value)]
    except KeyError as error:
        raise TypeError("Category reader returned an unsupported value") from error
