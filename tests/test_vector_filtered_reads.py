"""Filtered original-source reads decode only selected GeoPackage geometries."""

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import fiona
import pytest
from shapely.geometry import box, mapping

from eolab_app.attribute_filter import VectorFilter, matches_filter, ogr_predicate
from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app.bounded_vector import polygon_records
from eolab_app.catalog_selection import (
    CatalogSelection,
    ResolvedCatalogSelection,
    SelectionUnavailableError,
)
from eolab_app.raster.read_cancellation import RasterReadCancelled


def write_filtered_source(
    directory: Path, driver: str, predicate: VectorFilter
) -> ResolvedCatalogSelection:
    """Create an immutable polygon fixture with text and numeric filter fields.

    Args:
        directory: Isolated native source directory.
        driver: GeoPackage, GeoJSON or Shapefile native driver.
        predicate: Captured exact attribute selection.

    Returns:
        Native source descriptor with its conservative driver predicate.
    """
    extension = {"GPKG": ".gpkg", "GeoJSON": ".geojson", "ESRI Shapefile": ".shp"}
    path = directory / f"polygons{extension[driver]}"
    with fiona.open(
        path,
        "w",
        driver=driver,
        layer="polygons",
        crs="EPSG:4326",
        encoding="UTF-8",
        schema={"geometry": "Polygon", "properties": {"label": "str", "value": "int"}},
    ) as dataset:
        for index, label in enumerate(
            ("no match", "06", "O'Brien%_06", "雪06", "alpha", "Alpha", None)
        ):
            dataset.write(
                {
                    "geometry": mapping(box(index * 2, 0, index * 2 + 1, 1)),
                    "properties": {"label": label, "value": index},
                }
            )
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="polygons",
        assetKey="data",
        layerName="polygons",
        filter=predicate,
    )
    return ResolvedCatalogSelection(selection, path, driver, ogr_predicate(predicate))


@pytest.mark.parametrize("driver", ["GPKG", "GeoJSON", "ESRI Shapefile"])
@pytest.mark.parametrize(
    "predicate",
    [
        VectorFilter(rules=[{"field": "label", "operator": "contains", "value": "06"}]),
        VectorFilter(rules=[{"field": "label", "operator": "contains", "value": "%_"}]),
        VectorFilter(rules=[{"field": "label", "operator": "contains", "value": "雪"}]),
        VectorFilter(rules=[{"field": "label", "operator": "eq", "value": "Alpha"}]),
        VectorFilter(rules=[{"field": "label", "operator": "missing"}]),
        VectorFilter(
            rules=[
                {"field": "label", "operator": "contains", "value": "06"},
                {"field": "value", "operator": "ge", "value": 2},
            ]
        ),
        VectorFilter(
            match="any",
            rules=[
                {"field": "label", "operator": "contains", "value": "06"},
                {"field": "value", "operator": "ge", "value": 5},
            ],
        ),
    ],
)
def test_filtered_native_reads_preserve_exact_predicates_and_bbox(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    driver: str,
    predicate: VectorFilter,
) -> None:
    """Match the exact oracle while GeoPackages retrieve geometry only by selected FID.

    Args:
        tmp_path: Isolated native source directory.
        monkeypatch: Observe native geometry retrieval without replacing its result.
        driver: Source format whose supported reading strategy is exercised.
        predicate: Exact text, numeric, null or combined filter.
    """
    source = write_filtered_source(tmp_path, driver, predicate)
    expected = []
    with fiona.open(source.path, layer="polygons") as dataset:
        for feature in dataset.filter(bbox=(1.5, -1, 20, 2)):
            if matches_filter(predicate, feature.properties):
                expected.append(dict(feature.properties))
    original_get = fiona.Collection.get
    original_filter = fiona.Collection.filter
    fetched = []

    def record_get(collection: fiona.Collection, identifier: str) -> Any:
        """Record a native FID lookup and return the original source feature.

        Args:
            collection: Full-geometry original source handle.
            identifier: Native stable feature identifier from the attribute scan.

        Returns:
            The feature returned by the real Fiona driver.
        """
        fetched.append(identifier)
        return original_get(collection, identifier)

    def inspect_candidates(
        collection: fiona.Collection, **options: Any
    ) -> Iterator[Any]:
        """Verify filtered GeoPackage candidates omit geometry before exact matching.

        Args:
            collection: Candidate source handle.
            options: Existing native WHERE and spatial-filter arguments.

        Yields:
            Real native candidate records.
        """
        for feature in original_filter(collection, **options):
            if driver == "GPKG":
                assert feature.geometry is None
            yield feature

    monkeypatch.setattr(fiona.Collection, "get", record_get)
    monkeypatch.setattr(fiona.Collection, "filter", inspect_candidates)
    with polygon_records(source, ("label", "value"), bbox=(1.5, -1, 20, 2)) as records:
        actual = [properties for _, properties in records]
    assert actual == expected
    assert len(fetched) == (len(expected) if driver == "GPKG" else 0)


def test_filtered_candidate_budget_counts_nonmatching_features(tmp_path: Path) -> None:
    """Retain the candidate-work ceiling even when every attribute fails the filter.

    Args:
        tmp_path: Isolated original GeoPackage.
    """
    source = write_filtered_source(
        tmp_path,
        "GPKG",
        VectorFilter(
            rules=[{"field": "label", "operator": "contains", "value": "absent"}]
        ),
    )
    with pytest.raises(GeometryValidationError, match="3-feature budget"):
        with polygon_records(source, (), max_features=3) as records:
            list(records)


def test_filtered_cancellation_closes_both_native_sources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Close the attribute and geometry handles when a filtered read is cancelled.

    Args:
        tmp_path: Isolated original GeoPackage.
        monkeypatch: Observe real source handles through their close lifecycle.
    """
    source = write_filtered_source(
        tmp_path,
        "GPKG",
        VectorFilter(rules=[{"field": "label", "operator": "contains", "value": "06"}]),
    )
    original_open = fiona.open
    opened = []

    def record_open(*args: Any, **kwargs: Any) -> fiona.Collection:
        """Retain each actual native handle so closure can be verified.

        Args:
            args: Source path passed to Fiona.
            kwargs: Authorized layer and source-reading options.

        Returns:
            The actual native collection.
        """
        result = original_open(*args, **kwargs)
        opened.append(result)
        return result

    monkeypatch.setattr(fiona, "open", record_open)
    with pytest.raises(RasterReadCancelled):
        with polygon_records(
            source, (), cancellation_requested=lambda: True
        ) as records:
            list(records)
    assert len(opened) == 2 and all(source.closed for source in opened)


def test_filtered_missing_native_feature_reports_source_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Translate a failed native FID read instead of publishing incomplete geometry.

    Args:
        tmp_path: Isolated original GeoPackage.
        monkeypatch: Inject an actual-read failure at the native feature boundary.
    """
    source = write_filtered_source(
        tmp_path,
        "GPKG",
        VectorFilter(rules=[{"field": "label", "operator": "contains", "value": "06"}]),
    )
    monkeypatch.setattr(fiona.Collection, "get", lambda *_args: None)
    with pytest.raises(
        SelectionUnavailableError, match="selected polygon could not be read"
    ):
        with polygon_records(source, ()) as records:
            list(records)
