"""S3-compatible transport for provider-neutral remote scan contracts."""

import asyncio
from collections.abc import AsyncIterator, Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from time import perf_counter, thread_time
from typing import Any
from urllib.parse import quote, unquote, urlsplit

import boto3
import rasterio
from botocore.client import BaseClient
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from rasterio.session import AWSSession as RasterioAWSSession

from eolab_app.catalog.models import DatasetMetadataResult
from eolab_app.catalog.remote import (
    RemoteDatasetCandidate,
    RemoteDatasetHandlerRegistry,
    RemoteDatasetMetadataReader,
    RemoteDiscoveryPage,
    RemoteObject,
    RemoteScanRoot,
    validate_remote_scan_roots,
)
from eolab_app.catalog.shapefile import SHAPEFILE_COMPONENT_TYPES
from eolab_app.catalog.remote_handlers import (
    create_default_remote_dataset_handler_registry,
)


@dataclass(frozen=True)
class S3ConnectionSettings:
    """Server-side S3 connection and bounded-operation settings.

    Attributes:
        endpoint_url: Optional S3-compatible service URL.
        region: Signing region.
        access_key_id: Optional static read-only access key identifier.
        secret_access_key: Optional static secret access key.
        session_token: Optional temporary-credential session token.
        list_page_size: Maximum objects requested in one listing response.
        metadata_concurrency: Maximum simultaneous remote metadata reads.
    """

    endpoint_url: str | None
    region: str
    access_key_id: str | None = field(repr=False)
    secret_access_key: str | None = field(repr=False)
    session_token: str | None = field(default=None, repr=False)
    list_page_size: int = 500
    metadata_concurrency: int = 4

    def __post_init__(self) -> None:
        """Validate connection values without contacting the provider.

        Raises:
            ValueError: If credentials are incomplete, limits are invalid, or
                a custom endpoint contains unsafe URL components.
        """
        if not self.region:
            raise ValueError("S3 region cannot be blank")
        if (self.access_key_id is None) != (self.secret_access_key is None):
            raise ValueError(
                "S3 access key ID and secret access key must be configured together"
            )
        if not 1 <= self.list_page_size <= 1000:
            raise ValueError("S3 list page size must be between 1 and 1000")
        if self.metadata_concurrency < 1:
            raise ValueError("S3 metadata concurrency must be greater than zero")
        if self.endpoint_url is not None:
            endpoint = urlsplit(self.endpoint_url)
            if (
                endpoint.scheme not in {"http", "https"}
                or not endpoint.netloc
                or endpoint.username is not None
                or endpoint.password is not None
                or endpoint.path not in {"", "/"}
                or endpoint.query
                or endpoint.fragment
            ):
                raise ValueError(
                    "S3 endpoint URL must be an HTTP(S) origin without credentials"
                )

    def create_client(self) -> BaseClient:
        """Create a short-lived read-only S3 API client.

        Returns:
            Configured botocore S3 client using bounded retry and timeout rules.

        Raises:
            BotoCoreError: If botocore cannot construct the client.
        """
        return boto3.client(
            "s3",
            endpoint_url=self.endpoint_url,
            region_name=self.region,
            aws_access_key_id=self.access_key_id,
            aws_secret_access_key=self.secret_access_key,
            aws_session_token=self.session_token,
            config=Config(
                signature_version="s3v4",
                connect_timeout=5,
                read_timeout=30,
                retries={"max_attempts": 3, "mode": "standard"},
                s3={
                    "addressing_style": (
                        "path" if self.endpoint_url is not None else "auto"
                    )
                },
            ),
        )

    def gdal_options(self) -> dict[str, str]:
        """Build bounded GDAL options for signed random object reads.

        Returns:
            Addressing, range-cache, timeout, retry, and directory-listing
            limits. Credentials remain owned by the Rasterio session.
        """
        options = {
            "AWS_VIRTUAL_HOSTING": (
                "FALSE" if self.endpoint_url is not None else "TRUE"
            ),
            "CPL_VSIL_CURL_CHUNK_SIZE": str(64 * 1024),
            "CPL_VSIL_CURL_CACHE_SIZE": str(8 * 1024 * 1024),
            "GDAL_HTTP_MAX_RETRY": "3",
            "GDAL_HTTP_RETRY_DELAY": "1",
            "GDAL_HTTP_CONNECTTIMEOUT": "5",
            "GDAL_HTTP_TIMEOUT": "10",
            "GDAL_READDIR_LIMIT_ON_OPEN": str(self.list_page_size),
        }
        if self.endpoint_url is not None:
            endpoint = urlsplit(self.endpoint_url)
            options["AWS_HTTPS"] = "YES" if endpoint.scheme == "https" else "NO"
        return options

    def rasterio_environment(self) -> AbstractContextManager[rasterio.Env]:
        """Create a credential-scoped Rasterio environment.

        Returns:
            Rasterio GDAL environment with the S3 session and bounded options.
        """
        session = RasterioAWSSession(
            aws_access_key_id=self.access_key_id,
            aws_secret_access_key=self.secret_access_key,
            aws_session_token=self.session_token,
            region_name=self.region,
            endpoint_url=self.endpoint_url,
        )
        return rasterio.Env(
            session=session,
            **self.gdal_options(),
            GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        )

    @contextmanager
    def materialize_components(
        self,
        remote_objects: tuple[RemoteObject, ...],
        *,
        maximum_component_bytes: int,
        maximum_total_bytes: int,
    ) -> Iterator[dict[RemoteObject, Path]]:
        """Download multipart objects under explicit byte ceilings.

        Args:
            remote_objects: Exact listing snapshots to materialize.
            maximum_component_bytes: Hard maximum for any one object.
            maximum_total_bytes: Hard aggregate maximum.

        Yields:
            Mapping from snapshots to same-base temporary component paths.

        Raises:
            ValueError: If declared sizes exceed a ceiling or a response does
                not match its requested bounded range.
            ClientError: If S3 rejects a range request.
            BotoCoreError: If a range request cannot complete.
        """
        if maximum_component_bytes < 1 or maximum_total_bytes < 1:
            raise ValueError("Remote materialization limits must be positive")
        if any(
            remote_object.size > maximum_component_bytes
            for remote_object in remote_objects
        ):
            raise ValueError(
                "Remote Shapefile component exceeds the metadata download limit"
            )
        if sum(remote_object.size for remote_object in remote_objects) > (
            maximum_total_bytes
        ):
            raise ValueError(
                "Remote Shapefile components exceed the aggregate metadata "
                "download limit"
            )
        with TemporaryDirectory(prefix="eolab-remote-shapefile-") as directory:
            temporary_root = Path(directory)
            local_paths: dict[RemoteObject, Path] = {}
            for remote_object in remote_objects:
                extension = _shapefile_component_extension(remote_object.key)
                if extension is None:
                    raise ValueError("Unrecognized remote Shapefile component")
                destination = temporary_root / f"dataset{extension}"
                self._download_object_ranges(remote_object, destination)
                local_paths[remote_object] = destination
            yield local_paths

    def _download_object_ranges(
        self,
        remote_object: RemoteObject,
        destination: Path,
    ) -> None:
        """Download one already-bounded object in fixed byte ranges.

        Args:
            remote_object: Listing snapshot whose size bounds the operation.
            destination: Temporary local component path to create.

        Raises:
            ValueError: If a response length differs from its requested range.
            ClientError: If S3 rejects a range request.
            BotoCoreError: If a range request cannot complete.
        """
        chunk_size = 8 * 1024 * 1024
        client = self.create_client()
        try:
            with destination.open("wb") as destination_file:
                for start in range(0, remote_object.size, chunk_size):
                    end = min(start + chunk_size, remote_object.size) - 1
                    response = client.get_object(
                        Bucket=remote_object.root.bucket,
                        Key=remote_object.key,
                        Range=f"bytes={start}-{end}",
                    )
                    body = response["Body"]
                    try:
                        content = body.read(end - start + 2)
                    finally:
                        body.close()
                    if len(content) != end - start + 1:
                        raise ValueError(
                            "S3 range response length did not match the request"
                        )
                    destination_file.write(content)
        finally:
            client.close()

    def asset_href(self, remote_object: RemoteObject) -> str:
        """Build a stable unsigned STAC Asset URI.

        Args:
            remote_object: Object whose bucket and key identify the Asset.

        Returns:
            Unsigned ``s3:`` URI containing no endpoint or credentials.
        """
        return remote_object_href(remote_object)

    def gdal_path(self, remote_object: RemoteObject) -> str:
        """Build the internal GDAL virtual path for an S3 object.

        Args:
            remote_object: Object to open through GDAL.

        Returns:
            Exact ``/vsis3/`` path.
        """
        return remote_object_vsi_path(remote_object)

    def sanitize_error(self, error: Exception) -> str:
        """Return a browser-safe provider failure without secrets or endpoint.

        Args:
            error: Provider, transport, GDAL, or format exception.

        Returns:
            Redacted error text retaining an AWS error code when available.
        """
        if isinstance(error, ClientError):
            code = str(error.response.get("Error", {}).get("Code", "ClientError"))
            return f"S3 request failed ({code})"
        if isinstance(error, BotoCoreError):
            return f"S3 transport failed ({type(error).__name__})"
        message = str(error)
        sensitive_values = (
            self.endpoint_url,
            (
                urlsplit(self.endpoint_url).netloc
                if self.endpoint_url is not None
                else None
            ),
            self.access_key_id,
            self.secret_access_key,
            self.session_token,
        )
        for sensitive_value in sensitive_values:
            if sensitive_value:
                message = message.replace(sensitive_value, "[redacted]")
        return message or type(error).__name__


class S3DatasetDiscovery:
    """List S3 roots page-by-page and group supported remote datasets."""

    def __init__(
        self,
        roots: tuple[RemoteScanRoot, ...],
        connection: S3ConnectionSettings,
    ) -> None:
        """Configure bounded S3 discovery.

        Args:
            roots: Non-overlapping configured bucket/prefix namespaces.
            connection: Server-side S3 transport settings.

        Raises:
            ValueError: If source IDs are duplicated or roots overlap.
        """
        validate_remote_scan_roots(roots)
        self.roots = roots
        self.connection = connection

    async def pages(self) -> AsyncIterator[RemoteDiscoveryPage]:
        """Yield supported datasets without retaining a whole bucket listing.

        Yields:
            At most one provider listing page of completed candidates at a
            time. A Shapefile group crossing pages retains only its recognized
            sidecars until its exact base name changes.

        Raises:
            RuntimeError: If a provider listing request fails. The message is
                redacted for browser-visible scan status.
        """
        for root in self.roots:
            continuation_token: str | None = None
            pending_base: str | None = None
            pending_components: list[RemoteObject] = []
            while True:
                try:
                    objects, continuation_token = await asyncio.to_thread(
                        self._list_page,
                        root,
                        continuation_token,
                    )
                except Exception as error:
                    raise RuntimeError(
                        self.connection.sanitize_error(error)
                    ) from error
                candidates: list[RemoteDatasetCandidate] = []
                for remote_object in objects:
                    component_extension = _shapefile_component_extension(
                        remote_object.key
                    )
                    if component_extension is not None:
                        component_base = remote_object.key[
                            : -len(component_extension)
                        ]
                        if pending_base is not None and component_base != pending_base:
                            candidate = _build_shapefile_candidate(
                                pending_components
                            )
                            if candidate is not None:
                                candidates.append(candidate)
                            pending_components = []
                        pending_base = component_base
                        pending_components.append(remote_object)
                    elif PurePosixPath(remote_object.key).suffix.lower() in {
                        ".tif",
                        ".tiff",
                    }:
                        candidates.append(RemoteDatasetCandidate(
                            handler_name="remote-geotiff",
                            primary=remote_object,
                        ))
                if continuation_token is None:
                    candidate = _build_shapefile_candidate(pending_components)
                    if candidate is not None:
                        candidates.append(candidate)
                    pending_base = None
                    pending_components = []
                if candidates:
                    yield RemoteDiscoveryPage(candidates=tuple(candidates))
                if continuation_token is None:
                    break

    def _list_page(
        self,
        root: RemoteScanRoot,
        continuation_token: str | None,
    ) -> tuple[list[RemoteObject], str | None]:
        """Read exactly one ListObjectsV2 page.

        Args:
            root: Bucket/prefix namespace to list.
            continuation_token: Opaque token from the preceding page.

        Returns:
            Listed object snapshots and the next token, or ``None`` at EOF.

        Raises:
            ClientError: If S3 rejects the listing.
            BotoCoreError: If the provider request cannot complete.
            ValueError: If the response violates the bounded paging contract.
        """
        request: dict[str, Any] = {
            "Bucket": root.bucket,
            "Prefix": root.prefix,
            "MaxKeys": self.connection.list_page_size,
        }
        if continuation_token is not None:
            request["ContinuationToken"] = continuation_token
        client = self.connection.create_client()
        try:
            response = client.list_objects_v2(**request)
        finally:
            client.close()
        contents = response.get("Contents", [])
        if len(contents) > self.connection.list_page_size:
            raise ValueError("S3 listing exceeded the requested page size")
        objects = [
            RemoteObject(
                root=root,
                key=entry["Key"],
                size=int(entry["Size"]),
                last_modified=entry["LastModified"],
                etag=_normalize_etag(entry.get("ETag")),
            )
            for entry in contents
            if not entry["Key"].endswith("/")
        ]
        next_token = response.get("NextContinuationToken")
        if bool(response.get("IsTruncated")) != (next_token is not None):
            raise ValueError("S3 listing returned inconsistent pagination state")
        return objects, next_token


class S3DatasetMetadataPipeline(RemoteDatasetMetadataReader):
    """Read remote metadata concurrently through GDAL's S3 filesystem."""

    def __init__(
        self,
        connection: S3ConnectionSettings,
        dataset_handlers: RemoteDatasetHandlerRegistry | None = None,
    ) -> None:
        """Configure remote metadata extraction.

        Args:
            connection: Server-side S3 API and GDAL settings.
            dataset_handlers: Optional explicit remote format registry.
        """
        self.connection = connection
        self.dataset_handlers = (
            dataset_handlers or create_default_remote_dataset_handler_registry()
        )

    async def results(
        self,
        dataset_candidates: Sequence[RemoteDatasetCandidate],
    ) -> AsyncIterator[DatasetMetadataResult]:
        """Yield one isolated result per candidate with bounded concurrency.

        Args:
            dataset_candidates: One bounded listing page of logical datasets.

        Yields:
            Metadata results as each worker finishes.
        """
        event_loop = asyncio.get_running_loop()
        executor = ThreadPoolExecutor(
            max_workers=self.connection.metadata_concurrency,
            thread_name_prefix="s3-metadata",
        )
        pending = {
            event_loop.run_in_executor(
                executor,
                build_s3_dataset_metadata,
                candidate,
                self.connection,
                self.dataset_handlers,
            )
            for candidate in dataset_candidates
        }
        try:
            while pending:
                completed, pending = await asyncio.wait(
                    pending,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for completed_result in completed:
                    yield completed_result.result()
        finally:
            for pending_result in pending:
                pending_result.cancel()
            await asyncio.to_thread(
                executor.shutdown,
                wait=True,
                cancel_futures=True,
            )


class S3AssetAvailability:
    """Verify unsigned S3 Asset URIs against configured read-only roots."""

    def __init__(
        self,
        roots: tuple[RemoteScanRoot, ...],
        connection: S3ConnectionSettings,
    ) -> None:
        """Configure remote reconciliation.

        Args:
            roots: Configured bucket/prefix namespaces owned by this scanner.
            connection: Server-side S3 API settings.
        """
        self.roots = roots
        self.connection = connection

    def is_missing(self, asset_href: str) -> bool:
        """Return whether one configured S3 object is proven absent.

        Args:
            asset_href: Unsigned ``s3:`` Asset URI from a scanner-owned Item.

        Returns:
            ``True`` only for a provider 404 response; ``False`` when HEAD
            confirms the object exists.

        Raises:
            ValueError: If the URI is malformed or outside configured roots.
            RuntimeError: If credentials or transport prevent safe checking.
        """
        asset_uri = urlsplit(asset_href)
        if (
            asset_uri.scheme != "s3"
            or not asset_uri.netloc
            or not asset_uri.path.startswith("/")
            or asset_uri.query
            or asset_uri.fragment
        ):
            raise ValueError("Remote Asset is not a canonical s3 URI")
        bucket = asset_uri.netloc
        key = unquote(asset_uri.path.removeprefix("/"))
        if not any(
            root.bucket == bucket and key.startswith(root.prefix)
            for root in self.roots
        ):
            raise ValueError("Remote Asset is outside configured scan roots")
        client = self.connection.create_client()
        try:
            client.head_object(Bucket=bucket, Key=key)
        except ClientError as error:
            status = error.response.get("ResponseMetadata", {}).get(
                "HTTPStatusCode"
            )
            if status == 404:
                return True
            raise RuntimeError(self.connection.sanitize_error(error)) from error
        except BotoCoreError as error:
            raise RuntimeError(self.connection.sanitize_error(error)) from error
        finally:
            client.close()
        return False


def build_s3_dataset_metadata(
    candidate: RemoteDatasetCandidate,
    connection: S3ConnectionSettings,
    dataset_handlers: RemoteDatasetHandlerRegistry | None = None,
) -> DatasetMetadataResult:
    """Build one remote Item while detecting object changes around the read.

    Args:
        candidate: Remote dataset and listing-time object snapshots.
        connection: Server-side S3 transport and GDAL settings.
        dataset_handlers: Optional explicit remote format registry.

    Returns:
        Successful Item or a redacted isolated failure with timing.
    """
    elapsed_started = perf_counter()
    processing_started = thread_time()
    try:
        _verify_candidate_unchanged(candidate, connection)
        active_handlers = (
            dataset_handlers or create_default_remote_dataset_handler_registry()
        )
        item = active_handlers.build_item(candidate, connection)
        if item["geometry"] is None:
            raise ValueError(
                "Dataset has no spatial footprint; pgSTAC requires Item geometry"
            )
        _verify_candidate_unchanged(candidate, connection)
        items = (item,)
        error_message = None
    except Exception as error:
        items = ()
        error_message = connection.sanitize_error(error)
    elapsed_seconds = perf_counter() - elapsed_started
    return DatasetMetadataResult(
        path=None,
        items=items,
        error=error_message,
        elapsed_seconds=elapsed_seconds,
        processing_seconds=min(
            thread_time() - processing_started,
            elapsed_seconds,
        ),
        source_name=candidate.primary.display_name(),
    )


def remote_object_href(remote_object: RemoteObject) -> str:
    """Build a stable unsigned STAC Asset URI.

    Args:
        remote_object: Object whose bucket and exact key identify the Asset.

    Returns:
        Unsigned ``s3:`` URI containing no endpoint or credential material.
    """
    return f"s3://{remote_object.root.bucket}/{quote(remote_object.key, safe='/')}"


def remote_object_vsi_path(remote_object: RemoteObject) -> str:
    """Build the internal GDAL virtual path for an S3 object.

    Args:
        remote_object: Object to open through GDAL.

    Returns:
        Exact ``/vsis3/`` path. Credentials remain in the GDAL environment.
    """
    return f"/vsis3/{remote_object.root.bucket}/{remote_object.key}"


def rasterio_s3_environment(
    connection: S3ConnectionSettings,
) -> AbstractContextManager[rasterio.Env]:
    """Create the Rasterio environment for a bounded remote read.

    Args:
        connection: Server-side S3 and GDAL options.

    Returns:
        Rasterio GDAL environment context manager.
    """
    return connection.rasterio_environment()


def _verify_candidate_unchanged(
    candidate: RemoteDatasetCandidate,
    connection: S3ConnectionSettings,
) -> None:
    """Compare current object headers with listing-time snapshots.

    Args:
        candidate: Logical dataset whose objects must remain stable.
        connection: S3 API configuration.

    Raises:
        RuntimeError: If an object disappeared or changed after listing.
        ClientError: If S3 rejects a request for another reason.
        BotoCoreError: If a provider request cannot complete.
    """
    client = connection.create_client()
    try:
        objects = candidate.components or (candidate.primary,)
        for remote_object in objects:
            request: dict[str, Any] = {
                "Bucket": remote_object.root.bucket,
                "Key": remote_object.key,
            }
            if remote_object.version_id is not None:
                request["VersionId"] = remote_object.version_id
            try:
                current = client.head_object(**request)
            except ClientError as error:
                status = error.response.get("ResponseMetadata", {}).get(
                    "HTTPStatusCode"
                )
                if status in {404, 412}:
                    raise RuntimeError(
                        "Remote object changed or disappeared during scan"
                    ) from error
                raise
            current_etag = _normalize_etag(current.get("ETag"))
            current_version = current.get("VersionId")
            if (
                int(current["ContentLength"]) != remote_object.size
                or (
                    remote_object.etag is not None
                    and current_etag != remote_object.etag
                )
                or (
                    remote_object.version_id is not None
                    and current_version != remote_object.version_id
                )
            ):
                raise RuntimeError(
                    "Remote object changed or disappeared during scan"
                )
    finally:
        client.close()


def _build_shapefile_candidate(
    components: list[RemoteObject],
) -> RemoteDatasetCandidate | None:
    """Finalize one exact-base Shapefile component group.

    Args:
        components: Recognized objects sharing one case-sensitive base key.

    Returns:
        Shapefile candidate when a primary exists, otherwise ``None``.
    """
    primary = next(
        (
            component
            for component in components
            if _shapefile_component_extension(component.key) == ".shp"
        ),
        None,
    )
    if primary is None:
        return None
    return RemoteDatasetCandidate(
        handler_name="remote-shapefile",
        primary=primary,
        components=tuple(sorted(components, key=lambda value: value.key)),
    )


def _shapefile_component_extension(key: str) -> str | None:
    """Return the recognized lower-case Shapefile suffix for an object key.

    Args:
        key: Exact provider object key.

    Returns:
        Canonical suffix, including compound ``.shp.xml``, or ``None``.
    """
    lower_key = key.lower()
    for extension in SHAPEFILE_COMPONENT_TYPES:
        if lower_key.endswith(extension):
            return extension
    return None


def _normalize_etag(value: str | None) -> str | None:
    """Remove S3 wire quoting from an entity tag.

    Args:
        value: Optional provider ETag.

    Returns:
        Unquoted ETag or ``None``.
    """
    return value.strip('"') if value is not None else None
