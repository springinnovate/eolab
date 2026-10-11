"""Validate administrator-prepared hydrology data and write an installable report."""

import argparse


def main() -> None:
    """Run catalog-backed validation in the existing supervised native process.

    Sources remain read-only. The command writes a path-free report to the named
    output, which administrators can install in the application's configuration
    directory. Imports stay here so spawned native children do not load CLI or
    application composition.

    Raises:
        SystemExit: With a nonzero status when configuration, sources or budgets fail.
    """
    import asyncio
    from pathlib import Path
    import sys

    parser = argparse.ArgumentParser(
        description="Validate a prepared DEM and watershed network for EOlab models."
    )
    parser.add_argument("configuration", type=Path, help="Administrator hydrology YAML")
    parser.add_argument("--catalog-url", required=True, help="Internal STAC API URL")
    parser.add_argument(
        "--scan-mount",
        type=Path,
        required=True,
        help="Existing read-only catalog source mount",
    )
    parser.add_argument(
        "--output", type=Path, required=True, help="Report ending in .hydrology.json"
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=120,
        help="Whole native validation deadline",
    )
    parser.add_argument(
        "--memory-mib", type=int, default=2048, help="Linux child address-space ceiling"
    )
    parser.add_argument("--max-features", type=int, default=100_000)
    parser.add_argument("--max-coordinates", type=int, default=2_000_000)
    args = parser.parse_args()
    if not args.scan_mount.is_absolute() or not args.scan_mount.is_dir():
        parser.error(
            "--scan-mount must be an existing absolute read-only source directory"
        )
    if args.timeout_seconds <= 0 or args.memory_mib < 512:
        parser.error("Use a positive deadline and at least 512 MiB native memory")
    if not args.output.name.endswith(".hydrology.json"):
        parser.error("--output must end in .hydrology.json")
    try:
        asyncio.run(validate_configuration(args))
    except KeyboardInterrupt:
        parser.exit(130, "Validation cancelled; no report was installed.\n")
    except Exception as error:
        parser.exit(1, f"Hydrology validation failed: {error}\n")
    print(f"Validated configuration written to {args.output}", file=sys.stderr)


async def validate_configuration(args: argparse.Namespace) -> None:
    """Resolve configured catalog sources, validate them and atomically write the report.

    Args:
        args: Parsed administrator paths, catalog URL and positive validation budgets.

    Raises:
        ValueError: If configuration, source data or validation budgets are invalid.
        OSError: If the configuration or output cannot be read/written.
        ProcessDeadlineError: If supervised native work crashes or exceeds its deadline.
    """
    import os
    import tempfile

    import httpx2

    from eolab_app.execution.reusable_process import ReusableProcess
    from eolab_app.processing.model_yaml import parse_yaml, encode_canonical_json
    from eolab_app.processing.prepared_hydrology import (
        PreparedHydrologyDefinition,
        PreparedHydrologySnapshot,
    )
    from eolab_app.processing.hydrology_validation import (
        HydrologyValidationLimits,
        validate_hydrology_process,
    )
    from eolab_app.raster.catalog import StacRasterCatalog
    from eolab_app.raster.source_authorization import CatalogRasterSourceAuthorizer
    from eolab_app.raster.sources import MountedRasterResolver
    from eolab_app.vector.catalog import StacVectorCatalog
    from eolab_app.vector.sources import MountedVectorResolver
    from eolab_app.vector.filters import CatalogVectorFilterRequest, VectorFilter
    from eolab_app.vector.selection_source import resolve_selection

    with args.configuration.open("rb") as source:
        definition = PreparedHydrologyDefinition.model_validate(
            parse_yaml(source.read(64 * 1024 + 1))
        )
    limits = HydrologyValidationLimits(args.max_features, args.max_coordinates)
    async with httpx2.AsyncClient(timeout=30) as client:
        dem = await CatalogRasterSourceAuthorizer(
            StacRasterCatalog(client, args.catalog_url),
            MountedRasterResolver(args.scan_mount),
        ).authorize(definition.dem)
        watersheds = await resolve_selection(
            StacVectorCatalog(client, args.catalog_url),
            MountedVectorResolver(args.scan_mount),
            CatalogVectorFilterRequest(
                **definition.watersheds.model_dump(by_alias=True), filter=VectorFilter()
            ),
        )
    process = ReusableProcess(
        (validate_hydrology_process,),
        startup_seconds=min(30, args.timeout_seconds),
        address_space_bytes=args.memory_mib * 1024**2,
    )
    try:
        success, result = await process.run(
            validate_hydrology_process,
            (definition, dem, watersheds, limits),
            args.timeout_seconds,
        )
    finally:
        await process.close()
    if not success:
        raise ValueError(result)
    report = PreparedHydrologySnapshot.model_validate(result)
    # A complete validated report replaces the old one in one filesystem operation.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=args.output.parent, delete=False
        ) as output:
            temporary = output.name
            output.write(
                encode_canonical_json(report.model_dump(mode="json", by_alias=True))
            )
        os.replace(temporary, args.output)
        temporary = None
    finally:
        if temporary is not None:
            os.unlink(temporary)


if __name__ == "__main__":
    main()
