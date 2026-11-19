"""Trace flow to and from selected polygons on the elevation raster grid."""

from contextlib import ExitStack, closing
from dataclasses import dataclass, field
from hashlib import file_digest
import json
import logging
from math import hypot, isclose
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Literal

import numpy
from pydantic import BaseModel, ConfigDict, StrictBool, model_validator
import rasterio
from rasterio.shutil import copy as copy_raster
from rasterio.windows import Window

from eolab_app.bounded_vector import PolygonRasterizer
from eolab_app.catalog_selection import ResolvedCatalogSelection, VectorSelection
from eolab_app.execution.bounded_process import ProcessResultWriter
from eolab_app.processing.aggregate_models import RasterAggregateLimits
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.model_result_contracts import RasterResultGrid
from eolab_app.processing.models import Artifact, ProcessingError
from eolab_app.processing.raster_input import validate_supported_raster
from eolab_app.processing.raster_mask import temporary_polygon_mask
from eolab_app.raster.bounded_window import NoRasterBoundsOverlapError
from eolab_app.raster.reader import RasterDataset, open_raster_data
from eolab_app.raster.source_contract import read_native_raster_window
from eolab_app.raster.source_models import RasterSourceReference

OPERATION = "hydrology.polygon_flow_area.v1"
MASK_NODATA = 255
# EcoShard compares NoData with a tolerance and requires a finite sentinel.
ROUTING_NODATA = -1e100

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
    """Record the routing, seed membership and output values in Run YAML."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    version: Literal["hydrology.polygon_flow_area.v1"] = OPERATION
    routing: Literal["d8"] = "d8"
    depressions: Literal["fill_to_spill_elevation"] = "fill_to_spill_elevation"
    outlets: Literal["raster_edges_and_nodata"] = "raster_edges_and_nodata"
    polygonPixels: Literal["cell_centres_excluded_from_result"] = (
        "cell_centres_excluded_from_result"
    )
    valueDomain: Literal["stored_native_values"] = "stored_native_values"
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


def _write_routing_inputs(
    dem: RasterDataset,
    polygon: rasterio.io.DatasetReader,
    elevation_path: Path,
    seed_path: Path,
) -> int:
    """Write a finite-NoData DEM and seed weights for EcoShard in one tile pass.

    Args:
        dem: Open elevation raster with ordinary source validity rules.
        polygon: Polygon mask on the DEM grid, including cells with missing elevation.
        elevation_path: Destination for the routing DEM in the attempt directory.
        seed_path: Destination for the valid polygon-cell markers in the attempt directory.

    Returns:
        The number of DEM cells with valid elevation.

    Raises:
        ProcessingError: If there are no valid starting cells or values collide with the
            routing library's reserved NoData range.
        rasterio.errors.RasterioError: If raster I/O fails.
    """
    profile = {
        "driver": "GTiff",
        "width": dem.width,
        "height": dem.height,
        "count": 1,
        "crs": dem.crs,
        "transform": dem.transform,
        "tiled": True,
        "blockxsize": 256,
        "blockysize": 256,
        "BIGTIFF": "YES",
    }
    valid_count = 0
    has_seed = False
    with (
        rasterio.open(
            elevation_path, "w", **profile, dtype="float64", nodata=ROUTING_NODATA
        ) as elevation,
        rasterio.open(seed_path, "w", **profile, dtype="uint8") as seeds,
    ):
        for _, window in elevation.block_windows(1):
            values = read_native_raster_window(dem, window)
            valid = ~numpy.ma.getmaskarray(values)
            if numpy.any(valid & numpy.isclose(values.data, ROUTING_NODATA)):
                raise ProcessingError(
                    "unsupported_source",
                    "The DEM contains elevation values in the routing library's NoData range.",
                )
            seed_cells = valid & (polygon.read(1, window=window) == 1)
            has_seed |= bool(seed_cells.any())
            valid_count += int(numpy.count_nonzero(valid))
            elevation.write(
                numpy.where(valid, values.data, ROUTING_NODATA), 1, window=window
            )
            seeds.write(seed_cells.astype("uint8"), 1, window=window)
    if not has_seed:
        raise ProcessingError(
            "empty_flow_start",
            "No valid DEM cell centres fall inside the selected polygons.",
        )
    return valid_count


def _write_flow_mask(
    elevation_path: Path, seed_path: Path, traces: list[Path], destination: Path
) -> None:
    """Write the union of positive traces, excluding seeds and missing elevation.

    Args:
        elevation_path: Routing DEM with canonical NoData.
        seed_path: Valid DEM cells used to start the traces.
        traces: Upstream distances or downstream accumulated weights on the DEM grid.
        destination: Tiled GeoTIFF to finish as a COG.

    Raises:
        rasterio.errors.RasterioError: If an input or output tile cannot be read or written.
    """
    with ExitStack() as stack:
        elevation = stack.enter_context(rasterio.open(elevation_path))
        seeds = stack.enter_context(rasterio.open(seed_path))
        routed = [stack.enter_context(rasterio.open(path)) for path in traces]
        output = stack.enter_context(
            rasterio.open(
                destination,
                "w",
                **{**elevation.profile, "dtype": "uint8", "nodata": MASK_NODATA},
            )
        )
        for _, window in output.block_windows(1):
            seed_cells = seeds.read(1, window=window) == 1
            covered = numpy.zeros_like(seed_cells)
            for trace in routed:
                covered |= (trace.read(1, window=window, masked=True) > 0).filled(False)
            valid = elevation.read_masks(1, window=window) != 0
            mask = numpy.where(valid, covered & ~seed_cells, MASK_NODATA)
            output.write(mask.astype("uint8"), 1, window=window)


def calculate_flow_area(
    sources: tuple[Path, ResolvedCatalogSelection],
    plan: FlowAreaPlan,
    directory: Path,
    limits: RasterAggregateLimits,
) -> FlowAreaArtifact:
    """Condition the DEM, trace the requested paths and write a publishable GeoTIFF.

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
    from ecoshard.geoprocessing import routing

    dem_path, selection = sources
    result_path = directory / "result.tif"
    with TemporaryDirectory(dir=directory, prefix="flow-") as temporary:
        scratch = Path(temporary)
        elevation_path = scratch / "elevation.tif"
        seed_path = scratch / "seeds.tif"
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
            with (
                closing(polygons),
                temporary_polygon_mask(
                    dem, Window(0, 0, dem.width, dem.height), polygons, scratch, limits
                ) as polygon,
            ):
                assert (
                    polygon is not None
                )  # A PolygonRasterizer always supplies a mask.
                valid_count = _write_routing_inputs(
                    dem, polygon, elevation_path, seed_path
                )

        filled = scratch / "filled.tif"
        directions = scratch / "directions.tif"
        write_progress(directory, "flow_conditioning", 0, 0)
        routing.fill_pits(
            (str(elevation_path), 1),
            str(filled),
            working_dir=str(scratch),
            max_pixel_fill_count=-1,
        )
        write_progress(directory, "flow_directions", 0, 0)
        routing.flow_dir_d8((str(filled), 1), str(directions), working_dir=str(scratch))
        filled.unlink()

        flow_band = (str(directions), 1)
        seed_band = (str(seed_path), 1)
        traces = []
        if plan.inputs.upstream:
            write_progress(directory, "flow_upstream", 0, 0)
            upstream = scratch / "upstream.tif"
            routing.distance_to_channel_d8(flow_band, seed_band, str(upstream))
            traces.append(upstream)
        if plan.inputs.downstream:
            write_progress(directory, "flow_downstream", 0, 0)
            downstream = scratch / "downstream.tif"
            routing.flow_accumulation_d8(
                flow_band, str(downstream), weight_raster_path_band=seed_band
            )
            traces.append(downstream)

        write_progress(directory, "flow_writing", 0, 0)
        mask_path = scratch / "mask.tif"
        _write_flow_mask(elevation_path, seed_path, traces, mask_path)
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
