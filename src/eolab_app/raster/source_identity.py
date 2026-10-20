"""Canonical identity for one mounted raster source file."""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class RasterSourceIdentity:
    """Filesystem metadata captured for an immutable GeoTIFF's stored identity.

    Device number is deliberately excluded because it identifies a mount
    instance rather than the file and can change when an unchanged NFS-backed
    source is remounted into a replacement application container. Reads trust
    this captured identity rather than checking for later file changes.

    Attributes:
        inode: Filesystem object number within the mounted filesystem.
        size_bytes: Exact source length in bytes.
        modified_ns: Content modification time in nanoseconds.
        changed_ns: Metadata-change time in nanoseconds.
    """

    inode: int
    size_bytes: int
    modified_ns: int
    changed_ns: int

    @classmethod
    def from_status(cls, status: os.stat_result) -> "RasterSourceIdentity":
        """Build the canonical identity from one filesystem status result.

        Args:
            status: Result of inspecting the exact mounted source file.

        Returns:
            Identity containing only fields stable across ordinary remounts.
        """
        return cls(
            inode=status.st_ino,
            size_bytes=status.st_size,
            modified_ns=status.st_mtime_ns,
            changed_ns=status.st_ctime_ns,
        )

    @classmethod
    def read(cls, source_path: Path) -> "RasterSourceIdentity":
        """Inspect one mounted GeoTIFF through the canonical identity policy.

        Args:
            source_path: Confined mounted GeoTIFF path to inspect.

        Returns:
            Current content-relevant source identity.

        Raises:
            OSError: If filesystem metadata cannot be read.
        """
        return cls.from_status(source_path.stat())

    @classmethod
    def from_catalog(cls, value: list[int]) -> "RasterSourceIdentity":
        """Deserialize scanner-owned source identity metadata.

        Args:
            value: Scanner-produced integers in inode, size, modification-time,
                and metadata-change-time order.

        Returns:
            Canonical typed raster source identity.

        Raises:
            ValueError: If the stored identity cannot unpack into four fields.
        """
        inode, size_bytes, modified_ns, changed_ns = value
        return cls(
            inode=inode,
            size_bytes=size_bytes,
            modified_ns=modified_ns,
            changed_ns=changed_ns,
        )

    def to_catalog(self) -> list[int]:
        """Serialize the identity in its canonical catalog field order.

        Returns:
            Inode, byte size, modification time, and metadata-change time as
            exact JSON-compatible integers.
        """
        return [
            self.inode,
            self.size_bytes,
            self.modified_ns,
            self.changed_ns,
        ]
