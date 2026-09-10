"""Exact large selections survive display reduction and real analysis boundaries."""

import asyncio
import json
import math
from pathlib import Path
from typing import Any
from time import perf_counter

import fiona
import numpy as np
import pytest
import rasterio
from rasterio.features import geometry_mask
from rasterio.transform import from_origin
from shapely import get_num_coordinates
from shapely.geometry import Polygon, box, mapping, shape

from eolab_app.bounded_geometry import GeometryBuilder, GeometryValidationError
from eolab_app.processing.aggregate_models import AggregateArea
from eolab_app.processing.clip_models import RasterClipLimits
from eolab_app.processing.raster_aggregate import create_aggregate
from eolab_app.processing.service import ProcessingService
from eolab_app.raster.statistics import read_raster_statistics
from eolab_app.raster.paired_statistics import read_raster_paired_statistics
from eolab_app.sampling_area import TemporaryAoiSamplingArea
from eolab_app.temporary_aoi.errors import TemporaryAoiConflictError
from eolab_app.temporary_aoi.service import TemporaryAoiService
from eolab_app.vector.display_geometry import (
    MAX_DISPLAY_BYTES,
    MAX_DISPLAY_COORDINATES,
    display_geometry,
)
from eolab_app.vector.filters import CatalogVectorFilterRequest, VectorFilter
from eolab_app.vector.geometry import read_filtered_geometry
from eolab_app.vector.models import ResolvedVectorSource
from eolab_app.vector.sampling import VectorSamplingService
from eolab_app.vector.sources import vector_source_signature
from test_raster_aggregates import LIMITS, make_spec
from test_raster_clips import write_source

# Affine 3 emits this pending migration warning once per transformed vertex;
# recording millions of copies obscures geometry performance and wastes memory.
pytestmark = pytest.mark.filterwarnings(
    "ignore:Use .* matmul instead of .* mul operator for matrix multiplication:PendingDeprecationWarning"
)


@pytest.fixture
def detailed_source(tmp_path: Path) -> ResolvedVectorSource:
    """Write a valid detailed coastline and hole exceeding both old display caps.

    Args:
        tmp_path: Isolated source directory.

    Returns:
        Mounted GeoPackage fixture with an exact typed selection field.
    """
    ring = []
    for index in range(120_000):
        angle = index * math.tau / 120_000
        radius = 4 + 0.008 * math.sin(7000 * angle)
        ring.append((5 + radius * math.cos(angle), 5 + radius * math.sin(angle)))
    ring.append(ring[0])
    polygon = Polygon(ring, [[(4, 4), (4, 6), (6, 6), (6, 4), (4, 4)]])
    assert polygon.is_valid
    path = tmp_path / "detailed.gpkg"
    with fiona.open(
        path,
        "w",
        driver="GPKG",
        layer="areas",
        crs="EPSG:4326",
        schema={"geometry": "Polygon", "properties": {"name": "str"}},
    ) as dataset:
        dataset.write(
            {"geometry": mapping(polygon), "properties": {"name": "selected"}}
        )
        dataset.write(
            {
                "geometry": mapping(box(20, 20, 21, 21)),
                "properties": {"name": "excluded"},
            }
        )
    return ResolvedVectorSource("mounted", "geopackage", path, "data", "areas")


def test_large_filtered_selection_keeps_exact_histogram_and_summary_masks(
    detailed_source: ResolvedVectorSource,
    tmp_path: Path,
) -> None:
    """Exercise the supervised selector, lifecycle, job snapshot and native masks.

    Args:
        detailed_source: Valid source exceeding 2 MiB and 100,000 coordinates.
        tmp_path: Isolated raster and lifecycle directory.
    """

    class Catalog:
        """Provide catalog authority without publication or rendering state."""

        async def get_item(self, request: Any) -> dict:
            """Return fields for the requested source.

            Args:
                request: Validated catalog selection.

            Returns:
                Minimal authoritative item metadata.
            """
            return {
                "id": request.item_id,
                "properties": {"table:columns": [{"name": "name", "type": "str"}]},
            }

    class Resolver:
        """Resolve the exact test catalog source."""

        def resolve(self, item: dict) -> ResolvedVectorSource:
            """Return the mounted fixture.

            Args:
                item: Authorized catalog item.

            Returns:
                Exact mounted source.
            """
            return detailed_source

    async def scenario() -> None:
        """Compare every numeric boundary against exact source masks."""
        lifecycle = TemporaryAoiService(tmp_path / "retained")
        try:
            selector = VectorSamplingService(
                Catalog(), Resolver(), lifecycle.retain_geometry
            )
            request = CatalogVectorFilterRequest(
                collectionId="eolab-mounted-vectors",
                itemId="areas",
                filter=VectorFilter.model_validate(
                    {
                        "rules": [
                            {"field": "name", "operator": "eq", "value": "selected"}
                        ]
                    }
                ),
            )
            started = perf_counter()
            response = await selector.select(request)
            selection_seconds = perf_counter() - started
            resolved = await lifecycle.resolve_for_sampling(response["id"])
            exact = [value.as_geojson() for value in resolved.geometries]
            assert len(json.dumps(exact).encode()) > 2 * 1024**2
            assert (
                sum(int(get_num_coordinates(shape(value))) for value in exact) > 100_000
            )
            assert response["matched"] == 1 and response["total"] == 2
            assert "displayGeometry" not in response
            assert (
                len(json.dumps(response["geometry"], separators=(",", ":")).encode())
                <= MAX_DISPLAY_BYTES
            )
            assert response["bbox"] == resolved.bounds
            assert len(exact[0]["coordinates"]) == 2
            values = np.arange(256**2, dtype="int32").reshape(256, 256)
            transform = from_origin(0, 10, 10 / 256, 10 / 256)
            path = write_source(tmp_path / "raster.tif", values, transform=transform)
            exact_mask = geometry_mask(
                exact, out_shape=values.shape, transform=transform, invert=True
            )
            display_mask = geometry_mask(
                [feature["geometry"] for feature in response["geometry"]["features"]],
                out_shape=values.shape,
                transform=transform,
                invert=True,
            )
            # This must be boundary-sensitive: substituting the outline is wrong.
            assert np.any(display_mask != exact_mask)
            area = TemporaryAoiSamplingArea(resolved)
            started = perf_counter()
            statistics = read_raster_statistics(path, area)
            histogram_seconds = perf_counter() - started
            # Compare the histogram's own established inclusion/grid policy with
            # an independently retained exact source, rather than assuming it
            # uses Processing's cell-center inclusion.
            candidate = request.filter
            source_result = read_filtered_geometry(
                detailed_source, candidate, vector_source_signature(detailed_source)
            )
            baseline = await lifecycle.retain_geometry(
                source_result["geometry"], source_result["bbox"], "baseline"
            )
            baseline_statistics = read_raster_statistics(
                path, TemporaryAoiSamplingArea(baseline)
            )
            assert statistics.histogram == baseline_statistics.histogram
            paired = read_raster_paired_statistics(path, path, None, temporary_aoi=area)
            baseline_paired = read_raster_paired_statistics(
                path, path, None, temporary_aoi=TemporaryAoiSamplingArea(baseline)
            )
            assert paired.histogram == baseline_paired.histogram
            # Real Processing snapshot serialization enforces the unchanged 8 MiB cap.
            processing = ProcessingService(
                None, lifecycle, None, None, RasterClipLimits()
            )
            snapshot = await processing._area_snapshot(None, response["id"])
            assert snapshot["geometries"] == tuple(exact)
            spec = make_spec(path, ["count(a)", "sum(a)"], AggregateArea(**snapshot))
            started = perf_counter()
            artifact = create_aggregate(path, spec, tmp_path, LIMITS)
            summary_seconds = perf_counter() - started
            assert float(artifact.rows[0]["value"]) == exact_mask.sum()
            assert float(artifact.rows[1]["value"]) == values[exact_mask].sum()
            print(
                json.dumps(
                    {
                        "exactBytes": len(json.dumps(exact).encode()),
                        "displayBytes": len(
                            json.dumps(
                                response["geometry"], separators=(",", ":")
                            ).encode()
                        ),
                        "selectionSeconds": selection_seconds,
                        "histogramSeconds": histogram_seconds,
                        "summarySeconds": summary_seconds,
                    }
                )
            )
            response["geometry"]["features"].clear()
            assert (
                await lifecycle.resolve_for_sampling(response["id"])
            ).geometries == resolved.geometries
        finally:
            await lifecycle.close()

    asyncio.run(scenario())


def test_display_preserves_holes_multipolygon_and_dateline_components() -> None:
    """Keep explicit east/west dateline pieces separate and small holes visible."""
    west = Polygon(
        [(-180, 0), (-178, 0), (-178, 4), (-180, 4), (-180, 0)],
        [[(-179.8, 1), (-179.2, 1), (-179.2, 2), (-179.8, 2), (-179.8, 1)]],
    )
    east = box(178, 0, 180, 4)
    exact = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [
                        mapping(west)["coordinates"],
                        mapping(east)["coordinates"],
                    ],
                },
            }
        ],
    }
    original = json.dumps(exact)
    result = display_geometry(exact, (-180, 0, 180, 4))
    assert len(result["features"]) == 2
    assert sum(
        shape(feature["geometry"]).area for feature in result["features"]
    ) == pytest.approx(west.area + east.area)
    assert all(
        shape(feature["geometry"]).bounds[2] - shape(feature["geometry"]).bounds[0] <= 2
        for feature in result["features"]
    )
    assert json.dumps(exact) == original


def test_component_fallback_is_bounded_without_mutating_exact_selection() -> None:
    """An irreducible archipelago cannot exhaust browser resources."""
    polygons = [
        mapping(box(index % 100, index // 100, index % 100 + 0.1, index // 100 + 0.1))[
            "coordinates"
        ]
        for index in range(5000)
    ]
    exact = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {},
                "geometry": {"type": "MultiPolygon", "coordinates": polygons},
            }
        ],
    }
    result = display_geometry(exact, (0, 0, 100, 50))
    assert len(exact["features"][0]["geometry"]["coordinates"]) == 5000
    assert (
        sum(
            int(get_num_coordinates(shape(feature["geometry"])))
            for feature in result["features"]
        )
        <= MAX_DISPLAY_COORDINATES
    )
    assert len(json.dumps(result, separators=(",", ":")).encode()) <= MAX_DISPLAY_BYTES


def test_exact_selection_still_enforces_owned_budgets(
    detailed_source: ResolvedVectorSource,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Admission rejects exact work beyond its cap; uploads keep their old cap.

    Args:
        detailed_source: Detailed mounted fixture.
        monkeypatch: Lower independent exact byte/coordinate limits.
    """
    with fiona.open(detailed_source.source_path, layer="areas") as dataset:
        geometry = dict(next(iter(dataset)).geometry.__geo_interface__)
    with pytest.raises(GeometryValidationError, match="coordinate limit"):
        GeometryBuilder(polygons_only=True).add(geometry, "EPSG:4326")
    candidate = VectorFilter()
    with monkeypatch.context() as patch:
        patch.setattr("eolab_app.vector.geometry.MAX_EXACT_COORDINATES", 100)
        with pytest.raises(GeometryValidationError, match="coordinate limit"):
            read_filtered_geometry(
                detailed_source, candidate, vector_source_signature(detailed_source)
            )
    monkeypatch.setattr("eolab_app.vector.geometry.MAX_EXACT_GEOMETRY_BYTES", 100)
    with pytest.raises(GeometryValidationError, match="byte limit"):
        read_filtered_geometry(
            detailed_source, candidate, vector_source_signature(detailed_source)
        )


def test_retention_capacity_is_reclaimed_by_removal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Larger retained snapshots have a cumulative, reclaimable memory budget.

    Args:
        tmp_path: Isolated lifecycle directory.
        monkeypatch: Bound retention to exactly one small collection.
    """
    geometry = {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {}, "geometry": mapping(box(0, 0, 1, 1))}
        ],
    }
    monkeypatch.setattr(
        "eolab_app.temporary_aoi.service.MAX_RETAINED_GEOMETRY_BYTES",
        len(json.dumps(geometry).encode()),
    )

    async def scenario() -> None:
        """Reject the second snapshot, release the first, and admit a replacement."""
        lifecycle = TemporaryAoiService(tmp_path / "retained")
        try:
            first = await lifecycle.retain_geometry(geometry, (0, 0, 1, 1), "first")
            with pytest.raises(TemporaryAoiConflictError, match="capacity"):
                await lifecycle.retain_geometry(geometry, (0, 0, 1, 1), "second")
            await lifecycle.remove(first.identity.reference)
            await lifecycle.retain_geometry(geometry, (0, 0, 1, 1), "replacement")
        finally:
            await lifecycle.close()

    asyncio.run(scenario())
