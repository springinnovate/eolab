"""Persist Planning tools and private parcel scenarios with atomic revision checks."""

from collections.abc import Iterator
from contextlib import contextmanager
from importlib.resources import files
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from eolab_app.planning.models import (
    PlanningError,
    PlanningTool,
    PlanningToolDocument,
    PlanningToolSummary,
)
from eolab_app.planning.scenario_models import (
    CreateScenario,
    RenameScenario,
    Scenario,
    ScenarioAssignment,
    ScenarioAssignmentPage,
    SetScenarioAssignment,
)
from eolab_app.vector.parcel_models import ParcelId

PLANNING_SCHEMA_LOCK_ID = 7_610_619
"""Database-wide advisory identifier used only to serialize Planning schema setup."""


class PlanningToolStore:
    """Store tools and participant-owned scenarios without reading Catalog files.

    Tools are readable through opaque links but writable only by their author.
    Scenarios and assignments are readable and writable only by their browser
    owner. Scenario writes share a lock on the tool definition and lock the
    scenario they edit exclusively. Updating the definition requires an
    exclusive tool lock.
    """

    def __init__(self, conninfo: str = "") -> None:
        """Configure existing PostgreSQL access without connecting at construction.

        Args:
            conninfo: Test connection string; production uses standard PG variables.
        """
        self.conninfo = conninfo

    @contextmanager
    def transaction(self) -> Iterator[psycopg.Cursor[dict[str, Any]]]:
        """Open a short transaction and translate storage failures privately.

        Yields:
            Dictionary cursor committed or rolled back before its connection closes.

        Raises:
            PlanningError: PostgreSQL is unavailable or persisted data is invalid.
        """
        try:
            with psycopg.connect(
                self.conninfo,
                row_factory=dict_row,
                connect_timeout=3,
                options="-c statement_timeout=5000 -c lock_timeout=3000",
            ) as connection:
                with connection.cursor() as cursor:
                    yield cursor
        except (psycopg.Error, ValidationError) as error:
            raise PlanningError(
                503, "Planning storage is unavailable. Try again shortly."
            ) from error

    def initialize_schema(self) -> None:
        """Install Planning tables and indexes, including indexes on existing records.

        Raises:
            PlanningError: Schema installation could not complete.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "SELECT pg_advisory_xact_lock(%s)", (PLANNING_SCHEMA_LOCK_ID,)
            )
            # Building an index on populated tables can take longer than a single edit.
            cursor.execute("SET LOCAL statement_timeout = 0")
            cursor.execute(
                files("eolab_app.planning").joinpath("schema.sql").read_text()
            )

    @staticmethod
    def _read_tool(row: dict[str, Any]) -> PlanningTool:
        """Validate a stored tool without exposing its private author identity.

        Args:
            row: Database definition and public metadata.

        Returns:
            Validated public tool record.

        Raises:
            ValidationError: Persisted JSON or metadata violates the owned contract.
        """
        return PlanningTool.model_validate(
            {
                **row["definition"],
                "id": row["id"],
                "revision": row["revision"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
        )

    def create_tool(self, owner: str, document: PlanningToolDocument) -> PlanningTool:
        """Persist a validated definition under its browser author's identity.

        Args:
            owner: Server-derived browser hash, never accepted in request JSON.
            document: Definition with validated Catalog roles and parcel IDs.

        Returns:
            The new durable tool at revision one.

        Raises:
            PlanningError: Storage or the returned database record is invalid.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "INSERT INTO planning.tools(id,owner_hash,definition) VALUES(%s,%s,%s) RETURNING *",
                (
                    uuid4(),
                    owner,
                    Jsonb(document.model_dump(mode="json", exclude_unset=True)),
                ),
            )
            return self._read_tool(cursor.fetchone())

    def get_tool(self, owner: str, identifier: UUID) -> PlanningTool:
        """Read an author's tool without disclosing whether another author owns its ID.

        Args:
            owner: Requesting browser's server-derived identity.
            identifier: Opaque tool identifier.

        Returns:
            The author's current complete tool definition.

        Raises:
            PlanningError: The tool is unavailable to this author or storage failed.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "SELECT * FROM planning.tools WHERE id=%s AND owner_hash=%s",
                (identifier, owner),
            )
            row = cursor.fetchone()
            if row is None:
                raise PlanningError(404, "Planning tool not found.")
            return self._read_tool(row)

    def list_tools(self, owner: str) -> list[PlanningToolSummary]:
        """List only the requesting author's tools, most recently changed first.

        Args:
            owner: Requesting browser's server-derived identity.

        Returns:
            Summaries without layer definitions or owner hashes.

        Raises:
            PlanningError: Storage or persisted summary data is unavailable.
        """
        with self.transaction() as cursor:
            cursor.execute(
                'SELECT id,definition->>\'title\' AS title,revision,created_at AS "createdAt",updated_at AS "updatedAt" FROM planning.tools WHERE owner_hash=%s ORDER BY updated_at DESC,id',
                (owner,),
            )
            return [
                PlanningToolSummary.model_validate(row) for row in cursor.fetchall()
            ]

    def get_tool_definition(self, identifier: UUID) -> PlanningTool:
        """Read a tool through its opaque participant link without granting author access.

        Args:
            identifier: Tool identifier obtained from a participant link.

        Returns:
            Current tool definition, excluding its author's private identity.

        Raises:
            PlanningError: The tool does not exist or storage is unavailable.
        """
        with self.transaction() as cursor:
            cursor.execute("SELECT * FROM planning.tools WHERE id=%s", (identifier,))
            row = cursor.fetchone()
            if row is None:
                raise PlanningError(404, "Planning tool not found.")
            return self._read_tool(row)

    def require_revision(
        self, owner: str, identifier: UUID, expected_revision: int
    ) -> None:
        """Reject unavailable or stale edits before source validation starts.

        Args:
            owner: Requesting browser's server-derived identity.
            identifier: Existing tool identifier.
            expected_revision: Revision last acknowledged by the author.

        Raises:
            PlanningError: The tool is unavailable or the revision is stale.
        """
        current = self.get_tool(owner, identifier)
        if current.revision != expected_revision:
            raise PlanningError(
                409, "This Planning tool changed in another tab. Reload before saving."
            )

    def update_tool(
        self,
        owner: str,
        identifier: UUID,
        expected_revision: int,
        document: PlanningToolDocument,
    ) -> PlanningTool:
        """Replace an author's definition while preserving existing scenario meanings.

        Once any participant creates a scenario, the original parcel source
        reference, ID field and existing intervention IDs/names cannot change.
        Filters, presentation, AOI and additional interventions remain editable.

        Args:
            owner: Requesting browser's server-derived identity.
            identifier: Existing tool identifier.
            expected_revision: Revision rechecked after asynchronous source validation.
            document: Complete validated replacement definition.

        Returns:
            Durable tool with its revision incremented exactly once.

        Raises:
            PlanningError: Ownership, revision, existing scenarios or storage
                prevents the update.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "SELECT * FROM planning.tools WHERE id=%s AND owner_hash=%s FOR UPDATE",
                (identifier, owner),
            )
            row = cursor.fetchone()
            if row is None:
                raise PlanningError(404, "Planning tool not found.")
            current = self._read_tool(row)
            if current.revision != expected_revision:
                raise PlanningError(
                    409,
                    "This Planning tool changed in another tab. Reload before saving.",
                )
            cursor.execute(
                "SELECT 1 FROM planning.scenarios WHERE tool_id=%s LIMIT 1",
                (identifier,),
            )
            if cursor.fetchone() is not None:
                self._require_preserved_scenario_choices(current, document)
            cursor.execute(
                "UPDATE planning.tools SET definition=%s,revision=revision+1,updated_at=clock_timestamp() WHERE id=%s RETURNING *",
                (
                    Jsonb(document.model_dump(mode="json", exclude_unset=True)),
                    identifier,
                ),
            )
            return self._read_tool(cursor.fetchone())

    @staticmethod
    def _require_preserved_scenario_choices(
        current: PlanningTool, replacement: PlanningToolDocument
    ) -> None:
        """Reject definition edits that would reinterpret existing parcel choices.

        Args:
            current: Locked current definition with at least one saved scenario.
            replacement: Validated proposed definition.

        Raises:
            PlanningError: Parcel identity or an existing intervention would change.
        """
        old_parcels = next(
            layer for layer in current.layers if layer.id == current.parcelLayerId
        ).source_identity()
        new_parcels = next(
            layer
            for layer in replacement.layers
            if layer.id == replacement.parcelLayerId
        ).source_identity()
        old_choices = {(choice.id, choice.label) for choice in current.interventions}
        new_choices = {
            (choice.id, choice.label) for choice in replacement.interventions
        }
        if (old_parcels, current.parcelIdField) != (
            new_parcels,
            replacement.parcelIdField,
        ) or not old_choices.issubset(new_choices):
            raise PlanningError(
                409,
                "This tool has saved scenarios. Create a new tool to change the parcel "
                "source, parcel ID field, or existing intervention names and choices.",
            )

    @staticmethod
    def _read_scenario(row: dict[str, Any]) -> Scenario:
        """Validate stored scenario metadata and its current tool revision.

        Args:
            row: Scenario database row with a tool_revision column.

        Returns:
            Public metadata without the participant's private identity.

        Raises:
            ValidationError: Persisted metadata violates the scenario contract.
        """
        return Scenario(
            id=row["id"],
            toolId=row["tool_id"],
            name=row["name"],
            revision=row["revision"],
            toolRevision=row["tool_revision"],
            createdAt=row["created_at"],
            updatedAt=row["updated_at"],
        )

    @staticmethod
    def _require_scenario_revisions(
        scenario: Scenario, expected_revision: int, expected_tool_revision: int
    ) -> None:
        """Reject a save against an unacknowledged scenario or tool definition.

        Args:
            scenario: Current owned scenario metadata.
            expected_revision: Scenario revision acknowledged by the participant.
            expected_tool_revision: Tool revision acknowledged by the participant.

        Raises:
            PlanningError: Either revision changed since the participant's read.
        """
        if scenario.toolRevision != expected_tool_revision:
            raise PlanningError(
                409, "This Planning tool changed. Reload it before saving the scenario."
            )
        if scenario.revision != expected_revision:
            raise PlanningError(
                409, "This scenario changed in another tab. Reload before saving."
            )

    def create_scenario(
        self, owner: str, tool_id: UUID, request: CreateScenario
    ) -> Scenario:
        """Create one empty private scenario without changing the linked tool.

        Args:
            owner: Participant browser's server-derived identity.
            tool_id: Tool identifier from the participant link.
            request: Name and last acknowledged tool revision.

        Returns:
            New scenario metadata at revision one.

        Raises:
            PlanningError: The tool is missing, changed, or storage is unavailable.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "SELECT * FROM planning.tools WHERE id=%s FOR SHARE", (tool_id,)
            )
            row = cursor.fetchone()
            if row is None:
                raise PlanningError(404, "Planning tool not found.")
            tool = self._read_tool(row)
            if tool.revision != request.expectedToolRevision:
                raise PlanningError(
                    409,
                    "This Planning tool changed. Reload it before creating a scenario.",
                )
            cursor.execute(
                "INSERT INTO planning.scenarios(id,tool_id,owner_hash,name) VALUES(%s,%s,%s,%s) RETURNING *",
                (uuid4(), tool_id, owner, request.name),
            )
            return self._read_scenario(
                {**cursor.fetchone(), "tool_revision": tool.revision}
            )

    def list_scenarios(self, owner: str, tool_id: UUID) -> list[Scenario]:
        """List this participant's scenarios for one linked tool, newest edit first.

        Args:
            owner: Participant browser's server-derived identity.
            tool_id: Opaque tool identifier.

        Returns:
            Owned metadata only, excluding every other participant's scenarios.

        Raises:
            PlanningError: The tool is missing or storage is unavailable.
        """
        with self.transaction() as cursor:
            cursor.execute("SELECT 1 FROM planning.tools WHERE id=%s", (tool_id,))
            if cursor.fetchone() is None:
                raise PlanningError(404, "Planning tool not found.")
            cursor.execute(
                "SELECT s.*,t.revision AS tool_revision FROM planning.scenarios s "
                "JOIN planning.tools t ON t.id=s.tool_id "
                "WHERE s.tool_id=%s AND s.owner_hash=%s ORDER BY s.updated_at DESC,s.id",
                (tool_id, owner),
            )
            return [self._read_scenario(row) for row in cursor.fetchall()]

    def get_scenario(self, owner: str, identifier: UUID) -> Scenario:
        """Read private scenario metadata independently of Catalog availability.

        Args:
            owner: Participant browser's server-derived identity.
            identifier: Opaque scenario identifier.

        Returns:
            Current owned metadata and the current linked tool revision.

        Raises:
            PlanningError: The scenario is missing, belongs to another browser,
                or storage is unavailable.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "SELECT s.*,t.revision AS tool_revision FROM planning.scenarios s "
                "JOIN planning.tools t ON t.id=s.tool_id WHERE s.id=%s AND s.owner_hash=%s",
                (identifier, owner),
            )
            row = cursor.fetchone()
            if row is None:
                raise PlanningError(404, "Scenario not found.")
            return self._read_scenario(row)

    def get_scenario_tool_for_edit(
        self,
        owner: str,
        identifier: UUID,
        expected_revision: int,
        expected_tool_revision: int,
    ) -> PlanningTool:
        """Return the scenario's tool after checking ownership and both revisions.

        Call before native parcel validation; the write transaction rechecks revisions.

        Args:
            owner: Participant browser's server-derived identity.
            identifier: Opaque scenario identifier.
            expected_revision: Last acknowledged scenario revision.
            expected_tool_revision: Last acknowledged tool revision.

        Returns:
            Current linked tool definition for this participant's scenario.

        Raises:
            PlanningError: Ownership, revisions or storage prevent editing.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "SELECT s.*,t.revision AS tool_revision,t.definition,"
                "t.created_at AS tool_created_at,t.updated_at AS tool_updated_at "
                "FROM planning.scenarios s JOIN planning.tools t ON t.id=s.tool_id "
                "WHERE s.id=%s AND s.owner_hash=%s",
                (identifier, owner),
            )
            row = cursor.fetchone()
            if row is None:
                raise PlanningError(404, "Scenario not found.")
            scenario = self._read_scenario(row)
            self._require_scenario_revisions(
                scenario, expected_revision, expected_tool_revision
            )
            tool = self._read_tool(
                {
                    "definition": row["definition"],
                    "id": row["tool_id"],
                    "revision": row["tool_revision"],
                    "created_at": row["tool_created_at"],
                    "updated_at": row["tool_updated_at"],
                }
            )
            return tool

    def _lock_scenario_for_edit(
        self,
        cursor: psycopg.Cursor[dict[str, Any]],
        owner: str,
        identifier: UUID,
        expected_revision: int,
        expected_tool_revision: int,
    ) -> PlanningTool:
        """Hold the tool definition stable and lock the owned scenario for editing.

        Take the shared tool lock first, then recheck both revisions after
        acquiring the scenario's exclusive lock.

        Args:
            cursor: Current short Planning transaction.
            owner: Participant browser's server-derived identity.
            identifier: Opaque scenario identifier.
            expected_revision: Scenario revision to recheck after native validation.
            expected_tool_revision: Tool revision to recheck after native validation.

        Returns:
            Linked tool definition after locking the tool and owned scenario.

        Raises:
            PlanningError: The scenario is unavailable or a revision changed.
        """
        cursor.execute(
            "SELECT tool_id FROM planning.scenarios WHERE id=%s AND owner_hash=%s",
            (identifier, owner),
        )
        reference = cursor.fetchone()
        if reference is None:
            raise PlanningError(404, "Scenario not found.")
        cursor.execute(
            "SELECT * FROM planning.tools WHERE id=%s FOR SHARE",
            (reference["tool_id"],),
        )
        tool = self._read_tool(cursor.fetchone())
        cursor.execute(
            "SELECT * FROM planning.scenarios WHERE id=%s AND owner_hash=%s FOR UPDATE",
            (identifier, owner),
        )
        scenario = self._read_scenario(
            {**cursor.fetchone(), "tool_revision": tool.revision}
        )
        self._require_scenario_revisions(
            scenario, expected_revision, expected_tool_revision
        )
        return tool

    def rename_scenario(
        self, owner: str, identifier: UUID, request: RenameScenario
    ) -> Scenario:
        """Rename an owned scenario atomically without touching its saved choices.

        Args:
            owner: Participant browser's server-derived identity.
            identifier: Opaque scenario identifier.
            request: New name and both acknowledged revisions.

        Returns:
            Metadata with exactly one scenario revision increment.

        Raises:
            PlanningError: Ownership, revisions or storage prevent the rename.
        """
        with self.transaction() as cursor:
            tool = self._lock_scenario_for_edit(
                cursor,
                owner,
                identifier,
                request.expectedRevision,
                request.expectedToolRevision,
            )
            cursor.execute(
                "UPDATE planning.scenarios SET name=%s,revision=revision+1,updated_at=clock_timestamp() WHERE id=%s RETURNING *",
                (request.name, identifier),
            )
            return self._read_scenario(
                {**cursor.fetchone(), "tool_revision": tool.revision}
            )

    def set_assignment(
        self, owner: str, identifier: UUID, request: SetScenarioAssignment
    ) -> Scenario:
        """Save or clear one validated original parcel choice under both row locks.

        The caller checks the source's assignment rules before this transaction.
        This permits clearing a deleted drawing polygon's stored choice.
        The index narrows candidates by scenario, parcel type and hash. Exact
        value comparison distinguishes collisions. The scenario lock serializes insertions.

        Args:
            owner: Participant browser's server-derived identity.
            identifier: Opaque scenario identifier.
            request: Validated parcel, nullable choice and acknowledged revisions.

        Returns:
            Metadata with one revision increment, including a repeated or empty clear.

        Raises:
            PlanningError: Ownership, revisions, allowed choices or storage prevent saving.
        """
        with self.transaction() as cursor:
            tool = self._lock_scenario_for_edit(
                cursor,
                owner,
                identifier,
                request.expectedRevision,
                request.expectedToolRevision,
            )
            if request.interventionId is not None and not any(
                choice.id == request.interventionId for choice in tool.interventions
            ):
                raise PlanningError(
                    422, "Choose an intervention allowed by this Planning tool."
                )
            cursor.execute(
                "SELECT id FROM planning.scenario_assignments "
                "WHERE scenario_id=%(scenario)s AND parcel_id_type=%(type)s "
                "AND hashtext(parcel_id_value)=hashtext(%(value)s) AND parcel_id_value=%(value)s",
                {
                    "scenario": identifier,
                    "type": request.parcelId.type,
                    "value": request.parcelId.value,
                },
            )
            existing = cursor.fetchone()
            if request.interventionId is None:
                if existing is not None:
                    cursor.execute(
                        "DELETE FROM planning.scenario_assignments WHERE id=%s",
                        (existing["id"],),
                    )
            elif existing is not None:
                cursor.execute(
                    "UPDATE planning.scenario_assignments SET intervention_id=%s WHERE id=%s",
                    (request.interventionId, existing["id"]),
                )
            else:
                cursor.execute(
                    "INSERT INTO planning.scenario_assignments"
                    "(scenario_id,parcel_id_type,parcel_id_value,intervention_id) VALUES(%s,%s,%s,%s)",
                    (
                        identifier,
                        request.parcelId.type,
                        request.parcelId.value,
                        request.interventionId,
                    ),
                )
            cursor.execute(
                "UPDATE planning.scenarios SET revision=revision+1,updated_at=clock_timestamp() WHERE id=%s RETURNING *",
                (identifier,),
            )
            return self._read_scenario(
                {**cursor.fetchone(), "tool_revision": tool.revision}
            )

    def read_assignments(
        self,
        owner: str,
        identifier: UUID,
        expected_revision: int,
        offset: int,
        limit: int,
    ) -> ScenarioAssignmentPage:
        """Page all saved choices at one acknowledged revision, without source reads.

        A scenario share lock keeps the revision check and returned page atomic
        with assignment writes. Current AOI and view filters never omit choices.

        Args:
            owner: Participant browser's server-derived identity.
            identifier: Opaque scenario identifier.
            expected_revision: Revision required for every page of this read.
            offset: Validated nonnegative number of saved choices to skip.
            limit: Validated page size from one through 500.

        Returns:
            Typed assignments in insertion order and the next offset, if any.

        Raises:
            PlanningError: Ownership, revision or storage prevents reading.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "SELECT revision FROM planning.scenarios WHERE id=%s AND owner_hash=%s FOR SHARE",
                (identifier, owner),
            )
            scenario = cursor.fetchone()
            if scenario is None:
                raise PlanningError(404, "Scenario not found.")
            if scenario["revision"] != expected_revision:
                raise PlanningError(
                    409, "This scenario changed. Reload its saved assignments."
                )
            cursor.execute(
                "SELECT parcel_id_type,parcel_id_value,intervention_id "
                "FROM planning.scenario_assignments WHERE scenario_id=%s "
                "ORDER BY id LIMIT %s OFFSET %s",
                (identifier, limit + 1, offset),
            )
            rows = cursor.fetchall()
            return ScenarioAssignmentPage(
                revision=scenario["revision"],
                assignments=[
                    ScenarioAssignment(
                        parcelId=ParcelId(
                            type=row["parcel_id_type"], value=row["parcel_id_value"]
                        ),
                        interventionId=row["intervention_id"],
                    )
                    for row in rows[:limit]
                ],
                offset=offset,
                nextOffset=offset + limit if len(rows) > limit else None,
            )
