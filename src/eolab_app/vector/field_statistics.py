"""Calculate numeric field benchmarks from every feature in an original layer."""

from collections.abc import Mapping
from dataclasses import dataclass
from math import inf, isfinite
from threading import Event
from typing import Annotated, Self

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, model_validator

from eolab_app.catalog_selection import ResolvedCatalogSelection, VectorSelection
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector_fields import VectorFieldMissingError, visit_vector_fields

_FLOAT_FRACTION_BITS = 1074


class VectorLayerStatisticsRequest(BaseModel):
    """Request complete-layer benchmarks for up to 32 distinct fields.

    The source supplies its original identity and any calculated-field
    definitions. Its filter must have no conditions.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    source: VectorSelection
    fields: tuple[
        Annotated[str, Field(strict=True, min_length=1, max_length=256)], ...
    ] = Field(min_length=1, max_length=32)

    @model_validator(mode="after")
    def require_whole_layer_and_distinct_fields(self) -> Self:
        """Return a whole-layer request with unique field names.

        Returns:
            The validated request.

        Raises:
            ValueError: If the request includes filter conditions or duplicates.
        """
        if self.source.filter.rules:
            raise ValueError("Whole-layer statistics do not accept filter conditions.")
        if len(set(self.fields)) != len(self.fields):
            raise ValueError("Choose each statistics field only once.")
        return self


class VectorFieldStatistics(BaseModel):
    """Mean, minimum and maximum of the finite numeric values in one field.

    The count is the number of values included. A count of zero has null
    benchmarks, including when the source layer is empty.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    field: str
    count: int
    mean: FiniteFloat | None
    minimum: FiniteFloat | None
    maximum: FiniteFloat | None


@dataclass
class _FieldStatistics:
    """Accumulate one field's extrema and exact sum without retaining readings."""

    count: int = 0
    sum_in_float_units: int = 0
    minimum: int | float = inf
    maximum: int | float = -inf

    def add(self, value: int | float) -> None:
        """Include a finite number in the field's count, sum and extrema.

        Args:
            value: One finite numeric source value.
        """
        self.count += 1
        self.minimum = min(self.minimum, value)
        self.maximum = max(self.maximum, value)
        # Sum in units of the smallest positive float so intermediate sums
        # neither overflow nor lose small terms when large terms cancel.
        numerator, denominator = value.as_integer_ratio()
        self.sum_in_float_units += numerator << (
            _FLOAT_FRACTION_BITS - (denominator.bit_length() - 1)
        )

    def statistics(self, field: str) -> VectorFieldStatistics:
        """Return the complete statistics in the browser's numeric precision.

        Args:
            field: Original or calculated field whose values were read.

        Returns:
            The field's benchmarks, with null values when the count is zero.
        """
        return VectorFieldStatistics(
            field=field,
            count=self.count,
            mean=(
                self.sum_in_float_units / (self.count << _FLOAT_FRACTION_BITS)
                if self.count
                else None
            ),
            minimum=self.minimum if self.count else None,
            maximum=self.maximum if self.count else None,
        )


def read_vector_layer_statistics(
    source: ResolvedCatalogSelection,
    fields: tuple[str, ...],
    cancel_event: Event,
) -> tuple[VectorFieldStatistics, ...]:
    """Read the requested numeric fields in one geometry-free scan of the layer.

    Args:
        source: Authorized original source and compiled calculated fields.
        fields: Distinct authoritative fields in requested order.
        cancel_event: Cooperative stop signal supplied by vector sampling.

    Returns:
        One complete summary per requested field in the requested order.

    Raises:
        VectorConflictError: If the original field read fails or stops early.
    """
    accumulators = {field: _FieldStatistics() for field in fields}

    def visit(properties: Mapping[str, object]) -> None:
        """Include only finite numeric readings from one original feature.

        Args:
            properties: Requested field values for that feature.
        """
        for field, value in properties.items():
            if type(value) in (int, float) and isfinite(value):
                accumulators[field].add(value)

    try:
        complete = visit_vector_fields(
            str(source.path),
            source.selection.layerName,
            fields,
            None,
            cancel_event,
            visit,
            calculated_fields=source.calculated_fields,
        )
    except VectorFieldMissingError as error:
        raise VectorConflictError(
            "A selected field is missing from the original layer."
        ) from error
    except (OSError, RuntimeError, ValueError) as error:
        raise VectorConflictError("The original layer could not be read.") from error
    if not complete:
        raise VectorConflictError("The whole-layer read did not finish.")
    return tuple(
        accumulator.statistics(field) for field, accumulator in accumulators.items()
    )
