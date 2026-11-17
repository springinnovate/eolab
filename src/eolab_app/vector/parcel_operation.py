"""Validate, find and page original parcels in isolated Jobs execution processes."""

import asyncio
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

from eolab_app.catalog_selection import (
    CatalogSelection,
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.vector.parcel_models import (
    ParcelIdInput,
    ParcelIdValidation,
    ParcelLookupInput,
    ParcelRowsInput,
    ParcelRowsPage,
)

CATALOG_URL = "http://stac-api:8080"
SCAN_MOUNT = Path("/scan-source")


class ParcelIdResult(BaseModel):
    """Complete-layer identity validation or a safe expected source/read error."""

    model_config = ConfigDict(extra="forbid")
    validation: ParcelIdValidation | None = None
    error: str | None = Field(default=None, min_length=1, max_length=1024)

    @model_validator(mode="after")
    def require_validation_or_error(self) -> "ParcelIdResult":
        """Require exactly one outcome across the native process boundary.

        Returns:
            This validated result.

        Raises:
            ValueError: If both outcomes are present or neither is present.
        """
        if (self.validation is None) == (self.error is None):
            raise ValueError("Expected parcel ID validation or a read error")
        return self


class ParcelRowsResult(BaseModel):
    """One complete page of parcel attributes or a safe expected read error."""

    model_config = ConfigDict(extra="forbid")
    page: ParcelRowsPage | None = None
    error: str | None = Field(default=None, min_length=1, max_length=1024)

    @model_validator(mode="after")
    def require_page_or_error(self) -> "ParcelRowsResult":
        """Require exactly one outcome across the native process boundary.

        Returns:
            This validated result.

        Raises:
            ValueError: If both outcomes are present or neither is present.
        """
        if (self.page is None) == (self.error is None):
            raise ValueError("Expected a parcel page or a read error")
        return self


class ParcelLookupResult(BaseModel):
    """Original-layer membership, including absence, or a safe expected read error."""

    model_config = ConfigDict(extra="forbid")
    found: StrictBool | None = None
    error: str | None = Field(default=None, min_length=1, max_length=1024)

    @model_validator(mode="after")
    def require_membership_or_error(self) -> "ParcelLookupResult":
        """Require a membership Boolean or an error across the native boundary.

        Returns:
            This validated result, with false representing a successful absent lookup.

        Raises:
            ValueError: Both outcomes are present or neither is present.
        """
        if (self.found is None) == (self.error is None):
            raise ValueError("Expected parcel membership or a read error")
        return self


def lookup_catalog_parcel(inputs: ParcelLookupInput) -> ParcelLookupResult:
    """Find one original typed parcel ID through the registered native operation.

    Args:
        inputs: Catalog layer identity, original ID field and requested typed ID.

    Returns:
        Membership, including absent success, or a safe source/budget explanation.

    Raises:
        VectorFeatureError: Catalog authorization failed.
        OSError: The process memory allowance could not be applied.
    """
    from eolab_app.bounded_geometry import GeometryValidationError

    try:
        return asyncio.run(_lookup_catalog_parcel(inputs))
    except (GeometryValidationError, SelectionUnavailableError) as error:
        return ParcelLookupResult(error=str(error))


async def _lookup_catalog_parcel(inputs: ParcelLookupInput) -> ParcelLookupResult:
    """Reauthorize the original source and find an ID under existing native budgets.

    Args:
        inputs: Accepted Catalog identity, original ID field and requested typed ID.

    Returns:
        Exact original-layer membership.

    Raises:
        SelectionUnavailableError: Source identity changed or reading failed.
        GeometryValidationError: Schema, candidate IDs or read budgets are invalid.
        VectorFeatureError: Catalog authorization failed.
        OSError: The process memory allowance could not be applied.
    """
    from eolab_app.bounded_vector import _limit_memory
    from eolab_app.vector.parcels import lookup_parcel

    resolved = await _resolve_parcel_source(inputs.selection)
    with _limit_memory():
        found = lookup_parcel(resolved, inputs.idField, inputs.parcelId)
    return ParcelLookupResult(found=found)


def validate_catalog_parcel_ids(inputs: ParcelIdInput) -> ParcelIdResult:
    """Validate every original parcel ID through the registered native operation.

    Args:
        inputs: Catalog layer identity and one original ID field.

    Returns:
        Full-layer validation or a safe invalid-ID/source/budget explanation.

    Raises:
        VectorFeatureError: Catalog authorization failed.
        OSError: The process memory allowance could not be applied.
    """
    from eolab_app.bounded_geometry import GeometryValidationError

    try:
        return asyncio.run(_validate_catalog_parcel_ids(inputs))
    except (GeometryValidationError, SelectionUnavailableError) as error:
        return ParcelIdResult(error=str(error))


async def _validate_catalog_parcel_ids(inputs: ParcelIdInput) -> ParcelIdResult:
    """Reauthorize a whole-layer descriptor and validate IDs under native budgets.

    Args:
        inputs: Accepted Catalog identity and original ID field.

    Returns:
        Complete identity-validation result.

    Raises:
        SelectionUnavailableError: The source identity changed or cannot be read.
        GeometryValidationError: The ID field, polygon schema or read budget is invalid.
        VectorFeatureError: Catalog authorization failed.
        OSError: The process memory allowance could not be applied.
    """
    from eolab_app.bounded_vector import _limit_memory
    from eolab_app.vector.parcels import validate_parcel_ids

    resolved = await _resolve_parcel_source(inputs.selection)
    with _limit_memory():
        validation = validate_parcel_ids(resolved, inputs.idField)
    return ParcelIdResult(validation=validation)


def read_catalog_parcel_rows(inputs: ParcelRowsInput) -> ParcelRowsResult:
    """Read a filtered parcel page through the registered native operation.

    Args:
        inputs: Catalog selection, ID/display fields and page bounds.

    Returns:
        A complete page, including empty success, or a safe read explanation.

    Raises:
        VectorFeatureError: Catalog authorization failed.
        OSError: The process memory allowance could not be applied.
    """
    from eolab_app.bounded_geometry import GeometryValidationError

    try:
        return asyncio.run(_read_catalog_parcel_rows(inputs))
    except (GeometryValidationError, SelectionUnavailableError) as error:
        return ParcelRowsResult(error=str(error))


async def _read_catalog_parcel_rows(inputs: ParcelRowsInput) -> ParcelRowsResult:
    """Reauthorize a selection and read its current parcel page under native budgets.

    Args:
        inputs: Catalog selection, original ID/display fields and page bounds.

    Returns:
        The requested complete page.

    Raises:
        SelectionUnavailableError: Source identity changed or reading failed.
        GeometryValidationError: Fields, polygon schema or read budgets are invalid.
        VectorFeatureError: Catalog authorization failed.
        OSError: The process memory allowance could not be applied.
    """
    from eolab_app.bounded_vector import _limit_memory
    from eolab_app.vector.parcels import read_parcel_rows

    resolved = await _resolve_parcel_source(inputs.selection)
    with _limit_memory():
        page = read_parcel_rows(
            resolved, inputs.idField, inputs.fields, inputs.offset, inputs.limit
        )
    return ParcelRowsResult(page=page)


async def _resolve_parcel_source(
    selection: CatalogSelection,
) -> ResolvedCatalogSelection:
    """Resolve and recheck the Catalog identity accepted before queueing.

    Args:
        selection: Path-free immutable source descriptor.

    Returns:
        The authorized original layer and exact attribute-filter program.

    Raises:
        SelectionUnavailableError: The resolved layer differs from the accepted identity.
        VectorFeatureError: Catalog or mounted-source resolution failed.
    """
    import httpx2
    from eolab_app.vector.catalog import StacVectorCatalog
    from eolab_app.vector.selection_source import resolve_selection
    from eolab_app.vector.sources import MountedVectorResolver

    async with httpx2.AsyncClient(
        timeout=5, trust_env=False, follow_redirects=False
    ) as client:
        resolved = await resolve_selection(
            StacVectorCatalog(client, CATALOG_URL),
            MountedVectorResolver(SCAN_MOUNT),
            selection,
        )
    if resolved.selection != selection:
        raise SelectionUnavailableError(
            "The selected vector identity changed; select it again."
        )
    return resolved
