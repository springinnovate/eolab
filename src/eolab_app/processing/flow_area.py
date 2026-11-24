"""Trace flow to and from selected polygons on the elevation raster grid."""

from contextlib import closing
from dataclasses import dataclass, field
from hashlib import file_digest
from importlib.metadata import version as package_version
import json
import logging
from math import hypot, isclose
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Literal

import numpy
from numpy.typing import NDArray
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator
import rasterio
from rasterio.shutil import copy as copy_raster
from rasterio.transform import Affine

from eolab_app.bounded_vector import PolygonRasterizer
from eolab_app.catalog_selection import ResolvedCatalogSelection, VectorSelection
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.d8 import build_d8_flow_graph, read_d8_elevations
from eolab_app.processing.model_result_contracts import RasterResultGrid
from eolab_app.processing.models import Artifact, ProcessingError
from eolab_app.processing.raster_input import validate_supported_raster
from eolab_app.processing.raster_mask import temporary_polygon_mask
from eolab_app.raster.bounded_window import NoRasterBoundsOverlapError
from eolab_app.raster.reader import open_raster_data
from eolab_app.raster.source_models import RasterSourceReference

OPERATION = "hydrology.polygon_flow_area.v1"
MASK_NODATA = 255

LOGGER = logging.getLogger(__name__)


class FlowAreaInputs(BaseModel):
    """Capture the selected DEM, polygon predicate and directions for one run."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    dem: RasterSourceReference
    polygon: VectorSelection
    upstream: StrictBool
    downstream: StrictBool

    @model_validator(mode="after")
    def require_direction(self) -> "FlowAreaInputs":
        """Require at least one direction when validating run inputs.

        Returns:
            The checked inputs.

        Raises:
            ProcessingError: If both directions are unchecked.
        """
        if not (self.upstream or self.downstream):
            raise ProcessingError(
                "invalid_flow_direction", "Choose at least one flow direction."
            )
        return self


class QueuedFlowArea(BaseModel):
    """Persist path-free inputs while the run waits for a worker."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["hydrology.polygon_flow_area.v1"] = OPERATION
    request: FlowAreaInputs


class FlowAreaPlan(BaseModel):
    """Record the accepted inputs and expected mask grid for a native calculation."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    operation: Literal["hydrology.polygon_flow_area.v1"] = OPERATION
    inputs: FlowAreaInputs
    grid: RasterResultGrid


class FlowAreaPolicy(BaseModel):
    """Record the routing engine, seed membership and output values in Run YAML."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal["hydrology.polygon_flow_area.v1"] = OPERATION
    engine: Literal["pyflwdir"] = "pyflwdir"
    engineVersion: str = Field(default_factory=lambda: package_version("pyflwdir"))
    routing: Literal["d8"] = "d8"
    depressions: Literal["fill_to_spill_elevation"] = "fill_to_spill_elevation"
    outlets: Literal["raster_edges_and_nodata"] = "raster_edges_and_nodata"
    polygonPixels: Literal["cell_centres_excluded_from_result"] = (
        "cell_centres_excluded_from_result"
    )
    valueDomain: Literal["physical_elevation_order"] = "physical_elevation_order"
    nodata: Literal[255] = MASK_NODATA


@dataclass(frozen=True)
class FlowAreaArtifact(Artifact):
    """Describe the GeoTIFF mask and count its valid cells, including zeros."""

    valid_pixels: int
    media_type: str = field(default="image/tiff", kw_only=True)


def plan_flow_grid(dem_path: Path) -> RasterResultGrid:
    """Describe the mask grid from the authorized DEM's metadata.

    Args:
        dem_path: Confined path to the selected elevation raster.

    Returns:
        The DEM dimensions, CRS and transform with a byte-valued mask band.

    Raises:
        ProcessingError: If the DEM is unsupported or its cells are not square.
        rasterio.errors.RasterioError: If the source cannot be opened.
    """
    with open_raster_data(dem_path) as dem:
        validate_supported_raster(dem, dem_path)
        transform = dem.transform
        x_step = hypot(transform.a, transform.d)
        y_step = hypot(transform.b, transform.e)
        alignment = (transform.a / x_step) * (transform.b / y_step) + (
            transform.d / x_step
        ) * (transform.e / y_step)
        if not isclose(x_step, y_step, rel_tol=1e-6) or not isclose(
            alignment, 0, abs_tol=1e-6
        ):
            raise ProcessingError(
                "unsupported_source",
                "Flow tracing needs square DEM cells. Choose an elevation raster with square cells.",
            )
        return RasterResultGrid(
            width=dem.width,
            height=dem.height,
            crs=dem.crs.to_wkt(),
            dtype="uint8",
            transform=tuple(transform)[:6],
        )


def _write_flow_mask(
    grid: RasterResultGrid,
    valid: NDArray[numpy.bool_],
    traced: NDArray[numpy.bool_],
    destination: Path,
) -> None:
    """Write traced cells and native DEM validity to a tiled GeoTIFF.

    Args:
        grid: Expected geometry and byte format of the result.
        valid: Cells with valid elevation on the result grid.
        traced: Upstream or downstream cells outside the seed polygon.
        destination: Tiled GeoTIFF to finish as a COG.

    Raises:
        rasterio.errors.RasterioError: If an input or output tile cannot be read or written.
    """
    with rasterio.open(
        destination,
        "w",
        driver="GTiff",
        width=grid.width,
        height=grid.height,
        count=1,
        crs=rasterio.crs.CRS.from_wkt(grid.crs),
        transform=Affine(*grid.transform),
        dtype=grid.dtype,
        nodata=MASK_NODATA,
        tiled=True,
        blockxsize=256,
        blockysize=256,
        BIGTIFF="YES",
    ) as output:
        for _, window in output.block_windows(1):
            tile = window.toslices()
            mask = numpy.where(valid[tile], traced[tile], MASK_NODATA)
            output.write(mask.astype("uint8"), 1, window=window)


def calculate_flow_area(
    sources: tuple[Path, ResolvedCatalogSelection],
    plan: FlowAreaPlan,
    directory: Path,
    limits: RasterAggregateLimits,
) -> FlowAreaArtifact:
    """Condition the DEM, trace the requested paths and write a publishable GeoTIFF.

    A one-cell DEM produces a zero mask because its valid starting cell is
    excluded from the result.

    Args:
        sources: Authorized DEM and original vector source with its captured predicate.
        plan: Accepted directions and native result grid.
        directory: Private, supervisor-owned attempt directory.
        limits: Existing Processing settings for creating the temporary polygon mask.

    Returns:
        Completed raster metadata for the worker's artifact publisher.

    Raises:
        ProcessingError: If no valid starting cells exist or the final grid is invalid.
        Exception: If the native vector, raster or routing library cannot finish.
    """
    dem_path, selection = sources
    result_path = directory / "result.tif"
    with TemporaryDirectory(dir=directory, prefix="flow-") as temporary:
        scratch = Path(temporary)
        write_progress(directory, "flow_inputs", 0, 0)
        with open_raster_data(dem_path) as dem:
            try:
                polygons = PolygonRasterizer(
                    dem,
                    selection,
                    None,
                    max_retained_polygon_bytes=None,
                    read_limits=None,
                )
            except NoRasterBoundsOverlapError as error:
                raise ProcessingError(
                    "empty_flow_start", "The selected polygons do not overlap the DEM."
                ) from error
            seed_window = polygons.source_window
            with (
                closing(polygons),
                temporary_polygon_mask(
                    dem, seed_window, polygons, scratch, limits
                ) as polygon,
            ):
                assert (
                    polygon is not None
                )  # A PolygonRasterizer always supplies a mask.
                selected = polygon.read(1).view(numpy.bool_)
            if not selected.any():
                raise ProcessingError(
                    "empty_flow_start",
                    "No DEM cell centres fall inside the selected polygons.",
                )
            elevations = read_d8_elevations(dem)
            transform = dem.transform
            latlon = dem.crs.is_geographic
        valid = numpy.isfinite(elevations)
        selected &= valid[seed_window.toslices()]
        if not selected.any():
            raise ProcessingError(
                "empty_flow_start",
                "No valid DEM cell centres fall inside the selected polygons.",
            )
        if selected.shape == valid.shape:
            seeds = selected
        else:
            seeds = numpy.zeros_like(valid)
            seeds[seed_window.toslices()] = selected
        del selected
        valid_count = int(numpy.count_nonzero(valid))
        write_progress(directory, "flow_directions", 0, 0)
        # A one-cell grid has no cells outside its seed; PyFlwDir needs size > 1.
        flow = (
            build_d8_flow_graph(elevations, transform, latlon=latlon)
            if elevations.size > 1
            else None
        )
        del elevations
        traced = numpy.zeros_like(seeds)
        if flow is not None:
            if flow.idxs_seq.size != valid_count:
                raise ProcessingError(
                    "invalid_flow_graph",
                    "Flow directions did not cover all valid DEM cells.",
                )
            # Propagate True without counting or summing seeds.
            if plan.inputs.upstream:
                write_progress(directory, "flow_upstream", 0, 0)
                traced |= flow.fillnodata(seeds, nodata=False, direction="up")
            if plan.inputs.downstream:
                write_progress(directory, "flow_downstream", 0, 0)
                traced |= flow.fillnodata(
                    seeds, nodata=False, direction="down", how="max"
                )
        traced[seeds] = False
        del flow, seeds

        write_progress(directory, "flow_writing", 0, 0)
        mask_path = scratch / "mask.tif"
        _write_flow_mask(plan.grid, valid, traced, mask_path)
        del valid, traced
        copy_raster(
            mask_path,
            result_path,
            driver="COG",
            compress="DEFLATE",
            resampling="NEAREST",
            BIGTIFF="IF_SAFER",
        )

    with rasterio.open(result_path) as mask:
        if (
            mask.tags(ns="IMAGE_STRUCTURE").get("LAYOUT") != "COG"
            or mask.count != 1
            or mask.dtypes[0] != plan.grid.dtype
            or mask.width != plan.grid.width
            or mask.height != plan.grid.height
            or mask.crs != rasterio.crs.CRS.from_wkt(plan.grid.crs)
            or tuple(mask.transform)[:6] != plan.grid.transform
            or mask.nodata != MASK_NODATA
        ):
            raise ProcessingError(
                "invalid_output", "The flow mask failed GeoTIFF grid validation.", 500
            )
    with result_path.open("rb") as stream:
        checksum = file_digest(stream, "sha256").hexdigest()
    artifact = FlowAreaArtifact(
        size=result_path.stat().st_size,
        sha256=checksum,
        filename="polygon-flow-mask.tif",
        valid_pixels=valid_count,
    )
    (directory / "provenance.json").write_text(
        json.dumps(
            {
                "operation": OPERATION,
                "inputs": plan.inputs.model_dump(mode="json", by_alias=True),
                "grid": plan.grid.model_dump(mode="json"),
                "numericalPolicy": FlowAreaPolicy().model_dump(mode="json"),
                "raster": {
                    "filename": artifact.filename,
                    "bytes": artifact.size,
                    "sha256": artifact.sha256,
                    "validPixels": artifact.valid_pixels,
                },
            },
            allow_nan=False,
        ),
        encoding="utf-8",
    )
    return artifact


def flow_area_process_target(
    queue: ProcessResultWriter,
    action: Literal["plan", "calculate"],
    arguments: tuple[Any, ...],
) -> None:
    """Run flow-area work in the supervised worker and return a sanitized result.

    Args:
        queue: Supervisor's one-result writer.
        action: Read grid metadata or calculate and write the flow mask.
        arguments: Authorized, action-specific inputs supplied by Processing.
    """
    try:
        value = (
            plan_flow_grid(*arguments)
            if action == "plan"
            else calculate_flow_area(*arguments)
        )
        queue.put(("ok", value))
    except ProcessingError as error:
        queue.put(("error", (error.code, error.detail, error.status)))
    except Exception:
        LOGGER.exception("Polygon flow area %s failed", action)
        queue.put(
            (
                "error",
                (
                    "flow_area_failed",
                    "The DEM or polygon layer could not be processed for flow tracing.",
                    422,
                ),
            )
        )
