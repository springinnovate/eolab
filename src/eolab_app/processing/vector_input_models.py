"""Capture original vector selections and the attributes chosen for model inputs."""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from eolab_app.catalog_selection import VectorSelection


class VectorFieldSelection(BaseModel):
    """An original source and attribute names keyed by a recipe's field roles.

    The recipe defines the role names and picker labels; operations decide what
    those roles mean. For example, ``fields={"weight": "population"}`` binds the
    source's population attribute to a configured weight role. An empty mapping
    selects only the source. Original field types are checked by the source reader
    or operation when the source is opened, without an admission feature scan.

    Attributes:
        selection: Path-free Catalog or uploaded source and captured predicate.
        fields: Source attributes chosen for exactly the recipe's configured roles.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    selection: VectorSelection
    fields: dict[
        Annotated[str, Field(strict=True, pattern=r"^[a-z][a-z0-9_-]{0,63}$")],
        Annotated[str, Field(strict=True, min_length=1, max_length=256)],
    ]
