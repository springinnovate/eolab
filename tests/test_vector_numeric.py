"""Test bounded numeric classification for authoritative vector Items."""

import asyncio
from pathlib import Path
from threading import Event

import pytest

from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.fields import FionaVectorFieldReader
from eolab_app.vector.models import CatalogVectorNumericClassificationRequest
from eolab_app.vector.sources import MountedVectorResolver
from tests.test_vector_categories import assessed_category_item, category_service


def numeric_request(
    item: dict[str, object],
    field: str,
    method: str,
    class_count: int,
) -> CatalogVectorNumericClassificationRequest:
    """Build one validated numeric-classification request.

    Args:
        item: Authoritative assessed Catalog Item.
        field: Exact Catalog numeric field.
        method: Equal-interval or quantile method.
        class_count: Requested class count.

    Returns:
        Validated request model.
    """
    return CatalogVectorNumericClassificationRequest(
        collectionId=item["collection"],
        itemId=item["id"],
        field=field,
        method=method,
        classCount=class_count,
    )


def test_equal_interval_classification_returns_complete_open_ranges(
    tmp_path: Path,
) -> None:
    """Compute deterministic adjacent classes and exact observed counts.

    Args:
        tmp_path: Isolated mounted source root.
    """
    item, _ = assessed_category_item(tmp_path)

    summary = asyncio.run(category_service(item, tmp_path).classify_numeric(
        numeric_request(item, "score", "equal-interval", 3)
    ))

    assert summary.field == "score"
    assert summary.method == "equal-interval"
    assert summary.requested_class_count == summary.actual_class_count == 3
    assert summary.observed_minimum == 0
    assert summary.observed_maximum == 2
    assert summary.numeric_value_count == 8
    assert [classification.count for classification in summary.classes] == [3, 3, 2]
    assert summary.classes[0].minimum is None
    assert summary.classes[-1].maximum is None
    assert summary.classes[0].maximum == pytest.approx(2 / 3)
    assert summary.classes[1].minimum == summary.classes[0].maximum
    assert summary.complete is True
    assert summary.default_class_count == 5
    assert summary.minimum_class_count == 2
    assert summary.maximum_class_count == 9


def test_quantile_classification_collapses_repeated_breaks(
    tmp_path: Path,
) -> None:
    """Return fewer honest classes when duplicate values repeat at breaks.

    Args:
        tmp_path: Isolated mounted source root.
    """
    item, _ = assessed_category_item(tmp_path)

    summary = asyncio.run(category_service(item, tmp_path).classify_numeric(
        numeric_request(item, "rank", "quantile", 5)
    ))

    assert summary.requested_class_count == 5
    assert summary.actual_class_count == 2
    assert [classification.count for classification in summary.classes] == [4, 4]
    assert summary.classes[0].maximum == 0
    assert summary.classes[1].minimum == 0


def test_numeric_reader_is_bounded_and_rejects_non_numeric_fields(
    tmp_path: Path,
) -> None:
    """Share the capped field reader and keep field type authority in Catalog.

    Args:
        tmp_path: Isolated mounted source root.
    """
    item, _ = assessed_category_item(tmp_path)
    source = MountedVectorResolver(tmp_path).resolve(item)
    partial = FionaVectorFieldReader().read_numbers(
        source,
        "score",
        4,
        Event(),
    )

    assert partial.values == (0.0, 1.0, 2.0, 0.0)
    assert partial.scanned_feature_count == 4
    assert partial.complete is False
    with pytest.raises(VectorConflictError, match="integer or floating-point"):
        asyncio.run(category_service(item, tmp_path).classify_numeric(
            numeric_request(item, "category", "equal-interval", 5)
        ))
