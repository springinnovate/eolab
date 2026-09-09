"""Bounded exact-source polygon extraction, independent of publication."""

from time import monotonic
import sys

import fiona

from eolab_app.bounded_geometry import GeometryBuilder, GeometryValidationError
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.filters import VectorFilter, matches_filter, validate_filter
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sources import vector_source_signature

MAX_SCANNED_FEATURES = 1_000_000
GEOMETRY_READ_SECONDS = 15.0
GEOMETRY_ADDRESS_SPACE_BYTES = 2 * 1024 * 1024 * 1024


def read_filtered_geometry(source: ResolvedVectorSource, candidate: VectorFilter, signature: tuple) -> dict:
    """Read every matching polygon from one unchanged authoritative source.

    Args:
        source: Catalog-resolved mounted source and exact native layer.
        candidate: Catalog-validated typed predicate.
        signature: Exact component identity captured before admission.

    Returns:
        Complete bounded collection, bounds and exact matched/total counts.

    Raises:
        GeometryValidationError: If the complete selection cannot fit the budget.
        VectorConflictError: If source identity or fields have changed.
    """
    if source.source_format not in {"shapefile", "geopackage"} or source.source_path is None:
        raise GeometryValidationError("Sampling currently supports mounted Shapefile and GeoPackage polygon layers")
    if vector_source_signature(source) != signature:
        raise VectorConflictError("Vector source changed; refresh the layer before sampling")
    options = {"enabled_drivers": ["GPKG" if source.source_format == "geopackage" else "ESRI Shapefile"]}
    if source.layer_name is not None:
        options["layer"] = source.layer_name
    builder = GeometryBuilder(polygons_only=True)
    total = matched = 0
    deadline = monotonic() + GEOMETRY_READ_SECONDS
    with fiona.Env(OGR_CT_FORCE_TRADITIONAL_GIS_ORDER="YES"):
        with fiona.open(source.source_path, **options) as dataset:
            validate_filter(candidate, dataset.schema.get("properties", {}))
            if not dataset.crs:
                raise GeometryValidationError("The vector source has no coordinate reference system")
            for feature in dataset:
                total += 1
                if total > MAX_SCANNED_FEATURES or monotonic() > deadline:
                    raise GeometryValidationError("The complete selection exceeds the scan budget; use a smaller source layer")
                if not matches_filter(candidate, feature.properties):
                    continue
                matched += 1
                builder.add(dict(feature.geometry.__geo_interface__) if feature.geometry else None, dataset.crs)
    geometry, bounds = builder.finish()
    if vector_source_signature(source) != signature:
        raise VectorConflictError("Vector source changed during sampling; refresh the layer")
    return {"geometry": geometry, "bbox": bounds, "matched": matched, "total": total}


def geometry_process(writer, source: ResolvedVectorSource, candidate: VectorFilter, signature: tuple) -> None:
    """Deliver a bounded result or sanitized failure from the native child.

    Args:
        writer: Supervisor-owned result channel.
        source: Authorized source.
        candidate: Validated filter.
        signature: Expected exact source identity.
    """
    try:
        if sys.platform == "linux":
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (GEOMETRY_ADDRESS_SPACE_BYTES, GEOMETRY_ADDRESS_SPACE_BYTES))
        writer.put((True, read_filtered_geometry(source, candidate, signature)))
    except (GeometryValidationError, VectorConflictError) as error:
        writer.put((False, str(error)))
    except (fiona.errors.FionaError, OSError, ValueError, TypeError, MemoryError):
        writer.put((False, "The selected vector geometry could not be read safely"))
