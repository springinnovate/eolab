"""Neutral mounted-vector catalog identity contract shared by consumers."""

from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

MOUNTED_VECTOR_COLLECTION_ID = "eolab-mounted-vectors"


class CatalogVectorRequest(BaseModel):
    """Identify one mounted-vector catalog Item without accepting paths."""

    model_config = ConfigDict(extra="forbid")

    collection_id: Literal[MOUNTED_VECTOR_COLLECTION_ID] = Field(
        alias="collectionId",
    )
    item_id: str = Field(
        alias="itemId",
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._~-]*$",
        strict=True,
    )
