"""Verify private scenario workflows through real HTTP routes and PostgreSQL."""

import asyncio
from copy import deepcopy
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
import pytest

from eolab_app.attribute_filter import VectorFilter
from eolab_app.catalog_selection import CatalogSelection
from eolab_app.planning.models import MAX_REQUEST_BYTES, PlanningToolDocument
from eolab_app.planning.scenario_models import CreateScenario, SetScenarioAssignment
from eolab_app.planning.scenario_service import PlanningScenarioService
from eolab_app.planning.service import PlanningToolService
from eolab_app.planning.store import PlanningToolStore
from eolab_app.routes.planning_tools import (
    create_planning_scenarios_router,
    create_planning_tools_router,
)
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.parcel_models import (
    ParcelIdRequest,
    ParcelIdType,
    ParcelIdValidationResponse,
    ParcelLookupRequest,
    ParcelLookupResponse,
)
from test_planning_tools import BASE, HEADERS, authorize_layer, tool_document
from test_planning_tools_postgres import store  # noqa: F401


class OriginalParcelLookup:
    """Represent the source-reader boundary while recording exact lookup requests."""

    def __init__(self, id_type: ParcelIdType, values: tuple[str, ...]) -> None:
        """Choose the original fixture field type and values.

        Args:
            id_type: Integer or string field kind in this fixture's original source.
            values: Exact original values, represented as wire text.
        """
        self.id_type = id_type
        self.values = values
        self.requests: list[ParcelLookupRequest] = []
        self.available = True

    async def __call__(self, request: ParcelLookupRequest) -> ParcelLookupResponse:
        """Check exact membership without applying any tool view filter.

        Args:
            request: Catalog identity and typed original parcel ID.

        Returns:
            Membership tied to the authorized original source.

        Raises:
            VectorConflictError: This test deliberately made the source unavailable.
        """
        self.requests.append(request)
        if not self.available:
            raise VectorConflictError("The original parcel source is unavailable.")
        return ParcelLookupResponse(
            found=(
                request.parcelId.type == self.id_type
                and request.parcelId.value in self.values
            ),
            selection=CatalogSelection(
                collectionId=request.collection_id,
                itemId=request.item_id,
                assetKey="data",
                layerName="parcels",
                filter=VectorFilter(),
            ),
        )


def make_scenario_app(
    store: PlanningToolStore, lookup: OriginalParcelLookup
) -> FastAPI:
    """Compose production tool/scenario HTTP boundaries around real persistence.

    Args:
        store: Isolated disposable PostgreSQL Planning store.
        lookup: Original-source membership fixture, replacing only native I/O.

    Returns:
        App using the production browser identity, services, routers and store.
    """

    async def validate_ids(request: ParcelIdRequest) -> ParcelIdValidationResponse:
        """Admit the same original field type and IDs used by later fixture lookups.

        Args:
            request: Original Catalog layer and ID field chosen for the tool.

        Returns:
            Whole-source validation matching this fixture's original parcel schema.
        """
        return ParcelIdValidationResponse(
            idField=request.idField,
            idType=lookup.id_type,
            featureCount=len(lookup.values),
            selection=CatalogSelection(
                collectionId=request.collection_id,
                itemId=request.item_id,
                assetKey="data",
                layerName="parcels",
                filter=VectorFilter(),
            ),
        )

    app = FastAPI()
    app.include_router(
        create_planning_tools_router(
            PlanningToolService(store, authorize_layer, validate_ids)
        )
    )
    app.include_router(
        create_planning_scenarios_router(
            PlanningScenarioService(store, lookup_parcel=lookup)
        )
    )
    return app


def assignment_request(
    scenario: dict[str, Any],
    parcel_id: dict[str, str],
    intervention_id: str | None,
) -> dict[str, Any]:
    """Build a one-parcel edit using revisions acknowledged in scenario metadata.

    Args:
        scenario: Latest scenario response read by the test participant.
        parcel_id: Exact typed original ID.
        intervention_id: Allowed intervention UUID, or null to clear.

    Returns:
        Public assignment request with both expected revisions.
    """
    return {
        "parcelId": parcel_id,
        "interventionId": intervention_id,
        "expectedRevision": scenario["revision"],
        "expectedToolRevision": scenario["toolRevision"],
    }


@pytest.mark.parametrize(
    ("id_type", "values"),
    [
        ("string", ("001", "1", "a'Ω")),
        ("integer", ("9007199254740993", "9223372036854775807", "-1")),
    ],
)
def test_private_scenario_assign_change_clear_and_restart(
    store: PlanningToolStore, id_type: ParcelIdType, values: tuple[str, ...]
) -> None:
    """Keep each participant's exact parcel choices private and independently durable.

    Expected result: assigning, changing, clearing and renaming a scenario changes
    only that scenario. Another scenario and browser retain their separate choices;
    a tool author cannot read participants' work. Restart preserves acknowledged data.

    Args:
        store: Empty disposable PostgreSQL store.
        id_type: Original field kind exercised by this complete workflow.
        values: Distinct original IDs, including values unsafe as browser numbers.
    """
    lookup = OriginalParcelLookup(id_type, values)
    app = make_scenario_app(store, lookup)
    with (
        TestClient(app, base_url="https://testserver", headers=HEADERS) as author,
        TestClient(app, base_url="https://testserver", headers=HEADERS) as participant,
        TestClient(app, base_url="https://testserver", headers=HEADERS) as other,
    ):
        document = tool_document()
        created_tool = author.post(BASE, json=document)
        assert created_tool.status_code == 201, created_tool.text
        tool = created_tool.json()
        tool_path = created_tool.headers["location"]
        definition_path = f"{tool_path}/definition"
        scenarios_path = f"{tool_path}/scenarios"
        assert participant.get(definition_path).json() == tool
        assert other.get(definition_path).json() == tool
        assert participant.get(tool_path).status_code == 404
        assert participant.get(BASE).json() == []
        assert (
            participant.put(
                tool_path, json={**document, "expectedRevision": 1}
            ).status_code
            == 404
        )

        created = participant.post(
            scenarios_path, json={"name": "Restore uplands", "expectedToolRevision": 1}
        )
        assert created.status_code == 201, created.text
        scenario = created.json()
        scenario_path = created.headers["location"]
        assert scenario["revision"] == 1
        assert scenario["toolRevision"] == 1
        assert scenario["toolId"] == tool["id"]
        assert set(scenario) == {
            "id",
            "toolId",
            "name",
            "revision",
            "toolRevision",
            "createdAt",
            "updatedAt",
        }
        assert created.headers["cache-control"] == "private, no-store"
        assert created.headers["x-content-type-options"] == "nosniff"
        alternative = participant.post(
            scenarios_path, json={"name": "Alternative", "expectedToolRevision": 1}
        ).json()
        other_scenario = other.post(
            scenarios_path, json={"name": "Their plan", "expectedToolRevision": 1}
        ).json()
        assert {row["id"] for row in participant.get(scenarios_path).json()} == {
            scenario["id"],
            alternative["id"],
        }
        assert [row["id"] for row in other.get(scenarios_path).json()] == [
            other_scenario["id"]
        ]
        assert author.get(scenarios_path).json() == []
        assert (
            participant.get(
                f"/api/planning/scenarios/{other_scenario['id']}"
            ).status_code
            == 404
        )
        first_id = {"type": id_type, "value": values[0]}
        first_choice, second_choice = [
            entry["id"] for entry in document["interventions"]
        ]
        for stranger in (author, other):
            absent_path = f"/api/planning/scenarios/{uuid4()}"
            for path in (scenario_path, absent_path):
                response = stranger.get(path)
                assert response.status_code == 404
                assert response.json() == {"detail": "Scenario not found."}
                assert (
                    stranger.get(f"{path}/assignments?expectedRevision=1").status_code
                    == 404
                )
                assert (
                    stranger.put(
                        path,
                        json={
                            "name": "Stolen",
                            "expectedRevision": 1,
                            "expectedToolRevision": 1,
                        },
                    ).status_code
                    == 404
                )
                assert (
                    stranger.put(
                        f"{path}/assignment",
                        json=assignment_request(scenario, first_id, first_choice),
                    ).status_code
                    == 404
                )
        assert lookup.requests == []
        assert participant.get(
            f"{scenario_path}/assignments?expectedRevision=1"
        ).json() == {"revision": 1, "assignments": [], "offset": 0, "nextOffset": None}

        expected = []
        for value in values[:2]:
            parcel_id = {"type": id_type, "value": value}
            response = participant.put(
                f"{scenario_path}/assignment",
                json=assignment_request(scenario, parcel_id, first_choice),
            )
            assert response.status_code == 200, response.text
            scenario = response.json()
            expected.append({"parcelId": parcel_id, "interventionId": first_choice})
        assert scenario["revision"] == 3
        first_page = participant.get(
            f"{scenario_path}/assignments?expectedRevision=3&limit=1"
        ).json()
        assert first_page == {
            "revision": 3,
            "assignments": expected[:1],
            "offset": 0,
            "nextOffset": 1,
        }
        assert participant.get(
            f"{scenario_path}/assignments?expectedRevision=3&offset=1&limit=1"
        ).json() == {
            "revision": 3,
            "assignments": expected[1:],
            "offset": 1,
            "nextOffset": None,
        }
        alternative_path = f"/api/planning/scenarios/{alternative['id']}"
        response = participant.put(
            f"{alternative_path}/assignment",
            json=assignment_request(alternative, first_id, second_choice),
        )
        assert response.status_code == 200, response.text

        old_request = assignment_request(scenario, first_id, second_choice)
        changed = participant.put(f"{scenario_path}/assignment", json=old_request)
        assert changed.status_code == 200, changed.text
        scenario = changed.json()
        expected[0]["interventionId"] = second_choice
        calls = len(lookup.requests)
        assert (
            participant.put(f"{scenario_path}/assignment", json=old_request).status_code
            == 409
        )
        assert len(lookup.requests) == calls
        assert (
            participant.get(
                f"{scenario_path}/assignments?expectedRevision=3&offset=1"
            ).status_code
            == 409
        )
        cleared = participant.put(
            f"{scenario_path}/assignment",
            json=assignment_request(scenario, first_id, None),
        )
        assert cleared.status_code == 200, cleared.text
        scenario = cleared.json()
        renamed = participant.put(
            scenario_path,
            json={
                "name": "Updated restoration",
                "expectedRevision": scenario["revision"],
                "expectedToolRevision": 1,
            },
        )
        assert renamed.status_code == 200, renamed.text
        scenario = renamed.json()
        assert scenario["name"] == "Updated restoration"
        assert scenario["revision"] == 6
        assert (
            participant.get(f"{scenario_path}/assignments?expectedRevision=6").json()[
                "assignments"
            ]
            == expected[1:]
        )
        assert participant.get(
            f"{alternative_path}/assignments?expectedRevision=2"
        ).json()["assignments"] == [
            {"parcelId": first_id, "interventionId": second_choice}
        ]
        assert (
            other.get(
                f"/api/planning/scenarios/{other_scenario['id']}/assignments?expectedRevision=1"
            ).json()["assignments"]
            == []
        )
        assert len(lookup.requests) == 5
        assert all(
            request.collection_id == "eolab-mounted-vectors"
            for request in lookup.requests
        )
        assert all(
            request.item_id == "regions" and request.idField == "parcel_id"
            for request in lookup.requests
        )
        participant_cookies = dict(participant.cookies)

    lookup.available = False
    restarted_store = PlanningToolStore(store.conninfo)
    with TestClient(
        make_scenario_app(restarted_store, lookup),
        base_url="https://testserver",
        headers=HEADERS,
    ) as restored:
        restored.cookies.update(participant_cookies)
        assert restored.get(scenario_path).json() == scenario
        assert (
            restored.get(f"{scenario_path}/assignments?expectedRevision=6").json()[
                "assignments"
            ]
            == expected[1:]
        )
        assert len(lookup.requests) == 5


def test_filter_edits_preserve_choices_and_require_current_tool_revision(
    store: PlanningToolStore,
) -> None:
    """Exclude then reinclude a parcel without losing its saved intervention.

    Expected result: assignment reads remain identical while the ordinary AOI and
    parcel filters change. Old tool revisions cannot save edits; acknowledging the
    current definition permits editing the original parcel even when filtered out.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    lookup = OriginalParcelLookup("string", ("001",))
    with (
        TestClient(
            make_scenario_app(store, lookup),
            base_url="https://testserver",
            headers=HEADERS,
        ) as author,
        TestClient(
            make_scenario_app(store, lookup),
            base_url="https://testserver",
            headers=HEADERS,
        ) as participant,
    ):
        document = tool_document()
        created_tool = author.post(BASE, json=document)
        tool_path = created_tool.headers["location"]
        created = participant.post(
            f"{tool_path}/scenarios",
            json={"name": "Retained", "expectedToolRevision": 1},
        )
        path, scenario = created.headers["location"], created.json()
        parcel_id = {"type": "string", "value": "001"}
        choice = document["interventions"][0]["id"]
        response = participant.put(
            f"{path}/assignment", json=assignment_request(scenario, parcel_id, choice)
        )
        assert response.status_code == 200, response.text
        scenario = response.json()
        saved = participant.get(f"{path}/assignments?expectedRevision=2").json()
        excluded = deepcopy(document)
        for layer in excluded["layers"]:
            layer["definition"]["filter"] = {
                "enabled": True,
                "match": "all",
                "rules": [{"field": "area", "operator": "gt", "value": 999999}],
            }
        response = author.put(tool_path, json={**excluded, "expectedRevision": 1})
        assert response.status_code == 200, response.text
        assert participant.get(f"{path}/assignments?expectedRevision=2").json() == saved
        stale = participant.put(
            f"{path}/assignment", json=assignment_request(scenario, parcel_id, None)
        )
        assert stale.status_code == 409
        assert len(lookup.requests) == 1
        scenario = participant.get(path).json()
        assert scenario["revision"] == 2
        assert scenario["toolRevision"] == 2
        response = participant.put(
            f"{path}/assignment", json=assignment_request(scenario, parcel_id, choice)
        )
        assert response.status_code == 200, response.text
        assert response.json()["revision"] == 3
        assert len(lookup.requests) == 2
        response = author.put(tool_path, json={**document, "expectedRevision": 2})
        assert response.status_code == 200, response.text
        reincluded = participant.get(f"{path}/assignments?expectedRevision=3").json()
        assert reincluded["assignments"] == saved["assignments"]
        assert participant.get(path).json()["toolRevision"] == 3
        assert (
            participant.post(
                f"{tool_path}/scenarios",
                json={"name": "Stale definition", "expectedToolRevision": 1},
            ).status_code
            == 409
        )
        assert len(participant.get(f"{tool_path}/scenarios").json()) == 1


def test_invalid_assignments_and_http_boundaries_leave_scenario_unchanged(
    store: PlanningToolStore,
) -> None:
    """Reject invalid IDs, interventions and browser requests before persisting data.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    lookup = OriginalParcelLookup("string", ("001",))
    with TestClient(
        make_scenario_app(store, lookup), base_url="https://testserver", headers=HEADERS
    ) as client:
        document = tool_document()
        created_tool = client.post(BASE, json=document)
        tool_path = created_tool.headers["location"]
        created = client.post(
            f"{tool_path}/scenarios",
            json={"name": "Untouched", "expectedToolRevision": 1},
        )
        path, scenario = created.headers["location"], created.json()
        valid = assignment_request(
            scenario,
            {"type": "string", "value": "001"},
            document["interventions"][0]["id"],
        )
        for invalid_id in (
            {"type": "string", "value": "1"},
            {"type": "integer", "value": "1"},
        ):
            response = client.put(
                f"{path}/assignment", json={**valid, "parcelId": invalid_id}
            )
            assert response.status_code == 422, response.text
        assert len(lookup.requests) == 2
        for malformed in (
            {**valid, "interventionId": str(uuid4())},
            {**valid, "parcelId": {"type": "integer", "value": 1}},
            {**valid, "parcelId": {"type": "integer", "value": "01"}},
            {**valid, "parcelId": {"type": "string", "value": " "}},
            {**valid, "geometry": {"type": "Point", "coordinates": [0, 0]}},
            {**valid, "assignments": []},
            {**valid, "expectedRevision": True},
            {**valid, "owner": "other-browser"},
        ):
            response = client.put(f"{path}/assignment", json=malformed)
            assert response.status_code == 422, response.text
            assert response.headers["cache-control"] == "private, no-store"
        assert len(lookup.requests) == 2
        assert (
            client.put(
                f"{path}/assignment", json=valid, headers={"X-EOLab-Planning": ""}
            ).status_code
            == 403
        )
        assert (
            client.put(
                f"{path}/assignment",
                json=valid,
                headers={"Origin": "https://foreign.example"},
            ).status_code
            == 403
        )
        assert (
            client.put(
                f"{path}/assignment",
                json=valid,
                headers={"Sec-Fetch-Site": "cross-site"},
            ).status_code
            == 403
        )
        too_large = client.put(
            f"{path}/assignment", content=b" " * (MAX_REQUEST_BYTES + 1)
        )
        assert too_large.status_code == 413
        for query in (
            "",
            "?expectedRevision=1&limit=501",
            "?expectedRevision=1&offset=-1",
        ):
            assert client.get(f"{path}/assignments{query}").status_code == 422
        lookup.available = False
        assert client.put(f"{path}/assignment", json=valid).status_code == 422
        assert client.get(path).json() == scenario
        assert (
            client.get(f"{path}/assignments?expectedRevision=1").json()["assignments"]
            == []
        )


def test_assignment_disconnect_cancels_lookup_without_saving(
    store: PlanningToolStore,
) -> None:
    """Abandon an in-flight original-ID lookup without changing durable choices.

    Args:
        store: Empty disposable PostgreSQL store.
    """
    tool = store.create_tool(
        "author", PlanningToolDocument.model_validate(tool_document())
    )
    scenario = store.create_scenario(
        "participant", tool.id, CreateScenario(name="Untouched", expectedToolRevision=1)
    )

    async def run_request() -> None:
        """Disconnect the actual assignment endpoint after native lookup starts."""
        started, cancelled = asyncio.Event(), asyncio.Event()

        async def lookup(request: ParcelLookupRequest) -> ParcelLookupResponse:
            """Hold the native-reader boundary until the browser abandons it.

            Args:
                request: Original Catalog identity accepted by the real service.

            Raises:
                asyncio.CancelledError: The assignment request disconnected.
            """
            assert request.parcelId.value == "001"
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise
            raise AssertionError("The held lookup must be cancelled")

        async def receive() -> dict[str, str]:
            """Report disconnection after the lookup is known to be in progress.

            Returns:
                The ASGI disconnect event.
            """
            await started.wait()
            return {"type": "http.disconnect"}

        router = create_planning_scenarios_router(
            PlanningScenarioService(store, lookup_parcel=lookup)
        )
        endpoint = next(
            route.endpoint
            for route in router.routes
            if route.path.endswith("/assignment")
        )
        payload = SetScenarioAssignment(
            parcelId={"type": "string", "value": "001"},
            interventionId=tool.interventions[0].id,
            expectedRevision=1,
            expectedToolRevision=1,
        )
        with pytest.raises(HTTPException) as disconnected:
            await asyncio.wait_for(
                endpoint(
                    scenario.id,
                    payload,
                    Request({"type": "http"}, receive),
                    "participant",
                ),
                timeout=5,
            )
        assert disconnected.value.status_code == 499
        assert cancelled.is_set()

    asyncio.run(run_request())
    assert store.get_scenario("participant", scenario.id) == scenario
    assert (
        store.read_assignments("participant", scenario.id, 1, 0, 100).assignments == []
    )
