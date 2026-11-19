"""Exercise real mask admission and the shared polygon/raster upload boundary."""

import hashlib
from pathlib import Path
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient
import numpy
import pytest
import rasterio
from rasterio.transform import from_origin

from eolab_app.raster_uploads import RasterUploadStore
from eolab_app.routes.browser_identity import COOKIE
from eolab_app.routes.raster_uploads import create_raster_uploads_router
from eolab_app.routes.uploads import create_uploads_router
from eolab_app.routes.vector_uploads import create_vector_uploads_router
from eolab_app.upload_storage import UploadStorage
from eolab_app.vector_uploads import VectorUploadStore
from test_vector_uploads import HEADERS, write_layer


def mask_bytes(
    path: Path,
    *,
    value: int = 1,
    dtype: str = "uint8",
    count: int = 1,
    crs: str | None = "EPSG:4326",
) -> bytes:
    """Write a small real mask containing a candidate reference and a NoData cell.

    Args:
        path: Disposable GeoTIFF fixture path.
        value: Candidate reference value in the first cell.
        dtype: Native data type for admission tests.
        count: Number of bands to write.
        crs: Declared spatial reference, or None for an invalid mask.

    Returns:
        Complete GeoTIFF bytes after the native writer closes.
    """
    values = numpy.zeros((count, 4, 4), dtype=dtype)
    values[:, 0, 0] = value
    values[:, 1, 1] = 255
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=4,
        height=4,
        count=count,
        dtype=dtype,
        crs=crs,
        transform=from_origin(-4, 4, 1, 1),
        nodata=255,
        compress="deflate",
    ) as dataset:
        dataset.write(values)
    return path.read_bytes()


def upload_client(
    storage: UploadStorage,
    *,
    decoded_bytes: int = 256 * 1024**2,
    block_bytes: int = 16 * 1024**2,
) -> TestClient:
    """Mount both real upload adapters and the common inventory with one budget.

    Args:
        storage: Shared storage rooted in the test directory.
        decoded_bytes: Raster-only decoded-source admission ceiling.
        block_bytes: Raster-only decoded native-block admission ceiling.

    Returns:
        HTTPS client whose context initializes upload storage.
    """
    application = FastAPI()
    application.include_router(
        create_vector_uploads_router(
            VectorUploadStore(storage.root, None, storage=storage)
        )
    )
    application.include_router(create_uploads_router(storage))
    application.include_router(
        create_raster_uploads_router(
            RasterUploadStore(storage, decoded_bytes, block_bytes)
        )
    )
    return TestClient(application, base_url="https://testserver")


def test_binary_mask_is_private_immutable_and_visible_in_shared_inventory(
    tmp_path: Path,
) -> None:
    """Admit a mask once and preserve its bytes, privacy and combined usage metadata.

    Args:
        tmp_path: Disposable upload storage and GeoTIFF fixture.
    """
    storage = UploadStorage(tmp_path / "uploads")
    body = mask_bytes(tmp_path / "reference.tif")
    with upload_client(storage) as client:
        response = client.post(
            "/api/raster-uploads",
            params={"name": "Reference sites"},
            headers=HEADERS,
            content=body,
        )
        assert response.status_code == 201, response.text
        record = response.json()
        assert record["kind"] == "raster"
        assert record["reference_cells"] == 1
        assert record["sha256"] == hashlib.sha256(body).hexdigest()
        assert record["bounds"] == [-4, 0, 0, 4]
        assert response.headers["cache-control"] == "private, no-store"
        owner = hashlib.sha256(client.cookies[COOKIE].encode()).hexdigest()
        _, path = storage.get_upload_source(owner, UUID(record["id"]), "raster")
        assert path.read_bytes() == body
        summary = client.get("/api/uploads").json()
        assert summary["used_files"] == 1
        assert summary["max_files"] == 100
        assert summary["uploads"][0]["expires_at"] == record["expires_at"]
        client.cookies.clear()
        unavailable = client.get(f"/api/raster-uploads/{record['id']}")
        assert unavailable.status_code == 404
        assert str(tmp_path) not in unavailable.text
        assert client.get("/api/uploads").json()["uploads"] == []


@pytest.mark.parametrize(
    "options",
    [{"value": 2}, {"value": 0}, {"dtype": "uint16"}, {"count": 2}, {"crs": None}],
)
def test_unsupported_masks_leave_no_stored_file(
    tmp_path: Path, options: dict[str, object]
) -> None:
    """Reject unsupported or meaningless masks without consuming a shared slot.

    Args:
        tmp_path: Disposable upload storage and candidate fixture.
        options: Invalid source characteristic passed to the native writer.
    """
    storage = UploadStorage(tmp_path / "uploads")
    body = mask_bytes(tmp_path / "candidate.tif", **options)
    with upload_client(storage) as client:
        response = client.post(
            "/api/raster-uploads",
            params={"name": "Candidate"},
            headers=HEADERS,
            content=body,
        )
        assert response.status_code == 422, response.text
        assert client.get("/api/uploads").json()["used_files"] == 0
        assert list(storage.root.glob("*/.pending-*")) == []


def test_compressed_mask_is_checked_against_decoded_size(tmp_path: Path) -> None:
    """Apply raster admission limits to decoded cells before scanning values.

    Args:
        tmp_path: Disposable storage and compressed mask fixture.
    """
    storage = UploadStorage(tmp_path / "uploads")
    with upload_client(storage, decoded_bytes=8) as client:
        response = client.post(
            "/api/raster-uploads",
            params={"name": "Too many cells"},
            headers=HEADERS,
            content=mask_bytes(tmp_path / "compressed.tif"),
        )
        assert response.status_code == 422
        assert "uncompressed" in response.json()["detail"]
        assert client.get("/api/uploads").json()["used_files"] == 0


def test_polygons_and_rasters_share_slots_and_deletion_frees_one(
    tmp_path: Path,
) -> None:
    """Enforce one allowance across both real HTTP adapters and permit replacement.

    Args:
        tmp_path: Disposable shared volume and source fixtures.
    """
    storage = UploadStorage(tmp_path / "uploads")
    polygon = write_layer(tmp_path / "polygons.gpkg")
    raster = mask_bytes(tmp_path / "mask.tif")
    with upload_client(storage) as client:
        for index in range(99):
            response = client.post(
                "/api/vector-uploads",
                params={"name": f"Polygons {index}"},
                headers=HEADERS,
                content=polygon,
            )
            assert response.status_code == 201, response.text
        accepted = client.post(
            "/api/raster-uploads",
            params={"name": "Reference mask"},
            headers=HEADERS,
            content=raster,
        )
        assert accepted.status_code == 201, accepted.text
        rejected = client.post(
            "/api/vector-uploads",
            params={"name": "Extra polygons"},
            headers=HEADERS,
            content=polygon,
        )
        assert rejected.status_code == 409, rejected.text
        assert "upload limit (100)" in rejected.json()["detail"]
        summary = client.get("/api/uploads").json()
        assert summary["used_files"] == summary["max_files"] == 100
        removed = client.delete(
            f"/api/raster-uploads/{accepted.json()['id']}", headers=HEADERS
        )
        assert removed.status_code == 204
        assert client.get("/api/uploads").json()["used_files"] == 99
        replacement = client.post(
            "/api/raster-uploads",
            params={"name": "Replacement"},
            headers=HEADERS,
            content=raster,
        )
        assert replacement.status_code == 201, replacement.text


def test_native_blocks_are_bounded_before_pixel_decoding(tmp_path: Path) -> None:
    """Reject a compressed TIFF whose native block exceeds inspection capacity.

    Args:
        tmp_path: Disposable source fixture and storage.
    """
    storage = UploadStorage(tmp_path / "uploads")
    with upload_client(storage, block_bytes=16) as client:
        response = client.post(
            "/api/raster-uploads",
            params={"name": "Large block"},
            headers=HEADERS,
            content=mask_bytes(tmp_path / "block.tif"),
        )
        assert response.status_code == 422
        assert "block" in response.json()["detail"]
        assert client.get("/api/uploads").json()["used_files"] == 0


def test_other_containers_and_cross_origin_uploads_are_rejected(tmp_path: Path) -> None:
    """Allow only actual GeoTIFFs received through the private same-origin boundary.

    Args:
        tmp_path: Disposable upload volume.
    """
    storage = UploadStorage(tmp_path / "uploads")
    with upload_client(storage) as client:
        response = client.post(
            "/api/raster-uploads",
            params={"name": "Not a TIFF"},
            headers=HEADERS,
            content=b'<VRTDataset rasterXSize="4" rasterYSize="4"></VRTDataset>',
        )
        assert response.status_code == 422
        denied = client.post(
            "/api/raster-uploads",
            params={"name": "Cross-site"},
            headers={**HEADERS, "Origin": "https://another.example"},
            content=b"not admitted",
        )
        assert denied.status_code == 403
        assert denied.headers["cache-control"] == "private, no-store"
        assert client.get("/api/uploads").json()["used_files"] == 0


def test_raster_admission_limits_are_configurable_positive_bytes(
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep raster upload limits at their configured external admission boundary.

    Args:
        configured_environment: Complete application settings fixture.
        version_file_path: Disposable application version file.
        monkeypatch: Isolated administrator configuration.
    """
    from eolab_app.settings import load_settings

    monkeypatch.setenv("RASTER_UPLOAD_MAX_DECODED_BYTES", "1024")
    monkeypatch.setenv("RASTER_UPLOAD_MAX_BLOCK_BYTES", "128")
    settings = load_settings(version_file_path)
    assert settings.raster_upload_max_decoded_bytes == 1024
    assert settings.raster_upload_max_block_bytes == 128
    for variable in (
        "RASTER_UPLOAD_MAX_DECODED_BYTES",
        "RASTER_UPLOAD_MAX_BLOCK_BYTES",
    ):
        for invalid in ("0", "-1", "1.5", ""):
            monkeypatch.setenv(variable, invalid)
            with pytest.raises(ValueError):
                load_settings(version_file_path)
        monkeypatch.delenv(variable)
