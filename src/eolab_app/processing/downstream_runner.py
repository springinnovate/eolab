"""Adapt authorized EOlab inputs and outputs to the unchanged WWF model functions."""

import hashlib
from dataclasses import replace
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
    ECOSHARD_REVISION,
    PIT_FILL_TREAT_NODATA_AS_CLOSED,
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
        spec: Field mappings captured from Model YAML.
        directory: Private directory owned by this calculation attempt.

    Returns:
        Run-local VRT path readable by the original model.

    Raises:
        ProcessingError: If the configuration cannot represent HydroBASINS links.
        SelectionUnavailableError: If the watershed source changed.
        OSError: If the private view cannot be written.
    """
    sources.network.require_current()
    topology = spec.inputs.hydrology_sources.topology
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
        limits: Shared job lifecycle settings; rasterization uses the requested grid.

    Returns:
        AOI GeoJSON path and original or rasterized starting-mask path.

    Raises:
        ProcessingError: If rasterization cannot create a nonempty grid.
        OSError: If the prepared AOI cannot be written.
    """
    from osgeo import gdal

    starting_area_path = directory / "starting-area.geojson"
    starting_area_path.write_text(
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
        return starting_area_path, sources.rasters["starting_mask"]
    starting_mask_path = directory / "starting-mask.tif"
    starting_mask_dataset = gdal.Rasterize(
        str(starting_mask_path),
        str(starting_area_path),
        format="GTiff",
        outputSRS="EPSG:4326",
        xRes=spec.inputs.wgs84_pixel_size,
        yRes=spec.inputs.wgs84_pixel_size,
        burnValues=[1],
        noData=0,
        outputType=gdal.GDT_Byte,
        creationOptions=["TILED=YES", "COMPRESS=LZW", "BIGTIFF=YES"],
    )
    if (
        starting_mask_dataset is None
        or starting_mask_dataset.RasterXSize < 1
        or starting_mask_dataset.RasterYSize < 1
    ):
        raise ProcessingError(
            "empty_starting_mask",
            "The starting area is smaller than the selected calculation pixel size.",
            422,
        )
    starting_mask_dataset = None
    return starting_area_path, starting_mask_path


def summarize_downstream_covered_values(
    covered_values_path: Path,
    expression: str,
    original_model_sum: float,
    limits: DownstreamLimits,
) -> dict[str, Any]:
    """Summarize raster values inside the downstream coverage produced by the WWF model.

    ``sum(a)`` reports the exact float returned by the original model. Optional
    formulas are explicitly postprocessing: they read the model's output grid
    and NoData convention without changing its coverage or masked values.

    Args:
        covered_values_path: Complete values raster masked by downstream coverage.
        expression: Validated EOlab scalar formula.
        original_model_sum: Sum returned by ``mask_population_with_coverage``.
        limits: Shared job lifecycle and area-measurement settings.

    Returns:
        Ordinary Processing statistics fields, including coverage counts.

    Raises:
        ProcessingError: If the upstream result is nonfinite or a formula fails.
        RasterioError: If the completed raster cannot be read.
    """
    root = compile_expression(expression, "a")
    calculation = Calculation(root)
    with rasterio.open(covered_values_path) as dataset:
        pixel_area_calculator = (
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
            valid_covered_pixels = ~np.ma.getmaskarray(values) & np.isfinite(
                values.data
            )
            hectares = (
                pixel_area_calculator.calculate_hectares(window)
                if pixel_area_calculator
                else None
            )
            calculation.process_tile(
                values.data,
                valid_covered_pixels,
                hectares,
                valid_covered_pixels if pixel_area_calculator else None,
            )
    result = calculation.result()
    if root.op == "sum" and len(root.args) == 1 and root.args[0].op == "source":
        if not math.isfinite(original_model_sum):
            raise ProcessingError(
                "invalid_output",
                "The downstream model returned a nonfinite total.",
                422,
            )
        result.update(value=str(original_model_sum), valueType="float", state="ok")
    return result


def describe_downstream_raster_output(path: Path, name: str) -> ProducedFile:
    """Measure a completed downstream raster's size and checksum for result publication.

    Args:
        path: Flat, run-owned output file.
        name: Scientific output name declared by the registered operation.

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
    patched. Pit filling ignores NoData exits using the saved pit-search cutoff;
    subsequent MFD routing is unchanged. Only complete declared files remain for
    normal artifact publication. Routing and coverage progress counts completed
    terminal drainage groups.

    Args:
        sources: Authorized paths and immutable vector selections.
        spec: Captured calculation inputs and source identities.
        directory: Empty private workspace owned by this job attempt.
        limits: Shared job lifecycle settings.
        starting: Combined starting geometry already checked by admission.

    Returns:
        Statistics and unchanged upstream coverage, masked values, seed rasters
        and one pit-filled routing DEM per terminal drainage group.

    Raises:
        ProcessingError: If input adaptation or completed output validation fails.
        Exception: If an upstream calculation fails; the existing native boundary
            sanitizes the failure before exposing it to the browser.
    """
    from eolab_app.processing.statistics_csv import statistics_csv

    beneficiaries_model = load_beneficiaries()
    model_inputs = spec.inputs
    model_working_directory = directory / "upstream"
    model_working_directory.mkdir()
    write_progress(directory, "preparing_starting_mask", 0, 0)
    starting_area_path, starting_mask_path = prepare_starting_inputs(
        sources, spec, starting, model_working_directory, limits
    )
    watershed_view_path = write_watershed_view(sources, spec, model_working_directory)
    try:
        watershed_partitions_by_sink = (
            beneficiaries_model.partition_subwatersheds_by_terminal_drain(
                starting_area_path,
                watershed_view_path,
                beneficiaries_model.choose_equidistant_crs_from_bbox(
                    starting_area_path
                ),
                model_working_directory / "partitions",
            )
        )
    except Exception as error:
        raise ProcessingError(
            "watershed_read_failed",
            "The model could not read or process its configured watershed layer. Check the source and field mappings in Model YAML.",
            422,
        ) from error
    partition_coverage_paths = []
    partition_starting_mask_paths = []
    routing_dem_outputs: list[ProducedFile] = []
    for index, (identifier, partition_vector_path) in enumerate(
        watershed_partitions_by_sink.items()
    ):
        partition_directory = model_working_directory / identifier
        partition_directory.mkdir()
        partition_dem_path = str(partition_directory / "dem.tif")
        flow_direction_path = str(partition_directory / "flow.tif")
        write_progress(
            directory,
            "routing_downstream",
            index,
            len(watershed_partitions_by_sink),
            unit="drainage groups",
        )
        try:
            beneficiaries_model.align_and_resize_raster_on_vector(
                str(sources.rasters["dem"]),
                partition_dem_path,
                "near",
                [model_inputs.wgs84_pixel_size, -model_inputs.wgs84_pixel_size],
                partition_vector_path,
            )
        except Exception as error:
            raise ProcessingError(
                "dem_read_failed",
                "The model could not read or process its configured DEM. Check the source in Model YAML.",
                422,
            ) from error
        beneficiaries_model.calc_flow_dir(
            partition_dem_path,
            partition_directory,
            flow_direction_path,
            max_pixel_fill_count=spec.pit_fill_search_limit,
            treat_nodata_as_closed=PIT_FILL_TREAT_NODATA_AS_CLOSED,
        )
        partition_downstream_coverage_path = partition_directory / "coverage.tif"
        write_progress(
            directory,
            "buffering_downstream_coverage",
            index,
            len(watershed_partitions_by_sink),
            unit="drainage groups",
        )
        beneficiaries_model.calculate_downstream_coverage_from_conditional_raster(
            partition_vector_path,
            Path(flow_direction_path),
            starting_mask_path,
            "starting",
            "value > 0",
            model_inputs.buffer_m,
            model_inputs.cutoff_m,
            model_inputs.travel_time_pixel_size_m,
            partition_directory,
            partition_downstream_coverage_path,
        )
        partition_coverage_paths.append(
            (identifier, str(partition_downstream_coverage_path))
        )
        partition_starting_mask_paths.append(
            (
                identifier,
                str(partition_directory / ("mask_starting_" + starting_mask_path.name)),
            )
        )
        # calc_flow_dir routes this exact pit-filled file. Keep separate grids
        # for each drainage; a mosaic would resample or hide overlapping edges.
        routing_dem_name = f"routing_dem_{identifier}"
        retained_routing_dem_path = directory / f"{routing_dem_name}.tif"
        (partition_directory / "pit_filled_dem.tif").replace(retained_routing_dem_path)
        routing_dem_outputs.append(
            replace(
                describe_downstream_raster_output(
                    retained_routing_dem_path, routing_dem_name
                ),
                output_name="routing_dem",
                member_label=f"Drain {identifier.removeprefix('drain_')}",
            )
        )
    write_progress(directory, "writing_results", 0, 0)
    combined_partition_coverage_path = model_working_directory / "section-coverage.tif"
    beneficiaries_model.stitch_coverage_masks(
        partition_coverage_paths,
        model_inputs.wgs84_pixel_size,
        model_working_directory / "stitch-section",
        str(combined_partition_coverage_path),
    )
    downstream_coverage_path = directory / "coverage.tif"
    beneficiaries_model.stitch_coverage_masks(
        [("starting", str(combined_partition_coverage_path))],
        model_inputs.wgs84_pixel_size,
        model_working_directory / "stitch-union",
        str(downstream_coverage_path),
    )
    beneficiaries_model.stitch_coverage_masks(
        partition_starting_mask_paths,
        model_inputs.wgs84_pixel_size,
        model_working_directory / "stitch-seeds",
        str(directory / "starting_mask.tif"),
    )
    write_progress(directory, "summarizing_values", 0, 0)
    downstream_covered_values_path = directory / "masked_values.tif"
    original_model_sum = beneficiaries_model.mask_population_with_coverage(
        str(sources.rasters["values"]),
        str(downstream_coverage_path),
        str(downstream_covered_values_path),
    )
    statistics_rows = [
        {
            "label": model_inputs.label,
            "expression": model_inputs.summary,
            **summarize_downstream_covered_values(
                downstream_covered_values_path,
                model_inputs.summary,
                original_model_sum,
                limits,
            ),
        }
    ]
    statistics_csv_path = directory / "result.csv"
    statistics_csv_path.write_bytes(statistics_csv(statistics_rows))
    (directory / "provenance.json").write_text(
        json.dumps(
            {
                "operation": spec.operation,
                "beneficiariesRevision": BENEFICIARIES_REVISION,
                "ecoshardRevision": ECOSHARD_REVISION,
                "inputs": model_inputs.model_dump(mode="json", by_alias=True),
                "watershedSelection": spec.watershed_selection.model_dump(
                    mode="json", by_alias=True
                ),
                "numericalPolicy": {
                    "pitFillSearchLimit": spec.pit_fill_search_limit,
                    "pitFillTreatNodataAsClosed": PIT_FILL_TREAT_NODATA_AS_CLOSED,
                    "wgs84PixelSize": model_inputs.wgs84_pixel_size,
                    "distancePixelSizeMetres": model_inputs.travel_time_pixel_size_m,
                    "bufferMetres": model_inputs.buffer_m,
                    "cutoffMetres": model_inputs.cutoff_m,
                },
                "upstreamTotal": original_model_sum,
                "statistics": statistics_rows,
                "partitionIds": list(watershed_partitions_by_sink),
            },
            allow_nan=False,
        ),
        encoding="utf-8",
    )
    # The upstream functions have returned and closed their files. Only this
    # attempt's known scratch subtree is removed; publication remains flat.
    if (
        model_working_directory.resolve().parent != directory.resolve()
        or model_working_directory.is_symlink()
    ):
        raise ProcessingError(
            "invalid_output", "The downstream workspace changed unexpectedly.", 500
        )
    shutil.rmtree(model_working_directory)
    raster_outputs = tuple(
        describe_downstream_raster_output(directory / (name + ".tif"), name)
        for name in ("coverage", "starting_mask", "masked_values")
    )
    return AggregateArtifact(
        filename="downstream-statistics.csv",
        size=statistics_csv_path.stat().st_size,
        sha256=hashlib.sha256(statistics_csv_path.read_bytes()).hexdigest(),
        rows=statistics_rows,
        additional_outputs=(*raster_outputs, *routing_dem_outputs),
    )
