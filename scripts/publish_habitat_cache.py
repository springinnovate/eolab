"""Publish named Ecosystem Condition variables from an exported tile cache as catalog rasters."""

import argparse
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from importlib.resources import as_file, files
import json
from pathlib import Path
import re
import shutil
from tempfile import TemporaryDirectory
from uuid import uuid4

from nhi_terrestrial_integrity_modeling.analysis_config import (
    RasterStackConfiguration,
    load_raster_stack_configuration,
)
from osgeo import gdal


def installed_stacks() -> dict[str, RasterStackConfiguration]:
    """Load the scientific settings used to label published maps.

    Returns:
        Stack definitions indexed by their original cache configuration digest.

    Raises:
        OSError: The installed scientific configuration cannot be read.
        ValueError: The scientific configuration is invalid.
    """
    resource = files("nhi_terrestrial_integrity_modeling.config").joinpath(
        "south_africa_reference_condition_analysis.toml"
    )
    with as_file(resource) as path:
        default = load_raster_stack_configuration(path)
        stacks = (
            load_raster_stack_configuration(path, year=year)
            for year in range(default.minimum_year, default.maximum_year + 1)
        )
        return {stack.raster_configuration_sha256: stack for stack in stacks}


@contextmanager
def publication_staging(parent: Path) -> Iterator[Path]:
    """Stage files on the destination filesystem with normal inherited access rights.

    Args:
        parent: Directory whose ACLs should apply to files after they are renamed.

    Yields:
        New staging directory removed after publication or failure.

    Raises:
        OSError: The staging directory cannot be created or cleaned up.
    """
    staging = parent / f".publishing-{uuid4().hex}"
    staging.mkdir()
    try:
        yield staging
    finally:
        shutil.rmtree(staging)


def prepare_stack_folder(
    destination: Path, stack: RasterStackConfiguration, tiles: list[Path]
) -> Path:
    """Create or resume the output folder for one immutable set of tile coordinates.

    Args:
        destination: Root for published mosaics.
        stack: Scientific configuration identified by the source cache directory.
        tiles: Completed tile files in deterministic order.

    Returns:
        Folder for completed catalog GeoTIFFs.

    Raises:
        ValueError: An existing output belongs to a different snapshot.
        OSError: The destination cannot be created or read.
    """
    folder = (
        destination
        / f"ecosystem-condition-{stack.year}-{stack.raster_configuration_sha256[:12]}"
    )
    inventory = {
        "configuration": stack.raster_configuration_sha256,
        "tiles": [tile.parent.name for tile in tiles],
    }
    if not folder.exists():
        with publication_staging(destination) as temp:
            staged = temp / "stack"
            staged.mkdir()
            (staged / "tiles.json").write_text(json.dumps(inventory), encoding="utf-8")
            try:
                staged.rename(folder)
            except OSError:
                if not folder.is_dir():
                    raise
    if json.loads((folder / "tiles.json").read_text(encoding="utf-8")) != inventory:
        raise ValueError(
            f"Tile coverage changed for {stack.year}. Choose a new output folder for this snapshot."
        )
    return folder


def publish_stack(
    tiles: list[Path], stack: RasterStackConfiguration, destination: Path
) -> None:
    """Publish one lossless, single-band map for each configured predictor and response.

    Args:
        tiles: Completed, aligned multiband cache tiles for this stack.
        stack: Scientific definitions for the exact source configuration.
        destination: Catalog data directory, separate from the cache.

    Raises:
        ValueError: Published coverage differs or tile bands do not match the stack.
        RuntimeError: GDAL cannot read a source or finish a mosaic.
        OSError: The destination cannot be written.
    """
    bands = {
        name: band
        for name, band in zip(stack.band_names(), stack.bands, strict=True)
        if band.role in ("predictor", "response")
    }
    with gdal.Open(str(tiles[0])) as sample:
        names = [
            sample.GetRasterBand(i).GetDescription()
            for i in range(1, sample.RasterCount + 1)
        ]
    if names != list(bands):
        raise ValueError(
            f"Stored band descriptions differ from the installed {stack.year} configuration."
        )

    folder = prepare_stack_folder(destination, stack, tiles)
    print(f"{stack.year}: {len(tiles)} tiles, {len(names)} variables", flush=True)
    with ExitStack() as resources:
        mosaic = None
        for index, (name, band) in enumerate(bands.items(), 1):
            # The scientific identifier is stable even where the stored suffix was truncated.
            target = folder / f"{name}.tif"
            if target.exists():
                print(f"  [{index}/{len(names)}] Already published {name}", flush=True)
                continue
            print(f"  [{index}/{len(names)}] Writing {band.display_name}", flush=True)
            if mosaic is None:
                scratch = resources.enter_context(TemporaryDirectory())
                mosaic = resources.enter_context(
                    gdal.BuildVRT(
                        str(Path(scratch) / "stack.vrt"),
                        [str(tile) for tile in tiles],
                        options=gdal.BuildVRTOptions(strict=True, VRTNodata="nan"),
                    )
                )
            title = f"{band.display_name} (assessment year {stack.year})"
            mosaic.GetRasterBand(index).SetDescription(band.display_name)
            with publication_staging(folder) as temp:
                # Catalog discovery only sees the final .tif after GDAL closes it.
                partial = temp / "mosaic.partial"
                with gdal.Translate(
                    str(partial),
                    mosaic,
                    format="COG",
                    bandList=[index],
                    metadataOptions=[
                        f"EOLAB_TITLE={title}",
                        f"TIFFTAG_IMAGEDESCRIPTION=Prepared Ecosystem Condition {band.role} for assessment year {stack.year}.",
                    ],
                    creationOptions=[
                        "COMPRESS=DEFLATE",
                        "BIGTIFF=IF_SAFER",
                        "BLOCKSIZE=512",
                        (
                            "RESAMPLING=NEAREST"
                            if band.data_type != "continuous"
                            else "RESAMPLING=AVERAGE"
                        ),
                    ],
                ):
                    pass
                partial.replace(target)


def publish_cache(cache: Path, destination: Path) -> None:
    """Discover complete stacks and publish every available variable and assessment year.

    Args:
        cache: Extracted habitat-cache root, with its original namespace directories.
        destination: Separate directory for searchable GeoTIFFs; reruns resume there.

    Raises:
        ValueError: No tiles were found, source metadata is invalid, or a scientific
            configuration is missing from the installed model package.
        OSError: Source or publication files could not be accessed.
        RuntimeError: GDAL could not complete a raster operation.
    """
    cache = cache.resolve(strict=True)
    destination = destination.resolve()
    if cache.is_relative_to(destination) or destination.is_relative_to(cache):
        raise ValueError(
            "Use separate source and output folders so the scan excludes raw tiles."
        )
    known = installed_stacks()
    pending = []
    for namespace in sorted(cache.iterdir()):
        if not re.fullmatch(r"[a-f0-9]{64}", namespace.name) or not namespace.is_dir():
            continue
        tiles = sorted(
            entry / "tile.tif"
            for entry in namespace.iterdir()
            if re.fullmatch(r"-?\d+_-?\d+", entry.name)
            and (entry / "tile.tif").is_file()
        )
        if not tiles:
            continue
        if namespace.name not in known:
            raise ValueError(
                f"Unknown cache configuration {namespace.name}. Use the scientific package that produced this export."
            )
        stack = known[namespace.name]
        metadata = namespace / "configuration.json"
        if metadata.exists():
            record = json.loads(metadata.read_text(encoding="utf-8"))
            if (
                not isinstance(record, dict)
                or record.get("configuration_sha256") != namespace.name
                or record.get("year") != stack.year
            ):
                raise ValueError(
                    f"Cache metadata disagrees with the scientific configuration in {namespace.name}."
                )
        pending.append((stack.year, tiles, stack))
    if not pending:
        raise ValueError(
            f"No completed Ecosystem Condition cache tiles found in {cache}."
        )
    destination.mkdir(parents=True, exist_ok=True)
    with gdal.ExceptionMgr(), gdal.config_option("GDAL_PAM_ENABLED", "NO"):
        for _, tiles, stack in sorted(pending, key=lambda item: item[0]):
            publish_stack(tiles, stack, destination)


def main() -> None:
    """Read the cache and output directory arguments and publish all available stacks.

    Raises:
        SystemExit: The arguments are invalid or publication cannot finish.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path, help="Extracted habitat-cache folder")
    parser.add_argument(
        "destination",
        type=Path,
        help="Separate output folder on the catalog data mount",
    )
    args = parser.parse_args()
    try:
        publish_cache(args.cache, args.destination)
    except (OSError, RuntimeError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
