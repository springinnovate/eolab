"""Test safe catalog scanning of Shapefiles stored in ZIP archives."""

import logging
import os
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import fiona
import pytest

from eolab_app.catalog.handlers import (
    build_zipped_shapefile_items,
    create_default_dataset_handler_registry,
    discover_zipped_shapefiles,
)
from eolab_app.catalog.metadata import build_dataset_metadata
from eolab_app.catalog.models import DatasetCandidate
from eolab_app.catalog.pgstac import catalog_item_source
from eolab_app.catalog.zipped_shapefile import (
    ZipResourceLimits,
    build_stac_items,
)


def write_shapefile(path: Path, coordinate: tuple[float, float]) -> tuple[Path, ...]:
    """Write a complete one-feature WGS 84 Shapefile fixture.

    Args:
        path: `.shp` location to create.
        coordinate: Longitude and latitude for the fixture Point.

    Returns:
        Component paths created by Fiona, ordered by file name.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with fiona.open(
        path,
        mode="w",
        driver="ESRI Shapefile",
        schema={"geometry": "Point", "properties": {"name": "str:40"}},
        crs="EPSG:4326",
    ) as dataset:
        dataset.write({
            "geometry": {"type": "Point", "coordinates": coordinate},
            "properties": {"name": path.stem},
        })
    return tuple(sorted(
        path.parent.glob(f"{path.stem}.*"),
        key=lambda component_path: component_path.name,
    ))


def add_components_to_archive(
    archive: ZipFile,
    component_paths: tuple[Path, ...],
    internal_directory: str,
) -> None:
    """Add one Shapefile component group below an internal directory.

    Args:
        archive: Writable ZIP archive.
        component_paths: Mounted fixture files to add.
        internal_directory: POSIX directory path inside the archive.
    """
    for component_path in component_paths:
        archive.write(
            component_path,
            arcname=f"{internal_directory}/{component_path.name}",
        )


def create_archive(
    archive_path: Path,
    datasets: tuple[tuple[tuple[Path, ...], str], ...],
) -> Path:
    """Create a deflated ZIP containing one or more Shapefiles.

    Args:
        archive_path: ZIP location to create.
        datasets: Component groups and their target internal directories.

    Returns:
        The created archive path.
    """
    with ZipFile(archive_path, mode="w", compression=ZIP_DEFLATED) as archive:
        for component_paths, internal_directory in datasets:
            add_components_to_archive(
                archive,
                component_paths,
                internal_directory,
            )
    return archive_path


def test_zip_discovery_is_case_insensitive(tmp_path: Path) -> None:
    """Recognize ZIP containers without inspecting unrelated files.

    Args:
        tmp_path: Isolated mounted source directory.
    """
    (tmp_path / "vectors.ZIP").touch()
    (tmp_path / "notes.txt").touch()

    discovery = discover_zipped_shapefiles(
        tmp_path,
        (),
        ("notes.txt", "vectors.ZIP"),
    )

    assert [match.path for match in discovery.matches] == [
        tmp_path / "vectors.ZIP"
    ]
    assert not discovery.pruned_directory_names


def test_one_zipped_shapefile_builds_searchable_vector_item(
    tmp_path: Path,
) -> None:
    """Build vector, projection, time, identity, and archive Asset metadata.

    Args:
        tmp_path: Isolated mounted source directory.
    """
    components = write_shapefile(
        tmp_path / "fixtures" / "roads.shp",
        (-122.5, 47.5),
    )
    archive_path = create_archive(
        tmp_path / "delivery.zip",
        ((components, "nested/transport"),),
    )
    modified_at = 1_700_000_000
    os.utime(archive_path, (modified_at, modified_at))

    (item,) = build_stac_items(tmp_path, archive_path)

    assert item["collection"] == "eolab-mounted-vectors"
    assert item["id"].startswith("zipped-shapefile-")
    assert item["geometry"]["type"] == "Polygon"
    assert item["properties"]["title"] == (
        "delivery.zip!/nested/transport/roads.shp"
    )
    assert item["properties"]["datetime"] == "2023-11-14T22:13:20Z"
    assert "mounted ZIP archive's filesystem modification time" in (
        item["properties"]["description"]
    )
    assert item["properties"]["proj:epsg"] == 4326
    assert item["properties"]["table:row_count"] == 1
    assert item["properties"]["table:columns"] == [
        {"name": "geometry", "type": "Point"},
        {"name": "name", "type": "str:40"},
    ]
    assert item["assets"] == {
        "archive": {
            "href": archive_path.resolve().as_uri(),
            "type": "application/zip",
            "title": "delivery.zip",
            "roles": ["data"],
            "updated": "2023-11-14T22:13:20Z",
        },
    }


def test_nested_shapefiles_have_distinct_stable_internal_path_identities(
    tmp_path: Path,
) -> None:
    """Emit deterministically ordered Items and preserve IDs across rescans.

    Args:
        tmp_path: Isolated mounted source directory.
    """
    roads = write_shapefile(
        tmp_path / "roads-source" / "roads.shp",
        (-122.0, 47.0),
    )
    lakes = write_shapefile(
        tmp_path / "lakes-source" / "lakes.shp",
        (-121.0, 46.0),
    )
    archive_path = create_archive(
        tmp_path / "multi.zip",
        (
            (roads, "z-folder"),
            (lakes, "a-folder/nested"),
        ),
    )

    first_items = build_stac_items(tmp_path, archive_path)
    second_items = build_stac_items(tmp_path, archive_path)

    assert [item["properties"]["title"] for item in first_items] == [
        "multi.zip!/a-folder/nested/lakes.shp",
        "multi.zip!/z-folder/roads.shp",
    ]
    assert len({item["id"] for item in first_items}) == 2
    assert [item["id"] for item in first_items] == [
        item["id"] for item in second_items
    ]


def test_internal_shapefile_failure_does_not_discard_valid_sibling(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Log one corrupt internal dataset while returning its valid sibling.

    Args:
        tmp_path: Isolated mounted source directory.
        caplog: Captured logging records for the isolated dataset failure.
    """
    valid_components = write_shapefile(
        tmp_path / "valid-source" / "valid.shp",
        (-120.0, 45.0),
    )
    broken_components = write_shapefile(
        tmp_path / "broken-source" / "broken.shp",
        (-119.0, 44.0),
    )
    archive_path = tmp_path / "mixed.zip"
    with ZipFile(archive_path, mode="w", compression=ZIP_DEFLATED) as archive:
        add_components_to_archive(archive, valid_components, "valid")
        for component_path in broken_components:
            internal_name = f"broken/{component_path.name}"
            if component_path.suffix.lower() == ".shp":
                archive.writestr(internal_name, b"not a Shapefile")
            else:
                archive.write(component_path, arcname=internal_name)

    with caplog.at_level(logging.WARNING):
        items = build_stac_items(tmp_path, archive_path)

    assert [item["properties"]["title"] for item in items] == [
        "mixed.zip!/valid/valid.shp"
    ]
    assert "broken/broken.shp" in caplog.text
    assert "Skipped invalid Shapefile" in caplog.text


def test_archive_with_only_invalid_shapefile_reports_dataset_error(
    tmp_path: Path,
) -> None:
    """Capture a useful source error when no internal dataset can be emitted.

    Args:
        tmp_path: Isolated mounted source directory.
    """
    archive_path = tmp_path / "invalid.zip"
    with ZipFile(archive_path, mode="w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("broken/roads.shp", b"not a Shapefile")

    result = build_dataset_metadata(
        tmp_path,
        DatasetCandidate(archive_path, "zipped-shapefile"),
        create_default_dataset_handler_registry(),
    )

    assert result.items == ()
    assert result.error == (
        "ZIP archive contains no valid Shapefile datasets: "
        "broken/roads.shp: Shapefile is missing required components: "
        ".dbf, .prj, .shx"
    )


@pytest.mark.parametrize(
    ("entry_name", "expected_error"),
    (
        ("../roads.shp", "not a safe relative path"),
        ("C:/roads.shp", "not a safe relative path"),
        ("nested\\roads.shp", "ambiguous backslashes"),
    ),
)
def test_archive_member_paths_cannot_escape_or_be_ambiguous(
    tmp_path: Path,
    entry_name: str,
    expected_error: str,
) -> None:
    """Reject traversal and platform-dependent archive entry names.

    Args:
        tmp_path: Isolated mounted source directory.
        entry_name: Unsafe ZIP member path under test.
        expected_error: Diagnostic fragment required from validation.
    """
    archive_path = tmp_path / "malicious.zip"
    with ZipFile(archive_path, mode="w") as archive:
        archive.writestr(entry_name, b"malicious")
    if "\\" in entry_name:
        normalized_name = entry_name.replace("\\", "/").encode("utf-8")
        raw_name = entry_name.encode("utf-8")
        archive_path.write_bytes(
            archive_path.read_bytes().replace(normalized_name, raw_name)
        )

    with pytest.raises(ValueError, match=expected_error):
        build_stac_items(tmp_path, archive_path)


def test_archive_rejects_suspicious_compression_ratio(tmp_path: Path) -> None:
    """Stop a declared decompression bomb before GDAL reads any member.

    Args:
        tmp_path: Isolated mounted source directory.
    """
    archive_path = tmp_path / "bomb.zip"
    with ZipFile(archive_path, mode="w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("payload.bin", b"0" * 100_000)
    limits = ZipResourceLimits(compression_ratio=2.0)

    with pytest.raises(ValueError, match="compression ratio .* exceeds"):
        build_stac_items(tmp_path, archive_path, limits)


def test_archive_rejects_member_count_before_metadata_access(tmp_path: Path) -> None:
    """Enforce the central-directory member ceiling during preflight.

    Args:
        tmp_path: Isolated mounted source directory.
    """
    archive_path = tmp_path / "many.zip"
    with ZipFile(archive_path, mode="w") as archive:
        archive.writestr("one.txt", b"one")
        archive.writestr("two.txt", b"two")
    limits = ZipResourceLimits(member_count=1)

    with pytest.raises(ValueError, match="contains 2 entries; limit is 1"):
        build_stac_items(tmp_path, archive_path, limits)


def test_malformed_archive_is_an_isolated_dataset_failure(tmp_path: Path) -> None:
    """Return a useful error without raising beyond the metadata boundary.

    Args:
        tmp_path: Isolated mounted source directory.
    """
    archive_path = tmp_path / "malformed.zip"
    archive_path.write_bytes(b"this is not a ZIP archive")

    result = build_dataset_metadata(
        tmp_path,
        DatasetCandidate(archive_path, "zipped-shapefile"),
        create_default_dataset_handler_registry(),
    )

    assert result.items == ()
    assert result.error == (
        "ZIP archive has no valid end-of-central-directory record"
    )


def test_registry_builds_zip_items_and_reconciliation_tracks_archive(
    tmp_path: Path,
) -> None:
    """Wire ZIP discovery, dispatch, and archive-backed source ownership.

    Args:
        tmp_path: Isolated mounted source directory.
    """
    components = write_shapefile(
        tmp_path / "fixtures" / "habitat.shp",
        (-118.0, 43.0),
    )
    archive_path = create_archive(
        tmp_path / "habitat.ZIP",
        ((components, "data"),),
    )
    registry = create_default_dataset_handler_registry()
    candidates, pruned_names = registry.discover_directory(
        tmp_path,
        ("fixtures",),
        ("habitat.ZIP",),
    )

    assert not pruned_names
    assert candidates == [
        DatasetCandidate(archive_path, "zipped-shapefile")
    ]
    (item,) = build_zipped_shapefile_items(tmp_path, candidates[0])
    source = catalog_item_source(
        item["collection"],
        item["id"],
        item["assets"],
    )
    assert source.asset_hrefs == (archive_path.resolve().as_uri(),)


def test_zipped_item_requires_its_archive_source_asset() -> None:
    """Reject a ZIP-derived Item whose authoritative archive is absent."""
    with pytest.raises(ValueError, match="missing required source Assets"):
        catalog_item_source(
            "eolab-mounted-vectors",
            "zipped-shapefile-missing",
            {},
        )
