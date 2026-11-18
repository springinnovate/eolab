"""Check linked drawing identities through actual Planning and source HTTP APIs."""

import asyncio
from copy import deepcopy
import json
from typing import Any
from uuid import UUID, uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest

from eolab_app.drawings.models import DrawingLayer
from eolab_app.drawings.store import DrawingLayerStore
from eolab_app.planning.models import PlanningToolDocument
from eolab_app.planning.scenario_service import PlanningScenarioService
from eolab_app.planning.service import PlanningToolService
from eolab_app.planning.store import PlanningToolStore
from eolab_app.routes.drawings import create_drawings_router
from eolab_app.routes.planning_tools import (
    create_planning_scenarios_router,
    create_planning_tools_router,
)
from eolab_app.vector.filters import CatalogVectorFilterRequest
from eolab_app.vector.parcel_models import ParcelLookupRequest, ParcelLookupResponse
from test_planning_tools import (
    BASE,
    HEADERS,
    authorize_layer,
    tool_document,
    validate_ids,
)
from test_planning_tools_postgres import store  # noqa: F401

DRAWING_HEADERS = {**HEADERS, "X-EOLab-Drawings": "1"}


def drawing_collection() -> dict[str, Any]:
    """Return distinct original polygons with deliberately identical display names.

    Returns:
        Complete GeoJSON source with stable text IDs independent of feature position.
    """
    return {
        "type": "FeatureCollection",
        "name": "Drawn parcels",
        "features": [
            {
                "type": "Feature",
                "id": identifier,
                "properties": {"name": "Same name", "note": str(index)},
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [[index, 0], [index + 0.4, 0], [index, 0.4], [index, 0]]
                    ],
                },
            }
            for index, identifier in enumerate(("parcel-a", "parcel-b"))
        ],
    }


def drawing_view(identifier: str) -> dict[str, Any]:
    """Reference a source while retaining ordinary view-local filters and style.

    Args:
        identifier: Server-issued opaque drawing ID.

    Returns:
        Portable Planning view with no source geometry or edit credentials.
    """
    return {
        "drawingLayerId": identifier,
        "isCustom": True,
        "customName": "My parcels",
        "visible": True,
        "legendIncluded": True,
        "opacity": 0.8,
        "appearance": {
            "color": "#1686b0",
            "outline": "#202020",
            "weight": 1,
            "fillOpacity": 0.25,
            "labels": True,
        },
        "filter": {"enabled": True, "match": "all", "rules": []},
    }


def drawing_tool(identifier: str) -> dict[str, Any]:
    """Use one ordinary drawing view for both AOI and parcel roles.

    Args:
        identifier: Server-issued original drawing source ID.

    Returns:
        Valid tool document with built-in stable polygon identity.
    """
    result = tool_document()
    result["layers"] = [
        {"id": result["aoiLayerId"], "definition": drawing_view(identifier)}
    ]
    result["parcelLayerId"] = result["aoiLayerId"]
    result["parcelIdField"] = "id"
    return result


def make_linked_app(store: PlanningToolStore) -> FastAPI:
    """Compose real drawing and Planning storage with only Catalog I/O substituted.

    Args:
        store: Real Planning store in the explicitly disposable test database.

    Returns:
        HTTP app with browser ownership, source revisions and scenario persistence.
    """
    drawings = DrawingLayerStore(store.conninfo)
    drawings.initialize_schema()
    with drawings.transaction() as cursor:
        cursor.execute("TRUNCATE drawings.layers")

    async def read_drawing(identifier: UUID) -> DrawingLayer:
        """Read an admitted live source through its ordinary source owner.

        Args:
            identifier: Drawing reference in a saved tool.

        Returns:
            Latest source with no write permission granted to Planning.
        """
        return await asyncio.to_thread(drawings.read_layer, identifier)

    async def lookup_catalog(request: ParcelLookupRequest) -> ParcelLookupResponse:
        """Represent original Catalog membership independently of drawing storage.

        Args:
            request: Typed original Catalog parcel lookup.

        Returns:
            One accepted original ID, bound to its authorized Catalog source.
        """
        return ParcelLookupResponse(
            found=request.parcelId.type == "string"
            and request.parcelId.value == "catalog-parcel",
            selection=await authorize_layer(
                CatalogVectorFilterRequest(
                    collectionId=request.collection_id,
                    itemId=request.item_id,
                    filter={},
                )
            ),
        )

    app = FastAPI()
    app.include_router(create_drawings_router(drawings))
    app.include_router(
        create_planning_tools_router(
            PlanningToolService(store, authorize_layer, validate_ids, read_drawing)
        )
    )
    app.include_router(
        create_planning_scenarios_router(
            PlanningScenarioService(store, lookup_catalog, read_drawing)
        )
    )
    return app


def test_linked_edits_preserve_source_identity_and_private_scenario_choices(
    store: PlanningToolStore,
) -> None:
    """See updated source geometry in two tools without rewriting their saved choices.

    Args:
        store: Disposable real Planning store.
    """
    app = make_linked_app(store)
    with (
        TestClient(
            app, base_url="https://testserver", headers=DRAWING_HEADERS
        ) as author,
        TestClient(
            app, base_url="https://testserver", headers=DRAWING_HEADERS
        ) as participant,
    ):
        collection = drawing_collection()
        created = author.post(
            "/api/drawings",
            json={"localLayerId": "local-layer", "collection": collection},
        )
        assert created.status_code == 201, created.text
        drawing = created.json()
        source_path = f"/api/drawings/{drawing['id']}"
        assert participant.get(source_path).json()["canEdit"] is False
        assert participant.get("/api/drawings").json() == []
        assert (
            participant.put(
                source_path, json={"expectedRevision": 1, "collection": collection}
            ).status_code
            == 404
        )
        document = drawing_tool(drawing["id"])
        first = author.post(BASE, json=document)
        assert first.status_code == 201, first.text
        first_path = first.headers["location"]
        second = author.post(BASE, json={**document, "title": "Another linked plan"})
        assert second.status_code == 201, second.text
        second_path = second.headers["location"]
        scenario_response = participant.post(
            f"{first_path}/scenarios",
            json={"name": "My choices", "expectedToolRevision": 1},
        )
        assert scenario_response.status_code == 201, scenario_response.text
        scenario_path = scenario_response.headers["location"]
        edit = {
            "parcelId": {"type": "string", "value": "parcel-a"},
            "interventionId": document["interventions"][0]["id"],
            "expectedRevision": 1,
            "expectedToolRevision": 1,
        }
        assigned = participant.put(f"{scenario_path}/assignment", json=edit)
        assert assigned.status_code == 200, assigned.text
        saved = participant.get(
            f"{scenario_path}/assignments?expectedRevision=2"
        ).json()
        assert saved["assignments"][0]["parcelId"] == edit["parcelId"]
        assert author.get(scenario_path).status_code == 404

        changed = deepcopy(collection)
        changed["features"] = changed["features"][1:]
        changed["features"][0]["geometry"]["coordinates"][0][1] = [1.8, 0]
        changed["features"][0]["properties"]["name"] = "Updated polygon"
        response = author.put(
            source_path, json={"expectedRevision": 1, "collection": changed}
        )
        assert response.status_code == 200, response.text
        assert response.json()["revision"] == 2
        assert (
            author.put(
                source_path, json={"expectedRevision": 1, "collection": collection}
            ).status_code
            == 409
        )
        assert participant.get(source_path).json()["collection"] == changed
        for path in (first_path, second_path):
            tool = participant.get(f"{path}/definition").json()
            assert tool["revision"] == 1
            assert tool["layers"][0]["definition"]["drawingLayerId"] == drawing["id"]
            assert "coordinates" not in json.dumps(tool)
        assert (
            participant.get(f"{scenario_path}/assignments?expectedRevision=2").json()
            == saved
        )
        assert (
            participant.put(
                f"{scenario_path}/assignment", json={**edit, "expectedRevision": 2}
            ).status_code
            == 422
        )
        cleared = participant.put(
            f"{scenario_path}/assignment",
            json={**edit, "expectedRevision": 2, "interventionId": None},
        )
        assert cleared.status_code == 200, cleared.text
        assert (
            participant.get(f"{scenario_path}/assignments?expectedRevision=3").json()[
                "assignments"
            ]
            == []
        )

        # Undo restores the original identity rather than handing its choice to a neighbor.
        assert (
            author.put(
                source_path, json={"expectedRevision": 2, "collection": collection}
            ).status_code
            == 200
        )
        assert (
            participant.put(
                f"{scenario_path}/assignment", json={**edit, "expectedRevision": 3}
            ).status_code
            == 200
        )
        assert (
            participant.get(f"{scenario_path}/assignments?expectedRevision=4").json()[
                "assignments"
            ]
            == saved["assignments"]
        )


@pytest.mark.parametrize("drawn_role", ["aoi", "parcels"])
def test_mixed_sources_keep_ordinary_filters_and_use_the_correct_parcel_identity(
    store: PlanningToolStore,
    drawn_role: str,
) -> None:
    """Use drawn and Catalog roles together while preserving excluded assignments.

    Args:
        store: Disposable real Planning store.
        drawn_role: Which role uses the linked drawing source.
    """
    with TestClient(
        make_linked_app(store), base_url="https://testserver", headers=DRAWING_HEADERS
    ) as client:
        source = client.post(
            "/api/drawings",
            json={"localLayerId": "mixed", "collection": drawing_collection()},
        ).json()
        document = tool_document()
        role_index = 0 if drawn_role == "aoi" else 1
        document["layers"][role_index]["definition"] = drawing_view(source["id"])
        parcel_id = "catalog-parcel"
        if drawn_role == "parcels":
            document["parcelIdField"] = "id"
            parcel_id = "parcel-b"
        created = client.post(BASE, json=document)
        assert created.status_code == 201, created.text
        path = created.headers["location"]
        scenario = client.post(
            f"{path}/scenarios", json={"name": "Mixed", "expectedToolRevision": 1}
        )
        scenario_path = scenario.headers["location"]
        request = {
            "parcelId": {"type": "string", "value": parcel_id},
            "interventionId": document["interventions"][0]["id"],
            "expectedRevision": 1,
            "expectedToolRevision": 1,
        }
        assert (
            client.put(f"{scenario_path}/assignment", json=request).status_code == 200
        )
        expected = client.get(f"{scenario_path}/assignments?expectedRevision=2").json()[
            "assignments"
        ]
        excluded = deepcopy(document)
        excluded["layers"][role_index]["definition"]["filter"]["rules"] = [
            {"field": "name", "operator": "eq", "value": "Not present"}
        ]
        assert (
            client.put(path, json={**excluded, "expectedRevision": 1}).status_code
            == 200
        )
        assert (
            client.get(f"{scenario_path}/assignments?expectedRevision=2").json()[
                "assignments"
            ]
            == expected
        )
        assert (
            client.put(path, json={**document, "expectedRevision": 2}).status_code
            == 200
        )
        assert (
            client.get(f"{scenario_path}/assignments?expectedRevision=2").json()[
                "assignments"
            ]
            == expected
        )


def test_scenario_freezes_drawing_source_identity_but_not_ordinary_view_settings(
    store: PlanningToolStore,
) -> None:
    """Prevent source substitution while allowing a new view of the same source.

    Args:
        store: Disposable real Planning store.
    """
    with TestClient(
        make_linked_app(store), base_url="https://testserver", headers=DRAWING_HEADERS
    ) as client:
        sources = [
            client.post(
                "/api/drawings",
                json={"localLayerId": f"layer-{i}", "collection": drawing_collection()},
            ).json()
            for i in range(2)
        ]
        document = drawing_tool(sources[0]["id"])
        created = client.post(BASE, json=document)
        path = created.headers["location"]
        assert (
            client.post(
                f"{path}/scenarios", json={"name": "Stable", "expectedToolRevision": 1}
            ).status_code
            == 201
        )
        replacement = deepcopy(document)
        replacement["layers"][0]["definition"]["drawingLayerId"] = sources[1]["id"]
        assert (
            client.put(path, json={**replacement, "expectedRevision": 1}).status_code
            == 409
        )
        replacement = deepcopy(document)
        new_view = str(uuid4())
        replacement["layers"][0]["id"] = new_view
        replacement["aoiLayerId"] = replacement["parcelLayerId"] = new_view
        replacement["layers"][0]["definition"]["customName"] = "A view name"
        assert (
            client.put(path, json={**replacement, "expectedRevision": 1}).status_code
            == 200
        )
        assert client.get(f"/api/drawings/{sources[0]['id']}").json()["revision"] == 1
        for invalid in (
            {**document, "parcelIdField": "name"},
            {**document, "parcelIdField": "note"},
        ):
            with pytest.raises(ValidationError):
                PlanningToolDocument.model_validate(invalid)
        assert client.post(BASE, json=drawing_tool(str(uuid4()))).status_code == 404
