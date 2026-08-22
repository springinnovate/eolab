"""Test bounded GeoJSON FeatureCollection catalog metadata."""

import json
from pathlib import Path

import pytest

from eolab_app.catalog.geojson import (
    FALLBACK_DATETIME_DESCRIPTION,
    GEOJSON_MEDIA_TYPE,
    MAX_PROPERTY_COLUMNS,
    build_stac_item,
    discover_geojson_datasets,
)
from eolab_app.catalog.handlers import create_default_dataset_handler_registry
from eolab_app.catalog.metadata import build_dataset_metadata
from eolab_app.catalog.models import DatasetCandidate
from eolab_app.catalog.vector import TABLE_EXTENSION


def write_geojson(path: Path, document: object) -> None:
    """Write one compact JSON test document.

    Args:
        path: Destination fixture path.
        document: JSON-compatible document value.

    Returns:
        None.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document), encoding="utf-8")


def feature(
    geometry: dict[str, object] | None,
    properties: dict[str, object] | None,
) -> dict[str, object]:
    """Build one minimal GeoJSON Feature fixture.

    Args:
        geometry: GeoJSON geometry or null value.
        properties: Feature property mapping or null value.

    Returns:
        JSON-compatible GeoJSON Feature.
    """
    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": properties,
    }


def test_discovery_matches_only_geojson_case_insensitively(tmp_path: Path) -> None:
    """Recognize `.geojson` without claiming generic JSON files.

    Args:
        tmp_path: Isolated mounted source root.

    Returns:
        None.
    """
    file_names = ("data.GEOJSON", "ignored.json", "lower.geojson")

    discovered = discover_geojson_datasets(tmp_path, file_names)

    assert discovered == (
        tmp_path / "data.GEOJSON",
        tmp_path / "lower.geojson",
    )
    candidates, pruned_directory_names = (
        create_default_dataset_handler_registry().discover_directory(
            tmp_path,
            (),
            file_names,
        )
    )
    assert pruned_directory_names == frozenset()
    assert [
        (candidate.path, candidate.handler_name)
        for candidate in candidates
    ] == [
        (tmp_path / "data.GEOJSON", "geojson"),
        (tmp_path / "lower.geojson", "geojson"),
    ]


def test_feature_collection_builds_vector_item_and_lossless_schema(
    tmp_path: Path,
) -> None:
    """Aggregate bounds, count, geometry types, and mixed property types.

    Args:
        tmp_path: Isolated mounted source root.

    Returns:
        None.
    """
    geojson_path = tmp_path / "nested" / "observations.geojson"
    write_geojson(geojson_path, {
        "type": "FeatureCollection",
        "features": [
            feature(
                {"type": "Point", "coordinates": [-123.5, 48.25]},
                {"name": "first", "rank": 1, "nullable": None},
            ),
            feature(
                {
                    "type": "LineString",
                    "coordinates": [[-122.0, 47.0], [-120.0, 49.0]],
                },
                {"name": None, "rank": 2.5, "active": True},
            ),
        ],
    })

    item = build_stac_item(tmp_path, geojson_path)

    assert item["id"].startswith("geojson-")
    assert item["collection"] == "eolab-mounted-vectors"
    assert item["bbox"] == [-123.5, 47.0, -120.0, 49.0]
    assert item["geometry"] == {
        "type": "Polygon",
        "coordinates": [[
            [-123.5, 47.0],
            [-120.0, 47.0],
            [-120.0, 49.0],
            [-123.5, 49.0],
            [-123.5, 47.0],
        ]],
    }
    assert item["properties"]["description"] == FALLBACK_DATETIME_DESCRIPTION
    assert item["properties"]["proj:epsg"] == 4326
    assert item["properties"]["proj:bbox"] == item["bbox"]
    assert item["properties"]["table:row_count"] == 2
    assert item["properties"]["table:columns"] == [
        {"name": "geometry", "type": "Point | LineString"},
        {"name": "name", "type": "string | null"},
        {"name": "rank", "type": "number"},
        {"name": "nullable", "type": "null"},
        {"name": "active", "type": "boolean"},
    ]
    assert item["stac_extensions"][1] == TABLE_EXTENSION
    assert item["assets"]["data"] == {
        "href": geojson_path.resolve().as_uri(),
        "type": GEOJSON_MEDIA_TYPE,
        "title": "nested/observations.geojson",
        "roles": ["data"],
        "updated": item["properties"]["datetime"],
    }
    json.dumps(item)


def test_legacy_crs_accepts_only_unambiguous_wgs84(tmp_path: Path) -> None:
    """Accept legacy CRS84 and reject projected legacy declarations.

    Args:
        tmp_path: Isolated mounted source root.

    Returns:
        None.
    """
    geojson_path = tmp_path / "legacy.geojson"
    document = {
        "type": "FeatureCollection",
        "crs": {
            "type": "name",
            "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"},
        },
        "features": [feature(
            {"type": "Point", "coordinates": [1, 2]},
            {},
        )],
    }
    write_geojson(geojson_path, document)

    assert build_stac_item(tmp_path, geojson_path)["properties"]["proj:epsg"] == 4326

    document["crs"]["properties"]["name"] = "EPSG:3857"
    write_geojson(geojson_path, document)

    with pytest.raises(ValueError, match="legacy CRS must unambiguously name"):
        build_stac_item(tmp_path, geojson_path)


def test_rescan_identity_depends_only_on_mount_relative_path(tmp_path: Path) -> None:
    """Keep the Item identifier stable when file content and time change.

    Args:
        tmp_path: Isolated mounted source root.

    Returns:
        None.
    """
    geojson_path = tmp_path / "stable.geojson"
    write_geojson(geojson_path, {
        "type": "FeatureCollection",
        "features": [feature(
            {"type": "Point", "coordinates": [0, 0]},
            {"version": 1},
        )],
    })
    first_item = build_stac_item(tmp_path, geojson_path)
    write_geojson(geojson_path, {
        "type": "FeatureCollection",
        "features": [feature(
            {"type": "Point", "coordinates": [10, 10]},
            {"version": 2},
        )],
    })

    second_item = build_stac_item(tmp_path, geojson_path)

    assert second_item["id"] == first_item["id"]
    assert second_item["bbox"] != first_item["bbox"]


def test_large_feature_collection_is_streamed_to_one_item(tmp_path: Path) -> None:
    """Process many features without constructing a collection-sized list.

    Args:
        tmp_path: Isolated mounted source root.

    Returns:
        None.
    """
    geojson_path = tmp_path / "large.geojson"
    with geojson_path.open("w", encoding="utf-8") as destination:
        destination.write('{"type":"FeatureCollection","features":[')
        for feature_index in range(10_000):
            if feature_index:
                destination.write(",")
            json.dump(feature(
                {
                    "type": "Point",
                    "coordinates": [feature_index % 180, feature_index % 90],
                },
                {"index": feature_index},
            ), destination, separators=(",", ":"))
        destination.write("]}")

    item = build_stac_item(tmp_path, geojson_path)

    assert item["properties"]["table:row_count"] == 10_000
    assert item["properties"]["table:columns"] == [
        {"name": "geometry", "type": "Point"},
        {"name": "index", "type": "integer"},
    ]


def test_property_schema_has_an_explicit_column_bound(tmp_path: Path) -> None:
    """Fail one source instead of retaining an unbounded property-name map.

    Args:
        tmp_path: Isolated mounted source root.

    Returns:
        None.
    """
    geojson_path = tmp_path / "wide.geojson"
    write_geojson(geojson_path, {
        "type": "FeatureCollection",
        "features": [feature(
            {"type": "Point", "coordinates": [0, 0]},
            {
                f"field_{field_index}": field_index
                for field_index in range(MAX_PROPERTY_COLUMNS + 1)
            },
        )],
    })

    result = build_dataset_metadata(
        tmp_path,
        DatasetCandidate(geojson_path, "geojson"),
        create_default_dataset_handler_registry(),
    )

    assert result.items == ()
    assert result.error == (
        "GeoJSON schema exceeds the supported "
        f"{MAX_PROPERTY_COLUMNS}-column bound"
    )


@pytest.mark.parametrize(
    ("document", "error_pattern"),
    (
        ({"type": "Feature", "features": []}, "type must be FeatureCollection"),
        (
            {"type": "FeatureCollection", "features": []},
            "no spatial footprint",
        ),
        (
            {
                "type": "FeatureCollection",
                "features": [feature(
                    {"type": "Point", "coordinates": [200, 45]},
                    {},
                )],
            },
            "WGS 84 longitude",
        ),
    ),
)
def test_invalid_feature_collections_return_useful_errors(
    tmp_path: Path,
    document: object,
    error_pattern: str,
) -> None:
    """Reject invalid documents with source-specific actionable messages.

    Args:
        tmp_path: Isolated mounted source root.
        document: Invalid GeoJSON document fixture.
        error_pattern: Expected metadata error fragment.

    Returns:
        None.
    """
    geojson_path = tmp_path / "invalid.geojson"
    write_geojson(geojson_path, document)

    result = build_dataset_metadata(
        tmp_path,
        DatasetCandidate(geojson_path, "geojson"),
        create_default_dataset_handler_registry(),
    )

    assert result.items == ()
    assert result.error is not None
    assert error_pattern in result.error


def test_malformed_geojson_failure_does_not_affect_valid_candidate(
    tmp_path: Path,
) -> None:
    """Capture one parse failure while another candidate remains catalogable.

    Args:
        tmp_path: Isolated mounted source root.

    Returns:
        None.
    """
    malformed_path = tmp_path / "malformed.geojson"
    malformed_path.write_text('{"type":"FeatureCollection",', encoding="utf-8")
    valid_path = tmp_path / "valid.geojson"
    write_geojson(valid_path, {
        "type": "FeatureCollection",
        "features": [feature(
            {"type": "Point", "coordinates": [0, 0]},
            {},
        )],
    })
    registry = create_default_dataset_handler_registry()

    malformed_result = build_dataset_metadata(
        tmp_path,
        DatasetCandidate(malformed_path, "geojson"),
        registry,
    )
    valid_result = build_dataset_metadata(
        tmp_path,
        DatasetCandidate(valid_path, "geojson"),
        registry,
    )

    assert malformed_result.items == ()
    assert malformed_result.error is not None
    assert "malformed" in malformed_result.error
    assert len(valid_result.items) == 1
    assert valid_result.error is None
