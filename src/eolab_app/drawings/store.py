"""Persist original drawing sources with private writes and opaque read references."""

from collections.abc import Iterator
from contextlib import contextmanager
from importlib.resources import files
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from eolab_app.drawings.models import (
    CreateDrawingLayer,
    DrawingError,
    DrawingLayer,
    DrawingLayerSummary,
    UpdateDrawingLayer,
)

DRAWING_SCHEMA_LOCK_ID = 7_610_743
"""Database advisory lock used only to serialize drawing-source schema creation."""


class DrawingLayerStore:
    """Own reusable source geometry without depending on Planning or rendering.

    Removing a source's map view does not remove this data. Sources have no
    automatic expiry; owner revisions control changes to the original collection.
    """

    def __init__(self, conninfo: str = "") -> None:
        """Configure PostgreSQL without connecting until an operation is requested.

        Args:
            conninfo: Explicit test connection string; production uses PG environment.
        """
        self.conninfo = conninfo

    @contextmanager
    def transaction(self) -> Iterator[psycopg.Cursor[dict[str, Any]]]:
        """Commit a short source operation or translate storage failures privately.

        Yields:
            Dictionary cursor whose transaction ends before the connection closes.

        Raises:
            DrawingError: Storage is unavailable or persisted source data is invalid.
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
            raise DrawingError(
                503, "Drawing storage is unavailable. Try again shortly."
            ) from error

    def initialize_schema(self) -> None:
        """Create source tables idempotently without changing existing drawings.

        Raises:
            DrawingError: Schema initialization cannot complete.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "SELECT pg_advisory_xact_lock(%s)", (DRAWING_SCHEMA_LOCK_ID,)
            )
            cursor.execute(
                files("eolab_app.drawings").joinpath("schema.sql").read_text()
            )

    @staticmethod
    def _read_layer(row: dict[str, Any], owner: str | None) -> DrawingLayer:
        """Validate persisted source data and derive write permission for this caller.

        Args:
            row: Complete source database record.
            owner: Browser owner hash, or None for a read-only internal consumer.

        Returns:
            Public source data without the owner's hash or local device identity.

        Raises:
            ValidationError: Stored source data violates its published contract.
        """
        return DrawingLayer(
            id=row["id"],
            revision=row["revision"],
            collection=row["collection"],
            canEdit=owner is not None and row["owner_hash"] == owner,
            createdAt=row["created_at"],
            updatedAt=row["updated_at"],
        )

    def create_layer(self, owner: str, request: CreateDrawingLayer) -> DrawingLayer:
        """Create one original source or return an identical retry of the same drawing.

        The browser/local-ID uniqueness constraint serializes competing creates.
        A changed retry never overwrites the current source or receives a revision
        that could disguise an intervening edit as an initial creation.

        Args:
            owner: Server-derived browser identity.
            request: Local layer identity and validated full polygon collection.

        Returns:
            New source at revision one, or its identical current persisted version.

        Raises:
            DrawingError: The local ID already names different source data or storage failed.
        """
        collection = request.collection.model_dump(mode="json")
        with self.transaction() as cursor:
            cursor.execute(
                "INSERT INTO drawings.layers(id,owner_hash,local_layer_id,collection) "
                "VALUES(%s,%s,%s,%s) ON CONFLICT(owner_hash,local_layer_id) DO NOTHING RETURNING *",
                (uuid4(), owner, request.localLayerId, Jsonb(collection)),
            )
            row = cursor.fetchone()
            if row is None:
                cursor.execute(
                    "SELECT * FROM drawings.layers WHERE owner_hash=%s AND local_layer_id=%s",
                    (owner, request.localLayerId),
                )
                row = cursor.fetchone()
                if row["collection"] != collection:
                    raise DrawingError(
                        409,
                        "This drawing already has a linked source with different polygons. "
                        "Reload the linked drawing before saving changes.",
                    )
            return self._read_layer(row, owner)

    def read_layer(self, identifier: UUID, owner: str | None = None) -> DrawingLayer:
        """Read the current source through its opaque reference without granting edits.

        Args:
            identifier: Opaque source UUID retained by a map or Planning tool.
            owner: Optional browser identity used only to derive canEdit.

        Returns:
            Current full collection, revision and caller's write permission.

        Raises:
            DrawingError: The source does not exist or storage is unavailable.
        """
        with self.transaction() as cursor:
            cursor.execute("SELECT * FROM drawings.layers WHERE id=%s", (identifier,))
            row = cursor.fetchone()
            if row is None:
                raise DrawingError(404, "Drawing layer not found.")
            return self._read_layer(row, owner)

    def read_revision(self, identifier: UUID) -> int:
        """Read the committed revision for a map tile without loading the drawing's coordinates.

        Args:
            identifier: Opaque read reference to the linked drawing.

        Returns:
            Current source revision.

        Raises:
            DrawingError: The source is unavailable.
        """
        with self.transaction() as cursor:
            cursor.execute("SELECT revision FROM drawings.layers WHERE id=%s", (identifier,))
            row = cursor.fetchone()
            if row is None:
                raise DrawingError(404, "Drawing layer not found.")
            return row["revision"]

    def list_layers(self, owner: str) -> list[DrawingLayerSummary]:
        """Find this browser's reusable sources for recovery and reopening.

        Args:
            owner: Server-derived browser identity.

        Returns:
            Private source summaries, newest edit first, without polygon bodies.

        Raises:
            DrawingError: Storage is unavailable or stored summaries are invalid.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "SELECT id,local_layer_id,collection->>'name' AS name,revision,created_at,updated_at "
                "FROM drawings.layers WHERE owner_hash=%s ORDER BY updated_at DESC,id",
                (owner,),
            )
            return [
                DrawingLayerSummary(
                    id=row["id"],
                    localLayerId=row["local_layer_id"],
                    name=row["name"],
                    revision=row["revision"],
                    createdAt=row["created_at"],
                    updatedAt=row["updated_at"],
                )
                for row in cursor.fetchall()
            ]

    def update_layer(
        self, owner: str, identifier: UUID, request: UpdateDrawingLayer
    ) -> DrawingLayer:
        """Save the owner's full collection only at the acknowledged source revision.

        Args:
            owner: Server-derived browser identity.
            identifier: Linked source UUID.
            request: Replacement committed polygons and expected revision.

        Returns:
            Updated source with one revision increment and unchanged source identity.

        Raises:
            DrawingError: Ownership, revision or storage prevents this update.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "SELECT revision FROM drawings.layers WHERE id=%s AND owner_hash=%s FOR UPDATE",
                (identifier, owner),
            )
            current = cursor.fetchone()
            if current is None:
                raise DrawingError(404, "Drawing layer not found.")
            if current["revision"] != request.expectedRevision:
                raise DrawingError(
                    409, "This drawing changed in another tab. Reload before saving."
                )
            cursor.execute(
                "UPDATE drawings.layers SET collection=%s,revision=revision+1,updated_at=clock_timestamp() "
                "WHERE id=%s RETURNING *",
                (Jsonb(request.collection.model_dump(mode="json")), identifier),
            )
            return self._read_layer(cursor.fetchone(), owner)
