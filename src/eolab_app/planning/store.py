"""Persist author-owned Planning definitions and reject stale concurrent updates."""

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

PLANNING_SCHEMA_LOCK_ID = 7_610_619
"""Database-wide advisory identifier used only to serialize Planning schema setup."""


class PlanningToolStore:
    """Store durable tools for their author without reading Catalog or source files."""

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
        """Install the Planning table idempotently without changing existing tools.

        Raises:
            PlanningError: Schema installation could not complete.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "SELECT pg_advisory_xact_lock(%s)", (PLANNING_SCHEMA_LOCK_ID,)
            )
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
        """Atomically replace an author's validated definition at the expected revision.

        Args:
            owner: Requesting browser's server-derived identity.
            identifier: Existing tool identifier.
            expected_revision: Revision rechecked after asynchronous source validation.
            document: Complete validated replacement definition.

        Returns:
            Durable tool with its revision incremented exactly once.

        Raises:
            PlanningError: Ownership, revision or storage prevents the update.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "UPDATE planning.tools SET definition=%s,revision=revision+1,updated_at=clock_timestamp() WHERE id=%s AND owner_hash=%s AND revision=%s RETURNING *",
                (
                    Jsonb(document.model_dump(mode="json", exclude_unset=True)),
                    identifier,
                    owner,
                    expected_revision,
                ),
            )
            row = cursor.fetchone()
            if row is not None:
                return self._read_tool(row)
            cursor.execute(
                "SELECT 1 FROM planning.tools WHERE id=%s AND owner_hash=%s",
                (identifier, owner),
            )
            if cursor.fetchone() is None:
                raise PlanningError(404, "Planning tool not found.")
            raise PlanningError(
                409, "This Planning tool changed in another tab. Reload before saving."
            )
