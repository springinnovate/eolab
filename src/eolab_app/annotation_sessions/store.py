"""Store temporary sessions and enforce contribution ownership in PostgreSQL."""

from collections.abc import Iterator
from contextlib import contextmanager
from importlib.resources import files
import json
import secrets
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .models import AnnotationCollection, SessionError, ShareLayer

# Stable, application-chosen identifier for a PostgreSQL advisory transaction lock.
# The number is a lock name, not a limit, session ID or credential. All annotation
# session writes in this database use it so capacity checks and their writes cannot
# race across app processes. PostgreSQL releases it on commit or rollback.
# Keep this value distinct from locks used for unrelated work (Processing uses
# 7_610_329), and keep it unchanged across app processes and deployments.
ANNOTATION_SESSION_WRITE_LOCK_ID: int = 7_610_457
SESSION_BYTES = 32 * 1024 * 1024
TOTAL_BYTES = 256 * 1024 * 1024


class AnnotationSessionStore:
    """Keep session membership and the latest contribution from each local layer."""

    def __init__(self, conninfo: str = "") -> None:
        """Configure PostgreSQL without opening a connection.

        Args:
            conninfo: Test connection string; production uses the existing PG environment.
        """
        self.conninfo = conninfo

    @contextmanager
    def transaction(self, write: bool = False) -> Iterator[psycopg.Cursor]:
        """Open a short database transaction and serialize writes when needed.

        Args:
            write: Whether the transaction changes membership or contributions.

        Yields:
            Cursor returning dictionary rows.

        Raises:
            SessionError: If the database is unavailable or a transaction times out.
        """
        try:
            with psycopg.connect(
                self.conninfo,
                row_factory=dict_row,
                connect_timeout=3,
                options="-c statement_timeout=5000 -c lock_timeout=3000",
            ) as connection:
                with connection.cursor() as cursor:
                    if write:
                        cursor.execute(
                            "SELECT pg_advisory_xact_lock(%s)",
                            (ANNOTATION_SESSION_WRITE_LOCK_ID,),
                        )
                    else:
                        # Membership, authors and layers must describe one snapshot,
                        # even if another request withdraws or deletes a session.
                        cursor.execute(
                            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                        )
                    yield cursor
        except psycopg.Error as error:
            raise SessionError(
                503,
                "Shared annotations are temporarily unavailable. Your local annotations are safe.",
            ) from error

    def initialize_and_remove_expired_sessions(self) -> None:
        """Install the owned tables and delete expired sessions and old join attempts.

        Raises:
            SessionError: If the database cannot be reached or updated.
        """
        with self.transaction(write=True) as cursor:
            cursor.execute(
                files("eolab_app.annotation_sessions")
                .joinpath("schema.sql")
                .read_text()
            )
            cursor.execute(
                "DELETE FROM annotation_sessions.sessions WHERE expires_at <= now()"
            )
            cursor.execute(
                "DELETE FROM annotation_sessions.join_attempts WHERE started_at < now() - interval '1 hour'"
            )

    def list_sessions(self, browser: str) -> list[dict[str, Any]]:
        """Find unexpired sessions this browser has joined, without renewing them.

        Args:
            browser: Hash of the browser's private cookie.

        Returns:
            Session identifiers, names, join codes and expiration timestamps.

        Raises:
            SessionError: If the database is unavailable.
        """
        with self.transaction() as cursor:
            cursor.execute(
                'SELECT s.id, s.name, s.join_code AS "joinCode", s.expires_at AS "expiresAt" FROM annotation_sessions.sessions s JOIN annotation_sessions.contributors c ON c.session_id=s.id WHERE c.browser_hash=%s AND s.expires_at>now() ORDER BY s.name, s.id',
                (browser,),
            )
            return cursor.fetchall()

    def create_session(self, browser: str, name: str, contributor_name: str) -> UUID:
        """Create a session and register this browser as its owner.

        Args:
            browser: Private browser-cookie hash.
            name: Validated session name.
            contributor_name: Owner's validated display name.

        Returns:
            New session identifier.

        Raises:
            SessionError: If the site or browser already has too many sessions.
        """
        with self.transaction(write=True) as cursor:
            cursor.execute(
                "DELETE FROM annotation_sessions.sessions WHERE expires_at <= now()"
            )
            cursor.execute("SELECT count(*) AS total FROM annotation_sessions.sessions")
            total = cursor.fetchone()["total"]
            cursor.execute(
                "SELECT count(*) AS total FROM annotation_sessions.contributors WHERE browser_hash=%s",
                (browser,),
            )
            if total >= 100 or cursor.fetchone()["total"] >= 10:
                raise SessionError(
                    429,
                    "The annotation-session limit has been reached. Try again after a session expires.",
                )
            while True:
                code = "".join(
                    secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8)
                )
                cursor.execute(
                    "SELECT 1 FROM annotation_sessions.sessions WHERE join_code=%s",
                    (code,),
                )
                if not cursor.fetchone():
                    break
            identifier = uuid4()
            cursor.execute(
                "INSERT INTO annotation_sessions.sessions(id,name,join_code,expires_at) VALUES(%s,%s,%s,now()+interval '24 hours')",
                (identifier, name, code),
            )
            cursor.execute(
                "INSERT INTO annotation_sessions.contributors(id,session_id,browser_hash,name,is_owner) VALUES(%s,%s,%s,%s,true)",
                (uuid4(), identifier, browser, contributor_name),
            )
            return identifier

    def join_session(self, browser: str, code: str, name: str) -> UUID:
        """Redeem a join code and retain this browser's existing contributor identity.

        Args:
            browser: Private browser-cookie hash.
            code: Normalized join code.
            name: Validated contributor display name.

        Returns:
            The joined session identifier.

        Raises:
            SessionError: If the code is unavailable or membership/attempt limits apply.
        """
        # Commit failed attempts too; a rejected join must not roll its counter back.
        with self.transaction(write=True) as cursor:
            cursor.execute(
                "DELETE FROM annotation_sessions.join_attempts WHERE started_at < now()-interval '1 minute'"
            )
            cursor.execute(
                "SELECT count(*) AS total FROM annotation_sessions.join_attempts"
            )
            if cursor.fetchone()["total"] >= 2000:
                raise SessionError(
                    429, "Too many join attempts. Try again in a minute."
                )
            cursor.execute(
                "INSERT INTO annotation_sessions.join_attempts(browser_hash) VALUES(%s) ON CONFLICT(browser_hash) DO UPDATE SET attempts=annotation_sessions.join_attempts.attempts+1 RETURNING attempts",
                (browser,),
            )
            attempts = cursor.fetchone()["attempts"]
        if attempts > 10:
            raise SessionError(429, "Too many join attempts. Try again in a minute.")
        with self.transaction(write=True) as cursor:
            cursor.execute(
                "SELECT id, joins_open FROM annotation_sessions.sessions WHERE join_code=%s AND expires_at>now()",
                (code,),
            )
            session = cursor.fetchone()
            if not session:
                raise SessionError(
                    404, "That join code is unavailable or the session has expired."
                )
            cursor.execute(
                "SELECT id FROM annotation_sessions.contributors WHERE session_id=%s AND browser_hash=%s",
                (session["id"], browser),
            )
            if cursor.fetchone():
                return session["id"]
            if not session["joins_open"]:
                raise SessionError(403, "The session owner has closed joining.")
            cursor.execute(
                "SELECT count(*) AS total FROM annotation_sessions.contributors WHERE session_id=%s",
                (session["id"],),
            )
            count = cursor.fetchone()["total"]
            cursor.execute(
                "SELECT count(*) AS total FROM annotation_sessions.contributors c JOIN annotation_sessions.sessions s ON s.id=c.session_id WHERE c.browser_hash=%s AND s.expires_at>now()",
                (browser,),
            )
            if count >= 64 or cursor.fetchone()["total"] >= 10:
                raise SessionError(
                    429, "This session or browser has reached its contributor limit."
                )
            cursor.execute(
                "INSERT INTO annotation_sessions.contributors(id,session_id,browser_hash,name) VALUES(%s,%s,%s,%s)",
                (uuid4(), session["id"], browser, name),
            )
            self.extend_session_expiration(cursor, session["id"])
            return session["id"]

    def require_contributor(
        self, cursor: psycopg.Cursor, session_id: UUID, browser: str
    ) -> dict[str, Any]:
        """Require an unexpired membership before reading or changing session data.

        Args:
            cursor: Current transaction cursor.
            session_id: Requested session identifier.
            browser: Private browser-cookie hash.

        Returns:
            The caller's contributor record, without the cookie hash.

        Raises:
            SessionError: If the session expired or this browser is not a member.
        """
        cursor.execute(
            "SELECT c.id,c.name,c.is_owner FROM annotation_sessions.contributors c JOIN annotation_sessions.sessions s ON s.id=c.session_id WHERE s.id=%s AND c.browser_hash=%s AND s.expires_at>now()",
            (session_id, browser),
        )
        member = cursor.fetchone()
        if not member:
            raise SessionError(
                404, "This session has expired or this browser has not joined it."
            )
        return member

    @staticmethod
    def extend_session_expiration(cursor: psycopg.Cursor, session_id: UUID) -> None:
        """Extend a session for 24 hours after an explicit action or changed contribution.

        Args:
            cursor: Current write transaction.
            session_id: Already authorized session identifier.
        """
        cursor.execute(
            "UPDATE annotation_sessions.sessions SET expires_at=now()+interval '24 hours' WHERE id=%s",
            (session_id,),
        )

    def get_session_snapshot(self, session_id: UUID, browser: str) -> dict[str, Any]:
        """Read membership and layer metadata without loading every polygon.

        Args:
            session_id: Session to view.
            browser: Private browser-cookie hash.

        Returns:
            Session details, caller identity, contributors and layer revisions.

        Raises:
            SessionError: If membership expired or storage is unavailable.
        """
        with self.transaction() as cursor:
            member = self.require_contributor(cursor, session_id, browser)
            cursor.execute(
                'SELECT id,name,join_code AS "joinCode",expires_at AS "expiresAt",joins_open AS "joinsOpen" FROM annotation_sessions.sessions WHERE id=%s',
                (session_id,),
            )
            result = cursor.fetchone()
            result["contributorId"] = member["id"]
            result["isOwner"] = member["is_owner"]
            cursor.execute(
                'SELECT id,name,is_owner AS "isOwner" FROM annotation_sessions.contributors WHERE session_id=%s ORDER BY name,id',
                (session_id,),
            )
            result["contributors"] = cursor.fetchall()
            cursor.execute(
                'SELECT l.contributor_id AS "contributorId",l.local_id AS "layerId",l.revision,l.updated_at AS "updatedAt",l.collection->>\'name\' AS name,jsonb_array_length(l.collection->\'features\') AS "polygonCount" FROM annotation_sessions.layers l JOIN annotation_sessions.contributors c ON c.id=l.contributor_id WHERE c.session_id=%s ORDER BY c.name,l.local_id',
                (session_id,),
            )
            result["layers"] = cursor.fetchall()
            return result

    def read_shared_layer(
        self, session_id: UUID, browser: str, contributor_id: UUID, layer_id: UUID
    ) -> dict[str, Any]:
        """Read one contribution after confirming both parties belong to this session.

        Args:
            session_id: Session containing the contribution.
            browser: Reader's private browser-cookie hash.
            contributor_id: Author of the contribution.
            layer_id: Author's local layer identifier.

        Returns:
            Validated GeoJSON and its current revision.

        Raises:
            SessionError: If the layer is missing or inaccessible.
        """
        with self.transaction() as cursor:
            self.require_contributor(cursor, session_id, browser)
            cursor.execute(
                "SELECT l.collection,l.revision FROM annotation_sessions.layers l JOIN annotation_sessions.contributors c ON c.id=l.contributor_id WHERE c.session_id=%s AND c.id=%s AND l.local_id=%s",
                (session_id, contributor_id, layer_id),
            )
            row = cursor.fetchone()
            if not row:
                raise SessionError(404, "This contribution is no longer shared.")
            row["collection"] = AnnotationCollection.model_validate(
                row["collection"]
            ).model_dump()
            return row

    def save_shared_layer(
        self, session_id: UUID, browser: str, layer_id: UUID, request: ShareLayer
    ) -> int:
        """Save this contributor's layer, rejecting stale writes and oversized sessions.

        Args:
            session_id: Session receiving the layer.
            browser: Author's private browser-cookie hash.
            layer_id: Stable local layer identifier, also used for retry deduplication.
            request: Validated GeoJSON and last acknowledged revision (zero for new layers).

        Returns:
            Accepted revision; an identical retry returns the existing revision.

        Raises:
            SessionError: If the revision is stale, membership is invalid or storage is full.
        """
        collection = request.collection.model_dump(mode="json")
        size = len(json.dumps(collection).encode())
        with self.transaction(write=True) as cursor:
            member = self.require_contributor(cursor, session_id, browser)
            cursor.execute(
                "SELECT revision,collection,bytes FROM annotation_sessions.layers WHERE contributor_id=%s AND local_id=%s",
                (member["id"], layer_id),
            )
            previous = cursor.fetchone()
            if previous and previous["collection"] == collection:
                return previous["revision"]
            if request.revision != (previous["revision"] if previous else 0):
                raise SessionError(
                    409,
                    "This shared layer changed in another tab. Export your local copy before reloading to compare it.",
                )
            cursor.execute(
                "SELECT count(*) AS total FROM annotation_sessions.layers WHERE contributor_id=%s",
                (member["id"],),
            )
            if not previous and cursor.fetchone()["total"] >= 32:
                raise SessionError(
                    429, "A contributor can share at most 32 layers in a session."
                )
            cursor.execute(
                "SELECT coalesce(sum(bytes),0) AS total FROM annotation_sessions.layers"
            )
            total = cursor.fetchone()["total"]
            cursor.execute(
                "SELECT coalesce(sum(l.bytes),0) AS total FROM annotation_sessions.layers l JOIN annotation_sessions.contributors c ON c.id=l.contributor_id WHERE c.session_id=%s",
                (session_id,),
            )
            growth = size - (previous["bytes"] if previous else 0)
            if (
                total + growth > TOTAL_BYTES
                or cursor.fetchone()["total"] + growth > SESSION_BYTES
            ):
                raise SessionError(
                    413,
                    "Shared annotation storage is full (32 MiB per session). Export a copy, then withdraw unneeded layers.",
                )
            revision = request.revision + 1
            cursor.execute(
                "INSERT INTO annotation_sessions.layers(contributor_id,local_id,revision,collection,bytes) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(contributor_id,local_id) DO UPDATE SET revision=excluded.revision,collection=excluded.collection,bytes=excluded.bytes,updated_at=now()",
                (member["id"], layer_id, revision, Jsonb(collection), size),
            )
            self.extend_session_expiration(cursor, session_id)
            return revision

    def withdraw_shared_layer(
        self, session_id: UUID, browser: str, layer_id: UUID, revision: int
    ) -> None:
        """Remove the caller's contribution if they still have its latest revision.

        Args:
            session_id: Session containing the contribution.
            browser: Author's private browser-cookie hash.
            layer_id: Author's layer identifier.
            revision: Last observed revision, protecting concurrent edits.

        Raises:
            SessionError: If membership or the revision no longer matches.
        """
        with self.transaction(write=True) as cursor:
            member = self.require_contributor(cursor, session_id, browser)
            cursor.execute(
                "SELECT revision FROM annotation_sessions.layers WHERE contributor_id=%s AND local_id=%s",
                (member["id"], layer_id),
            )
            row = cursor.fetchone()
            if row and row["revision"] != revision:
                raise SessionError(
                    409, "This contribution changed. Refresh before withdrawing it."
                )
            cursor.execute(
                "DELETE FROM annotation_sessions.layers WHERE contributor_id=%s AND local_id=%s",
                (member["id"], layer_id),
            )
            if row:
                self.extend_session_expiration(cursor, session_id)

    def apply_session_action(self, session_id: UUID, browser: str, action: str) -> None:
        """Extend a session or let its owner open/close joining or delete it.

        Args:
            session_id: Session to manage.
            browser: Private browser-cookie hash.
            action: One of extend, open-joining, close-joining, or delete.

        Raises:
            SessionError: If membership or owner permission is missing.
        """
        with self.transaction(write=True) as cursor:
            member = self.require_contributor(cursor, session_id, browser)
            if action == "extend":
                self.extend_session_expiration(cursor, session_id)
            elif not member["is_owner"]:
                raise SessionError(403, "Only the session owner can do that.")
            elif action == "delete":
                cursor.execute(
                    "DELETE FROM annotation_sessions.sessions WHERE id=%s",
                    (session_id,),
                )
            else:
                cursor.execute(
                    "UPDATE annotation_sessions.sessions SET joins_open=%s WHERE id=%s",
                    (action == "open-joining", session_id),
                )

    def export_session_geojson(self, session_id: UUID, browser: str) -> dict[str, Any]:
        """Collect the current contributions as GeoJSON with server-assigned authorship.

        Args:
            session_id: Session to download.
            browser: Private browser-cookie hash of a member.

        Returns:
            FeatureCollection preserving session, contributor and layer identifiers/names.

        Raises:
            SessionError: If membership expired or storage is unavailable.
            ValueError: If a stored contribution is invalid.
        """
        with self.transaction() as cursor:
            self.require_contributor(cursor, session_id, browser)
            cursor.execute(
                "SELECT name FROM annotation_sessions.sessions WHERE id=%s",
                (session_id,),
            )
            name = cursor.fetchone()["name"]
            cursor.execute(
                "SELECT c.id,c.name,l.local_id,l.collection FROM annotation_sessions.layers l JOIN annotation_sessions.contributors c ON c.id=l.contributor_id WHERE c.session_id=%s ORDER BY c.name,c.id,l.local_id",
                (session_id,),
            )
            features = []
            for row in cursor.fetchall():
                collection = AnnotationCollection.model_validate(
                    row["collection"]
                ).model_dump()
                for feature in collection["features"]:
                    feature["properties"].update(
                        {
                            "contributor": row["name"],
                            "contributorId": str(row["id"]),
                            "layer": collection["name"],
                            "layerId": str(row["local_id"]),
                            "sessionId": str(session_id),
                        }
                    )
                    features.append(feature)
            return {"type": "FeatureCollection", "name": name, "features": features}
