"""Convert files or glob matches to EPSG:3857 Cloud Optimized GeoTIFFs.

Run with a Python environment containing GDAL's osgeo bindings. Each input must
have one georeferenced data band. Existing outputs are skipped without opening
them; GDAL chooses the output pixel size and retains the source data type.
"""

import argparse
from glob import glob
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from osgeo import gdal


def expand_inputs(patterns: list[str]) -> list[Path]:
    """Expand filenames and glob patterns into distinct, ordered input paths.

    Args:
        patterns: Literal filenames or glob patterns, including recursive **.

    Returns:
        Absolute file paths, preserving argument order and sorting each glob.

    Raises:
        ValueError: If an argument matches no files or identifies a directory.
        OSError: If a filesystem path cannot be resolved.
    """
    inputs: dict[Path, None] = {}
    for pattern in patterns:
        literal = Path(pattern).expanduser()
        matches = (
            [literal]
            if literal.exists()
            else [Path(match) for match in sorted(glob(str(literal), recursive=True))]
        )
        if not matches:
            raise ValueError(f"No files matched: {pattern}")
        for path in matches:
            if not path.is_file():
                raise ValueError(f"Not a file: {path}")
            inputs[path.resolve()] = None
    return list(inputs)


def prepare_raster(source_path: Path, output_path: Path, resampling: str) -> None:
    """Reproject one raster and publish its completed COG in the destination.

    Data and validity are warped together, then the validity band is stored as
    an internal mask so the output still has one data band. Temporary VRTs read
    original pixels on demand; no full intermediate raster is written.

    Args:
        source_path: Single-band georeferenced raster to read.
        output_path: Absent output filename in an existing writable directory.
        resampling: GDAL method used for reprojection and overviews.

    Raises:
        ValueError: If the input has multiple bands or no coordinate system.
        RuntimeError: If GDAL cannot read, reproject or encode the raster.
        OSError: If temporary files or the finished output cannot be written.
    """
    with (
        gdal.ExceptionMgr(),
        gdal.config_option("GDAL_TIFF_INTERNAL_MASK", "YES"),
        gdal.Open(str(source_path)) as source,
        TemporaryDirectory(
            prefix=".prepare-raster-", dir=output_path.parent
        ) as temporary,
    ):
        if source.RasterCount != 1:
            raise ValueError(
                "Expected one data band; select a band before preparing this raster."
            )
        if not source.GetSpatialRef():
            raise ValueError(
                "The raster has no coordinate system; assign its correct CRS first."
            )
        scratch = Path(temporary)
        # An explicit alpha source makes GDAL honor an embedded mask even when
        # the data band also declares NoData. Zero-valued data stays valid.
        with gdal.Translate(
            str(scratch / "source.vrt"),
            source,
            format="VRT",
            bandList=[1, "mask"],
            colorInterpretation=["gray", "alpha"],
        ) as masked_source:
            with gdal.Warp(
                str(scratch / "projected.vrt"),
                masked_source,
                format="VRT",
                dstSRS="EPSG:3857",
                srcAlpha=True,
                dstAlpha=True,
                srcNodata=source.GetRasterBand(1).GetNoDataValue(),
                dstNodata=source.GetRasterBand(1).GetNoDataValue(),
                resampleAlg=resampling,
                overviewLevel="NONE",
                warpOptions=["SRC_ALPHA_MAX=255", "DST_ALPHA_MAX=255"],
            ) as projected:
                staged_output = scratch / output_path.name
                with gdal.Translate(
                    str(staged_output),
                    projected,
                    format="COG",
                    bandList=[1],
                    maskBand=2,
                    creationOptions=[
                        "COMPRESS=DEFLATE",
                        "BLOCKSIZE=512",
                        "BIGTIFF=IF_SAFER",
                        "PREDICTOR=YES",
                        f"OVERVIEW_RESAMPLING={resampling.upper()}",
                    ],
                ):
                    pass
        # Linking the completed file publishes it without replacing a target
        # another invocation may have created while this conversion was running.
        output_path.hardlink_to(staged_output)


def main(arguments: list[str] | None = None) -> int:
    """Prepare a batch of rasters, skipping existing outputs and reporting failures.

    Args:
        arguments: CLI arguments, or None to read the process command line.

    Returns:
        Zero when every file was converted or skipped, one for conversion
        failures, or 130 when the user interrupts the batch.

    Raises:
        SystemExit: For --help, invalid arguments, unmatched inputs or conflicting
            output names. Input errors are reported before conversion begins.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "inputs", nargs="+", help="Raster files or quoted glob patterns."
    )
    parser.add_argument(
        "--destination", "-d", required=True, type=Path, help="Output folder."
    )
    parser.add_argument(
        "--resampling",
        choices=("nearest", "bilinear", "cubic", "average", "mode"),
        default="nearest",
        help="Reprojection and overview method (default: nearest).",
    )
    args = parser.parse_args(arguments)
    try:
        inputs = expand_inputs(args.inputs)
        destination = args.destination.expanduser().resolve()
        outputs: dict[Path, Path] = {}
        for source in inputs:
            output = destination / f"{source.stem}_cog_epsg3857.tif"
            if output in outputs:
                raise ValueError(
                    f"Output name collision: {outputs[output]} and {source} both produce {output.name}"
                )
            outputs[output] = source
        destination.mkdir(parents=True, exist_ok=True)
    except (ValueError, OSError) as error:
        parser.error(str(error))

    converted = skipped = failed = 0
    try:
        for index, (output, source) in enumerate(outputs.items(), start=1):
            if output.exists():
                print(f"Skip existing: {output}", flush=True)
                skipped += 1
                continue
            print(
                f"[{index}/{len(outputs)}] Converting {source} -> {output}", flush=True
            )
            try:
                prepare_raster(source, output, args.resampling)
                converted += 1
            except FileExistsError:
                print(f"Skip existing: {output}", flush=True)
                skipped += 1
            except (RuntimeError, ValueError, OSError) as error:
                print(f"Failed: {source}: {error}", file=sys.stderr, flush=True)
                failed += 1
    except KeyboardInterrupt:
        print(
            "Interrupted. Completed outputs are kept; rerun to continue.",
            file=sys.stderr,
        )
        return 130
    print(f"Converted: {converted}; skipped: {skipped}; failed: {failed}.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
