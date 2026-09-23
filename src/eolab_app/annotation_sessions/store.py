"""Store collaborative annotation layers and enforce contribution ownership in PostgreSQL."""

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
from .colors import choose_contributor_color, get_contributor_color

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
    """Keep shared-layer membership and each contributor's latest polygons."""

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

    def initialize_and_clean_join_attempts(self) -> None:
        """Create shared-layer tables and remove old join-attempt counters.

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
                "DELETE FROM shared_annotation_layers.join_attempts WHERE started_at < now() - interval '1 hour'"
            )

    def list_sessions(self, browser: str) -> list[dict[str, Any]]:
        """Find shared layers this browser has joined.

        Args:
            browser: Hash of the browser's private cookie.

        Returns:
            Shared-layer identifiers, names and join codes.

        Raises:
            SessionError: If the database is unavailable.
        """
        with self.transaction() as cursor:
            cursor.execute(
                'SELECT s.id, s.name, s.join_code AS "joinCode" FROM shared_annotation_layers.sessions s JOIN shared_annotation_layers.contributors c ON c.session_id=s.id WHERE c.browser_hash=%s ORDER BY s.name, s.id',
                (browser,),
            )
            return cursor.fetchall()

    def create_session(self, browser: str, name: str, contributor_name: str) -> UUID:
        """Create a shared layer and give its first contributor a palette color.

        Args:
            browser: Private browser-cookie hash.
            name: Validated session name.
            contributor_name: First contributor's validated display name.

        Returns:
            New session identifier.

        Raises:
            SessionError: If the site or browser already has too many sessions.
        """
        with self.transaction(write=True) as cursor:
            cursor.execute(
                "SELECT count(*) AS total FROM shared_annotation_layers.sessions"
            )
            total = cursor.fetchone()["total"]
            cursor.execute(
                "SELECT count(*) AS total FROM shared_annotation_layers.contributors WHERE browser_hash=%s",
                (browser,),
            )
            if total >= 100 or cursor.fetchone()["total"] >= 10:
                raise SessionError(
                    429,
                    "The annotation-session limit has been reached. Contact the site administrator to free storage.",
                )
            while True:
                code = "".join(
                    secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(8)
                )
                cursor.execute(
                    "SELECT 1 FROM shared_annotation_layers.sessions WHERE join_code=%s",
                    (code,),
                )
                if not cursor.fetchone():
                    break
            identifier = uuid4()
            cursor.execute(
                "INSERT INTO shared_annotation_layers.sessions(id,name,join_code) VALUES(%s,%s,%s)",
                (identifier, name, code),
            )
            cursor.execute(
                "INSERT INTO shared_annotation_layers.contributors(id,session_id,browser_hash,name,color) VALUES(%s,%s,%s,%s,%s)",
                (
                    uuid4(),
                    identifier,
                    browser,
                    contributor_name,
                    choose_contributor_color([]),
                ),
            )
            return identifier

    def join_session(self, browser: str, code: str, name: str) -> UUID:
        """Join a session using the supplied display name, including when returning.

        Returning browsers keep their contributor ID and polygons, but
        their color stays unchanged and their display name becomes the name entered
        on the join form. New members receive the least-used palette color while
        the write lock prevents concurrent joins from choosing the same unused color. Existing
        members can return when joining is closed to new contributors.

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
                "DELETE FROM shared_annotation_layers.join_attempts WHERE started_at < now()-interval '1 minute'"
            )
            cursor.execute(
                "SELECT count(*) AS total FROM shared_annotation_layers.join_attempts"
            )
            if cursor.fetchone()["total"] >= 2000:
                raise SessionError(
                    429, "Too many join attempts. Try again in a minute."
                )
            cursor.execute(
                "INSERT INTO shared_annotation_layers.join_attempts(browser_hash) VALUES(%s) ON CONFLICT(browser_hash) DO UPDATE SET attempts=shared_annotation_layers.join_attempts.attempts+1 RETURNING attempts",
                (browser,),
            )
            attempts = cursor.fetchone()["attempts"]
        if attempts > 10:
            raise SessionError(429, "Too many join attempts. Try again in a minute.")
        with self.transaction(write=True) as cursor:
            cursor.execute(
                "SELECT id, joins_open FROM shared_annotation_layers.sessions WHERE join_code=%s",
                (code,),
            )
            session = cursor.fetchone()
            if not session:
                raise SessionError(404, "That sharing code is unavailable.")
            cursor.execute(
                "SELECT id FROM shared_annotation_layers.contributors WHERE session_id=%s AND browser_hash=%s",
                (session["id"], browser),
            )
            contributor = cursor.fetchone()
            self.check_contributor_name_available(cursor, session["id"], browser, name)
            if contributor:
                cursor.execute(
                    "UPDATE shared_annotation_layers.contributors SET name=%s WHERE id=%s",
                    (name, contributor["id"]),
                )

                return session["id"]
            if not session["joins_open"]:
                raise SessionError(403, "Joining this shared layer is closed.")
            cursor.execute(
                "SELECT count(*) AS total FROM shared_annotation_layers.contributors WHERE session_id=%s",
                (session["id"],),
            )
            count = cursor.fetchone()["total"]
            cursor.execute(
                "SELECT count(*) AS total FROM shared_annotation_layers.contributors c JOIN shared_annotation_layers.sessions s ON s.id=c.session_id WHERE c.browser_hash=%s",
                (browser,),
            )
            if count >= 64 or cursor.fetchone()["total"] >= 10:
                raise SessionError(
                    429, "This session or browser has reached its contributor limit."
                )
            cursor.execute(
                "SELECT id,color FROM shared_annotation_layers.contributors WHERE session_id=%s",
                (session["id"],),
            )
            color = choose_contributor_color(
                get_contributor_color(row["id"], row["color"])
                for row in cursor.fetchall()
            )
            cursor.execute(
                "INSERT INTO shared_annotation_layers.contributors(id,session_id,browser_hash,name,color) VALUES(%s,%s,%s,%s,%s)",
                (uuid4(), session["id"], browser, name, color),
            )

            return session["id"]

    def require_contributor(
        self, cursor: psycopg.Cursor, session_id: UUID, browser: str
    ) -> dict[str, Any]:
        """Require membership before reading shared polygons or changing your contribution.

        Args:
            cursor: Current transaction cursor.
            session_id: Requested session identifier.
            browser: Private browser-cookie hash.

        Returns:
            The caller's contributor record, without the cookie hash.

        Raises:
            SessionError: If this browser has not joined the shared layer.
        """
        cursor.execute(
            "SELECT c.id,c.name FROM shared_annotation_layers.contributors c JOIN shared_annotation_layers.sessions s ON s.id=c.session_id WHERE s.id=%s AND c.browser_hash=%s",
            (session_id, browser),
        )
        member = cursor.fetchone()
        if not member:
            raise SessionError(
                404,
                "This shared layer is unavailable or this browser has not joined it.",
            )
        return member

    @staticmethod
    def check_contributor_name_available(
        cursor: psycopg.Cursor, session_id: UUID, browser: str, name: str
    ) -> None:
        """Reject a display name already used by another contributor in this layer.

        Args:
            cursor: Serialized membership-write transaction.
            session_id: Shared layer being joined or edited.
            browser: Current contributor's private cookie hash.
            name: Trimmed, validated display name.

        Raises:
            SessionError: If another contributor uses the name, ignoring case.
        """
        cursor.execute(
            "SELECT name FROM shared_annotation_layers.contributors WHERE session_id=%s AND browser_hash<>%s",
            (session_id, browser),
        )
        if any(
            row["name"].strip().casefold() == name.strip().casefold()
            for row in cursor.fetchall()
        ):
            raise SessionError(
                409,
                "That name is already used in this shared layer. Choose another name.",
            )

    def get_session_snapshot(self, session_id: UUID, browser: str) -> dict[str, Any]:
        """Read membership and layer metadata without loading every polygon.

        Args:
            session_id: Session to view.
            browser: Private browser-cookie hash.

        Returns:
            Session details, caller identity, contributor names/colors and layer revisions.

        Raises:
            SessionError: If membership is missing or storage is unavailable.
        """
        with self.transaction() as cursor:
            member = self.require_contributor(cursor, session_id, browser)
            cursor.execute(
                'SELECT id,name,join_code AS "joinCode" FROM shared_annotation_layers.sessions WHERE id=%s',
                (session_id,),
            )
            result = cursor.fetchone()
            result["contributorId"] = member["id"]
            cursor.execute(
                "SELECT id,name,color FROM shared_annotation_layers.contributors WHERE session_id=%s ORDER BY name,id",
                (session_id,),
            )
            result["contributors"] = cursor.fetchall()
            for person in result["contributors"]:
                person["color"] = get_contributor_color(person["id"], person["color"])
            cursor.execute(
                'SELECT l.contributor_id AS "contributorId",l.local_id AS "layerId",l.revision,l.updated_at AS "updatedAt",l.collection->>\'name\' AS name,jsonb_array_length(l.collection->\'features\') AS "polygonCount" FROM shared_annotation_layers.layers l JOIN shared_annotation_layers.contributors c ON c.id=l.contributor_id WHERE c.session_id=%s ORDER BY c.name,l.local_id',
                (session_id,),
            )
            result["layers"] = cursor.fetchall()
            return result

    def update_contributor_name(
        self, session_id: UUID, browser: str, name: str
    ) -> None:
        """Change only the requesting member's display name in an active session.

        Args:
            session_id: Session the browser has joined.
            browser: Private browser-cookie hash identifying the member.
            name: Display name validated by the session input model.

        Raises:
            SessionError: If membership is absent or storage is unavailable.
        """
        with self.transaction(write=True) as cursor:
            member = self.require_contributor(cursor, session_id, browser)
            self.check_contributor_name_available(cursor, session_id, browser, name)
            cursor.execute(
                "UPDATE shared_annotation_layers.contributors SET name=%s WHERE id=%s",
                (name, member["id"]),
            )

    def update_contributor_color(
        self, session_id: UUID, browser: str, color: str
    ) -> None:
        """Save a polygon fill color for only the authenticated contributor.

        Args:
            session_id: Shared layer this browser has joined.
            browser: Private cookie hash identifying the contributor.
            color: Six-digit hexadecimal color validated by ContributorColor.

        Raises:
            SessionError: If membership is absent or storage is unavailable.
        """
        with self.transaction(write=True) as cursor:
            member = self.require_contributor(cursor, session_id, browser)
            cursor.execute(
                "UPDATE shared_annotation_layers.contributors SET color=%s WHERE id=%s",
                (color.upper(), member["id"]),
            )

    def read_shared_layer(
        self, session_id: UUID, browser: str, contributor_id: UUID, layer_id: UUID
    ) -> dict[str, Any]:
        """Read one contribution after confirming both parties belong to this session.

        Args:
            session_id: Session containing the contribution.
            browser: Reader's private browser-cookie hash.
            contributor_id: Author of the contribution.
            layer_id: Shared layer identifier, equal to the session ID.

        Returns:
            Validated GeoJSON and its current revision.

        Raises:
            SessionError: If the layer is missing or inaccessible.
        """
        with self.transaction() as cursor:
            self.require_contributor(cursor, session_id, browser)
            cursor.execute(
                "SELECT l.collection,l.revision FROM shared_annotation_layers.layers l JOIN shared_annotation_layers.contributors c ON c.id=l.contributor_id WHERE c.session_id=%s AND c.id=%s AND l.local_id=%s",
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
            layer_id: Shared-layer identifier; each contributor has one collection in it.
            request: Validated GeoJSON and last acknowledged revision (zero for new layers).

        Returns:
            Accepted revision; an identical retry returns the existing revision.

        Raises:
            SessionError: If the revision is stale, membership is invalid or storage is full.
        """
        if layer_id != session_id:
            raise SessionError(
                422, "Use the shared layer identifier for your contribution."
            )
        collection = request.collection.model_dump(mode="json")
        size = len(json.dumps(collection).encode())
        with self.transaction(write=True) as cursor:
            member = self.require_contributor(cursor, session_id, browser)
            cursor.execute(
                "SELECT revision,collection,bytes FROM shared_annotation_layers.layers WHERE contributor_id=%s AND local_id=%s",
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
                "SELECT coalesce(sum(bytes),0) AS total FROM shared_annotation_layers.layers"
            )
            total = cursor.fetchone()["total"]
            cursor.execute(
                "SELECT coalesce(sum(l.bytes),0) AS total FROM shared_annotation_layers.layers l JOIN shared_annotation_layers.contributors c ON c.id=l.contributor_id WHERE c.session_id=%s",
                (session_id,),
            )
            growth = size - (previous["bytes"] if previous else 0)
            if (
                total + growth > TOTAL_BYTES
                or cursor.fetchone()["total"] + growth > SESSION_BYTES
            ):
                raise SessionError(
                    413,
                    "Shared annotation storage is full (32 MiB per session). Contact the site administrator; your previous contribution is unchanged.",
                )
            revision = request.revision + 1
            cursor.execute(
                "INSERT INTO shared_annotation_layers.layers(contributor_id,local_id,revision,collection,bytes) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(contributor_id,local_id) DO UPDATE SET revision=excluded.revision,collection=excluded.collection,bytes=excluded.bytes,updated_at=now()",
                (member["id"], layer_id, revision, Jsonb(collection), size),
            )

            return revision

    def export_session_geojson(self, session_id: UUID, browser: str) -> dict[str, Any]:
        """Collect the current contributions as GeoJSON with server-assigned authorship.

        Args:
            session_id: Session to download.
            browser: Private browser-cookie hash of a member.

        Returns:
            FeatureCollection preserving session, contributor and layer identifiers/names,
            plus contributor colors and an EOLab annotation metadata version.

        Raises:
            SessionError: If membership is missing or storage is unavailable.
            ValueError: If a stored contribution is invalid.
        """
        with self.transaction() as cursor:
            self.require_contributor(cursor, session_id, browser)
            cursor.execute(
                "SELECT name FROM shared_annotation_layers.sessions WHERE id=%s",
                (session_id,),
            )
            name = cursor.fetchone()["name"]
            cursor.execute(
                "SELECT c.id,c.name,c.color,l.local_id,l.collection FROM shared_annotation_layers.layers l JOIN shared_annotation_layers.contributors c ON c.id=l.contributor_id WHERE c.session_id=%s ORDER BY c.name,c.id,l.local_id",
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
                            "contributorColor": get_contributor_color(
                                row["id"], row["color"]
                            ),
                            "layer": collection["name"],
                            "layerId": str(row["local_id"]),
                            "sessionId": str(session_id),
                        }
                    )
                    features.append(feature)
            return {
                "type": "FeatureCollection",
                "name": name,
                "eolabAnnotations": 1,
                "features": features,
            }
