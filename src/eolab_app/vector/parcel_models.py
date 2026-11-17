"""Describe original parcel identities and bounded, geometry-free row pages."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictStr, model_validator

from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.catalog_selection import CatalogSelection
from eolab_app.vector.filters import CatalogVectorFilterRequest

ParcelField = Annotated[StrictStr, Field(min_length=1, max_length=256)]
ParcelOffset = Annotated[int, Field(strict=True, ge=0)]
ParcelPageSize = Annotated[int, Field(strict=True, ge=1, le=500)]
ParcelIdType = Literal["integer", "string"]


class ParcelIdRequest(CatalogVectorRequest):
    """Choose one original field to validate across an entire Catalog layer."""

    idField: ParcelField


class ParcelRowsRequest(CatalogVectorFilterRequest):
    """Read selected parcel rows, skipping offset exact matches in native order.

    Fields name original scalar attributes to show as text. They do not change
    the filter, and no geometry is returned. Limit bounds returned rows to 500.
    """

    idField: ParcelField
    fields: tuple[ParcelField, ...] = ()
    offset: ParcelOffset = 0
    limit: ParcelPageSize = 100


class ParcelIdInput(BaseModel):
    """Supply the authorized original layer and ID field to a native job."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    selection: CatalogSelection
    idField: ParcelField


class ParcelRowsInput(ParcelIdInput):
    """Supply an authorized selection and bounded attribute page to a native job."""

    fields: tuple[ParcelField, ...] = ()
    offset: ParcelOffset = 0
    limit: ParcelPageSize = 100


class ParcelId(BaseModel):
    """Identify a parcel without losing int64 precision in a browser.

    Integer values use canonical decimal text; string values preserve their
    original spelling. The type distinguishes integer 42 from string "42".
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    type: ParcelIdType
    value: StrictStr

    @model_validator(mode="after")
    def validate_value(self) -> "ParcelId":
        """Reject blank strings and noncanonical integer text at wire boundaries.

        Returns:
            This exact typed identifier.

        Raises:
            ValueError: If the value is blank or integer text is not canonical.
        """
        if not self.value.strip():
            raise ValueError("Parcel IDs must not be empty or whitespace-only")
        if self.type == "integer":
            try:
                canonical = str(int(self.value))
            except ValueError as error:
                raise ValueError(
                    "Integer parcel IDs require canonical decimal text"
                ) from error
            if canonical != self.value:
                raise ValueError("Integer parcel IDs require canonical decimal text")
        return self


class ParcelIdValidation(BaseModel):
    """Confirm a unique, nonempty original ID for every feature in a whole layer."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    idField: ParcelField
    idType: ParcelIdType
    featureCount: Annotated[int, Field(strict=True, ge=0)]


class ParcelLookupRequest(ParcelIdRequest):
    """Find one typed ID in an original Catalog layer, independently of its filter."""

    parcelId: ParcelId


class ParcelLookupInput(ParcelIdInput):
    """Supply the original authorized layer and exact typed ID to a lookup job."""

    parcelId: ParcelId


class ParcelLookupResponse(BaseModel):
    """Report original-layer membership tied to authoritative Catalog identity."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    found: Annotated[bool, Field(strict=True)]
    selection: CatalogSelection


class ParcelRow(BaseModel):
    """Return a typed parcel ID and original attributes formatted for display.

    Properties are text or null, including decimal text for int64 attributes.
    These display values are not an analysis-numeric interchange format.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    id: ParcelId
    properties: dict[str, StrictStr | None]


class ParcelRowsPage(BaseModel):
    """Return a bounded exact-match page and its next matching-row offset.

    A null nextOffset means the selection was exhausted. Native feature order
    is stable for the admitted immutable source; no geometry is included.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)
    rows: tuple[ParcelRow, ...]
    offset: ParcelOffset
    nextOffset: ParcelOffset | None


class ParcelIdValidationResponse(ParcelIdValidation):
    """Bind successful whole-layer ID validation to authoritative Catalog identity."""

    selection: CatalogSelection


class ParcelRowsResponse(ParcelRowsPage):
    """Bind returned rows to the authoritative Catalog source and exact filter."""

    selection: CatalogSelection
