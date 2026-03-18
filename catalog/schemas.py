from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class CollectionCreate(BaseModel):
    id: str
    title: str
    description: str
    license: str = 'proprietary'
    keywords: list[str] = Field(default_factory=list)
    extra: dict[str, Any] = Field(default_factory=dict)


class RegisterItemRequest(BaseModel):
    collection_id: str
    item: dict[str, Any]
    kind: Literal['raster', 'vector', 'derived'] | None = None
    logical_id: str | None = None


class BulkRegisterRequest(BaseModel):
    entries: list[RegisterItemRequest]


class WorkflowRunCreate(BaseModel):
    run_id: str
    workflow_id: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    started_at: datetime | None = None
    ended_at: datetime | None = None


class DerivedRegisterRequest(BaseModel):
    collection_id: str
    item: dict[str, Any]
    workflow_run_id: str
    source_asset_ids: list[str] = Field(default_factory=list)
    logical_id: str | None = None


class SearchRequest(BaseModel):
    collections: list[str] | None = None
    ids: list[str] | None = None
    asset_ids: list[str] | None = None
    kind: Literal['raster', 'vector', 'derived'] | None = None
    bbox: list[float] | None = None
    intersects: dict[str, Any] | None = None
    datetime: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    limit: int = 10


class ResolveAssetsRequest(BaseModel):
    asset_ids: list[str]
