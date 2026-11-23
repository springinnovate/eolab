"""Read identified feature attributes for inspection without loading map geometry."""

import json
import math
from contextlib import closing
from time import monotonic
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, field_validator

from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import (
    MAX_SCANNED_FEATURES,
    VectorReadLimits,
    _limit_memory,
)
from eolab_app.catalog_selection import (
    ResolvedCatalogSelection,
    SelectionUnavailableError,
    VectorSelection,
)
from eolab_app.execution.bounded_process import (
    ProcessDeadlineError,
    ProcessResultWriter,
    run_bounded_process,
)
from eolab_app.feature_intersection import iter_original_features
from eolab_app.vector.errors import VectorConflictError

MAX_FEATURE_ATTRIBUTE_BYTES = 8 * 1024**2
"""Maximum encoded inspection response, independent of map geometry budgets."""

FeatureAttributeValue = str | int | float | bool | None
"""JSON scalar retained from an original or calculated feature field."""


class FeatureAttributesRequest(BaseModel):
    """Read an exact ordered set of native IDs from a path-free filtered source.

    IDs must be unique signed-64-bit integers. The request has the
    ordinary interactive feature ceiling; a failed read never returns partial rows.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    selection: VectorSelection
    featureIds: tuple[
        Annotated[int, Field(strict=True, ge=-(2**63), le=2**63 - 1)], ...
    ] = Field(max_length=MAX_SCANNED_FEATURES)

    @field_validator("featureIds")
    @classmethod
    def require_unique_ids(cls, feature_ids: tuple[int, ...]) -> tuple[int, ...]:
        """Reject duplicate IDs at the external request boundary.

        Args:
            feature_ids: Validated native integer IDs in requested order.

        Returns:
            The unchanged unique IDs.

        Raises:
            ValueError: If an ID occurs more than once.
        """
        if len(set(feature_ids)) != len(feature_ids):
            raise ValueError("Select each feature ID only once")
        return feature_ids


class FeatureAttributes(BaseModel):
    """Native feature identity and scalar attributes, without display geometry.

    Non-finite numbers become null. Binary and other nonscalar values are
    omitted, matching the scalar observations consumed by feature plots.
    """

    model_config = ConfigDict(extra="forbid", frozen=True, allow_inf_nan=False)
    id: int
    properties: dict[str, FeatureAttributeValue]


class FeatureAttributesResult(BaseModel):
    """Complete ordered attributes tied to their original source and predicate.

    An empty request has an empty features tuple. Missing or filtered-out IDs
    fail the complete read; they are never silently dropped from a plotted set.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    selection: VectorSelection
    features: tuple[FeatureAttributes, ...]


async def read_feature_attributes(
    target: ResolvedCatalogSelection, feature_ids: tuple[int, ...]
) -> FeatureAttributesResult:
    """Read all requested attributes while the caller holds the original source.

    Args:
        target: Authorized original source with its exact filter already bound.
        feature_ids: Unique native IDs in the desired result order.

    Returns:
        Every requested row and the unchanged public source descriptor, including
        empty success. No geometry, WMS publication, or display outline is needed.

    Raises:
        VectorConflictError: If a requested ID is unavailable, excluded by the
            filter, or the complete read exceeds time, memory, feature, or
            eight-MiB encoded-response budgets.
        asyncio.CancelledError: After the native process stops reading the source.
    """
    if not feature_ids:
        return FeatureAttributesResult(selection=target.selection, features=())
    limits = VectorReadLimits()
    try:
        result, error = await run_bounded_process(
            _read_feature_attributes, (target, feature_ids, limits), limits.seconds
        )
    except ProcessDeadlineError as error:
        raise VectorConflictError(
            "Reading these feature attributes took too long. "
            "Select fewer features and try again."
        ) from error
    if error is not None:
        raise VectorConflictError(error)
    return result


def _read_feature_attributes(
    writer: ProcessResultWriter,
    target: ResolvedCatalogSelection,
    feature_ids: tuple[int, ...],
    limits: VectorReadLimits,
) -> None:
    """Return complete scalar rows or a safe failure from a supervised native read.

    Args:
        writer: Parent waiting for the result and optional failure message.
        target: Authorized immutable source and prepared exact predicate.
        feature_ids: Unique original IDs, in requested output order.
        limits: Interactive time, feature-work, and memory budgets. Geometry
            limits do not apply because native geometry is not decoded.
    """
    try:
        with _limit_memory(limits.memory_bytes):
            features: list[FeatureAttributes] = []
            encoded_size = len(
                json.dumps(
                    {
                        "selection": target.selection.model_dump(
                            mode="json", by_alias=True
                        ),
                        "features": [],
                    },
                    ensure_ascii=False,
                    allow_nan=False,
                    separators=(",", ":"),
                ).encode("utf-8")
            )
            with closing(
                iter_original_features(
                    target,
                    limits,
                    monotonic() + limits.seconds,
                    feature_ids=feature_ids,
                    read_geometry=False,
                )
            ) as originals:
                for feature_id, properties, _geometry in originals:
                    scalars: dict[str, FeatureAttributeValue] = {}
                    for name, value in properties.items():
                        if value is None or isinstance(value, (str, int, bool)):
                            scalars[name] = value
                        elif isinstance(value, float):
                            scalars[name] = value if math.isfinite(value) else None
                    feature = FeatureAttributes(id=feature_id, properties=scalars)
                    encoded_size += len(
                        feature.model_dump_json().encode("utf-8")
                    ) + bool(features)
                    if encoded_size > MAX_FEATURE_ATTRIBUTE_BYTES:
                        raise GeometryValidationError(
                            "These features contain too much attribute data to inspect at once. "
                            "Select fewer features and try again."
                        )
                    features.append(feature)
            if len(features) != len(feature_ids):
                raise SelectionUnavailableError(
                    "Some selected features do not match this layer's filter. Select the features again."
                )
            result = FeatureAttributesResult(
                selection=target.selection, features=tuple(features)
            )
        writer.put((result, None))
    except (GeometryValidationError, SelectionUnavailableError) as error:
        writer.put((None, str(error)))
    except MemoryError:
        writer.put(
            (
                None,
                "Feature attributes could not fit in memory. Select fewer features and try again.",
            )
        )
