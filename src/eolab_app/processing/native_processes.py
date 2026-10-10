"""Configure the worker's native process for registered Processing calculations."""

from eolab_app.execution.reusable_process import ReusableProcess
from eolab_app.bounded_vector import summary_process
from eolab_app.processing.models import ProcessingLimits
from eolab_app.processing.raster_aggregate import aggregate_process_target
from eolab_app.processing.raster_clip import clip_process_target
from eolab_app.processing.downstream_calculation import downstream_process_target
from eolab_app.source_files import verify_source_file


def create_native_process(limits: ProcessingLimits) -> ReusableProcess:
    """Prepare one lane for raster operations and immutable input verification.

    The dedicated worker uses this process for preparation and execution after
    claiming a job from the database queue.

    Args:
        limits: Existing startup/planning deadline policy.

    Returns:
        Unstarted lane, recycled after exceeding 1 GiB Linux peak RSS. Completed
        operation count does not trigger replacement.
        The configured Linux address-space ceiling applies to preparation and
        execution. Container limits additionally bound all children together.
    """
    return ReusableProcess(
        (
            clip_process_target,
            aggregate_process_target,
            downstream_process_target,
            summary_process,
            verify_source_file,
        ),
        recycle_bytes=1024**3,
        startup_seconds=limits.plan_timeout_seconds,
        address_space_bytes=limits.process_memory_bytes,
    )
