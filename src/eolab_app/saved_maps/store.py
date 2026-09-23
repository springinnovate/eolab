"""Persist immutable named map configurations in the application's PostgreSQL database."""

from collections.abc import Iterator
from contextlib import contextmanager
from importlib.resources import files
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from pydantic import ValidationError

from eolab_app.saved_maps.models import CreateSavedMap, SavedMap, SavedMapError


class SavedMapStore:
    """Create and retrieve named maps without contacting the referenced data sources."""

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
                'RETURNING slug, title, subtitle, view, created_at AS "createdAt"',
                (
                    request.slug,
                    request.title,
                    request.subtitle,
                    Jsonb(request.view.model_dump(mode="json", exclude_unset=True)),
                ),
            )
            return SavedMap.model_validate(cursor.fetchone())

    def get_saved_map(self, slug: str) -> SavedMap:
        """Read one stored map by its exact URL name.

        Args:
            slug: Validated lowercase URL name.

        Returns:
            Stored title, subtitle, map document and creation timestamp.

        Raises:
            SavedMapError: If the map is absent or storage cannot be read.
        """
        with self.transaction() as cursor:
            cursor.execute(
                'SELECT slug, title, subtitle, view, created_at AS "createdAt" FROM saved_maps.maps WHERE slug=%s',
                (slug,),
            )
            row = cursor.fetchone()
            if row is None:
                raise SavedMapError(404, "Saved map not found.")
            return SavedMap.model_validate(row)
