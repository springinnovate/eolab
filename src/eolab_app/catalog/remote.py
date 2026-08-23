"""Provider-neutral contracts for remote object-storage catalog sources."""

from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any, Protocol

from eolab_app.catalog.models import DatasetMetadataResult, ScanError


@dataclass(frozen=True)
class RemoteScanRoot:
    """One configured object-storage namespace.

    Attributes:
        source_id: Deployment-stable source namespace used in Item identity.
        bucket: Provider bucket or container identifier.
        prefix: Provider-native object-key prefix, without a leading slash.
        display_name: User-facing description independent of transport details.
    """

    source_id: str
    bucket: str
    prefix: str
    display_name: str

    def __post_init__(self) -> None:
        """Validate the provider-neutral root contract.

        Raises:
            ValueError: If the bucket or display name is blank, or the prefix
                is absolute or contains an ambiguous parent segment.
        """
        if not self.source_id:
            raise ValueError("Remote scan source ID cannot be blank")
        if not self.bucket:
            raise ValueError("Remote scan bucket cannot be blank")
        if not self.display_name:
            raise ValueError("Remote scan display name cannot be blank")
        if self.prefix.startswith("/") or ".." in self.prefix.split("/"):
            raise ValueError(
                "Remote scan prefix must be a relative object-key prefix"
            )


@dataclass(frozen=True)
class RemoteObject:
    """Immutable listing snapshot for one provider object.

    Attributes:
        root: Configured namespace that yielded the object.
        key: Exact provider object key.
        size: Object size in bytes at listing time.
        last_modified: Provider-reported last-modified timestamp.
        etag: Provider entity tag with transport quoting removed.
        version_id: Provider version identifier when the listing exposes one.
    """

    root: RemoteScanRoot
    key: str
    size: int
    last_modified: datetime
    etag: str | None
    version_id: str | None = None

    def __post_init__(self) -> None:
        """Validate an object listing snapshot.

        Raises:
            ValueError: If the key is outside its root, the size is negative,
                or the timestamp has no UTC offset.
        """
        if not self.key or not self.key.startswith(self.root.prefix):
            raise ValueError("Remote object key is outside its configured prefix")
        if self.size < 0:
            raise ValueError("Remote object size cannot be negative")
        if self.last_modified.tzinfo is None:
            raise ValueError("Remote object last-modified time must be timezone-aware")

    def display_name(self) -> str:
        """Return a browser-safe configured name for this object.

        Returns:
            Display root joined to the key portion below its configured prefix.
        """
        relative_key = self.key[len(self.root.prefix) :].lstrip("/")
        if not relative_key:
            return self.root.display_name
        return f"{self.root.display_name.rstrip('/')}/{relative_key}"


@dataclass(frozen=True)
class RemoteDatasetCandidate:
    """One logical remote dataset and its exact object snapshots.

    Attributes:
        handler_name: Provider-neutral remote format handler key.
        primary: Primary object used to open the dataset.
        components: Deterministically ordered multipart dataset objects.
    """

    handler_name: str
    primary: RemoteObject
    components: tuple[RemoteObject, ...] = ()

    def __post_init__(self) -> None:
        """Validate candidate dispatch and component ownership.

        Raises:
            ValueError: If the handler name is blank, the primary is absent
                from multipart components, or components cross roots.
        """
        if not self.handler_name:
            raise ValueError("Remote dataset handler name cannot be blank")
        if self.components and self.primary not in self.components:
            raise ValueError("Remote multipart components must include the primary")
        if any(component.root != self.primary.root for component in self.components):
            raise ValueError("Remote dataset components must share one scan root")


@dataclass(frozen=True)
class RemoteDiscoveryPage:
    """One bounded page of remote discovery output.

    Attributes:
        candidates: Logical datasets completed while consuming the page.
        errors: Isolated discovery failures safe for browser display.
    """

    candidates: tuple[RemoteDatasetCandidate, ...]
    errors: tuple[ScanError, ...] = ()


class RemoteDatasetDiscovery(Protocol):
    """Stream bounded pages of remote logical datasets."""

    def pages(self) -> AsyncIterator[RemoteDiscoveryPage]:
        """Yield bounded discovery pages.

        Yields:
            Logical dataset pages and isolated discovery errors.
        """


class RemoteDatasetMetadataReader(Protocol):
    """Extract metadata from provider-neutral remote candidates."""

    def results(
        self,
        dataset_candidates: Sequence[RemoteDatasetCandidate],
    ) -> AsyncIterator[DatasetMetadataResult]:
        """Yield one result for each remote dataset candidate.

        Args:
            dataset_candidates: One bounded discovery page.

        Yields:
            Remote metadata successes and isolated failures.
        """


class RemoteObjectAccess(Protocol):
    """Provider adapter used by format-specific remote metadata builders."""

    def asset_href(self, remote_object: RemoteObject) -> str:
        """Return a stable unsigned catalog Asset location.

        Args:
            remote_object: Provider-neutral object snapshot.

        Returns:
            Public, credential-free object URI.
        """

    def gdal_path(self, remote_object: RemoteObject) -> str:
        """Return an internal GDAL virtual filesystem path.

        Args:
            remote_object: Provider-neutral object snapshot.

        Returns:
            Provider-specific path used only during metadata extraction.
        """

    def gdal_options(self) -> dict[str, str]:
        """Return server-side bounded-read options for one GDAL environment.

        Returns:
            Provider addressing, cache, timeout, retry, and listing limits.
        """

    def rasterio_environment(self) -> AbstractContextManager[Any]:
        """Create a credential-scoped Rasterio GDAL environment.

        Returns:
            Context manager for one raster metadata read.
        """

    def materialize_components(
        self,
        remote_objects: tuple[RemoteObject, ...],
        *,
        maximum_component_bytes: int,
        maximum_total_bytes: int,
    ) -> AbstractContextManager[dict[RemoteObject, Path]]:
        """Materialize a bounded multipart dataset for local metadata access.

        Args:
            remote_objects: Exact object snapshots required by the format.
            maximum_component_bytes: Hard per-object download ceiling.
            maximum_total_bytes: Hard aggregate download ceiling.

        Returns:
            Context manager mapping snapshots to temporary local paths.

        Raises:
            ValueError: If listing sizes exceed either explicit ceiling.
            Exception: If a bounded provider read fails.
        """


RemoteDatasetItem = dict[str, Any]
RemoteDatasetItemBuilder = Callable[
    [RemoteDatasetCandidate, RemoteObjectAccess],
    RemoteDatasetItem,
]


@dataclass(frozen=True)
class RemoteDatasetHandler:
    """One explicit remote format metadata handler.

    Attributes:
        name: Stable dispatch key carried by remote candidates.
        build_item: Format-specific Item builder using a provider adapter.
    """

    name: str
    build_item: RemoteDatasetItemBuilder


@dataclass(frozen=True)
class RemoteDatasetHandlerRegistry:
    """Ordered explicit registry for remote dataset metadata handlers.

    Attributes:
        handlers: Unique format handlers available to remote sources.
    """

    handlers: tuple[RemoteDatasetHandler, ...]

    def __post_init__(self) -> None:
        """Validate explicit dispatch keys.

        Raises:
            ValueError: If the registry is empty or names are blank or repeated.
        """
        if not self.handlers:
            raise ValueError("Remote dataset handler registry cannot be empty")
        names = [handler.name for handler in self.handlers]
        if any(not name for name in names):
            raise ValueError("Remote dataset handler names cannot be blank")
        if len(names) != len(set(names)):
            raise ValueError("Remote dataset handler names must be unique")

    def build_item(
        self,
        candidate: RemoteDatasetCandidate,
        access: RemoteObjectAccess,
    ) -> RemoteDatasetItem:
        """Dispatch one candidate through its explicit format handler.

        Args:
            candidate: Remote dataset selected during discovery.
            access: Provider adapter for metadata I/O and Asset locations.

        Returns:
            Complete scanner-owned STAC Item.

        Raises:
            KeyError: If the candidate names an unregistered handler.
            Exception: Propagates format-specific metadata failures.
        """
        for handler in self.handlers:
            if handler.name == candidate.handler_name:
                return handler.build_item(candidate, access)
        raise KeyError(f"Unknown remote dataset handler: {candidate.handler_name}")

class RemoteAssetAvailability(Protocol):
    """Verify catalog Asset locations owned by configured remote sources."""

    def is_missing(self, asset_href: str) -> bool:
        """Check one unsigned remote Asset URI.

        Args:
            asset_href: Credential-free catalog Asset location.

        Returns:
            Whether the configured provider proves the object absent.

        Raises:
            ValueError: If the URI is outside configured source roots.
            Exception: If availability cannot be established safely.
        """


def validate_remote_scan_roots(roots: tuple[RemoteScanRoot, ...]) -> None:
    """Validate stable IDs and non-overlapping provider namespaces.

    Args:
        roots: Configured provider-neutral bucket/prefix roots.

    Raises:
        ValueError: If source IDs repeat or two prefixes overlap in one bucket.
    """
    source_ids = [root.source_id for root in roots]
    if len(source_ids) != len(set(source_ids)):
        raise ValueError("Remote scan source IDs must be unique")
    for root_index, root in enumerate(roots):
        for other_root in roots[root_index + 1 :]:
            if root.bucket != other_root.bucket:
                continue
            if (
                root.prefix.startswith(other_root.prefix)
                or other_root.prefix.startswith(root.prefix)
            ):
                raise ValueError("Remote scan bucket prefixes must not overlap")
