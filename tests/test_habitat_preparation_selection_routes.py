"""Exercise prepared Catalog selections and current coverage at the HTTP boundary."""

from pathlib import Path
from unittest.mock import AsyncMock, Mock, create_autospec

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from eolab_app.catalog_selection import (
    CatalogSelection,
    CatalogSelectionReader,
    SelectionUnavailableError,
)
from eolab_app.processing.habitat_earth_engine import HabitatCacheCoverage
from eolab_app.processing.habitat_preparation_selections import (
    HabitatPreparationSelections,
)
from eolab_app.processing.models import ProcessingError
from eolab_app.routes.habitat import create_habitat_router

BASE = "/api/processing/models/habitat-condition/preparation-selections"
COVERAGE = "/api/processing/models/habitat-condition/preparation-coverage"


@pytest.fixture
def selection() -> CatalogSelection:
    """Return an existing filtered Catalog selection with no private source information.

    Returns:
        Catalog selection whose filtered region must reach cache inspection unchanged.
    """
    return CatalogSelection.model_validate(
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


def create_client(
    store: HabitatPreparationSelections | None,
    selections: CatalogSelectionReader | None = None,
    cache_directory: Path | None = None,
) -> TestClient:
    """Compose the public Habitat router without map, administrator or GEE clients.

    Args:
        store: Persistence boundary containing recorded Catalog selections.
        selections: Original-source authorization boundary for coverage inspection.
        cache_directory: Existing private input cache, never returned to the browser.

    Returns:
        HTTP client requiring no administrator password for read-only choices.
    """
    app = FastAPI()
    app.include_router(create_habitat_router(store, selections, cache_directory))
    return TestClient(app)


def test_preparation_selections_reuse_the_catalog_contract_and_are_not_cached(
    selection: CatalogSelection,
) -> None:
    """Expose exact saved selections without preparation jobs or administrator login.

    Args:
        selection: Prepared selection whose full predicate appears in the response.
    """
    store = create_autospec(HabitatPreparationSelections, instance=True)
    store.list.return_value = (selection,)
    response = create_client(store).get(BASE)
    assert response.status_code == 200
    assert response.json() == {
        "selections": [selection.model_dump(mode="json", by_alias=True)]
    }
    assert response.headers["cache-control"] == "private, no-store"
    store.list.assert_called_once_with()


@pytest.mark.parametrize("cached", [0, 2, 4])
def test_coverage_checks_the_recorded_selection_and_requested_year(
    selection: CatalogSelection,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    cached: int,
) -> None:
    """Report zero, partial and complete coverage without changing the saved predicate.

    Args:
        selection: Exact prepared source and feature filter.
        tmp_path: Private cache directory supplied by composition.
        monkeypatch: Replace native cache I/O at its existing boundary.
        cached: Available tiles out of the four required by this fixture.
    """
    store = create_autospec(HabitatPreparationSelections, instance=True)
    store.contains.return_value = True
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
    response = create_client(store, selections, tmp_path).post(
        COVERAGE,
        json={
            "selection": selection.model_dump(mode="json", by_alias=True),
            "year": 2017,
        },
    )
    assert response.status_code == 200
    assert response.json() == {
        "year": 2017,
        "requiredTiles": 4,
        "cachedTiles": cached,
        "missingTiles": 4 - cached,
    }
    assert response.headers["cache-control"] == "private, no-store"
    store.contains.assert_called_once_with(selection)
    inspect.assert_awaited_once_with(selection, 2017, selections, tmp_path)
    assert str(tmp_path) not in response.text


def test_unrecorded_selection_is_rejected_before_reading_its_source(
    selection: CatalogSelection, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Refuse unrecorded Catalog selections before native cache inspection.

    Args:
        selection: Catalog selection without a recorded preparation request.
        tmp_path: Configured private cache directory.
        monkeypatch: Detect any attempted native coverage read.
    """
    store = create_autospec(HabitatPreparationSelections, instance=True)
    store.contains.return_value = False
    inspect = AsyncMock(
        side_effect=AssertionError("Unrecorded selections must not be read")
    )
    monkeypatch.setattr(
        "eolab_app.processing.habitat_cache.get_habitat_cache_coverage", inspect
    )
    response = create_client(store, Mock(spec=CatalogSelectionReader), tmp_path).post(
        COVERAGE,
        json={
            "selection": selection.model_dump(mode="json", by_alias=True),
            "year": 2018,
        },
    )
    assert response.status_code == 409
    assert response.headers["cache-control"] == "private, no-store"
    inspect.assert_not_awaited()


@pytest.mark.parametrize("configured", [False, True])
def test_unavailable_preparation_storage_has_an_actionable_error(
    configured: bool,
) -> None:
    """Translate absent or failing persistence without returning private details.

    Args:
        configured: Whether the store exists but reports an actual storage failure.
    """
    store = (
        create_autospec(HabitatPreparationSelections, instance=True)
        if configured
        else None
    )
    if store is not None:
        store.list.side_effect = ProcessingError(
            "habitat_preparation_selections_unavailable",
            "Prepared Catalog selections are temporarily unavailable.",
            503,
        )
    response = create_client(store).get(BASE)
    assert response.status_code == 503
    assert "unavailable" in response.json()["detail"]
    assert response.headers["cache-control"] == "private, no-store"


def test_original_source_unavailability_remains_a_public_conflict(
    selection: CatalogSelection, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Authorize the original source even when its preparation reference remains.

    Args:
        selection: Recorded Catalog reference whose source is no longer available.
        tmp_path: Configured private input-cache root.
        monkeypatch: Replace the original-source/cache boundary with an access failure.
    """
    store = create_autospec(HabitatPreparationSelections, instance=True)
    store.contains.return_value = True
    inspect = AsyncMock(
        side_effect=SelectionUnavailableError("This Catalog layer is unavailable.")
    )
    monkeypatch.setattr(
        "eolab_app.processing.habitat_cache.get_habitat_cache_coverage", inspect
    )
    response = create_client(store, Mock(spec=CatalogSelectionReader), tmp_path).post(
        COVERAGE,
        json={
            "selection": selection.model_dump(mode="json", by_alias=True),
            "year": 2018,
        },
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "This Catalog layer is unavailable."
    assert response.headers["cache-control"] == "private, no-store"


@pytest.mark.parametrize("invalid", ["path", "upload", "year", "oversized"])
def test_coverage_rejects_invalid_external_requests_before_storage(
    selection: CatalogSelection, invalid: str
) -> None:
    """Keep Catalog-only descriptors and the existing HTTP body bound at admission.

    Args:
        selection: Valid selection used as the starting request.
        invalid: External contract violation to introduce before dispatch.
    """
    body = {"selection": selection.model_dump(mode="json", by_alias=True), "year": 2018}
    if invalid == "path":
        body["selection"]["path"] = "/private/source.gpkg"
    elif invalid == "upload":
        body["selection"] = {
            "uploadId": "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d",
            "layerName": "regions",
            "filter": body["selection"]["filter"],
        }
    elif invalid == "year":
        body["year"] = True
    else:
        body["padding"] = "x" * (16 * 1024)
    store = create_autospec(HabitatPreparationSelections, instance=True)
    response = create_client(store).post(COVERAGE, json=body)
    assert response.status_code == (413 if invalid == "oversized" else 422)
    store.contains.assert_not_called()
