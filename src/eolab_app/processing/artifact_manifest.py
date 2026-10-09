"""Bounded file declarations and immutable manifests for private Processing results."""

from dataclasses import asdict
import json
from typing import Annotated, Literal

from pydantic import AfterValidator, ConfigDict, Field, TypeAdapter, model_validator
from pydantic.dataclasses import dataclass

MAX_ARTIFACT_FILES = 64
MAX_MANIFEST_BYTES = 64 * 1024


def validate_file_name(value: str) -> str:
    """Reject basenames that alias Windows devices or another filename.

    Args:
        value: An already syntax-checked flat basename.

    Returns:
        The unchanged portable basename.

    Raises:
        ValueError: If a device name or trailing dot would change file resolution.
    """
    devices = {
        "con",
        "prn",
        "aux",
        "nul",
        *(f"com{i}" for i in range(10)),
        *(f"lpt{i}" for i in range(10)),
    }
    if value.endswith(".") or value.split(".")[0].lower() in devices:
        raise ValueError("Unsafe artifact basename")
    return value


FileName = Annotated[
    str,
    Field(strict=True, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$"),
    AfterValidator(validate_file_name),
]
OutputName = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")]
Label = Annotated[str, Field(min_length=1, max_length=200)]
Digest = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
FileId = Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]
ByteCount = Annotated[int, Field(strict=True, ge=0)]
MediaType = Annotated[
    str, Field(pattern=r"^[a-z0-9.+-]+/[a-z0-9.+-]+$", max_length=100)
]
FileRole = Literal["result", "intermediate", "provenance"]


@dataclass(frozen=True, config=ConfigDict(extra="forbid"))
class ProducedFile:
    """A completed operation output awaiting a recipe's retention declaration.

    Attributes:
        name: Output name declared by the trusted operation.
        storage_name: Flat, private workspace basename; never a public locator.
        filename: Safe suggested download basename.
        media_type: File format produced by the operation.
        size: Exact completed byte count.
        sha256: SHA-256 digest to verify before publication.
    """

    name: OutputName
    storage_name: FileName
    filename: FileName
    media_type: MediaType
    size: ByteCount
    sha256: Digest


@dataclass(frozen=True, config=ConfigDict(extra="forbid"))
class FileDeclaration:
    """One file the application authorizes storage to retain after completion.

    Attributes:
        name: Recipe output alias, or the reserved provenance name.
        label: Human-readable description supplied by the application.
        role: Scientific result, retained intermediate, or provenance record.
        storage_name: Flat private workspace basename.
        filename: Suggested download basename.
        media_type: Declared file format.
        size: Expected byte count, or None for storage-measured provenance.
        sha256: Expected checksum, or None for storage-measured provenance.
    """

    name: OutputName
    label: Label
    role: FileRole
    storage_name: FileName
    filename: FileName
    media_type: MediaType
    size: ByteCount | None = None
    sha256: Digest | None = None


@dataclass(frozen=True, config=ConfigDict(extra="forbid"))
class PublishedFile:
    """A validated immutable file identified publicly by an opaque ID.

    Attributes:
        id: Random public file identity, scoped to its owning job.
        name: Declared output alias.
        label: User-facing file description.
        role: Result, intermediate, or provenance.
        storage_name: Private basename used only by the storage adapter.
        filename: Suggested download basename.
        media_type: Declared file format.
        size: Measured file bytes.
        sha256: Verified content checksum.
    """

    id: FileId
    name: OutputName
    label: Label
    role: FileRole
    storage_name: FileName
    filename: FileName
    media_type: MediaType
    size: ByteCount
    sha256: Digest


def encode_manifest_files(files: tuple[PublishedFile, ...]) -> bytes:
    """Encode the private on-disk inventory deterministically.

    Args:
        files: Validated immutable files, excluding the inventory itself.

    Returns:
        UTF-8 JSON bytes whose size is included in the retained disk charge.
    """
    return json.dumps(
        {"version": 1, "files": [asdict(file) for file in files]},
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


@dataclass(frozen=True, config=ConfigDict(extra="forbid"))
class ArtifactManifest:
    """All retained files and their exact disk charge, including the inventory.

    The storage adapter builds this only after verifying complete files. Database
    reads validate it again before exposing downloads. All files share one job's
    owner, expiry and transfer leases; the manifest grants no access by itself.

    Attributes:
        files: At most 64 files, with unique IDs, aliases and private basenames.
        total_bytes: File bytes plus the encoded inventory, limited to 64 KiB.
        version: Persisted manifest schema version.
    """

    files: Annotated[
        tuple[PublishedFile, ...], Field(min_length=1, max_length=MAX_ARTIFACT_FILES)
    ]
    total_bytes: ByteCount
    version: Literal[1] = 1

    @model_validator(mode="after")
    def check_inventory(self) -> "ArtifactManifest":
        """Reject duplicate identities or incorrect retained-byte accounting.

        Returns:
            This manifest after validating its inventory.

        Raises:
            ValueError: If names collide, inventory size exceeds its limit, or
                total_bytes differs from the actual file and inventory sizes.
        """
        for attribute in ("id", "name", "storage_name"):
            values = [getattr(file, attribute).casefold() for file in self.files]
            if len(set(values)) != len(values):
                raise ValueError("Duplicate artifact identity or name")
        inventory = encode_manifest_files(self.files)
        if len(inventory) > MAX_MANIFEST_BYTES or self.total_bytes != sum(
            file.size for file in self.files
        ) + len(inventory):
            raise ValueError("Invalid retained artifact byte count")
        return self


def read_artifact_manifest(value: object) -> ArtifactManifest:
    """Validate a manifest loaded from persisted job metadata.

    Args:
        value: JSON-compatible stored manifest or an already validated instance.

    Returns:
        Immutable, bounded manifest with verified accounting relationships.

    Raises:
        ValidationError: If persisted metadata violates the file contract.
    """
    return TypeAdapter(ArtifactManifest).validate_python(value)
