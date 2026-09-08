"""AOI geometry size diagnostics through real Processing HTTP composition."""

from dataclasses import replace
import json
from pathlib import Path
from typing import Any

import pytest

from eolab_app.processing.clip_models import RasterClipLimits
from test_processing_jobs import boundary, store, HEADERS, write_geopackage_layer
from test_raster_clips import SOURCE


@pytest.mark.parametrize(
    "store", [replace(RasterClipLimits(), max_geometry_bytes=100)], indirect=True
)
@pytest.mark.parametrize("operation", ["raster-clips", "raster-calculations"])
def test_aoi_size_error_reports_snapshot_bytes_and_configured_limit(
    boundary: Any, tmp_path: Path, operation: str
) -> None:
    """An uploaded AOI gets actionable geometry limits in both public plan APIs.

    Args:
        boundary: Real AOI, source, PostgreSQL and Processing route composition.
        tmp_path: Isolated upload fixture storage.
        operation: Clip or calculation planning endpoint.
    """
    client, *_ = boundary
    geometry = {
        "type": "Polygon",
        "coordinates": [[[0.1, 9.1], [0.9, 9.1], [0.9, 9.9], [0.1, 9.9], [0.1, 9.1]]],
    }
    upload = tmp_path / "area.gpkg"
    write_geopackage_layer(
        upload, "area", crs="EPSG:4326", geometry_type="Polygon", geometry=geometry
    )
    response = client.post(
        "/api/temporary-aois", files={"file": ("area.gpkg", upload.read_bytes())}
    )
    assert response.status_code == 201, response.text
    request = {"temporaryAoiId": response.json()["id"]}
    if operation == "raster-clips":
        request.update(SOURCE)
    else:
        request.update(
            sources={"a": SOURCE},
            calculations=[{"label": "Count", "expression": "count(a)"}],
        )
    response = client.post(
        f"/api/processing/{operation}/plan", json=request, headers=HEADERS
    )
    assert response.status_code == 413, response.text
    expected_bytes = len(
        json.dumps(
            {
                "kind": "aoi",
                "bounds": (0.1, 9.1, 0.9, 9.9),
                "geometries": (geometry,),
            }
        ).encode("utf-8")
    )
    detail = response.json()["detail"]
    assert detail["code"] == "aoi_too_large"
    assert f"serialized geometry is {expected_bytes:,} bytes" in detail["message"]
    assert (
        f"limit is 100 bytes ({expected_bytes - 100:,} bytes over)" in detail["message"]
    )
    assert "snapshot is at most 100 bytes" in detail["message"]
    assert str(tmp_path) not in response.text
    assert client.get("/api/processing/jobs").json() == {"jobs": []}
