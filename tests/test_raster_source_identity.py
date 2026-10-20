"""Test the canonical mounted-raster source identity contract."""

import json
from dataclasses import replace

import pytest

from eolab_app.raster.source_identity import RasterSourceIdentity


def test_catalog_round_trip_preserves_exact_identity() -> None:
    """Preserve every canonical integer through JSON serialization."""
    identity = RasterSourceIdentity(
        inode=54_607,
        size_bytes=37_342_482,
        modified_ns=1_580_503_744_000_000_000,
        changed_ns=1_665_161_574_521_396_640,
    )

    serialized = json.loads(json.dumps(identity.to_catalog()))

    assert serialized == [
        54_607,
        37_342_482,
        1_580_503_744_000_000_000,
        1_665_161_574_521_396_640,
    ]
    assert RasterSourceIdentity.from_catalog(serialized) == identity


@pytest.mark.parametrize(
    "field_name",
    ("inode", "size_bytes", "modified_ns", "changed_ns"),
)
def test_every_retained_field_invalidates_changed_source(
    field_name: str,
) -> None:
    """Keep replacement and content-relevant mutations distinguishable.

    Args:
        field_name: Canonical identity field changed by the fixture.
    """
    identity = RasterSourceIdentity(
        inode=7,
        size_bytes=11,
        modified_ns=13,
        changed_ns=17,
    )

    changed_identity = replace(
        identity,
        **{field_name: getattr(identity, field_name) + 1},
    )

    assert changed_identity != identity
