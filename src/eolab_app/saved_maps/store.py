"""Persist named map configurations in the application's PostgreSQL database."""

from collections.abc import Iterator
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
from importlib.resources import files
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from eolab_app.saved_maps.models import (
    CreateSavedMap,
    SavedMap,
    SavedMapError,
    UpdateSavedMap,
)


@dataclass(frozen=True)
class SourceRevisionMigration:
    """Report a selected map's obsolete fields and whether their removal committed.

    Attributes:
        slug: Unchanged map URL name.
        revision: Current map revision after this operation.
        changed_layers: Number of Catalog layers whose sourceRevision was removed.
        applied: Whether the database was updated; false for previews and no-ops.
    """

    slug: str
    revision: int
    changed_layers: int
    applied: bool


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

    def create_saved_map(self, request: CreateSavedMap) -> SavedMap:
        """Store a new map without replacing an existing map with the same URL name.

        Args:
            request: Validated title, optional subtitle, URL name and map document.

        Returns:
            Stored map, including the database creation timestamp.

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
            cursor.execute(
                "INSERT INTO saved_maps.maps (slug, title, subtitle, view) VALUES (%s, %s, %s, %s) "
                'RETURNING slug, title, subtitle, view, revision, created_at AS "createdAt"',
                (
                    request.slug,
                    request.title,
                    request.subtitle,
                    Jsonb(request.view.model_dump(mode="json", exclude_unset=True)),
                ),
            )
            return SavedMap.model_validate(cursor.fetchone())

    def get_saved_map(self, slug: str) -> SavedMap:
        """Read an active map by its exact URL name; deleted maps are unavailable.

        Args:
            slug: Validated lowercase URL name.

        Returns:
            Stored title, subtitle, map document and creation timestamp.

        Raises:
            SavedMapError: If the map is absent or storage cannot be read.
        """
        with self.transaction() as cursor:
            cursor.execute(
                'SELECT slug, title, subtitle, view, revision, created_at AS "createdAt" FROM saved_maps.maps WHERE slug=%s AND deleted_at IS NULL',
                (slug,),
            )
            row = cursor.fetchone()
            if row is None:
                raise SavedMapError(404, "Saved map not found.")
            return SavedMap.model_validate(row)

    def list_published_maps(self) -> list[dict[str, Any]]:
        """List active and deleted maps for administration without loading documents.

        Returns:
            Titles, fixed URL names and deletion times, ordered by title and URL name.

        Raises:
            SavedMapError: If storage is unavailable.
        """
        with self.transaction() as cursor:
            cursor.execute(
                'SELECT slug, title, deleted_at AS "deletedAt" FROM saved_maps.maps ORDER BY lower(title), slug'
            )
            return cursor.fetchall()

    def migrate_source_revisions(
        self, slug: str, *, apply: bool = False, expected_revision: int | None = None
    ) -> SourceRevisionMigration:
        """Preview or remove obsolete sourceRevision fields from one published map.

        Call explicitly during an upgrade, after backup and stopping old app
        writers. This is not run at startup or by the HTTP API. Only Catalog
        layer fields are removed; all other JSON and map metadata stay intact.
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
            changed_layers = 0
            # Persisted legacy JSON cannot satisfy the current contract until
            # these fields are removed. Validate the entire result below.
            layers = candidate["view"].get("layers")
            if isinstance(layers, list):
                for layer in layers:
                    if (
                        isinstance(layer, dict)
                        and "catalogItem" in layer
                        and "sourceRevision" in layer
                    ):
                        del layer["sourceRevision"]
                        changed_layers += 1
            try:
                SavedMap.model_validate(candidate)
            except ValidationError as error:
                raise SavedMapError(
                    422,
                    "This map has other incompatible fields after removing sourceRevision. "
                    "No changes were made; inspect the saved document before upgrading.",
                ) from error
            applied = apply and changed_layers > 0
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
                slug, row["revision"], changed_layers, applied
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

    def update_saved_map(self, slug: str, request: UpdateSavedMap) -> SavedMap:
        """Replace an active map's configuration only if its opened revision is current.

        Args:
            slug: Existing map's fixed URL name.
            request: Validated replacement configuration and expected revision.

        Returns:
            Updated map with the same URL and creation time, and a new revision.

        Raises:
            SavedMapError: If missing, renamed, edited elsewhere, or storage fails.
        """
        if request.slug != slug:
            raise SavedMapError(422, "A published map's URL cannot be changed.")
        with self.transaction() as cursor:
            cursor.execute(
                "UPDATE saved_maps.maps SET title=%s, subtitle=%s, view=%s, revision=revision+1 "
                "WHERE slug=%s AND revision=%s AND deleted_at IS NULL "
                'RETURNING slug, title, subtitle, view, revision, created_at AS "createdAt"',
                (
                    request.title,
                    request.subtitle,
                    Jsonb(request.view.model_dump(mode="json", exclude_unset=True)),
                    slug,
                    request.revision,
                ),
            )
            row = cursor.fetchone()
            if row is not None:
                return SavedMap.model_validate(row)
            cursor.execute(
                "SELECT 1 FROM saved_maps.maps WHERE slug=%s AND deleted_at IS NULL",
                (slug,),
            )
            if cursor.fetchone() is None:
                raise SavedMapError(404, "Saved map not found.")
            raise SavedMapError(
                409,
                "This map was changed by another administrator. Reload before editing again.",
            )
