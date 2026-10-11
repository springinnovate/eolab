"""Adapt authorized EOlab inputs and outputs to the unchanged WWF model functions."""

import hashlib
from importlib import import_module
from importlib.resources import files
import json
import math
from pathlib import Path
import shutil
from types import ModuleType
from typing import TYPE_CHECKING, Any
from xml.etree.ElementTree import Element, SubElement, ElementTree

import numpy as np
import rasterio
import fiona
from shapely.geometry import mapping
from shapely.geometry.base import BaseGeometry

from eolab_app.processing.aggregate_models import (
    AggregateArea,
    AggregateArtifact,
    RasterAggregateLimits,
)
from eolab_app.processing.artifact_manifest import ProducedFile
from eolab_app.processing.artifacts import write_progress
from eolab_app.processing.downstream_models import (
    BENEFICIARIES_REVISION,
    DownstreamLimits,
    DownstreamPlan,
)
from eolab_app.processing.ground_area import PixelAreaCalculator
from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_expression import Calculation, compile_expression, walk

if TYPE_CHECKING:
    from eolab_app.processing.downstream_calculation import DownstreamSources


def load_beneficiaries() -> ModuleType:
    """Load the pinned upstream runner after checking its packaged source checksum.

    Returns:
        The original module, with its functions and numerical constants unchanged.

    Raises:
        ProcessingError: If the installed source differs from the reviewed package.
        ImportError: If the application build omitted a required model dependency.
    """
    package = files("wwf_es_beneficiaries")
    provenance = json.loads((package / "source.json").read_text(encoding="utf-8"))
    if (
        provenance["revision"] != BENEFICIARIES_REVISION
        or hashlib.sha256((package / "workflow_runner.py").read_bytes()).hexdigest()
        != provenance["runnerSha256"]
    ):
        raise ProcessingError(
            "model_implementation_changed",
            "The installed downstream model does not match its recorded version.",
            500,
        )
    return import_module("wwf_es_beneficiaries.workflow_runner")


def write_watershed_view(
    sources: "DownstreamSources", spec: DownstreamPlan, directory: Path
) -> Path:
    """Expose the selected source layer under the upstream model's field names.

    The private OGR view only maps field names; it leaves IDs, links, geometries
    and the upstream traversal unchanged. Its source is an authorized native path.

    Args:
        sources: Resolved original files with source identity checks.
        spec: Captured administrator field mappings.
        directory: Private directory owned by this calculation attempt.

    Returns:
        Run-local VRT path readable by the original model.

    Raises:
        ProcessingError: If the configuration cannot represent HydroBASINS links.
        SelectionUnavailableError: If the watershed source changed.
        OSError: If the private view cannot be written.
    """
    sources.network.require_current()
    topology = spec.inputs.hydrology.definition.topology
    if topology.idType != "integer" or topology.terminalIdField is None:
        raise ProcessingError(
            "unsupported_hydrology",
            "This model needs integer watershed IDs and a next-sink ID field in its hydrology configuration.",
            422,
        )
    root = Element("OGRVRTDataSource")
    layer = SubElement(root, "OGRVRTLayer", name="watersheds")
    SubElement(layer, "SrcDataSource", relativeToVRT="0").text = str(
        sources.network.path
    )
    SubElement(layer, "SrcLayer").text = sources.network.selection.layerName
    for name, original in (
        ("HYBAS_ID", topology.idField),
        ("NEXT_DOWN", topology.downstreamField),
        ("NEXT_SINK", topology.terminalIdField),
    ):
        SubElement(layer, "Field", name=name, src=original, type="Integer64")
    target = directory / "watersheds.vrt"
    ElementTree(root).write(target, encoding="utf-8", xml_declaration=True)
    return target


def prepare_starting_inputs(
    sources: "DownstreamSources",
    spec: DownstreamPlan,
    starting: BaseGeometry,
    directory: Path,
    limits: DownstreamLimits,
) -> tuple[Path, Path]:
    """Write the selected AOI and adapt vector starts to the model's raster input.

    Raster masks pass through unchanged. A filtered vector becomes a binary
    raster on the chosen calculation grid. The upstream function remains
    responsible for its condition expression, warping and partition masking.

    Args:
        sources: Authorized raster or filtered-vector starting input.
        spec: Captured model settings, including the upstream grid resolution.
        starting: Validated WGS84 geometry from the existing selection reader.
        directory: Private per-run input directory.
        limits: Existing cell and disk budgets, also applied to the rasterized mask.

    Returns:
        AOI GeoJSON path and original or rasterized starting-mask path.

    Raises:
        ProcessingError: If rasterization cannot create a nonempty grid.
        OSError: If the prepared AOI cannot be written.
    """
    from osgeo import gdal

    aoi = directory / "starting-area.geojson"
    aoi.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {"type": "Feature", "properties": {}, "geometry": mapping(starting)}
                ],
            }
        ),
        encoding="utf-8",
    )
    if sources.starting is None:
        return aoi, sources.rasters["starting_mask"]
    check_calculation_grid(starting.bounds, spec, limits, limits.max_mask_cells)
    mask = directory / "starting-mask.tif"
    output = gdal.Rasterize(
        str(mask),
        str(aoi),
        format="GTiff",
        outputSRS="EPSG:4326",
        xRes=spec.inputs.wgs84_pixel_size,
        yRes=spec.inputs.wgs84_pixel_size,
        burnValues=[1],
        noData=0,
        outputType=gdal.GDT_Byte,
        creationOptions=["TILED=YES", "COMPRESS=LZW", "BIGTIFF=YES"],
    )
    if output is None or output.RasterXSize < 1 or output.RasterYSize < 1:
        raise ProcessingError(
            "empty_starting_mask",
            "The starting area is smaller than the selected calculation pixel size.",
            422,
        )
    output = None
    return aoi, mask


def check_calculation_grid(
    bounds: tuple[float, float, float, float],
    spec: DownstreamPlan,
    limits: DownstreamLimits,
    cell_limit: int,
) -> int:
    """Check the upstream output grid against existing work, memory and disk budgets.

    This only admits or rejects work; it never changes the model's resolution,
    alignment, resampling or values. Two edge cells allow for upstream alignment.

    Args:
        bounds: WGS84 bounds of the mask or watershed partition.
        spec: Captured resolution and existing disk reservation.
        limits: Administrator memory and storage limits.
        cell_limit: Existing mask or routing cell ceiling for this allocation.

    Returns:
        Conservative number of calculation cells.

    Raises:
        ProcessingError: If the requested resolution exceeds admitted resources.
    """
    from eolab_app.processing.downstream_calculation import (
        ESTIMATED_MEMORY_BYTES_PER_CELL,
        NATIVE_PROCESS_BASE_MEMORY_BYTES,
        ESTIMATED_SCRATCH_BYTES_PER_CELL,
        SCRATCH_FILE_OVERHEAD_BYTES,
    )

    resolution = spec.inputs.wgs84_pixel_size
    width = (bounds[2] - bounds[0]) / resolution
    height = (bounds[3] - bounds[1]) / resolution
    if not math.isfinite(width) or not math.isfinite(height):
        raise ProcessingError(
            "model_too_large", "Choose a larger calculation pixel size.", 413
        )
    cells = (math.ceil(width) + 2) * (math.ceil(height) + 2)
    if (
        cells > cell_limit
        or cells * ESTIMATED_MEMORY_BYTES_PER_CELL + NATIVE_PROCESS_BASE_MEMORY_BYTES
        > limits.process_memory_bytes
        or cells * ESTIMATED_SCRATCH_BYTES_PER_CELL + SCRATCH_FILE_OVERHEAD_BYTES
        > spec.reservedBytes
    ):
        raise ProcessingError(
            "model_too_large",
            "The calculation pixel size exceeds this run's cell, memory or disk budget. Choose a larger pixel size or a smaller starting area.",
            413,
        )
    return cells


def summarize_upstream_values(
    path: Path, expression: str, upstream_total: float, limits: DownstreamLimits
) -> dict[str, Any]:
    """Return the upstream sum or apply an EOlab formula to its masked output.

    ``sum(a)`` reports the exact float returned by the original model. Optional
    formulas are explicitly postprocessing: they read the model's output grid
    and NoData convention without changing its coverage or masked values.

    Args:
        path: Complete masked-values raster produced by the original model.
        expression: Validated EOlab scalar formula.
        upstream_total: Sum returned by ``mask_population_with_coverage``.
        limits: Existing area-calculation resource limits.

    Returns:
        Ordinary Processing statistics fields, including coverage counts.

    Raises:
        ProcessingError: If the upstream result is nonfinite or a formula fails.
        RasterioError: If the completed raster cannot be read.
    """
    root = compile_expression(expression, "a")
    calculation = Calculation(root)
    with rasterio.open(path) as dataset:
        area = (
            PixelAreaCalculator(
                dataset,
                AggregateArea(kind="wholeRaster"),
                RasterAggregateLimits.with_lifecycle(limits),
            )
            if any(node.op == "areaha" for node in walk(root))
            else None
        )
        for _, window in dataset.block_windows(1):
            values = dataset.read(1, window=window, masked=True)
            valid = ~np.ma.getmaskarray(values) & np.isfinite(values.data)
            hectares = area.calculate_hectares(window) if area else None
            calculation.process_tile(
                values.data, valid, hectares, valid if area else None
            )
    result = calculation.result()
    if root.op == "sum" and len(root.args) == 1 and root.args[0].op == "source":
        if not math.isfinite(upstream_total):
            raise ProcessingError(
                "invalid_output",
                "The downstream model returned a nonfinite total.",
                422,
            )
        result.update(value=str(upstream_total), valueType="float", state="ok")
    return result


def describe_output(path: Path, name: str) -> ProducedFile:
    """Describe an unchanged completed upstream raster for ordinary publication.

    Args:
        path: Flat, run-owned output file.
        name: Output name declared by the recipe.

    Returns:
        Measured file size and checksum for the artifact publisher.

    Raises:
        OSError: If the completed output cannot be read.
    """
    with path.open("rb") as stream:
        checksum = hashlib.file_digest(stream, "sha256").hexdigest()
    return ProducedFile(
        name=name,
        storage_name=path.name,
        filename=path.name,
        media_type="image/tiff",
        size=path.stat().st_size,
        sha256=checksum,
    )


def run_original_downstream(
    sources: "DownstreamSources",
    spec: DownstreamPlan,
    directory: Path,
    limits: DownstreamLimits,
    starting: BaseGeometry,
) -> AggregateArtifact:
    """Call the pinned model's existing functions in its original calculation order.

    EOlab supplies authorized inputs and runs the same functions sequentially in
    its supervised native process. No upstream numerical function is replaced or
    patched. Only complete declared files remain for normal artifact publication.

    Args:
        sources: Authorized paths and immutable vector selections.
        spec: Existing admitted calculation and resource reservation.
        directory: Empty private workspace owned by this job attempt.
        limits: Existing input, native-process and storage safeguards.
        starting: Combined starting geometry already checked by admission.

    Returns:
        Statistics and unchanged upstream coverage, masked values and seed rasters.

    Raises:
        ProcessingError: If admission, output or storage limits are exceeded.
        Exception: If an upstream calculation fails; the existing native boundary
            sanitizes the failure before exposing it to the browser.
    """
    from eolab_app.processing.statistics_csv import statistics_csv

    model = load_beneficiaries()
    request = spec.inputs
    working = directory / "upstream"
    working.mkdir()
    write_progress(directory, "preparing_starting_mask", 0, 0)
    aoi, mask = prepare_starting_inputs(sources, spec, starting, working, limits)
    network = write_watershed_view(sources, spec, working)
    partitions = model.partition_subwatersheds_by_terminal_drain(
        aoi,
        network,
        model.choose_equidistant_crs_from_bbox(aoi),
        working / "partitions",
    )
    if len(partitions) > limits.max_terminals:
        raise ProcessingError(
            "model_too_large",
            "The starting area exceeds the configured number of drainage partitions.",
            413,
        )
    # Upstream may follow links beyond EOlab's admission footprint. Check its
    # actual partitions without changing that traversal or clipping its results.
    from shapely.geometry import box
    from eolab_app.processing.downstream_calculation import plan_native_grid

    cells = records = 0
    all_bounds = []
    for vector in partitions.values():
        with fiona.open(vector) as dataset:
            bounds = rasterio.warp.transform_bounds(
                dataset.crs, "EPSG:4326", *dataset.bounds
            )
            records += len(dataset)
        cells += check_calculation_grid(bounds, spec, limits, limits.max_routing_cells)
        all_bounds.append(bounds)
        for name, ceiling in (
            ("dem", limits.max_routing_cells),
            ("values", limits.max_value_cells),
        ):
            with rasterio.open(sources.rasters[name]) as dataset:
                plan_native_grid(dataset, box(*bounds), ceiling, limits)
    if cells > limits.max_routing_cells or records > limits.max_watersheds:
        raise ProcessingError(
            "model_too_large",
            "The upstream drainage partitions exceed the configured work budget.",
            413,
        )
    if all_bounds:
        check_calculation_grid(
            (
                min(b[0] for b in all_bounds),
                min(b[1] for b in all_bounds),
                max(b[2] for b in all_bounds),
                max(b[3] for b in all_bounds),
            ),
            spec,
            limits,
            limits.max_routing_cells,
        )
    radius = request.buffer_m / request.travel_time_pixel_size_m
    if (
        not math.isfinite(radius)
        or (2 * round(radius) + 1) ** 2 > limits.max_routing_cells
    ):
        raise ProcessingError(
            "model_too_large",
            "The buffer exceeds the configured calculation-cell budget. Choose a larger pixel size for distances or a smaller buffer.",
            413,
        )
    coverages = []
    seeds = []
    for index, (identifier, vector) in enumerate(partitions.items()):
        partition = working / identifier
        partition.mkdir()
        dem = str(partition / "dem.tif")
        flow = str(partition / "flow.tif")
        write_progress(directory, "routing_downstream", index, len(partitions))
        model.align_and_resize_raster_on_vector(
            str(sources.rasters["dem"]),
            dem,
            "near",
            [request.wgs84_pixel_size, -request.wgs84_pixel_size],
            vector,
        )
        with rasterio.open(dem) as dataset:
            if dataset.width * dataset.height > limits.max_routing_cells:
                raise ProcessingError(
                    "model_too_large",
                    "The calculation grid exceeds the configured routing-cell limit.",
                    413,
                )
        model.calc_flow_dir(dem, partition, flow)
        coverage = partition / "coverage.tif"
        write_progress(
            directory, "buffering_downstream_coverage", index, len(partitions)
        )
        model.calculate_downstream_coverage_from_conditional_raster(
            vector,
            Path(flow),
            mask,
            "starting",
            "value > 0",
            request.buffer_m,
            request.cutoff_m,
            request.travel_time_pixel_size_m,
            partition,
            coverage,
        )
        coverages.append((identifier, str(coverage)))
        seeds.append((identifier, str(partition / ("mask_starting_" + mask.name))))
    write_progress(directory, "writing_results", 0, 0)
    section = working / "section-coverage.tif"
    model.stitch_coverage_masks(
        coverages, request.wgs84_pixel_size, working / "stitch-section", str(section)
    )
    coverage = directory / "coverage.tif"
    model.stitch_coverage_masks(
        [("starting", str(section))],
        request.wgs84_pixel_size,
        working / "stitch-union",
        str(coverage),
    )
    model.stitch_coverage_masks(
        seeds,
        request.wgs84_pixel_size,
        working / "stitch-seeds",
        str(directory / "starting_mask.tif"),
    )
    write_progress(directory, "summarizing_values", 0, 0)
    masked = directory / "masked_values.tif"
    total = model.mask_population_with_coverage(
        str(sources.rasters["values"]), str(coverage), str(masked)
    )
    rows = [
        {
            "label": request.label,
            "expression": request.summary,
            **summarize_upstream_values(masked, request.summary, total, limits),
        }
    ]
    result = directory / "result.csv"
    result.write_bytes(statistics_csv(rows))
    (directory / "provenance.json").write_text(
        json.dumps(
            {
                "operation": spec.operation,
                "beneficiariesRevision": BENEFICIARIES_REVISION,
                "inputs": request.model_dump(mode="json", by_alias=True),
                "numericalPolicy": {
                    "wgs84PixelSize": request.wgs84_pixel_size,
                    "distancePixelSizeMetres": request.travel_time_pixel_size_m,
                    "bufferMetres": request.buffer_m,
                    "cutoffMetres": request.cutoff_m,
                },
                "upstreamTotal": total,
                "statistics": rows,
                "partitionIds": list(partitions),
            },
            allow_nan=False,
        ),
        encoding="utf-8",
    )
    if (
        sum(path.stat().st_size for path in directory.rglob("*") if path.is_file())
        > spec.reservedBytes
    ):
        raise ProcessingError(
            "output_too_large",
            "Downstream scratch files exceeded the admitted disk reservation.",
            413,
        )
    # The upstream functions have returned and closed their files. Only this
    # attempt's known scratch subtree is removed; publication remains flat.
    if working.resolve().parent != directory.resolve() or working.is_symlink():
        raise ProcessingError(
            "invalid_output", "The downstream workspace changed unexpectedly.", 500
        )
    shutil.rmtree(working)
    outputs = tuple(
        describe_output(directory / (name + ".tif"), name)
        for name in ("coverage", "starting_mask", "masked_values")
    )
    return AggregateArtifact(
        filename="downstream-statistics.csv",
        size=result.stat().st_size,
        sha256=hashlib.sha256(result.read_bytes()).hexdigest(),
        rows=rows,
        additional_outputs=outputs,
    )
