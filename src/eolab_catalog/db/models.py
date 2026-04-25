from sqlalchemy import (
    Column,
    String,
    DateTime,
    Float,
    JSON,
    ForeignKey,
    Text,
    Index,
)
from sqlalchemy.orm import relationship
from datetime import datetime, timezone

from eolab_catalog.db.session import Base


class CatalogORM(Base):
    """
    ORM model representing a STAC Catalog.

    This model maps to the ``catalogs`` table and stores core STAC Catalog
    fields along with internal metadata used for persistence and auditing.

    The ``type`` field corresponds to the STAC object type and is expected
    to always be ``"Catalog"`` for this model. Fields defined explicitly
    on the model represent known STAC attributes, while any additional
    non-core or extension fields may be stored in ``extra_fields`` and
    merged into the top-level object during serialization.

    Attributes:
        id (str): Unique identifier for the catalog. Serves as the primary key.
        type (str): STAC object type. Must be ``"Catalog"``.
        title (str): Human-readable title of the catalog.
        description (str): Detailed description of the catalog.
        stac_version (str): STAC version string (e.g., ``"1.1.0"``).
        stac_extensions (Optional[List[str]]): List of STAC extension
            identifiers applied to this catalog. Optional.
        extra_fields (Optional[Dict[str, Any]]): Additional top-level STAC
            fields not explicitly modeled. These are preserved for round-trip
            serialization and may include custom or extension-defined fields.
        created_at (datetime): Timestamp indicating when this record was
            created in the database. Not part of the STAC specification.
        updated_at (datetime): Timestamp indicating when this record was last
            updated in the database. Not part of the STAC specification.
        collections (List[CollectionORM]): Related collections belonging to
            this catalog. Deleting the catalog will cascade and delete all
            associated collections.
    """

    __tablename__ = "catalogs"

    id = Column(String, primary_key=True, index=True)
    type = Column(String, nullable=False)
    title = Column(String, nullable=False)
    description = Column(Text, nullable=False)
    stac_version = Column(String, nullable=False)
    stac_extensions = Column(JSON, nullable=True)
    extra_fields = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    collections = relationship(
        "CollectionORM", back_populates="catalog", cascade="all, delete-orphan"
    )


class CollectionORM(Base):
    __tablename__ = "collections"

    id = Column(String, primary_key=True)
    catalog_id = Column(
        String, ForeignKey("catalogs.id", ondelete="CASCADE"), nullable=False
    )
    type = Column(String, nullable=False, default="Collection")
    title = Column(String, nullable=True)
    description = Column(Text, nullable=False)
    stac_version = Column(String, nullable=False)
    stac_extensions = Column(JSON, nullable=True)
    # Can
    license = Column(String, nullable=False, default="proprietary")
    keywords = Column(JSON, nullable=True, default=list)
    providers = Column(JSON, nullable=True, default=list)

    # Spatial extent: bbox as [west, south, east, north]
    # TODO: turn this into a list or something OGC compliant.
    bbox_west = Column(Float, nullable=True)
    bbox_south = Column(Float, nullable=True)
    bbox_east = Column(Float, nullable=True)
    bbox_north = Column(Float, nullable=True)

    # Temporal extent
    temporal_start = Column(DateTime, nullable=True)
    temporal_end = Column(DateTime, nullable=True)

    summaries = Column(JSON, nullable=True, default=dict)
    extra_fields = Column(JSON, nullable=True, default=dict)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    catalog = relationship("CatalogORM", back_populates="collections")
    items = relationship(
        "ItemORM", back_populates="collection", cascade="all, delete-orphan"
    )

    __table_args__ = (Index("ix_collections_catalog_id", "catalog_id"),)


class ItemORM(Base):
    __tablename__ = "items"

    id = Column(String, primary_key=True)
    collection_id = Column(
        String, ForeignKey("collections.id", ondelete="CASCADE"), nullable=False
    )
    catalog_id = Column(String, nullable=False)
    type = Column(String, nullable=False, default="Feature")
    stac_version = Column(String, nullable=False, default="1.0.0")
    stac_extensions = Column(JSON, nullable=True, default=list)

    # Geometry stored as GeoJSON dict
    geometry = Column(JSON, nullable=True)

    # Bbox denormalized for fast spatial queries
    bbox_west = Column(Float, nullable=True)
    bbox_south = Column(Float, nullable=True)
    bbox_east = Column(Float, nullable=True)
    bbox_north = Column(Float, nullable=True)

    # Core STAC properties
    datetime = Column(DateTime, nullable=True)
    start_datetime = Column(DateTime, nullable=True)
    end_datetime = Column(DateTime, nullable=True)
    created = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    platform = Column(String, nullable=True)
    instruments = Column(JSON, nullable=True)
    constellation = Column(String, nullable=True)
    mission = Column(String, nullable=True)
    gsd = Column(Float, nullable=True)
    eo_cloud_cover = Column(Float, nullable=True)
    extra_properties = Column(JSON, nullable=True, default=dict)

    # Assets: dict of asset_key -> asset object
    assets = Column(JSON, nullable=False, default=dict)

    # Links
    links = Column(JSON, nullable=True, default=list)

    collection = relationship("CollectionORM", back_populates="items")

    __table_args__ = (
        Index("ix_items_collection_id", "collection_id"),
        Index("ix_items_catalog_id", "catalog_id"),
        Index("ix_items_datetime", "datetime"),
        Index(
            "ix_items_bbox",
            "bbox_west",
            "bbox_south",
            "bbox_east",
            "bbox_north",
        ),
        Index("ix_items_platform", "platform"),
    )
