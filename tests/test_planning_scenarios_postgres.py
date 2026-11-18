"""Verify private scenario persistence and atomic edits against real PostgreSQL."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from threading import Barrier
from unittest.mock import patch
from uuid import UUID, uuid4

import pytest

from eolab_app.attribute_filter import VectorFilter
from eolab_app.catalog_selection import CatalogSelection
from eolab_app.planning.models import PlanningError, PlanningTool, PlanningToolDocument
from eolab_app.planning.scenario_models import (
    CreateScenario,
    RenameScenario,
    Scenario,
    SetScenarioAssignment,
)
from eolab_app.planning.scenario_service import PlanningScenarioService
from eolab_app.planning.store import PlanningToolStore
from eolab_app.vector.parcel_models import (
    ParcelId,
    ParcelLookupRequest,
    ParcelLookupResponse,
)
from test_planning_tools import tool_document
from test_planning_tools_postgres import store


def create_tool_and_scenario(store: PlanningToolStore) -> tuple[PlanningTool, Scenario]:
    """Create a tool and an empty scenario owned by different fixture browsers.

    Args:
        store: Empty real PostgreSQL Planning store.

    Returns:
        Author-owned tool and participant-owned scenario at revision one.
    """
    tool = store.create_tool(
        "author", PlanningToolDocument.model_validate(tool_document())
    )
    scenario = store.create_scenario(
        "participant",
        tool.id,
        CreateScenario(name="Restoration", expectedToolRevision=1),
    )
    return tool, scenario


def assignment_request(
    scenario: Scenario, value: str, intervention: UUID | None, *, integer: bool = False
) -> SetScenarioAssignment:
    """Build a one-parcel save using the fixture's acknowledged revisions.

    Args:
        scenario: Metadata last read by the participant.
        value: Original string or canonical decimal parcel ID.
        intervention: Allowed intervention, or null to clear.
        integer: Whether the source ID is integer rather than string.

    Returns:
        Validated assignment request with its original type and spelling.
    """
    return SetScenarioAssignment(
        parcelId=ParcelId(type="integer" if integer else "string", value=value),
        interventionId=intervention,
        expectedRevision=scenario.revision,
        expectedToolRevision=scenario.toolRevision,
    )


def test_owned_scenarios_survive_restart_and_remain_independent(
    store: PlanningToolStore,
) -> None:
    """Keep each participant's metadata and choices private across store restart.

    Args:
        store: Empty real PostgreSQL Planning store.
    """
    tool, first = create_tool_and_scenario(store)
    second = store.create_scenario(
        "participant", tool.id, CreateScenario(name="Farming", expectedToolRevision=1)
    )
    stranger = store.create_scenario(
        "stranger", tool.id, CreateScenario(name="Other plan", expectedToolRevision=1)
    )
    saved = store.set_assignment(
        "participant",
        first.id,
        assignment_request(first, "parcel-01", tool.interventions[0].id),
    )
    renamed = store.rename_scenario(
        "participant",
        first.id,
        RenameScenario(
            name="Riparian restoration", expectedRevision=2, expectedToolRevision=1
        ),
    )
    restarted = PlanningToolStore(store.conninfo)
    restarted.initialize_schema()
    assert restarted.get_tool_definition(tool.id) == tool
    assert restarted.get_scenario("participant", first.id) == renamed
    assert renamed.revision == 3
    assert renamed.createdAt == first.createdAt
    assert saved.revision == 2
    assert {row.id for row in restarted.list_scenarios("participant", tool.id)} == {
        first.id,
        second.id,
    }
    assert restarted.list_scenarios("stranger", tool.id) == [stranger]
    assert restarted.list_scenarios("author", tool.id) == []
    assert (
        restarted.read_assignments("participant", first.id, 3, 0, 100)
        .assignments[0]
        .parcelId.value
        == "parcel-01"
    )
    assert (
        restarted.read_assignments("participant", second.id, 1, 0, 100).assignments
        == []
    )
    for foreign_id in (first.id, uuid4()):
        with pytest.raises(PlanningError) as inaccessible:
            restarted.get_scenario("stranger", foreign_id)
        assert inaccessible.value.status == 404
        with pytest.raises(PlanningError) as inaccessible_page:
            restarted.read_assignments("stranger", foreign_id, 999, 0, 100)
        assert inaccessible_page.value.status == 404
        with pytest.raises(PlanningError) as inaccessible_edit:
            restarted.rename_scenario(
                "stranger",
                foreign_id,
                RenameScenario(
                    name="Stolen", expectedRevision=999, expectedToolRevision=999
                ),
            )
        assert inaccessible_edit.value.status == 404
    with pytest.raises(PlanningError) as not_author:
        restarted.get_tool("participant", tool.id)
    assert not_author.value.status == 404
    assert "owner_hash" not in renamed.model_dump()


def test_assignment_pages_preserve_typed_long_ids_and_changes(
    store: PlanningToolStore,
) -> None:
    """Store exact typed IDs, page saved choices and distinguish clearing from a choice.

    Args:
        store: Empty real PostgreSQL Planning store.
    """
    tool, scenario = create_tool_and_scenario(store)
    long_id = " parcel/" + "".join(uuid4().hex for _ in range(512)) + "溪流🌳 "
    ids = [
        ParcelId(type="integer", value="42"),
        ParcelId(type="string", value="42"),
        ParcelId(type="string", value=long_id),
    ]
    for parcel_id in ids:
        scenario = store.set_assignment(
            "participant",
            scenario.id,
            assignment_request(
                scenario,
                parcel_id.value,
                tool.interventions[0].id,
                integer=parcel_id.type == "integer",
            ),
        )
    first_page = store.read_assignments("participant", scenario.id, 4, 0, 2)
    second_page = store.read_assignments("participant", scenario.id, 4, 2, 2)
    assert [
        choice.parcelId for choice in first_page.assignments + second_page.assignments
    ] == ids
    assert first_page.nextOffset == 2
    assert second_page.nextOffset is None
    changed = store.set_assignment(
        "participant",
        scenario.id,
        assignment_request(scenario, "42", tool.interventions[1].id),
    )
    with pytest.raises(PlanningError) as stale_page:
        store.read_assignments("participant", scenario.id, 4, 2, 2)
    assert stale_page.value.status == 409
    choices = store.read_assignments(
        "participant", scenario.id, changed.revision, 0, 100
    ).assignments
    assert [choice.interventionId for choice in choices] == [
        tool.interventions[0].id,
        tool.interventions[1].id,
        tool.interventions[0].id,
    ]
    cleared = store.set_assignment(
        "participant", scenario.id, assignment_request(changed, "42", None)
    )
    remaining = store.read_assignments(
        "participant", scenario.id, cleared.revision, 0, 100
    ).assignments
    assert [choice.parcelId for choice in remaining] == [ids[0], ids[2]]
    assert (
        store.read_assignments(
            "participant", scenario.id, cleared.revision, 500, 100
        ).assignments
        == []
    )
    with pytest.raises(PlanningError) as invalid_choice:
        store.set_assignment(
            "participant", scenario.id, assignment_request(cleared, "42", uuid4())
        )
    assert invalid_choice.value.status == 422
    assert store.get_scenario("participant", scenario.id) == cleared


@pytest.mark.parametrize("change", ["source", "id_field", "remove", "rename"])
def test_existing_scenario_freezes_parcel_and_intervention_meanings(
    store: PlanningToolStore,
    change: str,
) -> None:
    """Reject reinterpretation even when another participant's scenario is empty.

    Args:
        store: Empty real PostgreSQL Planning store.
        change: Meaning-changing author edit to attempt.
    """
    tool, scenario = create_tool_and_scenario(store)
    original = store.get_tool("author", tool.id)
    replacement = original.model_dump(
        exclude={"id", "revision", "createdAt", "updatedAt"}, exclude_unset=True
    )
    if change == "source":
        replacement["layers"][1]["definition"]["catalogItem"][
            "id"
        ] = "different-parcels"
    elif change == "id_field":
        replacement["parcelIdField"] = "another_id"
    elif change == "remove":
        replacement["interventions"].pop()
    else:
        replacement["interventions"][0]["label"] = "Different restoration"
    with pytest.raises(PlanningError) as failure:
        store.update_tool(
            "author", tool.id, 1, PlanningToolDocument.model_validate(replacement)
        )
    assert failure.value.status == 409
    assert "saved scenarios" in str(failure.value)
    assert store.get_tool("author", tool.id) == original
    assert store.get_scenario("participant", scenario.id) == scenario


def test_tool_filters_views_and_new_choices_preserve_saved_assignments(
    store: PlanningToolStore,
) -> None:
    """Permit scope and presentation edits while retaining excluded parcel choices.

    Args:
        store: Empty real PostgreSQL Planning store.
    """
    tool, scenario = create_tool_and_scenario(store)
    scenario = store.set_assignment(
        "participant",
        scenario.id,
        assignment_request(scenario, "outside-new-filter", tool.interventions[0].id),
    )
    replacement = tool.model_dump(
        exclude={"id", "revision", "createdAt", "updatedAt"}, exclude_unset=True
    )
    replacement["title"] = "A revised planning view"
    replacement["layers"][0]["definition"]["catalogItem"]["id"] = "another-watershed"
    replacement["layers"][1]["definition"]["filter"]["rules"] = [
        {"field": "area", "operator": "gt", "value": 999999}
    ]
    replacement["layers"][1]["definition"]["opacity"] = 0.2
    replacement["layers"][1]["id"] = uuid4()
    replacement["parcelLayerId"] = replacement["layers"][1]["id"]
    replacement["interventions"].append({"id": uuid4(), "label": "Wetland restoration"})
    updated = store.update_tool(
        "author", tool.id, 1, PlanningToolDocument.model_validate(replacement)
    )
    assert updated.revision == 2
    refreshed = store.get_scenario("participant", scenario.id)
    assert refreshed.revision == scenario.revision
    assert refreshed.toolRevision == 2
    assert (
        store.read_assignments("participant", scenario.id, scenario.revision, 0, 100)
        .assignments[0]
        .parcelId.value
        == "outside-new-filter"
    )
    with pytest.raises(PlanningError) as old_definition:
        store.set_assignment(
            "participant",
            scenario.id,
            assignment_request(scenario, "outside-new-filter", None),
        )
    assert old_definition.value.status == 409
    cleared = store.set_assignment(
        "participant",
        scenario.id,
        assignment_request(refreshed, "outside-new-filter", None),
    )
    assert (
        store.read_assignments(
            "participant", scenario.id, cleared.revision, 0, 100
        ).assignments
        == []
    )


def test_only_one_concurrent_assignment_saves_at_a_revision(
    store: PlanningToolStore,
) -> None:
    """Serialize two participant tabs without inserting duplicate parcel choices.

    Args:
        store: Empty real PostgreSQL Planning store.
    """
    tool, scenario = create_tool_and_scenario(store)
    start = Barrier(2)

    def assign(intervention: UUID) -> int:
        """Attempt one competing assignment at the same initial revision.

        Args:
            intervention: One of the tool's allowed choices.

        Returns:
            Success or conflict HTTP-equivalent status.
        """
        start.wait(timeout=5)
        try:
            store.set_assignment(
                "participant",
                scenario.id,
                assignment_request(scenario, "same-parcel", intervention),
            )
            return 200
        except PlanningError as error:
            return error.status

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(assign, [choice.id for choice in tool.interventions]))
    assert sorted(statuses) == [200, 409]
    page = store.read_assignments("participant", scenario.id, 2, 0, 100)
    assert len(page.assignments) == 1
    assert (
        page.assignments[0].interventionId == tool.interventions[statuses.index(200)].id
    )


def test_participant_can_create_and_save_while_another_scenario_save_is_open(
    store: PlanningToolStore,
) -> None:
    """Commit a second participant's choice while the first save is uncommitted.

    Args:
        store: Empty real PostgreSQL Planning store.
    """
    tool, first = create_tool_and_scenario(store)
    with store.transaction() as first_transaction:
        # Keep the first save open while the other participant uses a new connection.
        with patch.object(
            store, "transaction", return_value=nullcontext(first_transaction)
        ):
            store.set_assignment(
                "participant",
                first.id,
                assignment_request(first, "parcel-1", tool.interventions[0].id),
            )
        second = store.create_scenario(
            "neighbor",
            tool.id,
            CreateScenario(name="Neighbor's plan", expectedToolRevision=tool.revision),
        )
        choice = assignment_request(second, "parcel-1", tool.interventions[1].id)
        saved = store.set_assignment("neighbor", second.id, choice)
        page = store.read_assignments("neighbor", second.id, saved.revision, 0, 1)
        assert [(row.parcelId, row.interventionId) for row in page.assignments] == [
            (choice.parcelId, choice.interventionId)
        ]


def test_first_scenario_serializes_with_meaning_changing_tool_update(
    store: PlanningToolStore,
) -> None:
    """Allow either create or definition replacement to win, never both old assumptions.

    Args:
        store: Empty real PostgreSQL Planning store.
    """
    document = PlanningToolDocument.model_validate(tool_document())
    tool = store.create_tool("author", document)
    replacement = document.model_copy(update={"parcelIdField": "new_original_id"})
    start = Barrier(2)

    def change(operation: str) -> int:
        """Race one initial scenario against an author changing parcel identity.

        Args:
            operation: Either create a scenario or change the tool definition.

        Returns:
            Success or conflict HTTP-equivalent status.
        """
        start.wait(timeout=5)
        try:
            if operation == "create":
                store.create_scenario(
                    "participant",
                    tool.id,
                    CreateScenario(name="Plan", expectedToolRevision=1),
                )
            else:
                store.update_tool("author", tool.id, 1, replacement)
            return 200
        except PlanningError as error:
            return error.status

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(change, ["create", "update"]))
    assert sorted(statuses) == [200, 409]
    current = store.get_tool_definition(tool.id)
    scenarios = store.list_scenarios("participant", tool.id)
    if statuses[0] == 200:
        assert current.parcelIdField == document.parcelIdField
        assert len(scenarios) == 1
    else:
        assert current.parcelIdField == "new_original_id"
        assert scenarios == []


@pytest.mark.parametrize("concurrent_edit", ["scenario", "tool"])
def test_native_validation_has_no_database_locks_and_rechecks_both_revisions(
    store: PlanningToolStore,
    concurrent_edit: str,
) -> None:
    """Permit a concurrent save during native validation and reject its stale result.

    Args:
        store: Empty real PostgreSQL Planning store.
        concurrent_edit: Whether the callback changes scenario or tool metadata.
    """
    tool, scenario = create_tool_and_scenario(store)
    lookup_requests: list[ParcelLookupRequest] = []

    async def lookup(request: ParcelLookupRequest) -> ParcelLookupResponse:
        """Perform a concurrent database edit while the native lookup is outstanding.

        Args:
            request: Whole-source typed parcel lookup, without view filters.

        Returns:
            A successful original membership result after another tab has saved.
        """
        lookup_requests.append(request)
        if concurrent_edit == "scenario":
            await asyncio.to_thread(
                store.rename_scenario,
                "participant",
                scenario.id,
                RenameScenario(
                    name="Other tab", expectedRevision=1, expectedToolRevision=1
                ),
            )
        else:
            document = PlanningToolDocument.model_validate(
                tool.model_dump(
                    exclude={"id", "revision", "createdAt", "updatedAt"},
                    exclude_unset=True,
                )
            ).model_copy(update={"title": "Updated tool"})
            await asyncio.to_thread(store.update_tool, "author", tool.id, 1, document)
        return ParcelLookupResponse(
            found=True,
            selection=CatalogSelection(
                collectionId=request.collection_id,
                itemId=request.item_id,
                assetKey="data",
                layerName="regions",
                filter=VectorFilter(),
            ),
        )

    service = PlanningScenarioService(store, lookup)
    with pytest.raises(PlanningError) as stale:
        asyncio.run(
            service.set_assignment(
                "participant",
                scenario.id,
                assignment_request(
                    scenario, "outside-filter", tool.interventions[0].id
                ),
            )
        )
    assert stale.value.status == 409
    assert len(lookup_requests) == 1
    assert set(lookup_requests[0].model_dump(by_alias=True)) == {
        "collectionId",
        "itemId",
        "idField",
        "parcelId",
    }
    current = store.get_scenario("participant", scenario.id)
    assert (
        store.read_assignments(
            "participant", scenario.id, current.revision, 0, 100
        ).assignments
        == []
    )


def test_invalid_stored_assignment_is_not_silently_returned(
    store: PlanningToolStore,
) -> None:
    """Validate persisted original parcel values when materializing assignment pages.

    Args:
        store: Empty real PostgreSQL Planning store.
    """
    tool, scenario = create_tool_and_scenario(store)
    scenario = store.set_assignment(
        "participant",
        scenario.id,
        assignment_request(scenario, "valid-id", tool.interventions[0].id),
    )
    with store.transaction() as cursor:
        cursor.execute(
            "UPDATE planning.scenario_assignments SET parcel_id_value=' ' WHERE scenario_id=%s",
            (scenario.id,),
        )
    with pytest.raises(PlanningError) as invalid:
        store.read_assignments("participant", scenario.id, scenario.revision, 0, 100)
    assert invalid.value.status == 503
    assert "Planning storage" in str(invalid.value)
