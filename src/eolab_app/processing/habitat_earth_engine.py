"""Fetch and reuse the original Habitat predictor and response rasters."""

from collections.abc import Callable
from contextlib import contextmanager
from collections.abc import Iterator
from dataclasses import dataclass
import errno
import json
import os
import re
import stat
from importlib.resources import as_file, files
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

from affine import Affine
from pydantic import BaseModel, ConfigDict, Field
import ee
from google.auth.exceptions import GoogleAuthError
from googleapiclient.errors import HttpError
from httplib2 import HttpLib2Error
from nhi_terrestrial_integrity_modeling.analysis_config import (
    RasterBandDefinition,
    RasterCacheGrid,
    RasterStackConfiguration,
    load_raster_stack_configuration,
)
from nhi_terrestrial_integrity_modeling.earth_engine_stack import (
    build_earth_engine_stack,
)
import rasterio
from rasterio.crs import CRS
from shapely.geometry import box
from shapely.geometry.base import BaseGeometry

from eolab_app.processing.raster_preparation import RasterGrid, calculate_raster_grid

_PROVIDER_ERRORS = (OSError, GoogleAuthError, HttpError, HttpLib2Error, ee.EEException)
_PROVIDER_SECRETS = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)"
    r"|\b[a-z][a-z0-9+.-]*://[^\s<>\"']+"
    r"|\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b"
    r"|\b(?:Bearer|Basic)\s+[A-Z0-9._~+/=-]+"
    r"|\b(?:ya29\.[A-Z0-9._-]+|AIza[A-Z0-9_-]{20,}|eyJ[A-Z0-9_-]+\.[A-Z0-9_-]+\.[A-Z0-9_-]+)"
    r"|\b(?:(?:access|refresh|id)[_ -]?token|api[_ -]?key|private[_ -]?key|client[_ -]?secret"
    r"|authorization|token|password|signature|credential)[\"']?\s*[:=]\s*"
    r"(?:(?:Bearer|Basic)\s+[^\s,;]+|\"[^\"]*(?:\"|$)|'[^']*(?:'|$)|[^\s,;]+)"
    r"|\b[A-Z]:[\\/][^\s<>\"']+|(?<![\w:/])/[^\s<>\"']+|\\\\[^\s<>\"']+",
    re.IGNORECASE | re.DOTALL,
)


@dataclass(frozen=True)
class HabitatEarthEngineSettings:
    """Server credentials used only by the Habitat acquisition process.

    Attributes:
        project: Google Cloud project registered for Earth Engine.
        credentials_file: Mounted service-account JSON key, outside source mounts.
            Never include its contents in requests, provenance or logs.
    """

    project: str
    credentials_file: Path


class HabitatEarthEngineConnectionError(RuntimeError):
    """Report why server credentials or the Earth Engine stack could not initialize."""


class HabitatTileFailure(BaseModel):
    """Describe a failed Earth Engine request without paths or credentials.

    Attributes:
        column: Column on the stack's globally anchored acquisition grid.
        row: Row on that same grid.
        stage: Operation that failed, currently the remote tile download.
        code: Stable category of the provider failure.
        detail: Bounded, sanitized provider explanation when available.
        httpStatus: Numeric provider HTTP status when the client retained it.
    """

    model_config = ConfigDict(frozen=True)
    column: int
    row: int
    stage: Literal["download"] = "download"
    code: str
    detail: str
    httpStatus: int | None = None


@dataclass(frozen=True)
class HabitatTiles:
    """Shared cached Habitat tiles and their scientific variable definitions.

    Attributes:
        tiles: Complete grid tiles in north-to-south, west-to-east order.
            Files belong to the persistent cache, not to a calculation attempt.
        bands: Ordered GeoTIFF band names mapped to the original definitions.
            Contains predictors and responses, never computed reference sites.
        required_tiles: Number of acquisition grid tiles intersecting the AOI.
        failures: Sanitized remote errors from attempted downloads, in tile order.
    """

    tiles: tuple[Path, ...]
    bands: dict[str, RasterBandDefinition]
    required_tiles: int
    failures: tuple[HabitatTileFailure, ...] = ()

    @property
    def missing_tiles(self) -> int:
        """Count the required tiles missing from this result.

        Returns:
            The difference between required and available complete tiles.
        """
        return self.required_tiles - len(self.tiles)


@dataclass(frozen=True)
class HabitatCacheCoverage:
    """Count cached input tiles required by one Habitat AOI and source year.

    Attributes:
        configuration_sha256: Scientific stack identity, including year, grid,
            datasets, bands and stack version.
        year: Assessment year selected by the scientific configuration.
        required_tiles: Number of complete acquisition tiles intersecting the AOI.
        cached_tiles: Required tiles observed as published cache entries.
        missing_tiles: Required tiles without a published cache entry.
    """

    configuration_sha256: str
    year: int
    required_tiles: int
    cached_tiles: int
    missing_tiles: int


class HabitatCacheConfiguration(BaseModel):
    """Describe the scientific identity and source year of one cache namespace.

    This small persisted record labels completed tiles after their source
    configuration is no longer installed. It does not authorize reads or track
    source mutation, jobs, areas or individual tiles. Readers admit at most
    4 KiB of JSON metadata for this fixed record format.

    Attributes:
        configuration_sha256: Existing scientific configuration digest naming the namespace.
        year: Source assessment year selected by acquisition.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    configuration_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    year: int = Field(strict=True)


@dataclass(frozen=True)
class HabitatCacheInventoryEntry:
    """Count completed tiles and their stored raster bytes in one cache namespace.

    Attributes:
        configuration_sha256: Scientific identity from the namespace directory.
        configuration: Persisted or installed descriptive metadata, otherwise None.
        cached_tiles: Completed tile files observed during this snapshot.
        stored_bytes: Sum of those tile.tif file sizes, excluding metadata and staging.
    """

    configuration_sha256: str
    configuration: HabitatCacheConfiguration | None
    cached_tiles: int
    stored_bytes: int


@dataclass(frozen=True)
class HabitatEarthEngineRuntime:
    """Server-only connection and persistent storage for Habitat input acquisition.

    Attributes:
        connection: Earth Engine project and mounted credential-file path.
        cache_directory: Model-private cache beside Processing attempts/results,
            on the same filesystem for atomic publication. Run cleanup does not
            remove completed cache entries.
    """

    connection: HabitatEarthEngineSettings
    cache_directory: Path


@contextmanager
def prepare_habitat_band_views(
    tiles: HabitatTiles, directory: Path
) -> Iterator[dict[str, Path]]:
    """Expose cached multiband tiles as job-local single-band raster mosaics.

    The views reference cached pixels without copying them. Pass the returned
    paths to ordinary raster preparation; they are not Catalog sources.

    Args:
        tiles: Complete, aligned files admitted by Habitat acquisition.
        directory: Private attempt directory owned by the native supervisor.

    Yields:
        VRT paths keyed by scientific band name, valid inside this context.
        Unsourced gaps are NoData; valid zero and source masks are preserved.

    Raises:
        RuntimeError: If GDAL cannot construct a band mosaic.
        OSError: If temporary view creation or cleanup fails.
    """
    from osgeo import gdal

    with TemporaryDirectory(prefix="habitat-bands-", dir=directory) as temporary:
        paths = {}
        for index, name in enumerate(tiles.bands, start=1):
            path = Path(temporary) / f"band-{index}.vrt"
            with gdal.ExceptionMgr():
                dataset = gdal.BuildVRT(
                    str(path),
                    [str(tile) for tile in tiles.tiles],
                    bandList=[index],
                    VRTNodata="nan",
                )
                dataset.FlushCache()
                dataset = None
            paths[name] = path
        yield paths


def load_habitat_stack(year: int | None = None) -> RasterStackConfiguration:
    """Load the original Habitat variables and acquisition grid for a source year.

    The upstream configuration filename names its original study area, but this
    scientific-only loader does not read that area's geometry or local settings.

    Args:
        year: Source year supported by the packaged scientific configuration,
            or None to use its configured default year.

    Returns:
        Original band computations, datasets and fixed acquisition grid.

    Raises:
        ValueError: If the year is outside the configuration's supported range.
        OSError: If the installed configuration cannot be read.
    """
    resource = files("nhi_terrestrial_integrity_modeling.config").joinpath(
        "south_africa_reference_condition_analysis.toml"
    )
    with as_file(resource) as path:
        return load_raster_stack_configuration(path, year=year)


def _select_tile_grids(
    area: BaseGeometry, grid: RasterCacheGrid
) -> tuple[RasterGrid, ...]:
    """Select full acquisition tiles with positive-area overlap with the AOI.

    Args:
        area: Nonempty AOI already projected into the acquisition CRS.
        grid: Original stack's globally anchored tile and pixel grid.

    Returns:
        Intersecting tile grids ordered north to south, then west to east.
    """
    span = grid.pixel_size_meters * grid.tile_size_pixels
    tiles = calculate_raster_grid(
        area.bounds,
        CRS.from_string(grid.crs),
        (span, span),
        (grid.origin_x, grid.origin_y),
    )
    selected = []
    for row in range(tiles.height):
        for column in range(tiles.width):
            left, top = tiles.transform * (column, row)
            if area.intersection(box(left, top - span, left + span, top)).area > 0:
                selected.append(
                    RasterGrid(
                        tiles.crs,
                        Affine(
                            grid.pixel_size_meters,
                            0,
                            left,
                            0,
                            -grid.pixel_size_meters,
                            top,
                        ),
                        grid.tile_size_pixels,
                        grid.tile_size_pixels,
                    )
                )
    return tuple(selected)


def _get_tile_cache_directory(
    tile: RasterGrid, cache_grid: RasterCacheGrid, stack_directory: Path
) -> Path:
    """Return the deterministic cache directory for one acquisition tile.

    Args:
        tile: Complete tile selected on the scientific acquisition grid.
        cache_grid: Globally anchored tile and pixel grid from the configuration.
        stack_directory: Cache directory for this scientific stack identity.

    Returns:
        Tile directory named by its grid column and row, without creating it.
    """
    span = cache_grid.pixel_size_meters * cache_grid.tile_size_pixels
    column = round((tile.transform.c - cache_grid.origin_x) / span)
    row = round((cache_grid.origin_y - tile.transform.f) / span)
    return stack_directory / f"{column}_{row}"


def inspect_habitat_cache(
    area: BaseGeometry,
    configuration: RasterStackConfiguration,
    cache_directory: Path,
) -> HabitatCacheCoverage:
    """Count published Habitat input tiles for a projected AOI without fetching.

    Use this to inspect preparation needs before submitting acquisition work.
    It uses the acquisition tile planner and trusts completed, immutable cache
    entries without opening raster files or contacting Earth Engine. It does
    not create cache directories or reserve tiles; acquisition checks the cache
    again when it runs.

    Args:
        area: Valid, nonempty AOI projected to configuration.grid.crs.
        configuration: Scientific settings from load_habitat_stack.
        cache_directory: Private persistent Habitat cache, which may not exist yet.

    Returns:
        Stack identity, assessment year and required, cached and missing tile
        counts observed during this call. Concurrent publication may increase
        coverage after an entry is checked.

    Raises:
        OSError: If the filesystem cannot inspect a cache entry.
    """
    cached = get_cached_habitat_tiles(area, configuration, cache_directory)
    return HabitatCacheCoverage(
        configuration_sha256=configuration.raster_configuration_sha256,
        year=configuration.year,
        required_tiles=cached.required_tiles,
        cached_tiles=len(cached.tiles),
        missing_tiles=cached.missing_tiles,
    )


def _get_habitat_model_bands(
    configuration: RasterStackConfiguration,
) -> dict[str, RasterBandDefinition]:
    """Return ordered predictor and response bands stored in each cache tile.

    Args:
        configuration: Original scientific stack definition for one year.

    Returns:
        Cache GeoTIFF band names mapped to their scientific definitions.
    """
    return {
        name: band
        for name, band in zip(configuration.band_names(), configuration.bands)
        if band.role in ("predictor", "response")
    }


def get_cached_habitat_tiles(
    area: BaseGeometry,
    configuration: RasterStackConfiguration,
    cache_directory: Path,
) -> HabitatTiles:
    """Return the already prepared tiles that intersect a projected AOI.

    This read trusts immutable cache entries and never initializes Earth Engine,
    downloads missing tiles, opens cached rasters or creates cache directories.

    Args:
        area: Valid nonempty AOI in the scientific grid's CRS.
        configuration: Scientific stack definition for the selected year.
        cache_directory: Private persistent cache root.

    Returns:
        Complete tiles observed in grid order, the band definitions and coverage counts.

    Raises:
        OSError: If the cache entries cannot be inspected.
    """
    grids = _select_tile_grids(area, configuration.grid)
    stack_directory = cache_directory / configuration.raster_configuration_sha256
    entries = (
        _get_tile_cache_directory(grid, configuration.grid, stack_directory)
        for grid in grids
    )
    return HabitatTiles(
        tuple(entry / "tile.tif" for entry in entries if entry.exists()),
        _get_habitat_model_bands(configuration),
        len(grids),
    )


def _describe_cache_configuration(
    configuration: RasterStackConfiguration,
) -> HabitatCacheConfiguration:
    """Return display metadata from an admitted scientific stack.

    Args:
        configuration: Installed scientific settings already admitted by the loader.

    Returns:
        Existing namespace identity and source assessment year.
    """
    return HabitatCacheConfiguration.model_construct(
        configuration_sha256=configuration.raster_configuration_sha256,
        year=configuration.year,
    )


def _publish_cache_configuration(
    configuration: RasterStackConfiguration,
    stack_directory: Path,
    working_directory: Path,
) -> None:
    """Publish namespace metadata atomically before a missing tile is published.

    Concurrent acquisition preserves the first immutable metadata file. Staging
    belongs to the attempt directory, so normal native-attempt cleanup also
    removes it if the worker terminates. Existing fully cached runs do not call
    this function and require no historical backfill.

    Args:
        configuration: Scientific settings supplying the namespace identity.
        stack_directory: Existing private cache namespace on the same filesystem.
        working_directory: Existing attempt directory owning temporary files.

    Raises:
        OSError: If metadata staging or publication fails for an actual I/O reason.
    """
    destination = stack_directory / "configuration.json"
    if destination.exists():
        return
    with TemporaryDirectory(
        prefix="habitat-metadata-", dir=working_directory
    ) as temporary:
        staged = Path(temporary) / "configuration.json"
        staged.write_text(
            _describe_cache_configuration(configuration).model_dump_json(),
            encoding="utf-8",
        )
        try:
            os.link(staged, destination)
        except FileExistsError:
            pass


def inspect_habitat_cache_inventory(
    cache_directory: Path,
) -> tuple[HabitatCacheInventoryEntry, ...]:
    """Count all completed Habitat cache tiles independently of job and AOI history.

    Enumerates only scientific digest namespaces and published grid-coordinate
    entries. Raster files are statted for byte counts, never opened or hashed.
    Missing namespace metadata is matched against installed scientific identities;
    unmatched historical configurations remain explicitly unknown. The snapshot
    may include a concurrent publication or observe it on the next refresh.

    Args:
        cache_directory: Server-controlled private cache root, which may not exist.

    Returns:
        Separate configuration rows with completed tile counts and tile-file bytes.
        Empty namespaces, staging and report files are excluded.

    Raises:
        OSError: If cache enumeration, metadata or tile sizes cannot be read.
        ValueError: If persisted metadata is malformed or a cache path is a symlink.
    """
    if not cache_directory.exists():
        return ()
    installed: dict[str, HabitatCacheConfiguration] | None = None
    entries = []
    for namespace in sorted(cache_directory.iterdir()):
        if re.fullmatch(r"[a-f0-9]{64}", namespace.name) is None:
            continue
        if namespace.is_symlink():
            raise ValueError("Cache namespaces must not be symbolic links.")
        if not namespace.is_dir():
            continue
        cached_tiles = stored_bytes = 0
        for tile in namespace.iterdir():
            if re.fullmatch(r"-?\d+_-?\d+", tile.name) is None:
                continue
            if tile.is_symlink():
                raise ValueError("Cache tiles must not be symbolic links.")
            if not tile.is_dir():
                continue
            path = tile / "tile.tif"
            if path.is_symlink():
                raise ValueError("Cached raster files must not be symbolic links.")
            try:
                status = path.stat()
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(status.st_mode):
                continue
            cached_tiles += 1
            stored_bytes += status.st_size
        if not cached_tiles:
            continue
        metadata = namespace / "configuration.json"
        if metadata.is_symlink():
            raise ValueError(
                "Cache configuration metadata must not be a symbolic link."
            )
        try:
            with metadata.open("rb") as stream:
                payload = stream.read(4097)
        except FileNotFoundError:
            if installed is None:
                default = load_habitat_stack()
                installed = {}
                for year in range(default.minimum_year, default.maximum_year + 1):
                    description = _describe_cache_configuration(
                        load_habitat_stack(year)
                    )
                    installed[description.configuration_sha256] = description
            configuration = installed.get(namespace.name)
        else:
            if len(payload) > 4096:
                raise ValueError("Cache configuration metadata is too large.")
            configuration = HabitatCacheConfiguration.model_validate_json(payload)
            if configuration.configuration_sha256 != namespace.name:
                raise ValueError(
                    "Cache configuration metadata names another namespace."
                )
        entries.append(
            HabitatCacheInventoryEntry(
                namespace.name, configuration, cached_tiles, stored_bytes
            )
        )
    return tuple(entries)


def _name_downloaded_bands(
    path: Path, grid: RasterGrid, names: tuple[str, ...]
) -> None:
    """Check an Earth Engine GeoTIFF against its request and name its bands.

    Args:
        path: Newly downloaded file, not yet returned to the caller.
        grid: Exact pixel grid requested from Earth Engine.
        names: Ordered predictor and response band names sent in the request.

    Raises:
        ValueError: If the downloaded raster does not match the requested stack.
        RasterioError: If the GeoTIFF cannot be read or updated.
    """
    with rasterio.open(path, "r+") as dataset:
        if (
            dataset.driver != "GTiff"
            or dataset.shape != (grid.height, grid.width)
            or dataset.count != len(names)
            or dataset.crs != grid.crs
            or dataset.transform != grid.transform
            or dataset.dtypes != ("float32",) * len(names)
        ):
            raise ValueError(
                "Earth Engine returned a raster that does not match the requested Ecosystem Condition stack."
            )
        # Decode once at download admission, so truncated pixel data is not
        # returned as a completed tile. Keep the original NoData and masks.
        dataset.read(masked=True)
        dataset.descriptions = names


def _describe_provider_failure(
    error: Exception, credentials_file: Path
) -> tuple[str, str, int | None]:
    """Extract a bounded safe reason and HTTP status from an Earth Engine failure.

    Args:
        error: Exception from the provider boundary. The Earth Engine client can
            translate an HTTP exception while retaining it as exception context.
        credentials_file: Configured secret-file path to redact even when it contains spaces.

    Returns:
        Stable error category, a sanitized provider reason or local explanation,
        and the HTTP status when available. Request URLs, credentials, account
        addresses and local paths are excluded.
    """
    if isinstance(error, GoogleAuthError):
        return "earth_engine_access_denied", "Earth Engine authorization failed.", None
    if isinstance(error, (OSError, HttpLib2Error)):
        return (
            "earth_engine_connection_failed",
            "The Earth Engine request could not connect.",
            None,
        )

    http_error = (
        error if isinstance(error, HttpError) else error.__cause__ or error.__context__
    )
    status = None
    message = ""
    if isinstance(http_error, HttpError):
        if 100 <= http_error.status_code <= 599:
            status = http_error.status_code
        # The HttpError string also includes its request URL. Read only the
        # provider's structured explanation, and ignore non-JSON responses.
        if len(http_error.content) <= 65536:
            try:
                body = json.loads(http_error.content)
            except (ValueError, UnicodeError):
                body = None
            if isinstance(body, dict) and isinstance(body.get("error"), dict):
                detail = body["error"].get("message")
                if isinstance(detail, str):
                    message = detail
    elif isinstance(error, ee.EEException):
        message = str(error)

    if status in (401, 403):
        code, fallback = (
            "earth_engine_access_denied",
            "Earth Engine denied access to the request.",
        )
    elif status == 429:
        code, fallback = (
            "earth_engine_rate_limited",
            "Earth Engine limited the request rate.",
        )
    elif status is not None and 500 <= status < 600:
        code, fallback = (
            "earth_engine_service_error",
            "Earth Engine could not process the request.",
        )
    else:
        code, fallback = (
            "earth_engine_request_failed",
            "Earth Engine could not download the tile.",
        )
    for spelling in (str(credentials_file), credentials_file.as_posix()):
        message = message.replace(spelling, "[redacted]")
    message = _PROVIDER_SECRETS.sub("[redacted]", message[:8192])
    message = " ".join(
        "".join(char if char.isprintable() else " " for char in message).split()
    )
    return code, message[:512] or fallback, status


def _build_habitat_image(
    configuration: RasterStackConfiguration,
    settings: HabitatEarthEngineSettings,
) -> ee.Image:
    """Connect with server credentials and build the original scientific image.

    Args:
        configuration: Scientific settings from load_habitat_stack.
        settings: Server-only Earth Engine project and service-account key path.

    Returns:
        Earth Engine expression for the configured bands, ready for tile requests.

    Raises:
        HabitatEarthEngineConnectionError: If credentials, initialization or
            expression construction fail. Only sanitized reasons are reported.
    """
    try:
        credentials = ee.ServiceAccountCredentials(
            key_file=str(settings.credentials_file)
        )
    except (ValueError, OSError, GoogleAuthError, ee.EEException):
        raise HabitatEarthEngineConnectionError(
            "Ecosystem Condition could not load the mounted service-account credentials. "
            "Ask the administrator to check the configured project and credentials."
        ) from None
    try:
        ee.Initialize(credentials, project=settings.project)
    except (*_PROVIDER_ERRORS, ValueError) as error:
        _, detail, _ = _describe_provider_failure(error, settings.credentials_file)
        raise HabitatEarthEngineConnectionError(
            "Ecosystem Condition could not connect to Earth Engine. Check the configured project "
            f"and the mounted service-account credentials and permissions. {detail}"
        ) from None
    try:
        return build_earth_engine_stack(configuration)
    except _PROVIDER_ERRORS as error:
        _, detail, _ = _describe_provider_failure(error, settings.credentials_file)
        raise HabitatEarthEngineConnectionError(
            f"Ecosystem Condition could not build the configured Earth Engine inputs. {detail}"
        ) from None


def _publish_tile(directory: Path, entry: Path) -> None:
    """Atomically publish a validated tile, preserving an existing winner.

    Args:
        directory: Private staging directory containing the completed tile.tif.
        entry: Deterministic cache directory on the same filesystem. Every
            published entry is nonempty, so rename cannot overwrite it.

    Raises:
        OSError: If publication fails for a reason other than another writer
            publishing the same tile first, including different filesystems.
    """
    try:
        directory.rename(entry)
    except OSError as error:
        if error.errno not in (errno.EEXIST, errno.ENOTEMPTY):
            raise


def get_habitat_tiles(
    area: BaseGeometry,
    configuration: RasterStackConfiguration,
    settings: HabitatEarthEngineSettings,
    *,
    cache_directory: Path,
    working_directory: Path,
    progress: Callable[[int, int], None],
    check_cancelled: Callable[[], None],
) -> HabitatTiles:
    """Reuse completed Habitat tiles and attempt every missing tile for a projected AOI.

    Run in a dedicated Processing native process: Earth Engine initialization is
    process-global. The upstream scientific configuration digest includes year,
    grid, datasets, bands and stack version; globally anchored tile coordinates
    allow overlapping AOIs to reuse the same pixels. Completed entries are
    immutable and are not reopened or rehashed here. An entirely cached request
    does not connect to Earth Engine. Namespace identity and source year are
    recorded before publishing a missing tile, so its later inventory does not
    depend on installed historical configurations. Warm historical namespaces
    require no metadata migration.

    Args:
        area: Valid, nonempty AOI already projected to configuration.grid.crs.
        configuration: Scientific settings from load_habitat_stack.
        settings: Server-only project and credentials, used only for cache misses.
        cache_directory: Private persistent cache, outside source mounts and
            attempt/result directories. Its files survive run expiry and restart.
            Administrators may clear it only while no calculations use it.
        working_directory: Existing private attempt directory on the same
            filesystem as the cache, allowing atomic directory publication.
        progress: Receive completed and total tile counts, including cache hits.
        check_cancelled: Raise to cancel between requests or before publication.
            The native supervisor handles cancellation during a blocking request.

    Returns:
        Shared cached files, ordered bands and sanitized remote tile failures.
        The first completed publication wins on concurrent cache misses. Failed
        remote requests leave no cache entry for this attempt.
        Previously published tiles remain reusable after failure or cancellation.

    Raises:
        HabitatEarthEngineConnectionError: If the provider cannot initialize or
            construct the stack for any tile request.
        ValueError: If a downloaded raster differs from the requested grid/bands.
        RasterioError: If downloaded pixels or metadata cannot be read or written.
        OSError: If local reads, writes, publication or staging cleanup fail.
        Exception: Propagates exceptions from progress and cancellation callbacks.
    """
    grids = _select_tile_grids(area, configuration.grid)
    bands = _get_habitat_model_bands(configuration)
    check_cancelled()
    progress(0, len(grids))
    stack_directory = cache_directory / configuration.raster_configuration_sha256
    stack_directory.mkdir(parents=True, exist_ok=True)
    image = None
    paths: list[Path] = []
    failures: list[HabitatTileFailure] = []
    for grid in grids:
        check_cancelled()
        entry = _get_tile_cache_directory(grid, configuration.grid, stack_directory)
        if not entry.exists():
            _publish_cache_configuration(
                configuration, stack_directory, working_directory
            )
            if image is None:
                image = _build_habitat_image(configuration, settings)
            try:
                pixels = ee.data.computePixels(
                    {
                        "expression": image,
                        "fileFormat": "GEO_TIFF",
                        "bandIds": list(bands),
                        "grid": {
                            "dimensions": {"width": grid.width, "height": grid.height},
                            "affineTransform": {
                                "scaleX": grid.transform.a,
                                "shearX": 0,
                                "translateX": grid.transform.c,
                                "shearY": 0,
                                "scaleY": grid.transform.e,
                                "translateY": grid.transform.f,
                            },
                            "crsWkt": grid.crs.to_wkt(version="WKT1_GDAL"),
                        },
                    }
                )
            except _PROVIDER_ERRORS as error:
                column, row = map(int, entry.name.split("_"))
                code, detail, status = _describe_provider_failure(
                    error, settings.credentials_file
                )
                failures.append(
                    HabitatTileFailure(
                        column=column,
                        row=row,
                        code=code,
                        detail=detail,
                        httpStatus=status,
                    )
                )
                progress(len(paths), len(grids))
                continue
            check_cancelled()
            with TemporaryDirectory(
                prefix="habitat-gee-", dir=working_directory
            ) as temporary:
                directory = Path(temporary)
                path = directory / "tile.tif"
                path.write_bytes(pixels)
                _name_downloaded_bands(path, grid, tuple(bands))
                check_cancelled()
                _publish_tile(directory, entry)
        paths.append(entry / "tile.tif")
        progress(len(paths), len(grids))
    check_cancelled()
    return HabitatTiles(tuple(paths), bands, len(grids), tuple(failures))
