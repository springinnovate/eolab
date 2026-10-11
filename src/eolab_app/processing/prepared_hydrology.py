"""Describe prepared hydrology datasets and retain their validated source identities."""

from pathlib import Path
from types import MappingProxyType
from typing import Annotated, Literal, Self

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from eolab_app.catalog.vector_contract import CatalogVectorRequest
from eolab_app.catalog_selection import CatalogSelection
from eolab_app.processing.model_yaml import compute_document_checksum, parse_yaml
from eolab_app.processing.models import ProcessingError
from eolab_app.raster.models import CatalogRasterRequest, Wgs84Bounds

Identifier = Annotated[str, Field(strict=True, pattern=r"^[a-z][a-z0-9_-]{0,63}$")]
Version = Annotated[
    str,
    Field(strict=True, pattern=r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"),
]
Digest = Annotated[str, Field(strict=True, pattern=r"^[a-f0-9]{64}$")]
FieldName = Annotated[str, Field(strict=True, min_length=1, max_length=128)]
NetworkId = (
    Annotated[int, Field(strict=True)]
    | Annotated[str, Field(strict=True, min_length=1, max_length=128)]
)


class HydrologySchema(BaseModel):
    """Immutable hydrology settings that reject misspelled or unsupported fields."""

    model_config = ConfigDict(
        extra="forbid", frozen=True, populate_by_name=True, allow_inf_nan=False
    )


class HydrologyRaster(CatalogRasterRequest):
    """An immutable catalog identity for the prepared elevation raster."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class HydrologyWatersheds(CatalogVectorRequest):
    """An immutable catalog identity for the complete watershed network."""

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class NetworkTermination(HydrologySchema):
    """Identify a terminal watershed by matching a constant or another field.

    For HydroBASINS this is typically NEXT_DOWN equal to integer zero. String,
    integer and Boolean terminal flags are supported without coercion. Setting
    ``equalsField: HYBAS_ID`` with ``field: NEXT_SINK`` instead stops at the next
    real sink, including endorheic sinks with virtual downstream links.
    """

    field: FieldName
    value: NetworkId | Annotated[bool, Field(strict=True)] | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    equalsField: FieldName | None = Field(
        default=None, exclude_if=lambda value: value is None
    )

    @model_validator(mode="after")
    def check_comparison(self) -> Self:
        """Require exactly one comparison and reject self-comparison.

        Returns:
            This terminal rule with an unambiguous comparison.

        Raises:
            ValueError: If neither or both comparisons are supplied, or fields match.
        """
        if (self.value is None) == (self.equalsField is None):
            raise ValueError("Choose a terminal value or equalsField")
        if self.equalsField == self.field:
            raise ValueError("Terminal comparison requires two different fields")
        return self

    def matches(self, properties: dict[str, object]) -> bool:
        """Test a watershed's fields against the configured stopping rule.

        Args:
            properties: Original source properties containing the required fields.

        Returns:
            True when both values have the same type and value.

        Raises:
            ValueError: If comparison values are missing or have different types.
        """
        actual = properties[self.field]
        expected = properties[self.equalsField] if self.equalsField else self.value
        if actual is None or type(actual) is not type(expected):
            raise ValueError(
                "Terminal comparison values must have the same non-null type"
            )
        return actual == expected


class WatershedTopology(HydrologySchema):
    """Map watershed IDs, downstream links and optional terminal drainage IDs.

    All IDs use the declared type. When terminalIdField is supplied, its value
    must equal the feature ID of the terminal reached by following downstream links.
    """

    idField: FieldName
    downstreamField: FieldName
    idType: Literal["integer", "string"]
    terminal: NetworkTermination
    terminalIdField: FieldName | None = None

    @model_validator(mode="after")
    def check_distinct_fields(self) -> Self:
        """Require distinct identity and downstream fields.

        Returns:
            This mapping after checking that links can identify another feature.

        Raises:
            ValueError: If identity and downstream fields coincide.
        """
        if self.idField == self.downstreamField:
            raise ValueError("Feature ID and next-downstream ID need different fields")
        return self


class TerrainPreparation(HydrologySchema):
    """Record the administrator's terrain preparation and intended routing method.

    Conditioning provenance is an explicit declaration, not a claim that this
    validator proves hydrologic correctness or recomputes flow directions.
    """

    routing: Literal["mfd"]
    elevationUnit: Literal["metre"]
    conditioning: Annotated[str, Field(strict=True, min_length=1, max_length=2000)]
    datasetVersion: Annotated[str, Field(strict=True, min_length=1, max_length=160)]


class PreparedHydrologyDefinition(HydrologySchema):
    """Pair catalog elevation and watershed data with their routing and field mappings."""

    schema_version: Literal["eolab.hydrology/v1"] = Field(alias="schema")
    id: Identifier
    version: Version
    title: Annotated[str, Field(strict=True, min_length=1, max_length=80)]
    description: Annotated[str, Field(strict=True, min_length=1, max_length=2000)]
    dem: HydrologyRaster
    watersheds: HydrologyWatersheds
    topology: WatershedTopology
    terrain: TerrainPreparation


class HydrologyGrid(HydrologySchema):
    """The original DEM grid checked during dataset preparation, before any run-specific warp."""

    crs: Annotated[str, Field(min_length=1, max_length=4096)]
    transform: tuple[float, float, float, float, float, float]
    width: Annotated[int, Field(strict=True, gt=0)]
    height: Annotated[int, Field(strict=True, gt=0)]
    dtype: str


class HydrologyValidation(HydrologySchema):
    """Record installed network checks and their scope without retaining geometry.

    Version 2 checks network connections and DEM metadata without reading elevation
    cells; coverage and connected boundaries are checked for each run. Version 1
    reports additionally certified network-wide pixel-center coverage and connected
    boundaries. Both versions retain source identities and remain readable in saved
    runs. Neither certifies terrain conditioning or vertical accuracy.
    """

    validator: Literal["eolab.hydrology-validation/v1", "eolab.hydrology-validation/v2"]
    validatedAt: AwareDatetime
    watershedCount: Annotated[int, Field(strict=True, gt=0)]
    terminalCount: Annotated[int, Field(strict=True, gt=0)]
    demCellsChecked: Annotated[int, Field(strict=True, ge=0)]
    bounds: Wgs84Bounds
    grid: HydrologyGrid

    @model_validator(mode="after")
    def check_validation_scope(self) -> Self:
        """Require the elevation-cell count to agree with the validator's scope.

        Returns:
            This report with consistent validation evidence.

        Raises:
            ValueError: If a version 1 report has no checked cells or a version 2
                report claims to have checked elevation cells during installation.
        """
        if (self.validator == "eolab.hydrology-validation/v1") != (
            self.demCellsChecked > 0
        ):
            raise ValueError(
                "DEM cell count does not match the hydrology validator scope"
            )
        return self


class HydrologyReference(HydrologySchema):
    """Select an exact prepared dataset, including its configuration and source revision."""

    presetId: Identifier
    version: Version
    effectiveSha256: Digest


class PreparedHydrologySnapshot(HydrologySchema):
    """A validated configuration and its source identities, safe to retain in Run YAML.

    The effective checksum covers configuration, source signatures and validator
    version. Validation time is informational. This contains no paths, geometries,
    filtered copies or authorization grants; readers must reauthorize the sources.
    """

    definition: PreparedHydrologyDefinition
    demSignature: Digest
    watershedSelection: CatalogSelection
    validation: HydrologyValidation
    effectiveSha256: Digest

    @model_validator(mode="after")
    def check_source_identity(self) -> Self:
        """Verify the full-network selection and checksum stored in a validation report.

        Returns:
            This snapshot after checking configuration/source identity.

        Raises:
            ValueError: If the selection is filtered, belongs to another item or
                the report's effective checksum does not match its contents.
        """
        source = self.watershedSelection
        definition = self.definition
        if (source.collection_id, source.item_id) != (
            definition.watersheds.collection_id,
            definition.watersheds.item_id,
        ) or source.filter.active:
            raise ValueError(
                "Hydrology requires the complete configured watershed layer"
            )
        if self.effectiveSha256 != self.compute_effective_checksum():
            raise ValueError(
                "Prepared hydrology checksum does not match its sources and configuration"
            )
        return self

    def compute_effective_checksum(self) -> str:
        """Identify the configuration, source revisions and recorded validation scope.

        Returns:
            Stable SHA-256 excluding only the informational validation timestamp.
        """
        return compute_document_checksum(
            {
                "definition": self.definition.model_dump(mode="json", by_alias=True),
                "demSignature": self.demSignature,
                "watershedSelection": self.watershedSelection.model_dump(
                    mode="json", by_alias=True
                ),
                "validation": self.validation.model_dump(
                    mode="json", exclude={"validatedAt"}
                ),
            }
        )

    @property
    def reference(self) -> HydrologyReference:
        """Return the path-free identity a model setup submits for this dataset.

        Returns:
            Configuration ID, semantic version and effective source/configuration checksum.
        """
        return HydrologyReference(
            presetId=self.definition.id,
            version=self.definition.version,
            effectiveSha256=self.effectiveSha256,
        )


class PreparedHydrologyLibrary(HydrologySchema):
    """Installed hydrology reports available for selection, subject to fresh source checks."""

    configurations: list[PreparedHydrologySnapshot]


class PreparedHydrologyRegistry:
    """Read validated administrator reports for model setup and run capture."""

    def __init__(self, snapshots: tuple[PreparedHydrologySnapshot, ...] = ()) -> None:
        """Index installed snapshots without limiting the number of configurations.

        Args:
            snapshots: Individually validated administrator reports.

        Raises:
            ValueError: If two reports use the same configuration ID and version.
        """
        entries = {}
        for snapshot in snapshots:
            key = (snapshot.definition.id, snapshot.definition.version)
            if key in entries:
                raise ValueError("Duplicate prepared hydrology ID and version")
            entries[key] = snapshot
        self._entries = MappingProxyType(entries)

    @classmethod
    def load(cls, directory: Path | None) -> "PreparedHydrologyRegistry":
        """Load bounded validation reports from an optional administrator directory.

        Args:
            directory: Read-only server configuration directory; None installs no datasets.

        Returns:
            The validated installed configurations, without reading their source data.

        Raises:
            ValueError: If the configured directory or a report is invalid.
            OSError: If administrator files cannot be read.
            ProcessingError: If a report violates the existing YAML/JSON document limits.
        """
        if directory is None:
            return cls()
        if not directory.is_dir():
            raise ValueError("Prepared hydrology directory must exist")
        snapshots = []
        for path in sorted(directory.glob("*.hydrology.json")):
            with path.open("rb") as source:
                document = parse_yaml(source.read(256 * 1024 + 1), run=True)
            snapshots.append(PreparedHydrologySnapshot.model_validate(document))
        return cls(tuple(snapshots))

    def list_configurations(self) -> tuple[PreparedHydrologySnapshot, ...]:
        """Return installed snapshots; their source availability is checked on selection.

        Returns:
            Complete path-free reports in configuration ID/version order.
        """
        return tuple(self._entries[key] for key in sorted(self._entries))

    def get(self, reference: HydrologyReference) -> PreparedHydrologySnapshot:
        """Find exactly the configuration and source revision selected in model setup.

        Args:
            reference: Expected configuration ID, version and effective checksum.

        Returns:
            The immutable installed snapshot to reauthorize and capture for a run.

        Raises:
            ProcessingError: If the dataset is missing or its effective version changed.
        """
        snapshot = self._entries.get((reference.presetId, reference.version))
        if snapshot is None:
            raise ProcessingError(
                "hydrology_unavailable",
                "This hydrology configuration is not installed.",
                404,
            )
        if snapshot.effectiveSha256 != reference.effectiveSha256:
            raise ProcessingError(
                "hydrology_changed",
                "The hydrology configuration changed. Choose it again.",
                409,
            )
        return snapshot
