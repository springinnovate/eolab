"""Test destructive catalog reconciliation boundaries."""

from pathlib import Path

import pytest

from eolab_app.catalog.models import CatalogItemSource
from eolab_app.catalog.reconciliation import catalog_item_is_missing


def test_reconciliation_rejects_assets_outside_the_scan_mount(
    tmp_path: Path,
) -> None:
    """Never verify or delete an Item through an untrusted external path."""
    item = CatalogItemSource(
        "eolab-mounted-geotiffs",
        "geotiff-a",
        ((tmp_path.parent / "outside.tif").as_uri(),),
    )

    with pytest.raises(ValueError, match="outside the scan mount"):
        catalog_item_is_missing(item, tmp_path)


def test_reconciliation_marks_an_absent_mounted_asset_missing(
    tmp_path: Path,
) -> None:
    """Treat a valid mount-relative file URL that no longer exists as stale."""
    item = CatalogItemSource(
        "eolab-mounted-geotiffs",
        "geotiff-a",
        ((tmp_path / "missing.tif").as_uri(),),
    )

    assert catalog_item_is_missing(item, tmp_path) is True
