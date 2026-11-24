"""Filtered original-source reads decode only selected GeoPackage geometries."""

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import fiona
import pytest
from osgeo import gdal, ogr
from shapely.geometry import box, mapping, shape

from eolab_app.attribute_filter import VectorFilter, matches_filter, ogr_predicate
from eolab_app.bounded_geometry import GeometryValidationError
from eolab_app import bounded_vector
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
        driver: Native driver, or GPKG-wide-ids to include colliding 64-bit IDs.
        predicate: Captured exact attribute selection.

    Returns:
        Native source descriptor with its conservative driver predicate.
    """
    wide_ids = driver == "GPKG-wide-ids"
    driver = "GPKG" if wide_ids else driver
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
    if wide_ids:
        from osgeo import gdal

        with (
            gdal.ExceptionMgr(),
            gdal.OpenEx(str(path), gdal.OF_VECTOR | gdal.OF_UPDATE) as dataset,
        ):
            dataset.ExecuteSQL(f"UPDATE polygons SET fid = {2**32 + 1} WHERE fid = 2")
            dataset.ExecuteSQL(f"UPDATE polygons SET fid = {2**31} WHERE fid = 3")
    selection = CatalogSelection(
        collectionId="eolab-mounted-vectors",
        itemId="polygons",
        assetKey="data",
        layerName="polygons",
        filter=predicate,
    )
    return ResolvedCatalogSelection(selection, path, driver, ogr_predicate(predicate))


@pytest.mark.parametrize("bbox", [None, (1.5, -1, 20, 2)])
@pytest.mark.parametrize(
    "driver", ["GPKG", "GPKG-wide-ids", "GeoJSON", "ESRI Shapefile"]
)
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
    bbox: tuple[float, float, float, float] | None,
) -> None:
    """Match the exact oracle while GeoPackages retrieve geometry only by selected FID.

    Args:
        tmp_path: Isolated native source directory.
        monkeypatch: Observe native geometry retrieval without replacing its result.
        driver: Source format whose supported reading strategy is exercised.
        predicate: Exact text, numeric, null or combined filter.
        bbox: Native candidate envelope, or an unrestricted attribute scan.
    """
    source = write_filtered_source(tmp_path, driver, predicate)
    expected = []
    with fiona.open(source.path, layer="polygons") as dataset:
        for feature in dataset.filter(bbox=bbox):
            if matches_filter(predicate, feature.properties):
                expected.append((dict(feature.properties), shape(feature.geometry)))
    original_get = ogr.Layer.GetFeature
    original_iter = ogr.Layer.__iter__
    original_geometry = bounded_vector.native_spatial_geometry
    fetched = []
    decoded = []

    def record_get(layer: ogr.Layer, identifier: int) -> ogr.Feature | None:
        """Observe exact native-ID geometry lookups without replacing their results.

        Args:
            layer: Original geometry source handle.
            identifier: Signed-64-bit feature identity from the candidate scan.

        Returns:
            The real native feature, or None if absent.
        """
        fetched.append(identifier)
        return original_get(layer, identifier)

    def inspect_candidates(layer: ogr.Layer) -> Iterator[ogr.Feature]:
        """Check that attribute-only scans omit native geometry when no bbox needs it.

        Args:
            layer: Original candidate handle with its native predicates.

        Yields:
            Original native records without decoding their geometry into Python.
        """
        for feature in original_iter(layer):
            if bbox is None:
                assert feature.GetGeometryRef() is None
            yield feature

    def record_geometry(geometry: ogr.Geometry) -> Any:
        """Count source geometries materialized after exact attribute acceptance.

        Args:
            geometry: Borrowed geometry from a selected source feature.

        Returns:
            The real normalized spatial geometry.
        """
        decoded.append(geometry.ExportToWkb())
        return original_geometry(geometry)

    monkeypatch.setattr(ogr.Layer, "GetFeature", record_get)
    monkeypatch.setattr(ogr.Layer, "__iter__", inspect_candidates)
    monkeypatch.setattr(bounded_vector, "native_spatial_geometry", record_geometry)
    with polygon_records(source, ("label", "value"), bbox=bbox) as records:
        actual = [(properties, shape(geometry)) for geometry, properties in records]
    assert actual == expected
    assert len(fetched) == (
        len(expected) if source.driver == "GPKG" and bbox is None else 0
    )
    assert len(decoded) == (len(expected) if source.driver == "GPKG" else 0)


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
    original_native_open = gdal.OpenEx
    original_close = gdal.Dataset.Close
    opened = []
    native_opened = []
    native_closed = []

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

    def record_native_open(*args: Any, **kwargs: Any) -> gdal.Dataset:
        """Retain the real native dataset opened with the supplied GDAL arguments.

        Args:
            args: Original native open arguments.
            kwargs: Original source configuration.

        Returns:
            Dataset returned by the actual driver.
        """
        dataset = original_native_open(*args, **kwargs)
        native_opened.append(dataset)
        return dataset

    def record_close(dataset: gdal.Dataset) -> Any:
        """Record closure of the native dataset and return the real close result.

        Args:
            dataset: Open original source about to close.

        Returns:
            Actual native close result.
        """
        native_closed.append(dataset)
        return original_close(dataset)

    monkeypatch.setattr(gdal, "OpenEx", record_native_open)
    monkeypatch.setattr(gdal.Dataset, "Close", record_close)
    monkeypatch.setattr(fiona, "open", record_open)
    with pytest.raises(RasterReadCancelled):
        with polygon_records(
            source, (), cancellation_requested=lambda: True
        ) as records:
            list(records)
    assert len(opened) == 1 and all(source.closed for source in opened)
    assert len(native_opened) == 2 and set(map(id, native_closed)) == set(
        map(id, native_opened)
    )


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
    monkeypatch.setattr(ogr.Layer, "GetFeature", lambda *_args: None)
    with pytest.raises(
        SelectionUnavailableError, match="selected polygon could not be read"
    ):
        with polygon_records(source, ()) as records:
            list(records)


def test_filtered_consumer_failure_is_not_translated_to_a_source_error(
    tmp_path: Path,
) -> None:
    """Preserve an exception raised by a consumer while its source scope is open.

    Args:
        tmp_path: Isolated source for an accepted filtered polygon read.
    """
    source = write_filtered_source(
        tmp_path,
        "GPKG",
        VectorFilter(rules=[{"field": "label", "operator": "contains", "value": "06"}]),
    )
    with pytest.raises(RuntimeError, match="consumer calculation failed"):
        with polygon_records(source, ()) as records:
            next(records)
            raise RuntimeError("consumer calculation failed")
