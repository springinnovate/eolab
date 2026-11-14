"""Exercise public saved-area choices and current coverage at the HTTP boundary."""

from pathlib import Path
from unittest.mock import AsyncMock, Mock, create_autospec

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.catalog_selection import CatalogSelection, CatalogSelectionReader
from eolab_app.processing.habitat_earth_engine import HabitatCacheCoverage
from eolab_app.processing.habitat_prepared_areas import (
    HabitatPreparedArea,
    HabitatPreparedAreaStore,
    get_habitat_prepared_area_id,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.routes.habitat import create_habitat_router

BASE = "/api/processing/models/habitat-condition/prepared-areas"


@pytest.fixture
def area() -> HabitatPreparedArea:
    """Return one saved filtered Catalog area with no private source information.

    Returns:
        Named selection whose filtered region must reach cache inspection unchanged.
    """
    selection = CatalogSelection.model_validate(
        {
            "collectionId": "eolab-mounted-vectors",
            "itemId": "study-regions",
            "assetKey": "data",
            "layerName": "regions",
            "filter": {
                "enabled": True,
                "match": "all",
                "rules": [{"field": "region", "operator": "eq", "value": "west"}],
            },
        }
    )
    return HabitatPreparedArea(
        id=get_habitat_prepared_area_id(selection),
        name="Western study area",
        selection=selection,
    )


def create_client(
    store: HabitatPreparedAreaStore | None,
    selections: CatalogSelectionReader | None = None,
    cache_directory: Path | None = None,
) -> TestClient:
    """Compose the public Habitat router without map, administrator or GEE clients.

    Args:
        store: Persistence boundary containing current saved-area definitions.
        selections: Original-source authorization boundary for coverage inspection.
        cache_directory: Existing private input cache, never returned to the browser.

    Returns:
        HTTP client requiring no administrator password for read-only choices.
    """
    app = FastAPI()
    app.include_router(create_habitat_router(store, selections, cache_directory))
    return TestClient(app)


def test_saved_areas_are_public_path_free_and_not_cached(
    area: HabitatPreparedArea,
) -> None:
    """Expose exact saved selections without preparation jobs or administrator login.

    Args:
        area: Saved area whose label and full predicate appear in the response.
    """
    store = create_autospec(HabitatPreparedAreaStore, instance=True)
    store.list.return_value = (area,)
    response = create_client(store).get(BASE)
    assert response.status_code == 200
    assert response.json() == {"areas": [area.model_dump(mode="json", by_alias=True)]}
    assert response.headers["cache-control"] == "private, no-store"
    store.list.assert_called_once_with()


@pytest.mark.parametrize("cached", [0, 2, 4])
def test_coverage_checks_the_registered_selection_and_requested_year(
    area: HabitatPreparedArea,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    cached: int,
) -> None:
    """Report zero, partial and complete coverage without changing the saved predicate.

    Args:
        area: Registered source selection resolved from the public area identifier.
        tmp_path: Private cache directory supplied by composition.
        monkeypatch: Replace native cache I/O at its existing boundary.
        cached: Available tiles out of the four required by this fixture.
    """
    store = create_autospec(HabitatPreparedAreaStore, instance=True)
    store.get.return_value = area
    selections = create_autospec(CatalogSelectionReader, instance=True)
    inspect = AsyncMock(
        return_value=HabitatCacheCoverage(
            configuration_sha256="a" * 64,
            year=2017,
            required_tiles=4,
            cached_tiles=cached,
            missing_tiles=4 - cached,
        )
    )
    monkeypatch.setattr(
        "eolab_app.processing.habitat_cache.get_habitat_cache_coverage", inspect
    )
    response = create_client(store, selections, tmp_path).get(
        f"{BASE}/{area.id}/coverage", params={"year": 2017}
    )
    assert response.status_code == 200
    assert response.json() == {
        "areaId": area.id,
        "year": 2017,
        "requiredTiles": 4,
        "cachedTiles": cached,
        "missingTiles": 4 - cached,
    }
    assert response.headers["cache-control"] == "private, no-store"
    store.get.assert_called_once_with(area.id)
    inspect.assert_awaited_once_with(area.selection, 2017, selections, tmp_path)
    assert str(tmp_path) not in response.text


def test_unknown_area_cannot_supply_an_arbitrary_selection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Resolve membership before cache inspection and refuse an unknown area ID.

    Args:
        tmp_path: Configured private cache directory.
        monkeypatch: Detect any attempted native coverage read.
    """
    store = create_autospec(HabitatPreparedAreaStore, instance=True)
    store.get.return_value = None
    inspect = AsyncMock(side_effect=AssertionError("Unknown areas must not be read"))
    monkeypatch.setattr(
        "eolab_app.processing.habitat_cache.get_habitat_cache_coverage", inspect
    )
    response = create_client(store, Mock(spec=CatalogSelectionReader), tmp_path).get(
        f"{BASE}/{'f' * 64}/coverage", params={"year": 2018}
    )
    assert response.status_code == 409
    assert response.headers["cache-control"] == "private, no-store"
    inspect.assert_not_awaited()


@pytest.mark.parametrize("configured", [False, True])
def test_unavailable_saved_area_storage_has_an_actionable_error(
    configured: bool,
) -> None:
    """Translate absent or failing persistence without returning private details.

    Args:
        configured: Whether the store exists but reports an actual storage failure.
    """
    store = (
        create_autospec(HabitatPreparedAreaStore, instance=True) if configured else None
    )
    if store is not None:
        store.list.side_effect = ProcessingError(
            "habitat_prepared_areas_unavailable",
            "Saved areas are temporarily unavailable.",
            503,
        )
    response = create_client(store).get(BASE)
    assert response.status_code == 503
    assert "unavailable" in response.json()["detail"]
    assert response.headers["cache-control"] == "private, no-store"
