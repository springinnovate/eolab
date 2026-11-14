"""Capture original vector selections and the attributes chosen for model inputs."""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from eolab_app.catalog_selection import VectorSelection


class VectorFieldSelectionRow(BaseModel):
    """Capture one row's attribute names and recipe-defined choice values.

    The model invocation validates the exact role names and allowed choices
    against the captured recipe. Source attribute types remain the responsibility
    of the operation or reader that opens the selected source.

    Attributes:
        fields: Source attributes keyed by the row's configured picker roles.
        parameters: String values keyed by the row's configured choice parameters.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    fields: dict[
        Annotated[str, Field(strict=True, pattern=r"^[a-z][a-z0-9_-]{0,63}$")],
        Annotated[str, Field(strict=True, min_length=1, max_length=256)],
    ]
    parameters: dict[
        Annotated[str, Field(strict=True, pattern=r"^[a-z][a-z0-9_-]{0,63}$")],
        Annotated[str, Field(strict=True, min_length=1, max_length=128)],
    ]


class VectorFieldSelection(BaseModel):
    """An original source and attribute names keyed by a recipe's field roles.

    The recipe defines the role names and picker labels; operations decide what
    those roles mean. For example, ``fields={"weight": "population"}`` binds the
    source's population attribute to a configured weight role. Empty fields and
    omitted rows select only the source. Original field types are checked by the
    source reader or operation when it opens the source, without an admission scan.

    Attributes:
        selection: Path-free Catalog or uploaded source and captured predicate.
        fields: Source attributes chosen for exactly the recipe's configured roles.
        rows: Ordered attribute and choice selections when the recipe enables rows.
            Omitted for ordinary inputs; configured inputs require at least one row.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    selection: VectorSelection
    fields: dict[
        Annotated[str, Field(strict=True, pattern=r"^[a-z][a-z0-9_-]{0,63}$")],
        Annotated[str, Field(strict=True, min_length=1, max_length=256)],
    ]
    rows: Annotated[tuple[VectorFieldSelectionRow, ...], Field(min_length=1)] | None = (
        Field(default=None, exclude_if=lambda value: value is None)
    )
