"""Persist named map configurations in the application's PostgreSQL database."""

from collections.abc import Iterator
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
from hashlib import sha256
from importlib.resources import files
from secrets import token_hex
from typing import Any, cast

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from eolab_app.saved_maps.models import (
    CreateSavedMap,
    INVALID_MAP_EDIT_LINK,
    PublishedMapSummary,
    PublishedSavedMap,
    SavedMap,
    SavedMapError,
    UpdateSavedMap,
)

ACTIVE_MAP_CONDITION = (
    "slug=%(slug)s AND deleted_at IS NULL "
    "AND (%(edit_token_digest)s::bytea IS NULL OR edit_token_digest=%(edit_token_digest)s)"
)


def _map_edit_token_digest(edit_token: str | None) -> bytes | None:
    """Hash a private edit token before using it in the saved-map database.

    Args:
        edit_token: Validated token for one map, or None for an unrestricted lookup.

    Returns:
        SHA-256 digest, or None when no token check is required.
    """
    return (
        sha256(edit_token.encode("ascii")).digest() if edit_token is not None else None
    )


@dataclass(frozen=True)
class SourceRevisionMigration:
    """Report a selected map's obsolete fields and whether their removal committed.

    Attributes:
        slug: Unchanged map URL name.
        revision: Current map revision after this operation.
        changed_layers: Number of layers with obsolete Catalog or shared-label fields removed.
        applied: Whether the database was updated; false for previews and no-ops.
        upgrades_format: Whether the protected Site Condition map needs its version marker updated.
    """

    slug: str
    revision: int
    changed_layers: int
    applied: bool
    upgrades_format: bool


class SavedMapStore:
    """Store and update named maps without contacting their referenced data sources."""

    def __init__(self, conninfo: str = "", capacity: int = 1000) -> None:
        """Configure database access and the maximum number of saved maps.

        Args:
            conninfo: PostgreSQL connection string; empty uses the standard PG environment.
            capacity: Maximum saved maps on this site, including maps from other users.

        Raises:
            ValueError: If capacity is not positive.
        """
        if capacity < 1:
            raise ValueError("Saved-map capacity must be positive.")
        self.conninfo = conninfo
        self.capacity = capacity

    @contextmanager
    def transaction(self) -> Iterator[psycopg.Cursor[dict[str, Any]]]:
        """Open a short transaction with bounded connection, statement and lock waits.

        Yields:
            Cursor for this component's saved_maps schema.

        Raises:
            SavedMapError: If PostgreSQL is unavailable or stored map data is invalid.
        """
        try:
            with psycopg.connect(
                self.conninfo,
                connect_timeout=3,
                options="-c statement_timeout=5000 -c lock_timeout=3000",
                row_factory=dict_row,
            ) as connection:
                with connection.cursor() as cursor:
                    yield cursor
        except (psycopg.Error, ValidationError) as error:
            raise SavedMapError(
                503, "Saved-map storage is unavailable. Try again shortly."
            ) from error

    def initialize_schema(self) -> None:
        """Create the saved-map table while preserving all existing maps.

        Raises:
            SavedMapError: If schema initialization cannot complete.
        """
        with self.transaction() as cursor:
            cursor.execute(
                files("eolab_app.saved_maps").joinpath("schema.sql").read_text()
            )

    def create_saved_map(self, request: CreateSavedMap) -> PublishedSavedMap:
        """Store a new map without replacing an existing map with the same URL name.

        Args:
            request: Validated title, optional subtitle, URL name and map document.

        Returns:
            Stored map with its creation timestamp and newly issued private edit token.
            Only the digest of the token is stored in the database.

        Raises:
            SavedMapError: For a duplicate name, full site capacity or database failure.
        """
        with self.transaction() as cursor:
            # Serialize count-and-insert across app processes; reads remain available.
            cursor.execute("LOCK TABLE saved_maps.maps IN SHARE ROW EXCLUSIVE MODE")
            cursor.execute(
                "SELECT 1 FROM saved_maps.maps WHERE slug=%s", (request.slug,)
            )
            if cursor.fetchone():
                raise SavedMapError(
                    409, "That map link name is already in use. Choose another name."
                )
            cursor.execute("SELECT count(*) AS count FROM saved_maps.maps")
            if cursor.fetchone()["count"] >= self.capacity:
                raise SavedMapError(
                    503,
                    "This site's saved-map capacity is full. Contact the site administrator.",
                )
            edit_token = token_hex(32)
            cursor.execute(
                "INSERT INTO saved_maps.maps (slug, title, subtitle, view, edit_token_digest) "
                "VALUES (%s, %s, %s, %s, %s) "
                'RETURNING slug, title, subtitle, view, revision, created_at AS "createdAt"',
                (
                    request.slug,
                    request.title,
                    request.subtitle,
                    Jsonb(request.view.model_dump(mode="json", exclude_unset=True)),
                    _map_edit_token_digest(edit_token),
                ),
            )
            return PublishedSavedMap.model_validate(
                {**cursor.fetchone(), "editToken": edit_token}
            )

    def get_saved_map(self, slug: str, *, edit_token: str | None = None) -> SavedMap:
        """Read an active map by its exact URL name; deleted maps are unavailable.

        Args:
            slug: Validated lowercase URL name.
            edit_token: Require this private edit token to match the map when supplied.

        Returns:
            Stored title, subtitle, map document and creation timestamp.

        Raises:
            SavedMapError: If the map is absent, the token is invalid, or storage cannot be read.
        """
        with self.transaction() as cursor:
            cursor.execute(
                'SELECT slug, title, subtitle, view, revision, created_at AS "createdAt" '
                f"FROM saved_maps.maps WHERE {ACTIVE_MAP_CONDITION}",
                {"slug": slug, "edit_token_digest": _map_edit_token_digest(edit_token)},
            )
            row = cursor.fetchone()
            if row is None:
                if edit_token is not None:
                    raise SavedMapError(403, INVALID_MAP_EDIT_LINK)
                raise SavedMapError(404, "Saved map not found.")
            try:
                return SavedMap.model_validate(row)
            except ValidationError as error:
                raise SavedMapError(
                    422,
                    "This saved map has settings this site cannot open. Ask the map owner for an updated map.",
                ) from error

    def list_published_maps(self) -> list[PublishedMapSummary]:
        """List active and deleted maps for administration without loading documents.

        Returns:
            Titles, fixed URL names, deletion times and whether each map has a
            private edit link, ordered by title and URL name.

        Raises:
            SavedMapError: If storage is unavailable.
        """
        with self.transaction() as cursor:
            cursor.execute(
                'SELECT slug, title, deleted_at AS "deletedAt", '
                'edit_token_digest IS NOT NULL AS "hasEditLink" '
                "FROM saved_maps.maps ORDER BY lower(title), slug"
            )
            return cast(list[PublishedMapSummary], cursor.fetchall())

    def issue_edit_token(self, slug: str) -> str:
        """Issue a new private edit token for an active map and invalidate the old one.

        Args:
            slug: Fixed URL name of the map selected by a site administrator.

        Returns:
            New token. Its digest replaces the previous digest without changing
            the map document or revision.

        Raises:
            SavedMapError: If the map is absent, deleted, or storage is unavailable.
        """
        edit_token = token_hex(32)
        with self.transaction() as cursor:
            cursor.execute(
                "UPDATE saved_maps.maps SET edit_token_digest=%s WHERE slug=%s AND deleted_at IS NULL",
                (_map_edit_token_digest(edit_token), slug),
            )
            if cursor.rowcount == 0:
                raise SavedMapError(404, "Saved map not found.")
        return edit_token

    def revoke_edit_token(self, slug: str) -> None:
        """Invalidate a map's private edit link, including for a deleted map.

        Args:
            slug: Fixed URL name of the map selected by a site administrator.

        Raises:
            SavedMapError: If the map does not exist or storage is unavailable.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "UPDATE saved_maps.maps SET edit_token_digest=NULL WHERE slug=%s",
                (slug,),
            )
            if cursor.rowcount == 0:
                raise SavedMapError(404, "Saved map not found.")

    def migrate_source_revisions(
        self, slug: str, *, apply: bool = False, expected_revision: int | None = None
    ) -> SourceRevisionMigration:
        """Preview or remove obsolete Catalog and Site Condition label settings.

        Call explicitly during an upgrade, after backup and stopping old app
        writers. This command updates only the selected map after its complete
        settings pass validation. The protected Site Condition map keeps its
        URL and its shared polygon references.
        Shared polygon storage is never accessed. A changed map advances its
        revision once, invalidating old administrator drafts. Compatible maps
        are no-ops, including a retry with the previously applied revision.

        Args:
            slug: Existing map's fixed URL name.
            apply: Commit the validated change instead of only previewing it.
            expected_revision: Revision reviewed in the preview; required to apply.

        Returns:
            Layer count, resulting revision and whether a change committed.

        Raises:
            SavedMapError: If missing or deleted, the reviewed revision is stale,
                application lacks a revision, the candidate remains incompatible,
                or the database transaction fails. Failures leave the map intact.
        """
        if apply and expected_revision is None:
            raise SavedMapError(
                422, "Applying a migration requires the preview revision."
            )
        with self.transaction() as cursor:
            cursor.execute(
                'SELECT slug, title, subtitle, view, revision, created_at AS "createdAt" '
                "FROM saved_maps.maps WHERE slug=%s AND deleted_at IS NULL FOR UPDATE",
                (slug,),
            )
            row = cursor.fetchone()
            if row is None:
                raise SavedMapError(404, "Saved map not found.")
            candidate = deepcopy(row)
            if not isinstance(candidate["view"], dict):
                raise SavedMapError(422, "The stored map must be a JSON object.")
            upgrades_format = (
                slug == "nhi-site-condition-mapper"
                and candidate["view"].get("schemaVersion") == 3
            )
            if upgrades_format:
                candidate["view"]["schemaVersion"] = 5
            changed_layers = 0
            # Persisted legacy JSON cannot satisfy the current contract until
            # these fields are removed. Validate the entire result below.
            layers = candidate["view"].get("layers")
            if isinstance(layers, list):
                for layer in layers:
                    if not isinstance(layer, dict):
                        continue
                    if "catalogItem" in layer and "sourceRevision" in layer:
                        del layer["sourceRevision"]
                        changed_layers += 1
                    elif (
                        slug == "nhi-site-condition-mapper"
                        and "sharedAnnotation" in layer
                    ):
                        appearance = layer.get("appearance")
                        if (
                            isinstance(appearance, dict)
                            and isinstance(appearance.get("labels"), bool)
                            and isinstance(appearance.get("notes"), bool)
                        ):
                            notes = appearance.pop("notes")
                            appearance["labels"] = appearance["labels"] or notes
                            changed_layers += 1
            try:
                SavedMap.model_validate(candidate)
            except ValidationError as error:
                raise SavedMapError(
                    422,
                    "This map has other incompatible settings. Inspect the saved document before upgrading.",
                ) from error
            applied = apply and (changed_layers > 0 or upgrades_format)
            if applied:
                if expected_revision != row["revision"]:
                    raise SavedMapError(
                        409,
                        "This map changed since preview. Preview its current revision again.",
                    )
                cursor.execute(
                    "UPDATE saved_maps.maps SET view=%s, revision=revision+1 WHERE slug=%s "
                    "RETURNING revision",
                    (Jsonb(candidate["view"]), slug),
                )
                row["revision"] = cursor.fetchone()["revision"]
            return SourceRevisionMigration(
                slug, row["revision"], changed_layers, applied, upgrades_format
            )

    def set_map_deleted(self, slug: str, *, deleted: bool) -> None:
        """Hide or restore a published map while retaining its URL and configuration.

        Actual state changes advance the revision so an older editor cannot save
        over a restored map. Repeated requests for the same state do nothing.
        Deleted maps keep their URL reserved and still count toward site capacity.
        Referenced shared layers and their polygons are never modified.

        Args:
            slug: Fixed URL name of the map.
            deleted: True to hide the map; False to restore it.

        Raises:
            SavedMapError: If the map does not exist or storage is unavailable.
        """
        with self.transaction() as cursor:
            cursor.execute(
                "SELECT deleted_at FROM saved_maps.maps WHERE slug=%s FOR UPDATE",
                (slug,),
            )
            row = cursor.fetchone()
            if row is None:
                raise SavedMapError(404, "Saved map not found.")
            if (row["deleted_at"] is not None) == deleted:
                return
            cursor.execute(
                "UPDATE saved_maps.maps SET deleted_at=CASE WHEN %s THEN clock_timestamp() ELSE NULL END, revision=revision+1 WHERE slug=%s",
                (deleted, slug),
            )

    def update_saved_map(
        self, slug: str, request: UpdateSavedMap, *, edit_token: str | None = None
    ) -> SavedMap:
        """Replace an active map's configuration if the revision and access still match.

        Args:
            slug: Existing map's fixed URL name.
            request: Validated replacement configuration and expected revision.
            edit_token: Private token required for a publisher's save. Administrators
                can save with their existing authorization and no token.

        Returns:
            Updated map with the same URL and creation time, and a new revision.

        Raises:
            SavedMapError: If missing, unauthorized, renamed, edited elsewhere, or storage fails.
        """
        if request.slug != slug:
            raise SavedMapError(422, "A published map's URL cannot be changed.")
        map_access = {
            "slug": slug,
            "edit_token_digest": _map_edit_token_digest(edit_token),
        }
        with self.transaction() as cursor:
            cursor.execute(
                "UPDATE saved_maps.maps SET title=%(title)s, subtitle=%(subtitle)s, "
                "view=%(view)s, revision=revision+1 "
                f"WHERE {ACTIVE_MAP_CONDITION} AND revision=%(revision)s "
                'RETURNING slug, title, subtitle, view, revision, created_at AS "createdAt"',
                {
                    **map_access,
                    "title": request.title,
                    "subtitle": request.subtitle,
                    "view": Jsonb(
                        request.view.model_dump(mode="json", exclude_unset=True)
                    ),
                    "revision": request.revision,
                },
            )
            row = cursor.fetchone()
            if row is not None:
                return SavedMap.model_validate(row)
            cursor.execute(
                f"SELECT 1 FROM saved_maps.maps WHERE {ACTIVE_MAP_CONDITION}",
                map_access,
            )
            if cursor.fetchone() is None:
                if edit_token is not None:
                    raise SavedMapError(403, INVALID_MAP_EDIT_LINK)
                raise SavedMapError(404, "Saved map not found.")
            raise SavedMapError(
                409,
                "This map changed while you were editing it. Reload to see the latest version before saving.",
            )
