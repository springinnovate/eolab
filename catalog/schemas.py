"""
Pydantic schemas for the catalog service API.

These models define request payloads for creating collections, registering
items and derived assets, and querying the catalog.

The schemas are designed to be flexible and loosely coupled to specific
data formats, allowing arbitrary metadata and item representations while
enforcing a consistent interface for catalog operations.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field


class CollectionCreate(BaseModel):
    """Request schema for creating a new collection.

    Attributes:
        id: Unique identifier for the collection.
        title: Human-readable name of the collection.
        description: Detailed description of the collection contents.
        license: License associated with the collection. Defaults to 'proprietary'.
        keywords: List of keywords for search and discovery.
        extra: Arbitrary additional metadata for the collection.
    """

    id: str
    title: str
    description: str
    license: str = "proprietary"
    keywords: list[str] = Field(default_factory=list)
    extra: dict[str, Any] = Field(default_factory=dict)


class RegisterItemRequest(BaseModel):
    """Request schema for registering a single item in a collection.

    Attributes:
        collection_id: Identifier of the target collection.
        item: Item payload (e.g., STAC item or equivalent structure).
        kind: Optional classification of the item (e.g., 'raster', 'vector', 'derived').
        logical_id: Optional logical identifier for grouping related items.
    """

    collection_id: str
    item: dict[str, Any]
    kind: Literal["raster", "vector", "derived"] | None = None
    logical_id: str | None = None


class BulkRegisterRequest(BaseModel):
    """Request schema for registering multiple items in bulk.

    Attributes:
        entries: List of item registration requests.
    """

    entries: list[RegisterItemRequest]


class SearchRequest(BaseModel):
    """Request schema for searching catalog items.

    Supports filtering by identifiers, spatial and temporal constraints,
    item kind, and arbitrary metadata.

    Attributes:
        collections: Optional list of collection IDs to filter by.
        ids: Optional list of item IDs to retrieve.
        asset_ids: Optional list of asset IDs to filter by.
        kind: Optional item type filter ('raster', 'vector', 'derived').
        bbox: Optional bounding box filter [minx, miny, maxx, maxy].
        intersects: Optional GeoJSON geometry for spatial intersection.
        datetime: Optional datetime or interval string for temporal filtering.
        metadata: Arbitrary metadata filters.
        limit: Maximum number of results to return. Defaults to 10.
    """

    collections: list[str] | None = None
    ids: list[str] | None = None
    asset_ids: list[str] | None = None
    kind: Literal["raster", "vector", "derived"] | None = None
    bbox: list[float] | None = None
    intersects: dict[str, Any] | None = None
    datetime: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    limit: int = 10


class ResolveAssetsRequest(BaseModel):
    """Request schema for resolving asset identifiers.

    Attributes:
        asset_ids: List of asset IDs to resolve into full item or asset records.
    """

    asset_ids: list[str]
