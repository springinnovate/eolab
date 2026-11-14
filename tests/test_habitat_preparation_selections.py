"""Verify lightweight preparation-reference failure boundaries."""

import asyncio
from pathlib import Path
from unittest.mock import create_autospec

import pytest

from eolab_app.catalog_selection import CatalogSelection, CatalogSelectionReader
from eolab_app.processing.habitat_preparation_selections import (
    HabitatPreparationSelections,
    PostgresHabitatPreparationSelections,
    get_habitat_preparation_coverage,
)
from eolab_app.processing.models import ProcessingError


def make_selection(
    value: str | int | float | bool | None = "North",
) -> CatalogSelection:
    """Create an existing Catalog selection without inspecting GIS files.

    Args:
        value: Typed comparison literal retained with the original selection.

    Returns:
        Validated Catalog source, asset, layer and exact attribute predicate.
    """
    return CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="administrative-areas",
        assetKey="data",
        layerName="polygons",
        filter={
            "enabled": True,
            "match": "all",
            "rules": [{"field": "region", "operator": "eq", "value": value}],
        },
    )


def test_closed_store_reports_a_safe_service_failure() -> None:
    """Translate actual pool lifecycle failure without publishing connection details."""
    store = PostgresHabitatPreparationSelections()
    store.close()
    with pytest.raises(ProcessingError) as caught:
        store.contains(make_selection())
    assert caught.value.code == "habitat_preparation_selections_unavailable"
    assert caught.value.status == 503
    assert "pool" not in caught.value.detail.lower()


def test_coverage_with_missing_services_fails_before_scientific_runtime_load() -> None:
    """Explain missing configuration before attempting source or native inspection."""
    with pytest.raises(ProcessingError) as caught:
        asyncio.run(
            get_habitat_preparation_coverage(make_selection(), 2018, None, None, None)
        )
    assert caught.value.code == "habitat_preparation_selections_unavailable"
    assert caught.value.status == 503


def test_unknown_selection_cannot_start_source_or_coverage_inspection() -> None:
    """Reject selections without preparation references before original-source access."""
    store = create_autospec(HabitatPreparationSelections, instance=True)
    store.contains.return_value = False
    reader = create_autospec(CatalogSelectionReader, instance=True)
    selection = make_selection()
    with pytest.raises(ProcessingError) as caught:
        asyncio.run(
            get_habitat_preparation_coverage(
                selection, 2018, store, reader, Path("private-cache")
            )
        )
    assert caught.value.code == "habitat_preparation_selection_unavailable"
    assert caught.value.status == 409
    store.contains.assert_called_once_with(selection)
    reader.resolve_for_sampling.assert_not_called()
