"""Measured native-work limit feedback shared by clips and calculations."""

from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from eolab_app.processing.models import ProcessingError
from eolab_app.processing.clip_models import ClipArea, RasterClipLimits
from eolab_app.processing.aggregate_models import AggregateArea, RasterAggregateLimits
from test_raster_clips import make_spec as clip_spec, write_source
from test_raster_aggregates import make_spec as aggregate_spec


@pytest.mark.parametrize("operation,budget", [
    ("calculation", "blocks"), ("calculation", "decoded_bytes"),
    ("clip", "decoded_bytes"),
])
def test_native_limits_report_requested_amount_limit_and_reduction(
    tmp_path: Path, operation: str, budget: str
) -> None:
    """Native planners expose actionable amounts from shared work admission.

    Args:
        tmp_path: Isolated real GeoTIFF source.
        operation: Consumer of the shared native admission boundary.
        budget: Block-index estimate or decoded source work to reject.
    """
    path = write_source(tmp_path / "source.tif", np.ones((34, 35), dtype="uint16"))
    # Four actual 32x32 blocks, including partial edge blocks. The preserved
    # preallocation estimate is (ceil(35/32)+1)*(ceil(34/32)+1) = 9 blocks.
    # Decoded source work is 34*35*(2-byte values + 1-byte validity) = 3,570 bytes.
    limits = RasterClipLimits() if operation == "clip" else RasterAggregateLimits()
    limits = replace(limits, **(
        {"max_native_blocks": 8} if budget == "blocks" else {"max_decoded_bytes": 3500}
    ))
    with pytest.raises(ProcessingError) as rejected:
        if operation == "clip":
            clip_spec(path, ClipArea(kind="bounds", bounds=(0, 9.66, 0.35, 10)), limits)
        else:
            aggregate_spec(path, ["count(a)"], AggregateArea(kind="wholeRaster"), limits)
    assert rejected.value.code == "source_work_too_large"
    assert rejected.value.status == 413
    if budget == "blocks":
        assert "conservative estimate is 9 native blocks" in rejected.value.detail
        assert "limit is 8 (1 over the limit)" in rejected.value.detail
        assert "8 blocks or fewer" in rejected.value.detail
    else:
        assert "3,570 decoded bytes" in rejected.value.detail
        assert "limit is 3,500 bytes (70 bytes over)" in rejected.value.detail
        assert "at most 3,500 decoded bytes" in rejected.value.detail


def test_native_block_rejection_precedes_index_allocation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reporting a large request never allocates its unbounded block-index tuple.

    Args:
        monkeypatch: Enforce the preallocation boundary on a metadata-only source.
    """
    from types import SimpleNamespace
    from rasterio.windows import Window
    import eolab_app.processing.raster_input as native

    def forbidden(*args: object) -> None:
        """Reject index allocation for an unadmitted request.

        Args:
            args: Unused block-index arguments.
        """
        pytest.fail("Rejected work must not allocate source-block indexes")

    monkeypatch.setattr(native, "source_block_indexes_for_window", forbidden)
    with pytest.raises(ProcessingError, match="1,002,001 native blocks"):
        native.native_work(SimpleNamespace(block_shapes=[(32, 32)]),
                           Window(0, 0, 32000, 32000), 500, 1_000_000)
