"""Test the authoritative raster assessment application workflow."""

import asyncio
from pathlib import Path

from eolab_app.raster.assessment import RasterAssessmentService
from eolab_app.raster.models import CatalogRasterRequest


class _Catalog:
    """Record assessment reads and updates."""

    def __init__(self, item: dict[str, object]) -> None:
        """Store one authoritative Item."""
        self.item = item
        self.upserted_item = None

    async def get_item(self, _: object) -> dict[str, object]:
        """Return the controlled Item."""
        return self.item

    async def upsert_item(
        self,
        _: object,
        item: dict[str, object],
    ) -> None:
        """Record the replacement Item."""
        self.upserted_item = item


class _Resolver:
    """Return one controlled mounted source."""

    def __init__(self, source_path: Path) -> None:
        """Store the source path."""
        self.source_path = source_path

    def resolve(self, _: object) -> Path:
        """Return the controlled source path."""
        return self.source_path


def test_assessment_rebuilds_and_upserts_only_an_outdated_item(
    tmp_path: Path,
) -> None:
    """Refresh outdated metadata while leaving current policy Items alone."""
    item_id = "geotiff-0123456789abcdef01234567"
    source_path = tmp_path / "raster.tif"
    request = CatalogRasterRequest.model_validate(
        {
            "collectionId": "eolab-mounted-geotiffs",
            "itemId": item_id,
        }
    )
    outdated_item = {
        "id": item_id,
        "assets": {
            "data": {
                "eolab:rendering": {
                    "policy": "raster-v1",
                    "eligible": False,
                }
            }
        },
    }
    updated_item = {
        "id": item_id,
        "assets": {
            "data": {
                "eolab:rendering": {
                    "policy": "raster-v2",
                    "eligible": True,
                }
            }
        },
    }
    catalog = _Catalog(outdated_item)
    build_count = 0

    def build_item(root: Path, source: Path) -> dict[str, object]:
        nonlocal build_count
        build_count += 1
        assert root == tmp_path
        assert source == source_path
        return updated_item

    service = RasterAssessmentService(
        tmp_path,
        catalog,
        _Resolver(source_path),
        build_item,
    )

    assert asyncio.run(service.assess(request)) is updated_item
    assert catalog.upserted_item is updated_item

    catalog.item = updated_item
    assert asyncio.run(service.assess(request)) is updated_item
    assert build_count == 1
