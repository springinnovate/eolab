"""Verify stable saved-area identity and lightweight registry boundaries."""

import asyncio
import json
from typing import Any

import pytest

from eolab_app.catalog_selection import CatalogSelection
from eolab_app.processing.habitat_prepared_areas import (
    HabitatPreparedArea,
    PostgresHabitatPreparedAreas,
    get_habitat_prepared_area_id,
    get_prepared_habitat_area_coverage,
)
from eolab_app.processing.models import ProcessingError


def make_selection(
    value: str | int | float | bool | None = "North",
) -> CatalogSelection:
    """Create a validated original-source predicate without reading GIS files.

    Args:
        value: Typed comparison literal retained with the selection.

    Returns:
        Exact Catalog source, asset, layer and attribute predicate.
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


@pytest.mark.parametrize(("retained", "submitted"), [(1.0, 1), (-0.0, 0)])
def test_browser_numeric_roundtrip_keeps_area_identity(
    retained: float, submitted: int
) -> None:
    """Keep a retained numeric predicate selectable after browser JSON serialization.

    Args:
        retained: Numeric literal stored by Python preparation history.
        submitted: Equivalent JSON number emitted by the browser.
    """
    selection = make_selection(retained)
    area = HabitatPreparedArea(
        id=get_habitat_prepared_area_id(selection),
        name="Northern area",
        selection=selection,
    )
    public = json.loads(area.model_dump_json(by_alias=True))
    public["selection"]["filter"]["rules"][0]["value"] = submitted
    from_browser = CatalogSelection.model_validate(public["selection"])
    assert get_habitat_prepared_area_id(from_browser) == area.id
    assert type(selection.filter.rules[0].value) is float


def test_area_identity_keeps_scalar_types_and_exact_source_predicates() -> None:
    """Distinguish Boolean/string literals and changes to the original source or predicate."""
    assert (
        len(
            {
                get_habitat_prepared_area_id(make_selection(value))
                for value in (True, 1, "1", 1.5, None)
            }
        )
        == 5
    )
    original = make_selection()
    variants: list[dict[str, Any]] = [
        {"itemId": "other-area"},
        {"assetKey": "other-data"},
        {"layerName": "other-polygons"},
        {"filter": {"enabled": False, "match": "all", "rules": []}},
        {
            "filter": {
                "enabled": True,
                "match": "any",
                "rules": [{"field": "region", "operator": "eq", "value": "North"}],
            }
        },
        {
            "filter": {
                "enabled": True,
                "match": "all",
                "rules": [{"field": "region", "operator": "ne", "value": "North"}],
            }
        },
    ]
    identities = {get_habitat_prepared_area_id(original)}
    for changes in variants:
        changed = CatalogSelection.model_validate(
            {**original.model_dump(mode="json", by_alias=True), **changes}
        )
        identities.add(get_habitat_prepared_area_id(changed))
    assert len(identities) == len(variants) + 1


def test_area_public_metadata_contains_no_year_or_source_path() -> None:
    """Keep public area definitions independent of labels, readiness and server files."""
    selection = make_selection()
    identity = get_habitat_prepared_area_id(selection)
    first = HabitatPreparedArea(id=identity, name="Northern area", selection=selection)
    renamed = first.model_copy(update={"name": "Renamed area"})
    assert renamed.id == first.id
    assert set(first.model_dump()) == {"id", "name", "selection"}
    assert HabitatPreparedArea.model_validate_json(first.model_dump_json()) == first


def test_closed_registry_reports_a_safe_service_failure() -> None:
    """Translate real pool lifecycle failure without publishing connection details."""
    store = PostgresHabitatPreparedAreas()
    store.close()
    with pytest.raises(ProcessingError) as caught:
        store.get("0" * 64)
    assert caught.value.code == "habitat_prepared_areas_unavailable"
    assert caught.value.status == 503
    assert "pool" not in caught.value.detail.lower()


def test_coverage_with_missing_services_fails_without_loading_scientific_runtime() -> (
    None
):
    """Return an actionable configuration error before trying cache or source inspection."""
    with pytest.raises(ProcessingError) as caught:
        asyncio.run(
            get_prepared_habitat_area_coverage("0" * 64, 2018, None, None, None)
        )
    assert caught.value.code == "habitat_prepared_areas_unavailable"
    assert caught.value.status == 503
