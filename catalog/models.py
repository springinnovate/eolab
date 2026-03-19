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

from stac_catalog.db.database import Base


class CatalogORM(Base):
    __tablename__ = "catalogs"

    id = Column(String, primary_key=True, index=True)
    # TODO: what other types are there?
    type = Column(String, nullable=False, default="Catalog")
    title = Column(String, nullable=True)
    description = Column(Text, nullable=False)
    stac_version = Column(String, nullable=False, default="1.1.0")
    stac_extensions = Column(JSON, nullable=True, default=list)
    extra_fields = Column(JSON, nullable=True, default=dict)
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
    stac_version = Column(String, nullable=False, default="1.0.0")
    stac_extensions = Column(JSON, nullable=True, default=list)
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
