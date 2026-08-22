"""Test the authoritative raster assessment application workflow."""

import asyncio
from pathlib import Path

from eolab_app.raster.assessment import RasterAssessmentService
from eolab_app.raster.models import (
    GEOSERVER_READER_CONTRACT,
    CatalogRasterRequest,
    RasterReaderAssessment,
)
from eolab_app.raster.sources import source_signature


class _Catalog:
    """Record assessment reads and updates."""

    def __init__(self, item: dict[str, object]) -> None:
        """Store one authoritative Item.

        Args:
            item: Controlled authoritative Item.
        """
        self.item = item
        self.upserted_item = None

    async def get_item(self, _: object) -> dict[str, object]:
        """Return the controlled Item.

        Args:
            _: Unused validated raster identity.

        Returns:
            Controlled authoritative Item.
        """
        return self.item

    async def upsert_item(
        self,
        _: object,
        item: dict[str, object],
    ) -> None:
        """Record the replacement Item.

        Args:
            _: Unused validated raster identity.
            item: Replacement authoritative Item.
        """
        self.upserted_item = item


class _Resolver:
    """Return one controlled mounted source."""

    def __init__(self, source_path: Path) -> None:
        """Store the source path.

        Args:
            source_path: Controlled mounted source.
        """
        self.source_path = source_path

    def resolve(self, _: object) -> Path:
        """Return the controlled source path.

        Args:
            _: Unused authoritative Item.

        Returns:
            Controlled mounted source.
        """
        return self.source_path


class _ReaderAssessor:
    """Return and record one controlled deployed-reader decision."""

    def __init__(self, assessment: RasterReaderAssessment) -> None:
        """Store the controlled result.

        Args:
            assessment: Reader result returned by each call.
        """
        self.assessment = assessment
        self.paths: list[Path] = []

    async def assess(self, source_path: Path) -> RasterReaderAssessment:
        """Record one source and return the controlled result.

        Args:
            source_path: Mounted source submitted for assessment.

        Returns:
            Controlled deployed-reader result.
        """
        self.paths.append(source_path)
        return self.assessment


def test_reassessment_rebuilds_and_replaces_a_current_result(
    tmp_path: Path,
) -> None:
    """Replace even current metadata after source or reader repair.

    Args:
        tmp_path: Temporary mounted source directory.
    """
    item_id = "geotiff-0123456789abcdef01234567"
    source_path = tmp_path / "raster.tif"
    source_path.write_bytes(b"raster")
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
        "collection": "eolab-mounted-geotiffs",
        "assets": {
            "data": {
                "eolab:rendering": {
                    "policy": "raster-v3",
                    "eligible": True,
                    "source_signature": list(source_signature(source_path)),
                }
            }
        },
    }
    catalog = _Catalog(outdated_item)
    reader_assessor = _ReaderAssessor(RasterReaderAssessment(
        contract=GEOSERVER_READER_CONTRACT,
        compatible=True,
    ))
    build_count = 0

    def build_item(root: Path, source: Path) -> dict[str, object]:
        """Return the controlled freshly extracted raster Item.

        Args:
            root: Scan root supplied to the metadata builder.
            source: Mounted raster supplied to the metadata builder.

        Returns:
            Controlled current-policy structural Item.
        """
        nonlocal build_count
        build_count += 1
        assert root == tmp_path
        assert source == source_path
        return updated_item

    service = RasterAssessmentService(
        tmp_path,
        catalog,
        _Resolver(source_path),
        reader_assessor,
        build_item,
    )

    assert asyncio.run(service.assess(request)) is updated_item
    assert catalog.upserted_item is updated_item

    catalog.item = updated_item
    assert asyncio.run(service.assess(request)) is updated_item
    assert build_count == 2
    assert reader_assessor.paths == [source_path, source_path]
    assert updated_item["assets"]["data"]["eolab:rendering"] == {
        "policy": "raster-v3",
        "eligible": True,
        "reader_contract": GEOSERVER_READER_CONTRACT,
        "reader_compatible": True,
        "source_signature": list(source_signature(source_path)),
    }
