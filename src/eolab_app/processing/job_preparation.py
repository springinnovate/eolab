"""Serialize raster inputs and display metadata for the job store."""

from eolab_app.processing.aggregate_models import AggregateSpec
from eolab_app.processing.clip_models import ClipSpec
from eolab_app.processing.models import PreparedJobPlan


def prepare_aggregate_job(spec: AggregateSpec) -> PreparedJobPlan:
    """Serialize a prepared raster calculation for the job store.

    Args:
        spec: Calculation inputs, formulas, selected area and native grid.

    Returns:
        Path-free execution inputs and the display summary for this job.
    """
    data = spec.model_dump(mode="json", by_alias=True)
    return PreparedJobPlan(
        specification=data,
        summary={
            **{key: data[key] for key in ("sources", "calculations", "grid")},
            "area": {
                "kind": spec.area.kind,
                "bounds": spec.area.bounds,
                **(
                    {"samplingBox": spec.area.samplingBox.model_dump(mode="json")}
                    if spec.area.samplingBox
                    else {}
                ),
            },
        },
        operation=spec.operation,
    )


def prepare_clip_job(spec: ClipSpec) -> PreparedJobPlan:
    """Serialize prepared raster clip inputs and display metadata.

    Args:
        spec: Exact raster or observation identity, selected area and output grid.

    Returns:
        Path-free execution inputs and the display summary for this job.
    """
    data = spec.model_dump(mode="json", by_alias=True)
    return PreparedJobPlan(
        specification=data,
        summary={
            "source": data["source"],
            "grid": data["grid"],
            "area": {
                "kind": spec.area.kind,
                "bounds": (
                    list(spec.area.bounds) if spec.area.bounds is not None else None
                ),
                **(
                    {"samplingBox": spec.area.samplingBox.model_dump(mode="json")}
                    if spec.area.samplingBox
                    else {}
                ),
            },
        },
        operation=spec.operation,
    )
