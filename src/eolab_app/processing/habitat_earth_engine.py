"""Download the original Habitat predictor and response rasters from Earth Engine."""

from collections.abc import Callable
from dataclasses import dataclass
from importlib.resources import as_file, files
from pathlib import Path
import shutil
from tempfile import mkdtemp

from affine import Affine
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


@dataclass(frozen=True)
class HabitatTileDownload:
    """Completed multiband Habitat tiles and their scientific variable definitions.

    Attributes:
        directory: Private download directory; the caller owns its removal.
        tiles: Complete grid tiles in north-to-south, west-to-east order.
        bands: Ordered GeoTIFF band names mapped to the original definitions.
            Contains predictors and responses, never computed reference sites.
    """

    directory: Path
    tiles: tuple[Path, ...]
    bands: dict[str, RasterBandDefinition]


def load_habitat_stack(year: int) -> RasterStackConfiguration:
    """Load the original Habitat variables and acquisition grid for a source year.

    The upstream configuration filename names its original study area, but this
    scientific-only loader does not read that area's geometry or local settings.

    Args:
        year: Source year supported by the packaged scientific configuration.

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
                "Earth Engine returned a raster that does not match the requested Habitat stack."
            )
        # Decode once at download admission, so truncated pixel data is not
        # returned as a completed tile. Keep the original NoData and masks.
        dataset.read(masked=True)
        dataset.descriptions = names


def download_habitat_tiles(
    area: BaseGeometry,
    configuration: RasterStackConfiguration,
    settings: HabitatEarthEngineSettings,
    directory: Path,
    *,
    progress: Callable[[int, int], None],
    check_cancelled: Callable[[], None],
) -> HabitatTileDownload:
    """Fetch the original Habitat variables for tiles intersecting a projected AOI.

    Call inside a dedicated Processing native process: Earth Engine initialization
    is process-global. Requests use the scientific acquisition grid, independently
    of the later model output grid. No files are reused or admitted to the Catalog.

    Args:
        area: Valid, nonempty AOI already projected to configuration.grid.crs.
        configuration: Scientific settings from load_habitat_stack.
        settings: Server-only Earth Engine project and service-account key path.
        directory: Existing private working directory, outside source mounts.
        progress: Receive completed and total tile counts, starting at zero.
        check_cancelled: Raise to cancel before initialization, between requests
            or before accepting a downloaded tile. Processing's existing native
            supervisor handles cancellation during a blocking request.

    Returns:
        Completed tiles with ordered band definitions in a new private directory.
        The caller owns that directory on success. Failure or cooperative
        cancellation removes it; after hard termination, the Processing owner
        removes the parent attempt directory once the native process has exited.

    Raises:
        RuntimeError: If credentials, initialization or an Earth Engine request
            fails. Credential contents and raw authentication errors are omitted.
        ValueError: If a downloaded raster differs from the requested grid/bands.
        RasterioError: If downloaded pixels or metadata cannot be read or written.
        OSError: If local files cannot be written or removed.
        Exception: Propagates exceptions from progress and cancellation callbacks.
    """
    grids = _select_tile_grids(area, configuration.grid)
    bands = {
        name: band
        for name, band in zip(configuration.band_names(), configuration.bands)
        if band.role in ("predictor", "response")
    }
    check_cancelled()
    progress(0, len(grids))
    try:
        credentials = ee.ServiceAccountCredentials(
            key_file=str(settings.credentials_file)
        )
        ee.Initialize(credentials, project=settings.project)
    except (
        OSError,
        ValueError,
        GoogleAuthError,
        HttpError,
        HttpLib2Error,
        ee.EEException,
    ):
        raise RuntimeError(
            "Habitat could not connect to Earth Engine. Check the configured project "
            "and the mounted service-account credentials and permissions."
        ) from None
    image = build_earth_engine_stack(configuration)
    download_directory = Path(mkdtemp(prefix="habitat-gee-", dir=directory))
    paths = []
    try:
        for index, grid in enumerate(grids):
            check_cancelled()
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
            except (OSError, GoogleAuthError, HttpError, HttpLib2Error, ee.EEException):
                raise RuntimeError(
                    "Earth Engine could not download a Habitat tile. Check the "
                    "server connection and access to the configured source datasets."
                ) from None
            check_cancelled()
            path = download_directory / f"tile-{index:06d}.tif"
            path.write_bytes(pixels)
            _name_downloaded_bands(path, grid, tuple(bands))
            paths.append(path)
            progress(index + 1, len(grids))
        check_cancelled()
        return HabitatTileDownload(download_directory, tuple(paths), bands)
    except BaseException:
        shutil.rmtree(download_directory)
        raise
