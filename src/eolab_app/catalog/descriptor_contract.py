"""Define portable catalog descriptors and their public curated metadata.

A ``*.eolab.yaml`` file describes a dataset or its selected logical layer. Local
asset paths and source selectors belong only to admission; public Assets use
catalog identity URLs.
The scanner owns filesystem confinement, source inspection and lifecycle. This
module performs no I/O except explicitly requested YAML parsing/schema export.
"""

from __future__ import annotations

from datetime import datetime
import json
from pathlib import PurePosixPath, PureWindowsPath
import re
from typing import Annotated, Any, Literal, Self
from urllib.parse import urlencode, urlsplit

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    JsonValue,
    model_validator,
)
import yaml

DESCRIPTOR_SCHEMA = "eolab/item/v1"
DESCRIPTOR_SUFFIX = ".eolab.yaml"
CURATED_METADATA_KEY = "eolab:metadata"
ASSET_ACCESS_KEY = "eolab:access"
DESCRIPTOR_ID_KEY = "eolab:descriptor_id"
TIME_BASIS_KEY = "eolab:time_basis"
NONSPATIAL_COLLECTION_ID = "eolab-described-nonspatial"

Identifier = Annotated[
    str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9._~-]*$")
]
NonemptyText = Annotated[str, Field(pattern=r"\S")]


def validate_http_url(value: str) -> str:
    """Return an HTTP(S) reference suitable for public links.

    Args:
        value: External URL supplied in a descriptor.

    Returns:
        The unchanged URL, preserving query strings and fragments.

    Raises:
        ValueError: If the URL lacks a host, includes credentials, controls,
            whitespace or backslashes, has an invalid port, or uses another protocol.
    """
    parsed = urlsplit(value)
    parsed.port  # Reading the port rejects malformed/out-of-range port values.
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or "\\" in value
        or any(character.isspace() or ord(character) < 32 for character in value)
    ):
        raise ValueError(
            "Use a valid HTTP(S) URL without credentials, whitespace or control characters"
        )
    return value


HttpReference = Annotated[
    str,
    Field(json_schema_extra={"pattern": r"^https?://"}),
    AfterValidator(validate_http_url),
]


def validate_relative_path(value: str) -> str:
    """Return a portable asset path relative to its descriptor.

    Args:
        value: POSIX-style local path; parent segments are allowed because the
            admission boundary confines the resolved result to the source mount.

    Returns:
        The unchanged relative path.

    Raises:
        ValueError: If the path is empty, absolute, drive-qualified, contains a
            URI scheme, backslash or NUL, or names only the current directory.
    """
    if (
        not value.strip()
        or value == "."
        or PurePosixPath(value).is_absolute()
        or PureWindowsPath(value).drive
        or ":" in value
        or "\\" in value
        or "\x00" in value
    ):
        raise ValueError(
            "Asset paths must be relative POSIX paths inside the source mount"
        )
    return value


RelativeAssetPath = Annotated[
    str, Field(min_length=1), AfterValidator(validate_relative_path)
]


def validate_timestamp(value: str) -> str:
    """Return a timezone-qualified RFC 3339 timestamp.

    Args:
        value: Observation or explicitly supplied source-modified timestamp.

    Returns:
        The unchanged valid timestamp.

    Raises:
        ValueError: If the value is not a complete timestamp with an offset.
    """
    if not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value
    ):
        raise ValueError("Use a complete RFC 3339 timestamp with a timezone")
    datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


Timestamp = Annotated[
    str,
    Field(
        json_schema_extra={
            "pattern": r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
        }
    ),
    AfterValidator(validate_timestamp),
]


class ContractModel(BaseModel):
    """Reject unknown authoring fields and preserve supplied JSON value types."""

    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


def validate_doi_name(value: str) -> str:
    """Return a DOI name for a dataset, Asset or related publication.

    Args:
        value: DOI name such as ``10.1234/example``, not a DOI URL.

    Returns:
        The unchanged DOI name.

    Raises:
        ValueError: If the value lacks a DOI prefix/suffix or has whitespace.
    """
    if not re.fullmatch(r"10\.\d{4,9}/\S+", value):
        raise ValueError("DOI must be a DOI name such as 10.1234/example")
    return value


DoiName = Annotated[str, AfterValidator(validate_doi_name)]


class Publication(ContractModel):
    """Describe a related publication, independently of dataset observation time.

    ``doi`` identifies the paper, not the dataset. Ordered authors and notes are
    retained as supplied; unavailable values remain absent rather than invented.
    Arbitrary public annotations preserve additional source fields losslessly.
    """

    id: Identifier
    title: NonemptyText
    doi: DoiName | None = None
    citation: NonemptyText | None = None
    url: HttpReference | None = None
    authors: list[NonemptyText] = Field(default_factory=list)
    year: Annotated[int, Field(ge=1, le=9999)] | None = None
    notes: list[NonemptyText] = Field(default_factory=list)
    annotations: dict[str, JsonValue] = Field(default_factory=dict)


class CuratedMetadata(ContractModel):
    """Carry the same public annotation envelope on an Item or one Asset.

    Lists retain source order; absent lists/maps become empty. Optional values
    remain null or absent. ``annotations`` preserves JSON scalar, array, object
    and null values, including zero and false. Authors must exclude private
    locations/secrets from these deliberately public values. Category, risk,
    status and study IDs are exact author-supplied labels for search; they are
    not restricted to the resilience workbook's vocabulary. ``doi`` and
    ``citation`` describe the dataset/resource itself, separately from related
    papers in ``publications``.
    """

    version: Literal[1] = 1
    title: NonemptyText | None = None
    description: str | None = None
    keywords: list[NonemptyText] = Field(default_factory=list)
    license: NonemptyText | None = None
    attribution: NonemptyText | None = None
    doi: DoiName | None = None
    citation: NonemptyText | None = None
    categories: list[NonemptyText] = Field(default_factory=list)
    risks: list[NonemptyText] = Field(default_factory=list)
    statuses: list[NonemptyText] = Field(default_factory=list)
    study_ids: list[Identifier] = Field(default_factory=list)
    study_time: str | None = None
    publications: list[Publication] = Field(default_factory=list)
    annotations: dict[str, JsonValue] = Field(default_factory=dict)


class LocalAsset(ContractModel):
    """Reference a local file or container without exposing its location publicly.

    The admission boundary resolves ``path`` relative to the descriptor and
    confines it to the source mount. Supporting files can be shared by Items.
    """

    location: Literal["local"]
    path: RelativeAssetPath
    media_type: NonemptyText
    roles: list[NonemptyText] = Field(default_factory=list)
    metadata: CuratedMetadata = Field(default_factory=CuratedMetadata)


class ExternalAsset(ContractModel):
    """Reference an existing external HTTP(S) resource without fetching it."""

    location: Literal["external"]
    href: HttpReference
    media_type: NonemptyText
    roles: list[NonemptyText] = Field(default_factory=list)
    metadata: CuratedMetadata = Field(default_factory=CuratedMetadata)


Asset = Annotated[LocalAsset | ExternalAsset, Field(discriminator="location")]


class SpatialSource(ContractModel):
    """Select the existing reader and exact logical layer in the primary Asset.

    GeoPackages and File Geodatabases optionally select ``layer``. ZIP/Shapefile
    sources optionally select the complete internal ``member`` path to a .shp
    file. Omit the selector to admit every Item the existing reader produces. These are
    admission selectors, not public paths. Ordinary GeoTIFF, GeoJSON and
    Shapefile sources have neither selector.
    """

    format: Literal[
        "geotiff",
        "geopackage",
        "shapefile",
        "zipped-shapefile",
        "geojson",
        "file-geodatabase",
    ]
    layer: NonemptyText | None = None
    member: RelativeAssetPath | None = None

    @model_validator(mode="after")
    def validate_source_selector(self) -> Self:
        """Require only the selector understood by the selected format reader.

        Returns:
            This validated spatial source.

        Raises:
            ValueError: If an inapplicable selector is supplied, or an archive
                member can escape its root.
        """
        layered = self.format in {"geopackage", "file-geodatabase"}
        archived = self.format == "zipped-shapefile"
        if (self.layer is not None and not layered) or (
            self.member is not None and not archived
        ):
            raise ValueError(
                "Use layer only for GeoPackage/File Geodatabase and member only for ZIP/Shapefile"
            )
        if self.member is not None and (
            ".." in PurePosixPath(self.member).parts
            or not self.member.lower().endswith(".shp")
        ):
            raise ValueError("Archive member must name a confined .shp member")
        return self


class InstantTime(ContractModel):
    """Supply one observation timestamp, independently of publication dates."""

    mode: Literal["instant"]
    datetime: Timestamp


class IntervalTime(ContractModel):
    """Supply an inclusive observation interval with no invented midpoint."""

    mode: Literal["interval"]
    start_datetime: Timestamp
    end_datetime: Timestamp

    @model_validator(mode="after")
    def validate_time_order(self) -> Self:
        """Reject an interval whose end precedes its start.

        Returns:
            This validated interval.

        Raises:
            ValueError: If the interval is reversed after timezone conversion.
        """
        if datetime.fromisoformat(
            self.start_datetime.replace("Z", "+00:00")
        ) > datetime.fromisoformat(self.end_datetime.replace("Z", "+00:00")):
            raise ValueError("Observation interval must end at or after its start")
        return self


class ModifiedTime(ContractModel):
    """Explicitly use primary-file modification time when observation time is unknown.

    Admission must publish ``eolab:time_basis=source-modified``. This is a
    catalog timestamp, never a claim that the study observed data at that time.
    """

    mode: Literal["modified"]


TemporalMetadata = Annotated[
    InstantTime | IntervalTime | ModifiedTime, Field(discriminator="mode")
]


class ItemOverride(ContractModel):
    """Override one container layer/member without duplicating common metadata.

    Only explicitly supplied metadata fields replace common fields. Arrays and
    annotation maps replace as a whole; optional scalar nulls clear inherited
    values. An empty list/map clears that field. Item title cannot be cleared.
    Assets merge by key as complete replacements; the primary Asset cannot be
    replaced. Common supporting Assets remain unless their key is replaced.
    """

    metadata: CuratedMetadata = Field(default_factory=CuratedMetadata)
    assets: dict[Identifier, Asset] = Field(default_factory=dict)


class CatalogDescriptor(ContractModel):
    """Describe a dataset and its assets without prescribing a collection.

    A stable descriptor ID identifies this declared logical dataset. Existing
    spatial Item IDs and collections remain reader-owned; the scanner records
    the descriptor association. A container may produce several Items; common
    metadata applies to each, with exact layer/member ``item_overrides``. A
    common title remains unchanged unless overridden. Several descriptors may
    instead select distinct layers in one container. ``metadata.title`` is required
    for an Item. Nonspatial Items require explicit temporal metadata; spatial sources may retain their
    existing reader's date contract. The existing temporal ``dataset.yaml`` is
    a separate contract and is not interpreted by this model.
    """

    schema_version: Literal["eolab/item/v1"] = Field(alias="schema")
    id: Identifier
    kind: Literal["raster", "vector", "nonspatial"]
    primary_asset: Identifier
    assets: Annotated[dict[Identifier, Asset], Field(min_length=1)]
    metadata: CuratedMetadata
    source: SpatialSource | None = None
    temporal: TemporalMetadata | None = None
    item_overrides: dict[NonemptyText, ItemOverride] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_item_shape(self) -> Self:
        """Check relationships between declared Item kind, assets and source.

        Returns:
            This validated descriptor.

        Raises:
            ValueError: If the primary Asset is absent, Item title is missing,
                source and kind disagree, or required temporal metadata is absent.
        """
        if self.primary_asset not in self.assets:
            raise ValueError("primary_asset must identify a declared Asset")
        if self.metadata.title is None:
            raise ValueError("Item metadata must supply a title")
        if self.kind == "nonspatial":
            if self.source is not None or self.temporal is None:
                raise ValueError(
                    "Nonspatial Items require temporal metadata and no spatial source"
                )
        elif self.source is None or not isinstance(
            self.assets[self.primary_asset], LocalAsset
        ):
            raise ValueError(
                "Spatial Items require a local primary Asset and existing source format"
            )
        elif (self.kind == "raster") != (self.source.format == "geotiff"):
            raise ValueError(
                "Raster Items use geotiff; vector Items use an existing vector format"
            )
        if isinstance(self.temporal, ModifiedTime) and not isinstance(
            self.assets[self.primary_asset], LocalAsset
        ):
            raise ValueError("Modified-time mode requires a local primary Asset")
        if self.item_overrides:
            if self.source is None or self.source.format not in {
                "geopackage",
                "file-geodatabase",
                "zipped-shapefile",
            }:
                raise ValueError(
                    "Item overrides apply only to container layers or archive members"
                )
            selected = self.source.layer or self.source.member
            if selected is not None and set(self.item_overrides) != {selected}:
                raise ValueError(
                    "Overrides must identify the explicitly selected layer/member"
                )
            for override in self.item_overrides.values():
                if self.primary_asset in override.assets:
                    raise ValueError(
                        "An Item override cannot replace the primary Asset"
                    )
                if (
                    "title" in override.metadata.model_fields_set
                    and override.metadata.title is None
                ):
                    raise ValueError("An Item override cannot clear its title")
        return self


def metadata_for_item(
    descriptor: CatalogDescriptor, selector: str | None = None
) -> CuratedMetadata:
    """Apply explicitly supplied metadata for one admitted layer/member.

    Args:
        descriptor: Validated dataset descriptor.
        selector: Exact reader-owned layer/member, or None for a single Item.
            Admission must reject override selectors absent from reader output.

    Returns:
        Common metadata with supplied override fields replaced. Optional null
        values clear inherited scalars; arrays/maps replace as complete values.
    """
    override = descriptor.item_overrides.get(selector) if selector is not None else None
    if override is None:
        return descriptor.metadata
    return descriptor.metadata.model_copy(
        update={
            name: getattr(override.metadata, name)
            for name in override.metadata.model_fields_set
        }
    )


def assets_for_item(
    descriptor: CatalogDescriptor, selector: str | None = None
) -> dict[str, Asset]:
    """Return common Assets plus complete supporting replacements for one Item.

    Args:
        descriptor: Validated dataset descriptor.
        selector: Exact admitted layer/member, or None for a single Item.

    Returns:
        A new Asset mapping. Shared supporting assets keep their common keys;
        explicitly supplied replacements/additions apply only to this Item.
    """
    assets = dict(descriptor.assets)
    override = descriptor.item_overrides.get(selector) if selector is not None else None
    if override is not None:
        assets.update(override.assets)
    return assets


def parse_catalog_descriptor(document: str) -> CatalogDescriptor:
    """Parse YAML authoring text into the validated v1 descriptor contract.

    Args:
        document: Contents of one ``*.eolab.yaml`` descriptor. Quote timestamps
            so YAML supplies strings rather than implicit datetime objects.

    Returns:
        A validated descriptor with private locations separate from metadata.

    Raises:
        yaml.YAMLError: If the document is malformed YAML.
        pydantic.ValidationError: If supplied values violate the contract.
    """
    return CatalogDescriptor.model_validate(yaml.safe_load(document))


def public_metadata_fields(metadata: CuratedMetadata) -> dict[str, Any]:
    """Project curated metadata into standard STAC fields and one public envelope.

    Args:
        metadata: Already validated Item or Asset annotations.

    Returns:
        Fresh JSON-compatible fields. Title, description, keywords and license
        are mirrored for ordinary STAC clients; ``eolab:metadata`` is authoritative
        for curated presentation. Null annotation values remain intact.
    """
    envelope = metadata.model_dump(mode="json")
    fields: dict[str, Any] = {CURATED_METADATA_KEY: envelope}
    for name in ("title", "description", "keywords", "license"):
        value = envelope[name]
        if value is not None and value != []:
            fields[name] = value
    return fields


def catalog_asset_href(collection_id: str, item_id: str, asset_key: str) -> str:
    """Build a local Asset URL containing catalog identity rather than a path.

    Args:
        collection_id: Owning STAC Collection identity.
        item_id: Owning Item identity within that Collection.
        asset_key: Named Asset within that Item.

    Returns:
        Relative URL for the catalog attachment endpoint. Its implementation
        resolves and authorizes the stored Asset; clients cannot supply paths.
    """
    return "/api/catalog/asset?" + urlencode(
        {"collection": collection_id, "item": item_id, "asset": asset_key}
    )


def public_asset_fields(
    asset: Asset, collection_id: str, item_id: str, asset_key: str
) -> dict[str, Any]:
    """Publish an Asset without copying local source paths or reader selectors.

    Args:
        asset: Validated descriptor Asset.
        collection_id: Owning STAC Collection identity.
        item_id: Owning Item identity.
        asset_key: Named Asset key.

    Returns:
        STAC Asset fields with an identity URL for local attachments or the
        declared HTTP(S) URL for external resources. Access kind is ``catalog``
        or ``external`` respectively. No file is read or downloaded.
    """
    local = isinstance(asset, LocalAsset)
    return {
        "href": (
            catalog_asset_href(collection_id, item_id, asset_key)
            if local
            else asset.href
        ),
        "type": asset.media_type,
        "roles": list(asset.roles),
        ASSET_ACCESS_KEY: {"kind": "catalog" if local else "external"},
        **public_metadata_fields(asset.metadata),
    }


def public_temporal_fields(
    temporal: TemporalMetadata, *, modified_at: str | None = None
) -> dict[str, Any]:
    """Produce STAC time fields without confusing observations and file dates.

    Args:
        temporal: Validated explicit temporal authoring mode.
        modified_at: Primary source modification timestamp supplied by admission,
            required only for the explicit ``modified`` mode.

    Returns:
        STAC datetime or interval properties and a public time-basis label.

    Raises:
        ValueError: If modified mode lacks a valid timezone-qualified timestamp.
    """
    if isinstance(temporal, InstantTime):
        return {"datetime": temporal.datetime, TIME_BASIS_KEY: "observation"}
    if isinstance(temporal, IntervalTime):
        return {
            "datetime": None,
            "start_datetime": temporal.start_datetime,
            "end_datetime": temporal.end_datetime,
            TIME_BASIS_KEY: "observation",
        }
    if modified_at is None:
        raise ValueError(
            "Modified-time mode requires the primary source modification timestamp"
        )
    return {
        "datetime": validate_timestamp(modified_at),
        TIME_BASIS_KEY: "source-modified",
    }


def descriptor_json_schema() -> dict[str, Any]:
    """Return the machine-readable authoring schema for the v1 descriptor.

    Returns:
        Pydantic's JSON Schema, including the shared CuratedMetadata definition.
        Cross-field relationships are additionally enforced by typed validators.
    """
    return CatalogDescriptor.model_json_schema(by_alias=True)


if __name__ == "__main__":
    print(json.dumps(descriptor_json_schema(), indent=2, ensure_ascii=False))
