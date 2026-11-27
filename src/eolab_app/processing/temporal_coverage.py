"""Retain the date labels of the observations included in a temporal result."""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any, Self

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

if TYPE_CHECKING:
    from eolab_app.raster.temporal import ResolvedTemporalInterval


class ObservationLabels(BaseModel):
    """Describe how to display a prepared stack's first and last observations.

    Attributes:
        period: Calendar period, snapshot precision or the literal string `explicit`.
        explicitStarts: Inclusive starts of the first and last explicit intervals.
            Their exclusive ends are the result's existing observation timestamps.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    period: str
    explicitStarts: tuple[AwareDatetime, AwareDatetime] | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @classmethod
    def from_interval(cls, source: ResolvedTemporalInterval) -> Self | None:
        """Capture the labels of the nonempty interval selected for a calculation.

        Args:
            source: Authorized observations in timestamp order and their metadata.

        Returns:
            Prepared-stack labels, or None when the archive supplied no precision.
        """
        if source.time_labels is None:
            return None
        return cls(
            period=source.time_labels,
            explicitStarts=(
                (
                    source.observations[0].interval_start,
                    source.observations[-1].interval_start,
                )
                if source.time_labels == "explicit"
                else None
            ),
        )


OptionalObservationLabels = Annotated[
    ObservationLabels | None, Field(exclude_if=lambda value: value is None)
]
"""Omit observation labels when an archive supplies only its UTC timestamps."""


def temporal_result_coverage(policy: dict[str, Any], unit: str) -> dict[str, Any]:
    """Return the recorded coverage for a completed period map or CSV.

    Args:
        policy: Numerical policy saved when the temporal operation was prepared.
        unit: Recorded output unit, or an empty string for formulas without a shared unit.

    Returns:
        The result's unit, count, first and last timestamps and any saved date labels.
    """
    return {
        "unit": unit,
        "observationCount": policy["observationCount"],
        "firstObservation": policy["firstObservation"],
        "lastObservation": policy["lastObservation"],
        **(
            {"observationLabels": policy["observationLabels"]}
            if "observationLabels" in policy
            else {}
        ),
    }
