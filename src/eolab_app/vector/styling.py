"""Application workflow for authoritative vector styling and categories."""

import asyncio
from threading import Event
from typing import Any

from eolab_app.rendering.errors import (
    PublishedLayerChangedError,
    PublishedLayerNotAuthorizedError,
)
from eolab_app.rendering.geoserver import GEOSERVER_WORKSPACE_NAME
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.models import (
    AppliedVectorStyle,
    CatalogVectorCategoryRequest,
    CatalogVectorStyleRequest,
    VECTOR_CATEGORY_DEFAULT_LIMIT,
    VECTOR_CATEGORY_FEATURE_LIMIT,
    VECTOR_CATEGORY_MAXIMUM_LIMIT,
    VECTOR_READER_CONTRACT,
    VECTOR_RENDERING_METADATA_KEY,
    VECTOR_RENDERING_POLICY,
    VectorCategorySummary,
    VectorCategoryValue,
    VectorCategoryValueCount,
)
from eolab_app.vector.ports import (
    VectorCatalog,
    VectorCategoryReader,
    VectorStyler,
)
from eolab_app.vector.sources import (
    MountedVectorResolver,
    PublishedVectorRegistry,
    vector_source_signature,
)


class VectorStyleService:
    """Apply styles only to current, published, authoritative vector Items."""

    def __init__(
        self,
        catalog: VectorCatalog,
        source_resolver: MountedVectorResolver,
        styler: VectorStyler,
        vector_registry: PublishedVectorRegistry,
        category_reader: VectorCategoryReader,
    ) -> None:
        """Create authoritative vector styling and category-summary use cases.

        Args:
            catalog: Authoritative vector catalog port.
            source_resolver: Exact mounted source and layer resolver.
            styler: GeoServer vector style adapter.
            vector_registry: Current public-WMS authorization registry.
            category_reader: Bounded mounted-source attribute reader.
        """
        self._catalog = catalog
        self._source_resolver = source_resolver
        self._styler = styler
        self._vector_registry = vector_registry
        self._category_reader = category_reader
        self._style_lock = asyncio.Lock()
        self._category_slots = asyncio.Semaphore(2)

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
        feature_count = _catalog_vector_feature_count(item)
        try:
            source_signature = await asyncio.to_thread(
                vector_source_signature,
                source,
            )
        except (OSError, ValueError) as error:
            raise VectorConflictError(
                "Category summary unavailable: reassess the current vector "
                "Item before styling it."
            ) from error
        _require_assessed_metadata(item, source_signature)

        cancel_event = Event()
        try:
            async with self._category_slots:
                category_read = await asyncio.to_thread(
                    self._category_reader.read,
                    source,
                    request.field,
                    VECTOR_CATEGORY_FEATURE_LIMIT,
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
                "Category summary unavailable: the vector source changed "
                "during the bounded read."
            ) from error
        if final_signature != source_signature:
            raise VectorConflictError(
                "Category summary unavailable: the vector source changed "
                "during the bounded read."
            )
        if (
            category_read.complete
            and category_read.scanned_feature_count != feature_count
        ):
            raise VectorConflictError(
                "Category summary unavailable: reassess the vector Item "
                "because its feature count has changed."
            )
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


def _catalog_vector_feature_count(item: dict[str, Any]) -> int:
    """Return the authoritative non-negative STAC Table row count.

    Args:
        item: Authoritative Catalog Item loaded by the style service.

    Returns:
        Declared feature count.

    Raises:
        VectorConflictError: If current Table metadata has no valid row count.
    """
    value = item.get("properties", {}).get("table:row_count")
    if type(value) is not int or value < 0:
        raise VectorConflictError(
            "Category summary unavailable: reassess the vector Item because "
            "its feature count is missing."
        )
    return value


def _require_assessed_metadata(
    item: dict[str, Any],
    source_signature: tuple[tuple[str, int, int, int, int, int], ...],
) -> dict[str, Any]:
    """Require current eligible assessment metadata for a source signature.

    Args:
        item: Authoritative Catalog Item.
        source_signature: Current complete mounted-source signature.

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
            "Category summary unavailable: reassess the current vector Item "
            "before styling it."
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
