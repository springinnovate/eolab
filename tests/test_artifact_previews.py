"""Bounded native preview reading and file-lifetime contract tests."""

import asyncio
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from eolab_app.rendering.artifact_preview import (
    ArtifactPreviewError,
    ArtifactPreviewService,
    artifact_preview_process,
    read_raster_preview,
    read_vector_preview,
)


def write_preview_raster(path: Path) -> Path:
    """Create numeric values with an internal mask and native NoData.

    Args:
        path: Isolated test output path.

    Returns:
        GeoTIFF path whose upper-left cell must remain transparent.
    """
    with (
        rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True),
        rasterio.open(
            path,
            "w",
            driver="GTiff",
            width=4,
            height=4,
            count=1,
            dtype="float32",
            crs="EPSG:4326",
            transform=from_origin(-5, 5, 1, 1),
            nodata=-9999,
        ) as target,
    ):
        values = np.arange(16, dtype="float32").reshape(4, 4)
        values[3, 3] = -9999
        target.write(values, 1)
        mask = np.full((4, 4), 255, dtype="uint8")
        mask[0, 0] = 0
        mask[3, 3] = 0
        target.write_mask(mask)
    return path


def test_raster_preview_keeps_masks_and_projects_to_map(tmp_path: Path) -> None:
    """Preserve internal validity masks while limiting display cells and geographic bounds.

    Args:
        tmp_path: Isolated filesystem root.
    """
    data = read_raster_preview(write_preview_raster(tmp_path / "masked.tif"))
    assert data["bounds"] == [-5, 1, -1, 5]
    assert data["width"] <= 512 and data["height"] <= 512
    assert data["values"][0] is None and data["values"][-1] is None
    assert {value for value in data["values"] if value is not None} == set(range(1, 15))


class Capture:
    """Capture the native target's single supervised response."""

    def put(self, value: dict[str, Any]) -> None:
        """Retain one response for assertions.

        Args:
            value: Native success or sanitized error envelope.
        """
        self.value = value


def test_native_preview_checks_checksum_before_read(tmp_path: Path) -> None:
    """A same-sized changed file cannot be served under its old immutable identity.

    Args:
        tmp_path: Isolated filesystem root.
    """
    path = write_preview_raster(tmp_path / "changed.tif")
    captured = Capture()
    artifact_preview_process(
        captured, path, "image/tiff", path.stat().st_size, "0" * 64
    )
    assert "changed" in captured.value["error"]
    assert str(path) not in json.dumps(captured.value)


@pytest.mark.parametrize(
    "geometry",
    [
        {"type": "Point", "coordinates": [0, 2]},
        {"type": "LineString", "coordinates": [[0, 2], [1, 3]]},
        {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [0, 1], [0, 0]]]},
    ],
)
def test_vector_preview_strips_properties(
    tmp_path: Path, geometry: dict[str, Any]
) -> None:
    """Deliver bounded display geometry without carrying arbitrary property content.

    Args:
        tmp_path: Isolated filesystem root.
        geometry: Each supported geometry family.
    """
    path = tmp_path / "area.geojson"
    path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"html": "<script>bad()</script>"},
                        "geometry": geometry,
                    }
                ],
            }
        )
    )
    result = read_vector_preview(path)
    assert result["geojson"]["features"][0]["properties"] == {}
    assert result["geojson"]["features"][0]["geometry"] == geometry


@pytest.mark.parametrize(
    "coordinates", [[181, 0], [0, 90], [True, 0], [float("nan"), 0], []]
)
def test_vector_preview_rejects_invalid_coordinates(
    tmp_path: Path, coordinates: list[Any]
) -> None:
    """Reject unsupported or nonfinite coordinate data before it reaches the browser.

    Args:
        tmp_path: Isolated filesystem root.
        coordinates: Invalid point position.
    """
    path = tmp_path / "invalid.geojson"
    path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "geometry": {"type": "Point", "coordinates": coordinates},
                    }
                ],
            }
        )
    )
    with pytest.raises(ValueError):
        read_vector_preview(path)


@dataclass
class LeasedFile:
    """Test implementation of the authorized immutable preview-file contract."""

    path: Path
    size: int
    sha256: str
    media_type: str = "image/tiff"
    lease_id: str = "lease"


def test_preview_rechecks_access_and_releases_lease(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Deletion during generation prevents delivery and still releases its retained files.

    Args:
        tmp_path: Isolated filesystem root.
        monkeypatch: Replace only the process execution boundary with deterministic completion.
    """
    acquired = []
    released = []

    async def acquire(owner: str, run: str, artifact: str) -> LeasedFile:
        """Authorize once, then model a concurrent deletion.

        Args:
            owner: Session identity.
            run: Run identity.
            artifact: File identity.

        Returns:
            Initial file lease.

        Raises:
            PermissionError: On reauthorization after deletion.
        """
        acquired.append((owner, run, artifact))
        if len(acquired) > 1:
            raise PermissionError("deleted")
        return LeasedFile(tmp_path / "file", 12, "0" * 64)

    async def release(lease: str) -> bool:
        """Record file-lifetime release.

        Args:
            lease: Acquired lifetime token.

        Returns:
            True after release.
        """
        released.append(lease)
        return True

    async def native(*args: Any) -> dict[str, Any]:
        """Return completed display data without native timing.

        Args:
            args: Supervised target arguments.

        Returns:
            Successful native envelope.
        """
        return {"data": {"kind": "raster"}}

    monkeypatch.setattr(
        "eolab_app.rendering.artifact_preview.run_bounded_process", native
    )
    with pytest.raises(PermissionError):
        asyncio.run(
            ArtifactPreviewService(acquire, release).read("owner", "run", "file")
        )
    assert len(acquired) == 2 and released == ["lease"]


def test_supervised_native_preview_runs_without_geoserver(tmp_path: Path) -> None:
    """Exercise checksum verification, native-process isolation and complete lease release.

    Args:
        tmp_path: Isolated filesystem root.
    """
    path = write_preview_raster(tmp_path / "native.tif")
    file = LeasedFile(
        path, path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest()
    )
    releases = []

    async def acquire(owner: str, run: str, artifact: str) -> LeasedFile:
        """Return the test's immutable file lease.

        Args:
            owner: Session identity.
            run: Run identity.
            artifact: File identity.

        Returns:
            The scoped test file.
        """
        return file

    async def release(lease: str) -> bool:
        """Record both generation and final access-check releases.

        Args:
            lease: Acquired lifetime token.

        Returns:
            True after recording the release.
        """
        releases.append(lease)
        return True

    result = asyncio.run(
        ArtifactPreviewService(acquire, release).read("owner", "run", "file")
    )
    assert result["kind"] == "raster" and result["sha256"] == file.sha256
    assert releases == ["lease", "lease"]


def test_cancelled_acquisition_releases_its_late_lease(tmp_path: Path) -> None:
    """Cancellation cannot orphan a file lease returned by an in-flight ownership read.

    Args:
        tmp_path: Isolated path for an unstarted preview.
    """
    released = []

    async def exercise() -> None:
        """Cancel a blocked acquisition, then let its database result finish."""
        entered, finish = asyncio.Event(), asyncio.Event()

        async def acquire(owner: str, run: str, artifact: str) -> LeasedFile:
            """Hold acquisition until cancellation has reached its caller.

            Args:
                owner: Session identity.
                run: Run identity.
                artifact: File identity.

            Returns:
                Lease obtained after cancellation was requested.
            """
            entered.set()
            await finish.wait()
            return LeasedFile(tmp_path / "not-read", 1, "0" * 64)

        async def release(lease: str) -> bool:
            """Record release of the late acquisition.

            Args:
                lease: Token returned by file authorization.

            Returns:
                Successful release.
            """
            released.append(lease)
            return True

        task = asyncio.create_task(
            ArtifactPreviewService(acquire, release).read("owner", "run", "file")
        )
        await entered.wait()
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done()
        finish.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(exercise())
    assert released == ["lease"]


def test_preview_concurrency_is_bounded_and_cancellation_releases_capacity(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only two native previews can retain capacity, and both leases end on cancellation.

    Args:
        tmp_path: Isolated file location.
        monkeypatch: Replace native work with a controllable execution boundary.
    """
    released = []

    async def exercise() -> None:
        """Fill preview capacity, reject extra work and cancel the admitted reads."""
        entered = asyncio.Event()
        started = 0

        async def acquire(owner: str, run: str, artifact: str) -> LeasedFile:
            """Authorize a distinguishable test lease.

            Args:
                owner: Session identity.
                run: Run identity.
                artifact: File identity and test lease label.

            Returns:
                Immutable file lease.
            """
            return LeasedFile(tmp_path / "file", 1, "0" * 64, lease_id=artifact)

        async def release(lease: str) -> bool:
            """Record release only after supervised work exits.

            Args:
                lease: File-lifetime token.

            Returns:
                Successful release.
            """
            released.append(lease)
            return True

        async def native(*args: Any) -> None:
            """Retain native capacity until cancellation.

            Args:
                args: Supervised target and input metadata.
            """
            nonlocal started
            started += 1
            if started == 2:
                entered.set()
            await asyncio.Event().wait()

        monkeypatch.setattr(
            "eolab_app.rendering.artifact_preview.run_bounded_process", native
        )
        service = ArtifactPreviewService(acquire, release)
        tasks = [
            asyncio.create_task(service.read("owner", "run", str(index)))
            for index in range(2)
        ]
        await entered.wait()
        with pytest.raises(ArtifactPreviewError) as error:
            await service.read("owner", "run", "extra")
        assert error.value.status == 429 and not released
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(exercise())
    assert sorted(released) == ["0", "1"]
