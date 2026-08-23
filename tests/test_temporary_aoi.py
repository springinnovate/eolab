"""Test bounded temporary-AOI validation, HTTP, and lifecycle cleanup."""

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

import fiona
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.routes.temporary_aois import (
    MAX_MULTIPART_BODY_BYTES,
    create_temporary_aoi_router,
)
from eolab_app.sampling_area import SamplingAreaUnavailableError
from eolab_app.temporary_aoi.service import TemporaryAoiService
from eolab_app.temporary_aoi.validation import (
    MAX_UPLOAD_BYTES,
    MAX_ZIP_COMPRESSION_RATIO,
)


def write_geopackage_layer(
    path: Path,
    layer_name: str,
    *,
    crs: str | None = "EPSG:3857",
    geometry_type: str | None = "Polygon",
    geometry: dict[str, Any] | None = None,
    write_feature: bool = True,
) -> None:
    """Add one representative vector or nonspatial GeoPackage layer.

    Args:
        path: GeoPackage container path to create or extend.
        layer_name: Exact layer name to write.
        crs: Coordinate reference system, or ``None`` for a table.
        geometry_type: Fiona geometry schema, or ``None`` for a table.
        geometry: Optional fixture geometry in the source CRS.
        write_feature: Whether to write one row.

    Returns:
        None.
    """
    if geometry is None and geometry_type == "Polygon":
        geometry = {
            "type": "Polygon",
            "coordinates": [[
                [0, 0],
                [1_000, 0],
                [1_000, 1_000],
                [0, 1_000],
                [0, 0],
            ]],
        }
    with fiona.open(
        path,
        mode="w",
        driver="GPKG",
        layer=layer_name,
        crs=crs,
        schema={"geometry": geometry_type, "properties": {"secret": "str"}},
    ) as dataset:
        if write_feature:
            dataset.write({
                "geometry": geometry,
                "properties": {"secret": "must not reach browser"},
            })


def write_shapefile(path: Path) -> tuple[Path, ...]:
    """Create one complete WGS 84 zipped-Shapefile fixture source.

    Args:
        path: `.shp` component path to create.

    Returns:
        All generated component paths ordered by filename.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with fiona.open(
        path,
        mode="w",
        driver="ESRI Shapefile",
        crs="EPSG:4326",
        schema={"geometry": "Polygon", "properties": {}},
    ) as dataset:
        dataset.write({
            "geometry": {
                "type": "Polygon",
                "coordinates": [[
                    [-123, 47],
                    [-122, 47],
                    [-122, 48],
                    [-123, 48],
                    [-123, 47],
                ]],
            },
            "properties": {},
        })
    return tuple(sorted(path.parent.glob(f"{path.stem}.*")))


def build_client(
    service: TemporaryAoiService,
    maximum_upload_bytes: int = MAX_UPLOAD_BYTES,
) -> TestClient:
    """Create a minimal application containing only temporary-AOI routes.

    Args:
        service: Isolated lifecycle service used by the route.
        maximum_upload_bytes: Maximum file bytes accepted by the route.

    Returns:
        Synchronous FastAPI test client.
    """
    application = FastAPI()
    application.include_router(
        create_temporary_aoi_router(service, maximum_upload_bytes)
    )
    return TestClient(application)


def close_service(service: TemporaryAoiService) -> None:
    """Close one lifecycle service from a synchronous test.

    Args:
        service: Service whose files and tasks must be cleaned up.

    Returns:
        None.
    """
    asyncio.run(service.close())


def test_single_layer_geopackage_returns_bounded_wgs84_geometry_and_removes(
    tmp_path: Path,
) -> None:
    """Transform with longitude-first axes and omit uploaded attributes.

    Args:
        tmp_path: Isolated parent for fixture and service storage.

    Returns:
        None.
    """
    source_path = tmp_path / "source.gpkg"
    write_geopackage_layer(source_path, "AOI")
    service = TemporaryAoiService(tmp_path / "temporary")
    client = build_client(service)

    with source_path.open("rb") as source:
        response = client.post(
            "/api/temporary-aois",
            files={
                "file": (
                    "client-name.gpkg",
                    source,
                    "application/geopackage+sqlite3",
                )
            },
        )

    assert response.status_code == 201
    document = response.json()
    assert document["state"] == "ready"
    assert document["filename"] == "client-name.gpkg"
    assert document["selectedDataset"] == "AOI"
    assert document["bbox"] == pytest.approx([0, 0, 0.008983152841, 0.008983152804])
    assert document["geometry"]["type"] == "FeatureCollection"
    assert document["geometry"]["features"][0]["properties"] == {}
    assert "temporary" not in str(document)
    temporary_id = document["id"]
    assert (service.root_path / temporary_id / "source.gpkg").exists()

    removal = client.delete(f"/api/temporary-aois/{temporary_id}")

    assert removal.status_code == 204
    assert not (service.root_path / temporary_id).exists()
    assert client.delete(f"/api/temporary-aois/{temporary_id}").status_code == 404
    close_service(service)


def test_temporary_aoi_sampling_port_returns_only_ready_polygonal_geometry(
    tmp_path: Path,
) -> None:
    """Resolve immutable polygons while rejecting ready non-areal uploads.

    Args:
        tmp_path: Isolated parent for fixture and service storage.

    Returns:
        None.
    """
    polygon_path = tmp_path / "polygon.gpkg"
    point_path = tmp_path / "point.gpkg"
    write_geopackage_layer(polygon_path, "area")
    write_geopackage_layer(
        point_path,
        "marker",
        crs="EPSG:4326",
        geometry_type="Point",
        geometry={"type": "Point", "coordinates": [-122, 48]},
    )
    polygon_service = TemporaryAoiService(tmp_path / "temporary-polygon-sampling")
    point_service = TemporaryAoiService(tmp_path / "temporary-point-sampling")
    polygon_client = build_client(polygon_service)
    point_client = build_client(point_service)
    with polygon_path.open("rb") as source:
        polygon_response = polygon_client.post(
            "/api/temporary-aois",
            files={"file": ("polygon.gpkg", source)},
        ).json()
    with point_path.open("rb") as source:
        point_response = point_client.post(
            "/api/temporary-aois",
            files={"file": ("point.gpkg", source)},
        ).json()

    resolved = asyncio.run(
        polygon_service.resolve_for_sampling(polygon_response["id"])
    )

    assert resolved.identity.reference == polygon_response["id"]
    assert resolved.bounds == tuple(polygon_response["bbox"])
    assert len(resolved.geometries) == 1
    assert resolved.geometries[0].geometry_type == "Polygon"
    assert "geometry" not in resolved.__dict__
    with pytest.raises(SamplingAreaUnavailableError, match="no polygonal area"):
        asyncio.run(point_service.resolve_for_sampling(point_response["id"]))

    close_service(polygon_service)
    close_service(point_service)


def test_multiple_geopackage_layers_require_opaque_selection(
    tmp_path: Path,
) -> None:
    """List explicit choices and read only the selected usable layer.

    Args:
        tmp_path: Isolated parent for fixture and service storage.

    Returns:
        None.
    """
    source_path = tmp_path / "multi.gpkg"
    write_geopackage_layer(source_path, "areas")
    write_geopackage_layer(
        source_path,
        "sites",
        crs="EPSG:4326",
        geometry_type="Point",
        geometry={"type": "Point", "coordinates": [-122, 48]},
    )
    write_geopackage_layer(
        source_path,
        "notes",
        crs=None,
        geometry_type=None,
    )
    service = TemporaryAoiService(tmp_path / "temporary")
    client = build_client(service)

    response = client.post(
        "/api/temporary-aois",
        files={"file": ("multi.gpkg", source_path.read_bytes())},
    )

    assert response.status_code == 202
    selection = response.json()
    assert selection["state"] == "selectionRequired"
    assert [choice["label"] for choice in selection["choices"]] == [
        "areas",
        "sites",
    ]
    assert all(choice["id"] != choice["label"] for choice in selection["choices"])
    assert client.post(
        f"/api/temporary-aois/{selection['id']}/selection",
        json={"choiceId": "A" * 32},
    ).status_code == 409

    ready = client.post(
        f"/api/temporary-aois/{selection['id']}/selection",
        json={"choiceId": selection["choices"][1]["id"]},
    )

    assert ready.status_code == 200
    assert ready.json()["selectedDataset"] == "sites"
    assert ready.json()["bbox"] == [-122, 48, -122, 48]
    close_service(service)


@pytest.mark.parametrize(
    ("geometry_type", "expected_detail"),
    (
        ("Polygon", "coordinate reference system"),
        (None, "nonspatial"),
    ),
)
def test_geopackage_rejects_missing_crs_and_nonspatial_layers(
    tmp_path: Path,
    geometry_type: str | None,
    expected_detail: str,
) -> None:
    """Return specific errors for unusable GeoPackage layer contracts.

    Args:
        tmp_path: Isolated parent for GeoPackage fixtures and storage.
        geometry_type: Spatial schema without a CRS, or a nonspatial schema.
        expected_detail: Actionable validation detail required in the response.

    Returns:
        None.
    """
    source_path = tmp_path / "unusable.gpkg"
    write_geopackage_layer(
        source_path,
        "unusable",
        crs=None,
        geometry_type=geometry_type,
    )
    service = TemporaryAoiService(tmp_path / "temporary")
    client = build_client(service)

    response = client.post(
        "/api/temporary-aois",
        files={"file": ("unusable.gpkg", source_path.read_bytes())},
    )

    assert response.status_code == 422
    assert expected_detail in response.json()["detail"]
    assert not any(service.root_path.iterdir())
    close_service(service)


def test_zipped_shapefile_upload_extracts_safely_and_cleans_up(
    tmp_path: Path,
) -> None:
    """Accept sidecars in one ZIP without exposing extraction paths.

    Args:
        tmp_path: Isolated parent for archive and service storage.

    Returns:
        None.
    """
    components = write_shapefile(tmp_path / "source" / "habitat.shp")
    archive_path = tmp_path / "habitat.zip"
    with ZipFile(archive_path, mode="w", compression=ZIP_DEFLATED) as archive:
        for component in components:
            archive.write(component, arcname=f"nested/{component.name}")
    service = TemporaryAoiService(tmp_path / "temporary")
    client = build_client(service)

    response = client.post(
        "/api/temporary-aois",
        files={"file": ("habitat.zip", archive_path.read_bytes())},
    )

    assert response.status_code == 201
    document = response.json()
    assert document["selectedDataset"] == "nested/habitat.shp"
    assert document["bbox"] == [-123, 47, -122, 48]
    assert str(service.root_path) not in str(document)
    resolved = asyncio.run(service.resolve_for_sampling(document["id"]))
    assert resolved.identity.reference == document["id"]
    assert len(resolved.geometries) == 1
    assert resolved.geometries[0].geometry_type == "Polygon"
    assert client.delete(f"/api/temporary-aois/{document['id']}").status_code == 204
    assert not any(service.root_path.iterdir())
    close_service(service)


def test_multiple_zipped_shapefiles_require_explicit_dataset_selection(
    tmp_path: Path,
) -> None:
    """Return opaque choices for each complete internal Shapefile.

    Args:
        tmp_path: Isolated parent for archive and service storage.

    Returns:
        None.
    """
    roads = write_shapefile(tmp_path / "roads-source" / "roads.shp")
    habitat = write_shapefile(tmp_path / "habitat-source" / "habitat.shp")
    archive_path = tmp_path / "multi.zip"
    with ZipFile(archive_path, mode="w", compression=ZIP_DEFLATED) as archive:
        for component in roads:
            archive.write(component, arcname=f"transport/{component.name}")
        for component in habitat:
            archive.write(component, arcname=f"ecology/{component.name}")
    service = TemporaryAoiService(tmp_path / "temporary")
    client = build_client(service)

    response = client.post(
        "/api/temporary-aois",
        files={"file": ("multi.zip", archive_path.read_bytes())},
    )

    assert response.status_code == 202
    document = response.json()
    assert [choice["label"] for choice in document["choices"]] == [
        "ecology/habitat.shp",
        "transport/roads.shp",
    ]
    ready = client.post(
        f"/api/temporary-aois/{document['id']}/selection",
        json={"choiceId": document["choices"][0]["id"]},
    )
    assert ready.status_code == 200
    assert ready.json()["selectedDataset"] == "ecology/habitat.shp"
    close_service(service)


@pytest.mark.parametrize(
    ("member_name", "expected_detail"),
    (
        ("../roads.shp", "safe relative path"),
        ("nested\\roads.shp", "unsafe path"),
        ("nested/archive.zip", "nested inside"),
    ),
)
def test_zip_rejects_unsafe_and_nested_paths_without_leaking_files(
    tmp_path: Path,
    member_name: str,
    expected_detail: str,
) -> None:
    """Reject unsafe ZIP identities and clean every failed upload directory.

    Args:
        tmp_path: Isolated parent for archive and service storage.
        member_name: Unsafe internal path under test.
        expected_detail: Required actionable response fragment.

    Returns:
        None.
    """
    archive_path = tmp_path / "unsafe.zip"
    with ZipFile(archive_path, mode="w") as archive:
        archive.writestr(member_name, b"unsafe")
    if "\\" in member_name:
        archive_path.write_bytes(
            archive_path.read_bytes().replace(
                member_name.replace("\\", "/").encode("utf-8"),
                member_name.encode("utf-8"),
            )
        )
    service = TemporaryAoiService(tmp_path / "temporary")
    client = build_client(service)

    response = client.post(
        "/api/temporary-aois",
        files={"file": ("unsafe.zip", archive_path.read_bytes())},
    )

    assert response.status_code == 422
    assert expected_detail in response.json()["detail"]
    assert not any(service.root_path.iterdir())
    close_service(service)


def test_zip_rejects_incomplete_dataset_and_decompression_bomb(
    tmp_path: Path,
) -> None:
    """Return specific errors for sidecar and compression-ratio failures.

    Args:
        tmp_path: Isolated parent for archives and service storage.

    Returns:
        None.
    """
    incomplete_path = tmp_path / "incomplete.zip"
    with ZipFile(incomplete_path, mode="w") as archive:
        archive.writestr("roads.shp", b"not complete")
    bomb_path = tmp_path / "bomb.zip"
    with ZipFile(bomb_path, mode="w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("roads.shp", b"0" * 100_000)
    service = TemporaryAoiService(tmp_path / "temporary")
    client = build_client(service)

    incomplete = client.post(
        "/api/temporary-aois",
        files={"file": ("incomplete.zip", incomplete_path.read_bytes())},
    )
    bomb = client.post(
        "/api/temporary-aois",
        files={"file": ("bomb.zip", bomb_path.read_bytes())},
    )

    assert incomplete.status_code == 422
    assert "missing .dbf, .prj, .shx" in incomplete.json()["detail"]
    assert bomb.status_code == 413
    assert f"{MAX_ZIP_COMPRESSION_RATIO:g}:1" in bomb.json()["detail"]
    assert not any(service.root_path.iterdir())
    close_service(service)


def test_replace_is_atomic_across_failure_and_success(tmp_path: Path) -> None:
    """Retain the old AOI on failure and remove it after success.

    Args:
        tmp_path: Isolated parent for GeoPackage fixtures and storage.

    Returns:
        None.
    """
    first_path = tmp_path / "first.gpkg"
    second_path = tmp_path / "second.gpkg"
    write_geopackage_layer(first_path, "first")
    write_geopackage_layer(second_path, "second")
    service = TemporaryAoiService(tmp_path / "temporary")
    client = build_client(service)
    first = client.post(
        "/api/temporary-aois",
        files={"file": ("first.gpkg", first_path.read_bytes())},
    ).json()

    failed = client.post(
        "/api/temporary-aois",
        files={
            "file": ("bad.gpkg", b"not a geopackage"),
            "replacementId": (None, first["id"]),
        },
    )

    assert failed.status_code == 422
    assert (service.root_path / first["id"]).exists()
    replaced = client.post(
        "/api/temporary-aois",
        files={
            "file": ("second.gpkg", second_path.read_bytes()),
            "replacementId": (None, first["id"]),
        },
    )
    assert replaced.status_code == 201
    assert not (service.root_path / first["id"]).exists()
    close_service(service)


def test_expiration_and_shutdown_remove_abandoned_uploads(tmp_path: Path) -> None:
    """Expire fixed-TTL records and remove all remaining files on shutdown.

    Args:
        tmp_path: Isolated parent for GeoPackage fixtures and storage.

    Returns:
        None.
    """
    current_time = [datetime(2026, 8, 22, tzinfo=timezone.utc)]
    source_path = tmp_path / "aoi.gpkg"
    write_geopackage_layer(source_path, "aoi")
    service = TemporaryAoiService(
        tmp_path / "temporary",
        ttl=timedelta(seconds=10),
        now=lambda: current_time[0],
    )
    client = build_client(service)
    uploaded = client.post(
        "/api/temporary-aois",
        files={"file": ("aoi.gpkg", source_path.read_bytes())},
    ).json()
    current_time[0] += timedelta(seconds=10)

    assert asyncio.run(service.expire()) == 1
    assert client.delete(f"/api/temporary-aois/{uploaded['id']}").status_code == 404
    assert not any(service.root_path.iterdir())
    close_service(service)
    assert not service.root_path.exists()


def test_multipart_contract_rejects_unknown_fields_and_media_types(
    tmp_path: Path,
) -> None:
    """Reject extra multipart input before it reaches the lifecycle service.

    Args:
        tmp_path: Isolated parent for service storage.

    Returns:
        None.
    """
    service = TemporaryAoiService(tmp_path / "temporary")
    client = build_client(service)

    extra = client.post(
        "/api/temporary-aois",
        files={"file": ("aoi.gpkg", b"data")},
        data={"unexpected": "value"},
    )
    wrong_media = client.post(
        "/api/temporary-aois",
        content=b"raw bytes",
        headers={"content-type": "application/octet-stream"},
    )

    assert extra.status_code == 400
    assert "unsupported field" in extra.json()["detail"]
    assert wrong_media.status_code == 400
    assert "multipart/form-data" in wrong_media.json()["detail"]
    close_service(service)


def test_multipart_allows_exact_file_limit_and_rejects_excessive_body(
    tmp_path: Path,
) -> None:
    """Separate the 25 MiB file ceiling from bounded multipart framing.

    Args:
        tmp_path: Isolated parent for service storage.

    Returns:
        None.
    """
    service = TemporaryAoiService(tmp_path / "temporary")
    client = build_client(service)

    exact_file = client.post(
        "/api/temporary-aois",
        files={"file": ("exact.gpkg", b"x" * MAX_UPLOAD_BYTES)},
    )
    excessive_body = client.post(
        "/api/temporary-aois",
        content=b"x",
        headers={
            "content-type": "multipart/form-data; boundary=bounded",
            "content-length": str(MAX_MULTIPART_BODY_BYTES + 1),
        },
    )

    assert exact_file.status_code == 422
    assert "malformed or unreadable" in exact_file.json()["detail"]
    assert excessive_body.status_code == 413
    assert "multipart requests" in excessive_body.json()["detail"]
    assert not any(service.root_path.iterdir())
    close_service(service)


def test_configured_upload_limit_applies_at_route_and_service_boundaries(
    tmp_path: Path,
) -> None:
    """Apply the deployment file limit during streaming and durable copying.

    Args:
        tmp_path: Isolated parent for service storage.

    Returns:
        None.
    """
    route_limited_service = TemporaryAoiService(
        tmp_path / "route-limited",
        maximum_upload_bytes=8,
    )
    route_limited_client = build_client(route_limited_service, 4)
    route_response = route_limited_client.post(
        "/api/temporary-aois",
        files={"file": ("route.gpkg", b"12345")},
    )

    service_limited_service = TemporaryAoiService(
        tmp_path / "service-limited",
        maximum_upload_bytes=4,
    )
    service_limited_client = build_client(service_limited_service, 8)
    service_response = service_limited_client.post(
        "/api/temporary-aois",
        files={"file": ("service.gpkg", b"12345")},
    )

    assert route_response.status_code == 413
    assert "4-byte limit" in route_response.json()["detail"]
    assert service_response.status_code == 413
    assert "cannot exceed 4 bytes" in service_response.json()["detail"]
    assert (
        not route_limited_service.root_path.exists()
        or not any(route_limited_service.root_path.iterdir())
    )
    assert not any(service_limited_service.root_path.iterdir())
    close_service(route_limited_service)
    close_service(service_limited_service)


def test_hard_processing_timeout_terminates_worker_before_cleanup(
    tmp_path: Path,
) -> None:
    """Enforce a wall-time deadline without leaving a worker-owned file.

    Args:
        tmp_path: Isolated parent for fixture and service storage.

    Returns:
        None.
    """
    source_path = tmp_path / "aoi.gpkg"
    write_geopackage_layer(source_path, "aoi")
    service = TemporaryAoiService(
        tmp_path / "temporary",
        processing_seconds=0.001,
    )
    client = build_client(service)

    response = client.post(
        "/api/temporary-aois",
        files={"file": ("aoi.gpkg", source_path.read_bytes())},
    )

    assert response.status_code == 422
    assert "exceeded" in response.json()["detail"]
    assert not any(service.root_path.iterdir())
    close_service(service)


def test_storage_root_cannot_overlap_repository_or_scan_source(
    tmp_path: Path,
) -> None:
    """Reject storage nested within either forbidden durable data root.

    Args:
        tmp_path: Isolated parent representing a forbidden root.

    Returns:
        None.
    """
    forbidden_root = tmp_path / "repository-or-scan"
    forbidden_root.mkdir()

    with pytest.raises(ValueError, match="must not overlap"):
        TemporaryAoiService(
            forbidden_root / "temporary-uploads",
            forbidden_roots=(forbidden_root,),
        )


def test_processing_returns_geometry_larger_than_process_pipe_buffer(
    tmp_path: Path,
) -> None:
    """Consume a large worker result before joining its queue feeder.

    Args:
        tmp_path: Isolated parent for fixture and service storage.

    Returns:
        None.
    """
    source_path = tmp_path / "large.gpkg"
    coordinates = [
        [-120 + index / 1_000_000, 45 + (index % 10) / 1_000_000]
        for index in range(6_000)
    ]
    write_geopackage_layer(
        source_path,
        "large",
        crs="EPSG:4326",
        geometry_type="LineString",
        geometry={"type": "LineString", "coordinates": coordinates},
    )
    service = TemporaryAoiService(tmp_path / "temporary")
    client = build_client(service)

    response = client.post(
        "/api/temporary-aois",
        files={"file": ("large.gpkg", source_path.read_bytes())},
    )

    assert response.status_code == 201
    assert len(json.dumps(response.json()["geometry"])) > 65_536
    close_service(service)
