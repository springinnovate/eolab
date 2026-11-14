"""Exercise sidecar admission through discovery, existing readers and reconciliation."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
from typing import Any, IO

import numpy
import pytest
import rasterio
from rasterio.transform import from_origin
import yaml

from eolab_app.catalog.asset_access import ASSET_SOURCE_KEY
from eolab_app.catalog.descriptor_contract import NONSPATIAL_COLLECTION_ID
from eolab_app.catalog.descriptors import DESCRIPTOR_SOURCE_KEY
from eolab_app.catalog.handlers import (
    DatasetHandler,
    DatasetHandlerRegistry,
    create_default_dataset_handler_registry,
)
from eolab_app.catalog.metadata import MetadataPipeline
from eolab_app.catalog.models import DatasetCandidate
from eolab_app.catalog.scanner import ScanManager
from tests.catalog_support import RecordingCatalogDatabase, RecordingCatalogWriter


def write_raster(path: Path) -> None:
    """Write a small real source for the ordinary GeoTIFF admission handler.

    Args:
        path: New raster location inside the test mount.
    """
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=2,
        width=2,
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(10, 20, 1, 1),
    ) as dataset:
        dataset.write(numpy.ones((1, 2, 2), dtype="float32"))


def descriptor_document(
    path: str, *, kind: str = "nonspatial", identifier: str = "study"
) -> dict[str, Any]:
    """Return one authoring document with metadata that must survive ingestion.

    Args:
        path: Relative primary Asset path.
        kind: Declared Item capability.
        identifier: Stable descriptor ID.

    Returns:
        Mutable YAML document for the admission boundary.
    """
    result = {
        "schema": "eolab/item/v1",
        "id": identifier,
        "kind": kind,
        "primary_asset": "data",
        "temporal": {"mode": "modified"},
        "metadata": {
            "title": "Study data",
            "categories": ["Water"],
            "annotations": {"zero": 0, "reviewed": False, "missing": None},
            "publications": [
                {"id": "paper-1", "title": "Study paper", "doi": "10.1234/paper"}
            ],
        },
        "assets": {
            "data": {
                "location": "local",
                "path": path,
                "media_type": "application/octet-stream",
                "roles": ["data"],
                "metadata": {"title": "Source data"},
            }
        },
    }
    if kind != "nonspatial":
        result["source"] = {"format": "geotiff" if kind == "raster" else "geopackage"}
    return result


def write_descriptor(path: Path, document: dict[str, Any]) -> None:
    """Serialize authoring metadata as a descriptor on the mounted source.

    Args:
        path: Recognizable sidecar filename.
        document: External authoring document to validate during admission.
    """
    path.write_text(yaml.safe_dump(document), encoding="utf-8")


def scan(
    root: Path,
    writer: RecordingCatalogWriter,
    *,
    paths: tuple[Path, ...] | None = None,
    registry: DatasetHandlerRegistry | None = None,
    production_workers: bool = False,
    expected_state: str = "completed",
) -> dict[str, Any]:
    """Run a complete scan against the persistent in-memory catalog.

    Args:
        root: Authorized mounted source root.
        writer: Inventory retained between scans.
        paths: Optional partial scan scope.
        registry: Existing-handler registry, optionally with one controlled reader.
        production_workers: Use actual spawned metadata processes when true.
        expected_state: Terminal state expected from publication success or failure.

    Returns:
        Terminal scan report including admission and reconciliation errors.
    """
    handlers = registry or create_default_dataset_handler_registry()
    manager = ScanManager(
        root,
        paths or (root,),
        writer,
        RecordingCatalogDatabase(writer),
        1,
        1,
        2,
        dataset_handlers=handlers,
        metadata_pipeline=MetadataPipeline(
            root,
            1,
            2,
            handlers,
            executor_factory=None if production_workers else ThreadPoolExecutor,
        ),
    )

    async def finish() -> dict[str, Any]:
        """Wait for this test-owned scan to finish or fail within its deadline.

        Returns:
            Terminal scanner status.
        """
        await manager.start()
        async with asyncio.timeout(20):
            while manager.status()["state"] in {"discovering", "scanning"}:
                await asyncio.sleep(0.001)
        return manager.status()

    status = asyncio.run(finish())
    assert status["state"] == expected_state, status
    return status


def test_raster_adopts_sidecar_without_changing_identity_or_physical_metadata(
    tmp_path: Path,
) -> None:
    """Keep source identity across annotation, replacement and sidecar removal.

    Args:
        tmp_path: Isolated mounted source tree.
    """
    source = tmp_path / "depth.tif"
    write_raster(source)
    writer = RecordingCatalogWriter()
    assert scan(tmp_path, writer)["failed"] == 0
    key, ordinary = next(iter(writer.write_session.items.items()))
    (tmp_path / "observations.csv").write_bytes(b"not interpreted as a table")
    sidecar = tmp_path / "depth.tif.eolab.yaml"
    document = descriptor_document(source.name, kind="raster")
    document["assets"]["observations"] = {
        "location": "local",
        "path": "observations.csv",
        "media_type": "text/csv",
        "roles": ["data"],
        "metadata": {"title": "Observations", "annotations": {"rows": 0}},
    }
    write_descriptor(sidecar, document)
    assert scan(tmp_path, writer)["failed"] == 0
    described = writer.write_session.items[key]
    assert set(writer.write_session.items) == {key}
    assert described["geometry"] == ordinary["geometry"]
    assert described["properties"]["proj:epsg"] == ordinary["properties"]["proj:epsg"]
    assert (
        described["properties"]["eolab:metadata"]["annotations"]
        == document["metadata"]["annotations"]
    )
    assert described["assets"]["data"][ASSET_SOURCE_KEY] == {"href": source.as_uri()}
    assert described["assets"]["data"]["type"] == ordinary["assets"]["data"]["type"]
    assert described["assets"]["observations"]["href"].startswith("/api/catalog/asset?")
    document["metadata"]["annotations"] = {"replacement": True}
    document["assets"].pop("observations")
    write_descriptor(sidecar, document)
    assert scan(tmp_path, writer)["failed"] == 0
    assert writer.write_session.items[key]["properties"]["eolab:metadata"][
        "annotations"
    ] == {"replacement": True}
    assert "observations" not in writer.write_session.items[key]["assets"]
    sidecar.unlink()
    assert scan(tmp_path, writer)["failed"] == 0
    assert "eolab:metadata" not in writer.write_session.items[key]["properties"]
    assert writer.write_session.items[key]["assets"]["data"]["href"] == source.as_uri()


def test_nonspatial_admission_never_reads_payload_and_retires_changed_ids(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Use only YAML and file metadata for standalone arbitrary payloads.

    Args:
        tmp_path: Isolated mounted source tree.
        monkeypatch: Controlled external filesystem failure or payload-read guard.
    """
    source = tmp_path / "measurements.csv"
    source.write_bytes(b"\x00\xffnot a parseable table")
    sidecar = tmp_path / "measurements.csv.eolab.yaml"
    document = descriptor_document(source.name)
    write_descriptor(sidecar, document)
    original_open = Path.open

    def guarded_open(path: Path, *args: Any, **kwargs: Any) -> IO[Any]:
        """Reject a payload read while allowing the descriptor's real YAML parse.

        Args:
            path: File selected by production admission.
            *args: File-open positional options.
            **kwargs: File-open keyword options.

        Returns:
            Open descriptor stream.
        """
        if path == source:
            raise AssertionError("Nonspatial payload must not be opened")
        return original_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", guarded_open)
    writer = RecordingCatalogWriter()
    assert scan(tmp_path, writer)["failed"] == 0
    item = writer.write_session.items[(NONSPATIAL_COLLECTION_ID, "study")]
    assert item["geometry"] is None and "bbox" not in item
    assert item["properties"]["eolab:time_basis"] == "source-modified"
    document["id"] = "study-replaced"
    write_descriptor(sidecar, document)
    assert scan(tmp_path, writer)["failed"] == 0
    assert set(writer.write_session.items) == {
        (NONSPATIAL_COLLECTION_ID, "study-replaced")
    }
    sidecar.unlink()
    assert scan(tmp_path, writer)["failed"] == 0
    assert not writer.write_session.items


@pytest.mark.parametrize("failure", ["malformed", "unreadable", "missing-asset"])
def test_failed_cross_directory_sidecar_keeps_claims_and_last_good_item(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    """Avoid bare reindexing through both full and partial source scans.

    Args:
        tmp_path: Isolated mounted source tree.
        monkeypatch: Controlled external filesystem failure or payload-read guard.
        failure: Admission failure exercised by this case.
    """
    metadata = tmp_path / "metadata"
    payload = tmp_path / "payload"
    metadata.mkdir()
    payload.mkdir()
    write_raster(payload / "depth.tif")
    sidecar = metadata / "depth.eolab.yaml"
    document = descriptor_document("../payload/depth.tif", kind="raster")
    write_descriptor(sidecar, document)
    writer = RecordingCatalogWriter()
    assert scan(tmp_path, writer)["failed"] == 0
    original = deepcopy(writer.write_session.items)
    if failure == "malformed":
        sidecar.write_text("schema: [", encoding="utf-8")
    elif failure == "missing-asset":
        document["assets"]["missing"] = {
            "location": "local",
            "path": "absent.csv",
            "media_type": "text/csv",
            "roles": ["data"],
            "metadata": {"title": "Missing"},
        }
        write_descriptor(sidecar, document)
    else:
        read_text = Path.read_text

        def deny_descriptor(path: Path, *args: Any, **kwargs: Any) -> str:
            """Simulate a filesystem permission failure at descriptor admission.

            Args:
                path: Requested file.
                *args: Encoding options.
                **kwargs: Encoding options.

            Returns:
                Text for unrelated files.

            Raises:
                PermissionError: For the test descriptor.
            """
            if path == sidecar:
                raise PermissionError("descriptor cannot be read")
            return read_text(path, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", deny_descriptor)
    assert scan(tmp_path, writer)["failed"] == 1
    assert writer.write_session.items == original
    assert scan(tmp_path, writer, paths=(payload,))["failed"] == 0
    assert writer.write_session.items == original


def test_removed_cross_directory_descriptor_restores_spatial_item_in_partial_scope(
    tmp_path: Path,
) -> None:
    """Restore native metadata when the descriptor scope excludes its primary.

    Args:
        tmp_path: Isolated mounted source tree.
    """
    metadata = tmp_path / "metadata"
    metadata.mkdir()
    payload = tmp_path / "payload"
    payload.mkdir()
    write_raster(payload / "depth.tif")
    sidecar = metadata / "depth.eolab.yaml"
    write_descriptor(
        sidecar, descriptor_document("../payload/depth.tif", kind="raster")
    )
    writer = RecordingCatalogWriter()
    assert scan(tmp_path, writer)["failed"] == 0
    key = next(iter(writer.write_session.items))
    sidecar.unlink()
    assert scan(tmp_path, writer, paths=(payload,))["failed"] == 0
    assert DESCRIPTOR_SOURCE_KEY in writer.write_session.items[key]["assets"]
    assert scan(tmp_path, writer, paths=(metadata,))["failed"] == 0
    assert DESCRIPTOR_SOURCE_KEY not in writer.write_session.items[key]["assets"]


def test_new_invalid_same_name_sidecar_suppresses_ordinary_fallback(
    tmp_path: Path,
) -> None:
    """Report unparseable metadata instead of silently dropping its meaning.

    Args:
        tmp_path: Isolated mounted source tree.
    """
    write_raster(tmp_path / "depth.tif")
    (tmp_path / "depth.tif.eolab.yaml").write_text("schema: [", encoding="utf-8")
    writer = RecordingCatalogWriter()
    status = scan(tmp_path, writer)
    assert status["failed"] == 1
    assert "only the same-name source" in status["errors"][0]["error"]
    assert not writer.write_session.items


def test_descriptor_paths_cannot_escape_mount(tmp_path: Path) -> None:
    """Reject traversal before interpreting the referenced payload.

    Args:
        tmp_path: Isolated mounted source tree.
    """
    outside = tmp_path.parent / "outside-source.csv"
    outside.write_text("external", encoding="utf-8")
    write_descriptor(
        tmp_path / "outside.eolab.yaml", descriptor_document("../outside-source.csv")
    )
    writer = RecordingCatalogWriter()
    status = scan(tmp_path, writer)
    assert status["failed"] == 1
    assert "escapes" in status["errors"][0]["error"]
    assert not writer.write_session.items


def test_duplicate_descriptor_ids_preserve_previous_admission(tmp_path: Path) -> None:
    """Reject both colliding declarations without replacing prior ownership.

    Args:
        tmp_path: Isolated mounted source tree.
    """
    (tmp_path / "one.csv").touch()
    (tmp_path / "two.csv").touch()
    write_descriptor(tmp_path / "one.eolab.yaml", descriptor_document("one.csv"))
    writer = RecordingCatalogWriter()
    assert scan(tmp_path, writer)["failed"] == 0
    previous = deepcopy(writer.write_session.items)
    write_descriptor(tmp_path / "two.eolab.yaml", descriptor_document("two.csv"))
    assert scan(tmp_path, writer)["failed"] == 2
    assert writer.write_session.items == previous


def test_container_uses_one_existing_reader_and_layer_overrides(tmp_path: Path) -> None:
    """Fan out reader identities, common metadata and exact per-layer overrides.

    Args:
        tmp_path: Isolated mounted source tree.
    """
    (tmp_path / "study.gpkg").touch()
    (tmp_path / "shared.csv").touch()
    calls: list[Path] = []

    def read_layers(
        root: Path, candidate: DatasetCandidate
    ) -> tuple[dict[str, Any], ...]:
        """Represent a container reader's established multi-Item output contract.

        Args:
            root: Authorized mount passed by the existing registry.
            candidate: Ordinary container input selected by discovery.

        Returns:
            Two native layer identities with physical source metadata.
        """
        assert root == tmp_path
        calls.append(candidate.path)
        return tuple(
            {
                "type": "Feature",
                "stac_version": "1.0.0",
                "id": "geopackage-" + layer,
                "collection": "eolab-mounted-vectors",
                "geometry": {"type": "Point", "coordinates": [0, 0]},
                "properties": {
                    "title": layer,
                    "datetime": "2020-01-01T00:00:00Z",
                    "eolab:vector_source": {
                        "format": "geopackage",
                        "asset_key": "data",
                        "layer_name": layer,
                    },
                },
                "assets": {
                    "data": {
                        "href": candidate.path.as_uri(),
                        "type": "application/geopackage+sqlite3",
                        "roles": ["data"],
                    }
                },
                "links": [],
            }
            for layer in ("sites", "regions")
        )

    original = create_default_dataset_handler_registry()
    registry = DatasetHandlerRegistry(
        handlers=tuple(
            DatasetHandler(
                handler.name,
                handler.discover,
                read_layers if handler.name == "geopackage" else handler.build_items,
                handler.prepare_candidate,
            )
            for handler in original.handlers
        )
    )
    document = descriptor_document("study.gpkg", kind="vector")
    document["item_overrides"] = {
        "sites": {
            "metadata": {"title": "Site measurements", "annotations": {"count": 0}},
            "assets": {
                "support": {
                    "location": "local",
                    "path": "shared.csv",
                    "media_type": "text/csv",
                    "roles": ["data"],
                    "metadata": {"title": "Shared support"},
                }
            },
        }
    }
    sidecar = tmp_path / "study.gpkg.eolab.yaml"
    write_descriptor(sidecar, document)
    writer = RecordingCatalogWriter()
    assert scan(tmp_path, writer, registry=registry)["failed"] == 0
    assert calls == [tmp_path / "study.gpkg"]
    items = {item["id"]: item for item in writer.write_session.items.values()}
    assert items["geopackage-sites"]["properties"]["title"] == "Site measurements"
    assert items["geopackage-regions"]["properties"]["title"] == "Study data"
    assert "support" in items["geopackage-sites"]["assets"]
    assert "support" not in items["geopackage-regions"]["assets"]
    previous = deepcopy(writer.write_session.items)
    document["item_overrides"]["absent"] = {"metadata": {"title": "Unknown layer"}}
    write_descriptor(sidecar, document)
    assert scan(tmp_path, writer, registry=registry)["failed"] == 1
    assert writer.write_session.items == previous
    document["item_overrides"] = {}
    document["source"]["layer"] = "sites"
    write_descriptor(sidecar, document)
    assert scan(tmp_path, writer, registry=registry)["failed"] == 0
    regions = writer.write_session.items[
        ("eolab-mounted-vectors", "geopackage-regions")
    ]
    assert "eolab:metadata" not in regions["properties"]
    other = descriptor_document("study.gpkg", kind="vector", identifier="other-study")
    other["source"]["layer"] = "regions"
    other["metadata"]["title"] = "Regional study"
    write_descriptor(tmp_path / "regions.eolab.yaml", other)
    before = len(calls)
    assert scan(tmp_path, writer, registry=registry)["failed"] == 0
    assert len(calls) == before + 1
    assert len(writer.write_session.items) == 2
    assert (
        writer.write_session.items[("eolab-mounted-vectors", "geopackage-regions")][
            "properties"
        ]["title"]
        == "Regional study"
    )


def test_nonspatial_descriptor_move_keeps_declared_identity(tmp_path: Path) -> None:
    """Reconcile the old location before publishing its stable ID at a new path.

    Args:
        tmp_path: Isolated mounted source tree.
    """
    (tmp_path / "data.csv").touch()
    old = tmp_path / "old.eolab.yaml"
    document = descriptor_document("data.csv")
    write_descriptor(old, document)
    writer = RecordingCatalogWriter()
    assert scan(tmp_path, writer)["failed"] == 0
    old.rename(tmp_path / "new.eolab.yaml")
    assert scan(tmp_path, writer)["failed"] == 0
    assert set(writer.write_session.items) == {(NONSPATIAL_COLLECTION_ID, "study")}
    item = next(iter(writer.write_session.items.values()))
    assert (
        item["assets"][DESCRIPTOR_SOURCE_KEY]["href"]
        == (tmp_path / "new.eolab.yaml").as_uri()
    )


def test_shared_support_asset_is_not_independently_admitted(tmp_path: Path) -> None:
    """Resolve cross-directory supporting claims before any ordinary payload read.

    Args:
        tmp_path: Isolated mounted source tree.
    """
    metadata = tmp_path / "z_metadata"
    metadata.mkdir()
    payload = tmp_path / "a_payload"
    payload.mkdir()
    support = payload / "support.tif"
    support.write_bytes(b"deliberately unreadable GIS payload")
    writer = RecordingCatalogWriter()
    for identifier in ("one", "two"):
        (metadata / (identifier + ".csv")).touch()
        document = descriptor_document(identifier + ".csv", identifier=identifier)
        document["assets"]["support"] = {
            "location": "local",
            "path": "../a_payload/support.tif",
            "media_type": "image/tiff",
            "roles": ["data"],
            "metadata": {"title": "Shared support"},
        }
        write_descriptor(metadata / (identifier + ".eolab.yaml"), document)
    status = scan(tmp_path, writer)
    assert status["failed"] == 0, status
    assert len(writer.write_session.items) == 2
    assert all(item["geometry"] is None for item in writer.write_session.items.values())
    assert all(
        item["assets"]["support"][ASSET_SOURCE_KEY]["href"] == support.as_uri()
        for item in writer.write_session.items.values()
    )


def test_new_primary_claim_survives_missing_support_on_rejected_edit(
    tmp_path: Path,
) -> None:
    """Suppress both prior and newly declared primaries when an Asset is absent.

    Args:
        tmp_path: Isolated mounted source tree.
    """
    write_raster(tmp_path / "old.tif")
    write_raster(tmp_path / "new.tif")
    sidecar = tmp_path / "metadata.eolab.yaml"
    document = descriptor_document("old.tif", kind="raster")
    write_descriptor(sidecar, document)
    writer = RecordingCatalogWriter()
    assert scan(tmp_path, writer)["failed"] == 0
    previous = deepcopy(writer.write_session.items)
    document["assets"]["data"]["path"] = "new.tif"
    document["assets"]["support"] = {
        "location": "local",
        "path": "missing.csv",
        "media_type": "text/csv",
        "roles": ["data"],
        "metadata": {"title": "Missing support"},
    }
    write_descriptor(sidecar, document)
    status = scan(tmp_path, writer)
    assert status["failed"] == 1
    assert status["catalogItemsWritten"] == 0
    assert writer.write_session.items == previous


def test_partial_scan_rejects_claiming_another_descriptors_primary_as_support(
    tmp_path: Path,
) -> None:
    """Keep out-of-scope ownership authoritative during supporting-file changes.

    Args:
        tmp_path: Isolated mounted source tree.
    """
    first = tmp_path / "first"
    first.mkdir()
    second = tmp_path / "second"
    second.mkdir()
    (first / "one.csv").touch()
    (second / "two.csv").touch()
    write_descriptor(
        first / "one.eolab.yaml", descriptor_document("one.csv", identifier="one")
    )
    writer = RecordingCatalogWriter()
    assert scan(tmp_path, writer)["failed"] == 0
    previous = deepcopy(writer.write_session.items)
    document = descriptor_document("two.csv", identifier="two")
    document["assets"]["support"] = {
        "location": "local",
        "path": "../first/one.csv",
        "media_type": "text/csv",
        "roles": ["data"],
        "metadata": {"title": "Already another Item"},
    }
    write_descriptor(second / "two.eolab.yaml", document)
    assert scan(tmp_path, writer, paths=(second,))["failed"] == 1
    assert writer.write_session.items == previous


def test_explicit_rescan_rebuilds_after_source_mount_relocation(tmp_path: Path) -> None:
    """Use admitted relative ownership to rebuild sources without deleting old data.

    Args:
        tmp_path: Isolated mounted source tree.
    """
    import shutil

    old = tmp_path / "old"
    old.mkdir()
    new = tmp_path / "new"
    (old / "table.csv").touch()
    write_raster(old / "depth.tif")
    write_descriptor(
        old / "table.eolab.yaml", descriptor_document("table.csv", identifier="table")
    )
    write_descriptor(
        old / "depth.eolab.yaml",
        descriptor_document("depth.tif", kind="raster", identifier="depth"),
    )
    writer = RecordingCatalogWriter()
    assert scan(old, writer)["failed"] == 0
    keys = set(writer.write_session.items)
    shutil.copytree(old, new)
    assert scan(new, writer)["failed"] == 0
    assert set(writer.write_session.items) == keys
    for item in writer.write_session.items.values():
        assert item["assets"][DESCRIPTOR_SOURCE_KEY]["href"].startswith(
            new.as_uri() + "/"
        )
        assert item["assets"]["data"][ASSET_SOURCE_KEY]["href"].startswith(
            new.as_uri() + "/"
        )


def test_described_raster_runs_in_production_spawn_worker(tmp_path: Path) -> None:
    """Serialize prepared descriptors and reader callbacks through spawned workers.

    Args:
        tmp_path: Isolated source mount containing a real raster.
    """
    write_raster(tmp_path / "depth.tif")
    write_descriptor(
        tmp_path / "depth.tif.eolab.yaml",
        descriptor_document("depth.tif", kind="raster"),
    )
    writer = RecordingCatalogWriter()
    assert scan(tmp_path, writer, production_workers=True)["failed"] == 0
    item = next(iter(writer.write_session.items.values()))
    assert item["properties"]["eolab:metadata"]["title"] == "Study data"


def test_failed_nonspatial_replacement_keeps_previous_item(tmp_path: Path) -> None:
    """Retire a changed descriptor ID only after replacement publication succeeds.

    Args:
        tmp_path: Isolated mounted source tree.
    """
    (tmp_path / "data.csv").touch()
    path = tmp_path / "data.eolab.yaml"
    document = descriptor_document("data.csv")
    write_descriptor(path, document)
    writer = RecordingCatalogWriter()
    assert scan(tmp_path, writer)["failed"] == 0
    previous = deepcopy(writer.write_session.items)
    document["id"] = "replacement"
    write_descriptor(path, document)
    writer.write_session.item_error = RuntimeError("catalog unavailable")
    scan(tmp_path, writer, expected_state="failed")
    assert writer.write_session.items == previous


def test_attaching_an_existing_spatial_item_retires_its_standalone_entry(
    tmp_path: Path,
) -> None:
    """Publish associated GIS data as an Asset without a duplicate catalog Item.

    Args:
        tmp_path: Isolated mounted source tree.
    """
    write_raster(tmp_path / "primary.tif")
    write_raster(tmp_path / "support.tif")
    writer = RecordingCatalogWriter()
    assert scan(tmp_path, writer)["failed"] == 0
    assert len(writer.write_session.items) == 2
    document = descriptor_document("primary.tif", kind="raster")
    document["assets"]["support"] = {
        "location": "local",
        "path": "support.tif",
        "media_type": "image/tiff",
        "roles": ["data"],
        "metadata": {"title": "Supporting GIS data"},
    }
    write_descriptor(tmp_path / "primary.eolab.yaml", document)
    assert scan(tmp_path, writer)["failed"] == 0
    assert len(writer.write_session.items) == 1
    assert "support" in next(iter(writer.write_session.items.values()))["assets"]
