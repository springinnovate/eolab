from datetime import datetime, timezone

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import JSON

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class CollectionRecord(Base):
    __tablename__ = "collections"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    license: Mapped[str] = mapped_column(
        String, nullable=False, default="proprietary"
    )
    keywords_json: Mapped[list] = mapped_column(
        JSON, nullable=False, default=list
    )
    extra_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class ItemRecord(Base):
    __tablename__ = "items"
    __table_args__ = (
        UniqueConstraint(
            "collection_id", "logical_id", "version", name="uq_item_version"
        ),
    )

    item_id: Mapped[str] = mapped_column(String, primary_key=True)
    collection_id: Mapped[str] = mapped_column(
        ForeignKey("collections.id"), nullable=False, index=True
    )
    logical_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String, nullable=False, index=True)
    geometry_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    bbox_json: Mapped[list | None] = mapped_column(JSON, nullable=True)
    datetime_value: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    properties_json: Mapped[dict] = mapped_column(
        JSON, nullable=False, default=dict
    )
    assets_json: Mapped[dict] = mapped_column(
        JSON, nullable=False, default=dict
    )
    stac_extensions_json: Mapped[list] = mapped_column(
        JSON, nullable=False, default=list
    )
    links_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    raw_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class AssetRecord(Base):
    __tablename__ = "assets"

    stable_id: Mapped[str] = mapped_column(String, primary_key=True)
    item_id: Mapped[str] = mapped_column(
        ForeignKey("items.item_id"), nullable=False, index=True
    )
    collection_id: Mapped[str] = mapped_column(
        String, nullable=False, index=True
    )
    logical_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    asset_key: Mapped[str] = mapped_column(String, nullable=False)
    href: Mapped[str] = mapped_column(Text, nullable=False)
    media_type: Mapped[str | None] = mapped_column(String, nullable=True)
    roles_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    asset_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
