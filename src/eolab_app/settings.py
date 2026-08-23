"""Load and validate EOLab application settings from the environment."""

import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path

from eolab_app.catalog.remote import RemoteScanRoot, validate_remote_scan_roots
from eolab_app.catalog.s3 import S3ConnectionSettings


APPLICATION_VERSION_PATH = Path("/app/version")


@dataclass(frozen=True)
class Settings:
    """Validated runtime settings for the EOLab application.

    Attributes:
        app_title: Browser-visible application title.
        app_subtitle: Browser-visible application description.
        app_version: Git-derived deployed version.
        catalog_url: Browser-facing STAC API path or URL.
        catalog_internal_url: Server-side STAC API URL.
        wms_url: Browser-facing WMS path or URL.
        geoserver_internal_url: Server-side GeoServer base URL.
        geoserver_metrics_internal_url: Server-side metrics endpoint.
        geoserver_wms_render_count: Concurrent GeoServer render capacity.
        raster_pixel_read_concurrency: Concurrent pixel-read capacity.
        raster_statistics_read_concurrency: Concurrent statistics capacity.
        raster_statistics_cache_entries: Completed statistics cache capacity.
        geoserver_admin_user: Server-side GeoServer administrator name.
        geoserver_admin_password: Server-side GeoServer secret.
        scan_mount_path: Read-only mounted source root.
        scan_paths_within_mount: Relative mounted directories to scan.
        scan_display_path_prefix: User-facing mounted source root.
        scan_worker_count: Mounted metadata worker processes.
        scan_writer_count: Concurrent catalog writers.
        scan_batch_size: Maximum Items per catalog write.
        scan_error_detail_limit: Browser-visible per-dataset error limit.
        scan_reconciliation_page_size: Catalog cleanup page size.
        scan_reconciliation_concurrency: Concurrent source existence checks.
        scan_reconciliation_spool_memory_bytes: In-memory stale-key limit.
        scan_catalog_write_timeout_seconds: Per-operation STAC write timeout.
        scan_catalog_error_detail_limit: Captured upstream error-text limit.
        remote_s3_roots: Provider-neutral remote source namespaces.
        s3_connection: Server-side S3 connection and operation limits.
        basemap_url: Browser map tile URL template.
        basemap_attribution: Browser map attribution markup.
        initial_latitude: Initial WGS 84 map latitude.
        initial_longitude: Initial WGS 84 map longitude.
        initial_zoom: Initial map zoom level.
    """

    app_title: str
    app_subtitle: str
    app_version: str
    catalog_url: str
    catalog_internal_url: str
    wms_url: str
    geoserver_internal_url: str
    geoserver_metrics_internal_url: str
    geoserver_wms_render_count: int
    raster_pixel_read_concurrency: int
    raster_statistics_read_concurrency: int
    raster_statistics_cache_entries: int
    geoserver_admin_user: str
    geoserver_admin_password: str = field(repr=False)
    scan_mount_path: Path
    scan_paths_within_mount: tuple[Path, ...]
    scan_display_path_prefix: str
    scan_worker_count: int
    scan_writer_count: int
    scan_batch_size: int
    scan_error_detail_limit: int
    scan_reconciliation_page_size: int
    scan_reconciliation_concurrency: int
    scan_reconciliation_spool_memory_bytes: int
    scan_catalog_write_timeout_seconds: float
    scan_catalog_error_detail_limit: int
    remote_s3_roots: tuple[RemoteScanRoot, ...]
    s3_connection: S3ConnectionSettings = field(repr=False)
    basemap_url: str
    basemap_attribution: str
    initial_latitude: float
    initial_longitude: float
    initial_zoom: float

    def __post_init__(self) -> None:
        """Validate the application settings contract.

        Raises:
            ValueError: If a required text setting is blank or a map value is
                outside its documented range.
        """
        required_text_settings = {
            "APP_TITLE": self.app_title,
            "APP_SUBTITLE": self.app_subtitle,
            "application version": self.app_version,
            "CATALOG_URL": self.catalog_url,
            "CATALOG_INTERNAL_URL": self.catalog_internal_url,
            "WMS_URL": self.wms_url,
            "GEOSERVER_INTERNAL_URL": self.geoserver_internal_url,
            "GEOSERVER_METRICS_INTERNAL_URL": self.geoserver_metrics_internal_url,
            "GEOSERVER_ADMIN_USER": self.geoserver_admin_user,
            "GEOSERVER_ADMIN_PASSWORD": self.geoserver_admin_password,
            "SCAN_DISPLAY_PATH_PREFIX": self.scan_display_path_prefix,
            "BASEMAP_URL": self.basemap_url,
            "BASEMAP_ATTRIBUTION": self.basemap_attribution,
        }
        for environment_variable_name, setting_value in required_text_settings.items():
            if not setting_value:
                raise ValueError(f"{environment_variable_name} must not be blank")

        if not -90 <= self.initial_latitude <= 90:
            raise ValueError("INITIAL_LATITUDE must be between -90 and 90")
        if not -180 <= self.initial_longitude <= 180:
            raise ValueError("INITIAL_LONGITUDE must be between -180 and 180")
        if not 0 <= self.initial_zoom <= 22:
            raise ValueError("INITIAL_ZOOM must be between 0 and 22")
        if self.scan_worker_count < 1:
            raise ValueError("SCAN_WORKER_COUNT must be greater than zero")
        if self.geoserver_wms_render_count < 1:
            raise ValueError("GEOSERVER_WMS_RENDER_COUNT must be greater than zero")
        if self.raster_pixel_read_concurrency < 1:
            raise ValueError(
                "RASTER_PIXEL_READ_CONCURRENCY must be greater than zero"
            )
        if self.raster_statistics_read_concurrency < 1:
            raise ValueError(
                "RASTER_STATISTICS_READ_CONCURRENCY must be greater than zero"
            )
        if self.raster_statistics_cache_entries < 1:
            raise ValueError(
                "RASTER_STATISTICS_CACHE_ENTRIES must be greater than zero"
            )
        if self.scan_writer_count < 1:
            raise ValueError("SCAN_WRITER_COUNT must be greater than zero")
        if self.scan_batch_size < 1:
            raise ValueError("SCAN_BATCH_SIZE must be greater than zero")
        positive_scan_settings = {
            "SCAN_ERROR_DETAIL_LIMIT": self.scan_error_detail_limit,
            "SCAN_RECONCILIATION_PAGE_SIZE": self.scan_reconciliation_page_size,
            "SCAN_RECONCILIATION_CONCURRENCY": (
                self.scan_reconciliation_concurrency
            ),
            "SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES": (
                self.scan_reconciliation_spool_memory_bytes
            ),
            "SCAN_CATALOG_WRITE_TIMEOUT_SECONDS": (
                self.scan_catalog_write_timeout_seconds
            ),
            "SCAN_CATALOG_ERROR_DETAIL_LIMIT": (
                self.scan_catalog_error_detail_limit
            ),
        }
        for environment_variable_name, setting_value in positive_scan_settings.items():
            if not math.isfinite(setting_value) or setting_value <= 0:
                raise ValueError(
                    f"{environment_variable_name} must be greater than zero"
                )
        if not self.scan_mount_path.is_absolute():
            raise ValueError("SCAN_MOUNT_PATH must be an absolute path")
        if not self.scan_mount_path.is_dir():
            raise ValueError("SCAN_MOUNT_PATH must be an existing directory")
        if not self.scan_paths_within_mount:
            raise ValueError("SCAN_PATHS_WITHIN_MOUNT must contain at least one path")
        validate_remote_scan_roots(self.remote_s3_roots)

        resolved_mount_path = self.scan_mount_path.resolve()
        source_paths: list[Path] = []
        for relative_path in self.scan_paths_within_mount:
            if relative_path.is_absolute():
                raise ValueError("SCAN_PATHS_WITHIN_MOUNT paths must be relative")
            if ".." in relative_path.parts:
                raise ValueError("SCAN_PATHS_WITHIN_MOUNT paths must not contain '..'")
            source_path = (resolved_mount_path / relative_path).resolve()
            if not source_path.is_relative_to(resolved_mount_path):
                raise ValueError(
                    "SCAN_PATHS_WITHIN_MOUNT paths must remain within the mount"
                )
            if not source_path.is_dir():
                raise ValueError(
                    "SCAN_PATHS_WITHIN_MOUNT paths must identify existing directories"
                )
            source_paths.append(source_path)

        if len(source_paths) != len(set(source_paths)):
            raise ValueError("SCAN_PATHS_WITHIN_MOUNT paths must not be duplicated")
        for source_index, source_path in enumerate(source_paths):
            for other_source_path in source_paths[source_index + 1 :]:
                if (
                    source_path in other_source_path.parents
                    or other_source_path in source_path.parents
                ):
                    raise ValueError("SCAN_PATHS_WITHIN_MOUNT paths must not overlap")

    def as_public_dict(self) -> dict[str, object]:
        """Serialize settings for the public browser configuration endpoint.

        Returns:
            Browser configuration containing application identity strings,
            the browser-facing catalog and WMS URLs, user-facing scan paths,
            basemap URL and attribution strings, and numeric initial-view
            latitude, longitude, and zoom values. Internal service URLs are
            not exposed.
        """
        return {
            "appTitle": self.app_title,
            "appSubtitle": self.app_subtitle,
            "appVersion": self.app_version,
            "catalogUrl": self.catalog_url,
            "wmsUrl": self.wms_url,
            "scanDisplayPathPrefix": self.scan_display_path_prefix,
            "scanDisplayPaths": [
                *self.scan_display_paths(),
                *(root.display_name for root in self.remote_s3_roots),
            ],
            "basemap": {
                "url": self.basemap_url,
                "attribution": self.basemap_attribution,
            },
            "initialView": {
                "latitude": self.initial_latitude,
                "longitude": self.initial_longitude,
                "zoom": self.initial_zoom,
            },
        }

    def scan_display_paths(self) -> tuple[str, ...]:
        """Build user-facing locations for the configured scan directories.

        Returns:
            Display prefix joined to each mount-relative scan directory using
            the path separator implied by the configured display prefix. A
            root scan path is represented by the display prefix alone.
        """
        separator = "\\" if "\\" in self.scan_display_path_prefix else "/"
        display_paths: list[str] = []
        for relative_path in self.scan_paths_within_mount:
            relative_path_text = relative_path.as_posix()
            if relative_path_text == ".":
                display_paths.append(self.scan_display_path_prefix)
                continue
            normalized_relative_path = relative_path_text.replace("/", separator)
            joiner = (
                ""
                if self.scan_display_path_prefix.endswith(("/", "\\"))
                else separator
            )
            display_paths.append(
                f"{self.scan_display_path_prefix}{joiner}"
                f"{normalized_relative_path}"
            )
        return tuple(display_paths)


def load_settings(
    version_file_path: Path = APPLICATION_VERSION_PATH,
) -> Settings:
    """Load application settings from the environment and baked version file.

    Args:
        version_file_path: File containing the Git-derived application version.

    Returns:
        Validated settings with surrounding whitespace removed from text,
        map values parsed as floating-point numbers, and the application
        version read from the baked version file.

    Raises:
        FileNotFoundError: If the baked version file does not exist.
        KeyError: If a required environment variable is missing.
        ValueError: If a setting violates its type or range contract.
    """
    scan_paths = json.loads(os.environ["SCAN_PATHS_WITHIN_MOUNT"])
    if not isinstance(scan_paths, list) or not all(
        isinstance(scan_path, str) and scan_path for scan_path in scan_paths
    ):
        raise ValueError("SCAN_PATHS_WITHIN_MOUNT must be a JSON array of paths")

    remote_s3_sources = json.loads(
        os.environ.get("SCAN_REMOTE_S3_SOURCES", "[]")
    )
    if not isinstance(remote_s3_sources, list) or not all(
        isinstance(source, dict)
        and set(source) == {"id", "bucket", "prefix", "displayName"}
        and all(isinstance(value, str) for value in source.values())
        for source in remote_s3_sources
    ):
        raise ValueError(
            "SCAN_REMOTE_S3_SOURCES must be a JSON array of objects with "
            "id, bucket, prefix, and displayName strings"
        )
    remote_s3_roots = tuple(
        RemoteScanRoot(
            source_id=source["id"].strip(),
            bucket=source["bucket"].strip(),
            prefix=source["prefix"],
            display_name=source["displayName"].strip(),
        )
        for source in remote_s3_sources
    )

    def optional_environment_text(name: str) -> str | None:
        """Read an optional environment value with blank treated as absent.

        Args:
            name: Environment variable name.

        Returns:
            Stripped nonempty value, or ``None`` when unset or blank.
        """
        value = os.environ.get(name, "").strip()
        return value or None

    s3_connection = S3ConnectionSettings(
        endpoint_url=optional_environment_text("S3_ENDPOINT_URL"),
        region=os.environ.get("S3_REGION", "us-east-1").strip(),
        access_key_id=optional_environment_text("S3_ACCESS_KEY_ID"),
        secret_access_key=optional_environment_text("S3_SECRET_ACCESS_KEY"),
        session_token=optional_environment_text("S3_SESSION_TOKEN"),
        list_page_size=int(os.environ.get("S3_LIST_PAGE_SIZE", "500")),
        metadata_concurrency=int(
            os.environ.get("S3_METADATA_CONCURRENCY", "4")
        ),
    )

    return Settings(
        app_title=os.environ["APP_TITLE"].strip(),
        app_subtitle=os.environ["APP_SUBTITLE"].strip(),
        app_version=version_file_path.read_text(encoding="utf-8").strip(),
        catalog_url=os.environ["CATALOG_URL"].strip(),
        catalog_internal_url=os.environ["CATALOG_INTERNAL_URL"].strip(),
        wms_url=os.environ["WMS_URL"].strip(),
        geoserver_internal_url=os.environ["GEOSERVER_INTERNAL_URL"].strip(),
        geoserver_metrics_internal_url=os.environ[
            "GEOSERVER_METRICS_INTERNAL_URL"
        ].strip(),
        geoserver_wms_render_count=int(os.environ["GEOSERVER_WMS_RENDER_COUNT"]),
        raster_pixel_read_concurrency=int(
            os.environ["RASTER_PIXEL_READ_CONCURRENCY"]
        ),
        raster_statistics_read_concurrency=int(
            os.environ["RASTER_STATISTICS_READ_CONCURRENCY"]
        ),
        raster_statistics_cache_entries=int(
            os.environ["RASTER_STATISTICS_CACHE_ENTRIES"]
        ),
        geoserver_admin_user=os.environ["GEOSERVER_ADMIN_USER"].strip(),
        geoserver_admin_password=os.environ["GEOSERVER_ADMIN_PASSWORD"],
        scan_mount_path=Path(os.environ["SCAN_MOUNT_PATH"]),
        scan_paths_within_mount=tuple(Path(scan_path) for scan_path in scan_paths),
        scan_display_path_prefix=os.environ["SCAN_DISPLAY_PATH_PREFIX"].strip(),
        scan_worker_count=int(os.environ["SCAN_WORKER_COUNT"]),
        scan_writer_count=int(os.environ["SCAN_WRITER_COUNT"]),
        scan_batch_size=int(os.environ["SCAN_BATCH_SIZE"]),
        scan_error_detail_limit=int(os.environ["SCAN_ERROR_DETAIL_LIMIT"]),
        scan_reconciliation_page_size=int(
            os.environ["SCAN_RECONCILIATION_PAGE_SIZE"]
        ),
        scan_reconciliation_concurrency=int(
            os.environ["SCAN_RECONCILIATION_CONCURRENCY"]
        ),
        scan_reconciliation_spool_memory_bytes=int(
            os.environ["SCAN_RECONCILIATION_SPOOL_MEMORY_BYTES"]
        ),
        scan_catalog_write_timeout_seconds=float(
            os.environ["SCAN_CATALOG_WRITE_TIMEOUT_SECONDS"]
        ),
        scan_catalog_error_detail_limit=int(
            os.environ["SCAN_CATALOG_ERROR_DETAIL_LIMIT"]
        ),
        remote_s3_roots=remote_s3_roots,
        s3_connection=s3_connection,
        basemap_url=os.environ["BASEMAP_URL"].strip(),
        basemap_attribution=os.environ["BASEMAP_ATTRIBUTION"].strip(),
        initial_latitude=float(os.environ["INITIAL_LATITUDE"]),
        initial_longitude=float(os.environ["INITIAL_LONGITUDE"]),
        initial_zoom=float(os.environ["INITIAL_ZOOM"]),
    )
