"""Publish individually named raster files from one declared model output."""

from dataclasses import asdict, replace
from datetime import datetime, timedelta, timezone
import hashlib
from pathlib import Path
from threading import Event
from typing import Any

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from eolab_app.processing.aggregate_models import AggregateArtifact
from eolab_app.processing.artifact_manifest import ProducedFile
from eolab_app.processing.artifacts import LocalJobArtifacts
from eolab_app.processing.model_runs import (
    declare_model_files,
    serialize_model_artifacts,
)
from eolab_app.processing.model_run_contracts import ModelArtifactManifest, ModelOutcome
from eolab_app.processing.models import ProcessingError, ProcessingLimits


@pytest.fixture
def routing_dem_files(
    tmp_path: Path,
) -> tuple[LocalJobArtifacts, dict[str, Any], AggregateArtifact]:
    """Prepare two separate drainage grids and a recipe retaining both.

    Args:
        tmp_path: Isolated private artifact storage.

    Returns:
        Storage adapter, captured output declarations and completed native files.
    """
    storage = LocalJobArtifacts(tmp_path)
    storage.initialize()
    directory = storage.prepare("a" * 32, 0, ProcessingLimits())
    statistics = b"value\n42\n"
    (directory / "result.csv").write_bytes(statistics)
    outputs = []
    for drain in (2, 3):
        name = f"routing_dem_drain_{drain}"
        path = directory / f"{name}.tif"
        with rasterio.open(
            path,
            "w",
            driver="GTiff",
            width=3,
            height=2,
            count=1,
            dtype="int16",
            nodata=-9999,
            crs="EPSG:4326",
            transform=from_origin(drain, 4, 0.1, 0.1),
        ) as raster:
            raster.write(np.array([[3, 2, -9999], [4, 3, 1]], dtype="int16"), 1)
        data = path.read_bytes()
        outputs.append(
            ProducedFile(
                name=name,
                output_name="routing_dem",
                member_label=f"Drain {drain}",
                storage_name=path.name,
                filename=path.name,
                media_type="image/tiff",
                size=len(data),
                sha256=hashlib.sha256(data).hexdigest(),
            )
        )
    artifact = AggregateArtifact(
        filename="statistics.csv",
        size=len(statistics),
        sha256=hashlib.sha256(statistics).hexdigest(),
        rows=[],
        additional_outputs=tuple(outputs),
    )
    row = {
        "summary": {
            "operationId": "hydrology.downstream_beneficiaries.v1",
            "outputs": {
                "statistics": {
                    "name": "total",
                    "label": "Statistics",
                    "role": "result",
                    "mediaType": "text/csv",
                },
                "routing_dem": {
                    "name": "terrain",
                    "label": "Terrain used for routing",
                    "role": "intermediate",
                    "mediaType": "image/tiff",
                },
            },
        }
    }
    return storage, row, artifact


def test_collection_members_use_normal_publication_and_cleanup(
    routing_dem_files: tuple[LocalJobArtifacts, dict[str, Any], AggregateArtifact],
) -> None:
    """Retain both exact DEMs under a custom recipe label and clean them together.

    Args:
        routing_dem_files: Separate drainage grids in the ordinary attempt store.
    """
    storage, row, artifact = routing_dem_files
    declarations = declare_model_files(row, artifact)
    assert [file.name for file in declarations] == [
        "total",
        "routing_dem_drain_2",
        "routing_dem_drain_3",
    ]
    assert [file.label for file in declarations[1:]] == [
        "Terrain used for routing · Drain 2",
        "Terrain used for routing · Drain 3",
    ]
    manifest = storage.publish("a" * 32, 0, declarations, Event())
    for file, original in zip(
        manifest.files[1:], artifact.additional_outputs, strict=True
    ):
        path = storage.artifact_path("a" * 32, file.storage_name)
        assert file.role == "intermediate" and file.media_type == "image/tiff"
        assert hashlib.sha256(path.read_bytes()).hexdigest() == original.sha256
        with rasterio.open(path) as raster:
            assert raster.nodata == -9999
            assert raster.read_masks(1)[0, 2] == 0
    storage.remove_orphans(set(), -1)
    with pytest.raises(ProcessingError, match="no longer available"):
        storage.artifact_path("a" * 32, manifest.files[1].storage_name)


def test_omitted_collection_is_discarded_with_scratch(
    routing_dem_files: tuple[LocalJobArtifacts, dict[str, Any], AggregateArtifact],
) -> None:
    """A recipe must request the collection before any of its files are retained.

    Args:
        routing_dem_files: A completed operation with optional routing DEMs.
    """
    storage, row, artifact = routing_dem_files
    del row["summary"]["outputs"]["routing_dem"]
    manifest = storage.publish("a" * 32, 0, declare_model_files(row, artifact), Event())
    assert [file.name for file in manifest.files] == ["total"]
    with pytest.raises(ProcessingError, match="no longer available"):
        storage.artifact_path("a" * 32, artifact.additional_outputs[0].storage_name)


def test_many_drainage_files_publish_without_an_inventory_ceiling(
    routing_dem_files: tuple[LocalJobArtifacts, dict[str, Any], AggregateArtifact],
) -> None:
    """A large collection survives storage, persisted reads and public response validation.

    Args:
        routing_dem_files: Real GeoTIFFs to repeat as independently named outputs.
    """
    storage, row, artifact = routing_dem_files
    source_manifest = storage.publish(
        "a" * 32, 0, declare_model_files(row, artifact), Event()
    )
    directory = storage.prepare("b" * 32, 0, ProcessingLimits())
    for source in source_manifest.files[:2]:
        (directory / source.storage_name).write_bytes(
            storage.artifact_path("a" * 32, source.storage_name).read_bytes()
        )
    original = artifact.additional_outputs[0]
    data = (directory / original.storage_name).read_bytes()
    files = []
    for drain in range(200):
        name = f"routing_dem_drain_{drain}"
        (directory / f"{name}.tif").write_bytes(data)
        files.append(
            replace(
                original,
                name=name,
                storage_name=f"{name}.tif",
                filename=f"{name}.tif",
                member_label=f"Drain {drain}",
            )
        )
    collection = replace(artifact, additional_outputs=tuple(files))
    manifest = storage.publish(
        "b" * 32, 0, declare_model_files(row, collection), Event()
    )
    assert len(manifest.files) == 201
    assert manifest.total_bytes - sum(file.size for file in manifest.files) > 64 * 1024
    response = ModelArtifactManifest.model_validate(
        serialize_model_artifacts(
            {
                "id": "b" * 32,
                "status": "ready",
                "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
                "artifact": {"manifest": asdict(manifest)},
            }
        )
    )
    assert len(response.files) == 201
    outcome = ModelOutcome(
        status="ready",
        error=None,
        statistics=None,
        artifacts=[file.model_dump(exclude={"url"}) for file in response.files],
    )
    assert len(outcome.artifacts) == 201


@pytest.mark.parametrize(
    "invalid",
    [
        "missing",
        "duplicate",
        "unknown-output",
        "wrong-format",
        "unlabelled-member",
        "single-as-collection",
        "collection-as-single",
        "wrong-role",
    ],
)
def test_collection_contract_rejects_invalid_native_results(
    routing_dem_files: tuple[LocalJobArtifacts, dict[str, Any], AggregateArtifact],
    invalid: str,
) -> None:
    """Reject incomplete or misdeclared collections before artifact publication.

    Args:
        routing_dem_files: Complete declarations and files before corruption.
        invalid: Contract violation to introduce at the native result boundary.
    """
    _, row, artifact = routing_dem_files
    first, second = artifact.additional_outputs
    if invalid == "missing":
        artifact = replace(artifact, additional_outputs=())
    elif invalid == "duplicate":
        artifact = replace(artifact, additional_outputs=(first, first))
    elif invalid == "wrong-role":
        row["summary"]["outputs"]["routing_dem"]["role"] = "result"
    else:
        changes = {
            "unknown-output": {"output_name": "unknown"},
            "wrong-format": {"media_type": "text/csv"},
            "unlabelled-member": {"member_label": None},
            "single-as-collection": {"output_name": "coverage"},
            "collection-as-single": {
                "name": "routing_dem",
                "output_name": None,
                "member_label": None,
            },
        }[invalid]
        artifact = replace(
            artifact, additional_outputs=(replace(first, **changes), second)
        )
    with pytest.raises(ProcessingError) as error:
        declare_model_files(row, artifact)
    assert error.value.code == "invalid_model_result"
