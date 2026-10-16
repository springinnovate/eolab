"""Bounded native preview reading and file-lifetime contract tests."""

import asyncio
from dataclasses import dataclass
from collections.abc import Awaitable, Callable
import hashlib
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest

from eolab_app.source_files import (
    LeasedSourceFiles,
    SourceFileError,
    verify_source_file,
)

from eolab_app.rendering.artifact_preview import (
    ArtifactPreviewError,
    ArtifactPreviewService,
    read_vector_preview,
)


def write_preview_vector(path: Path) -> Path:
    """Create a small GeoJSON file with geometry and an arbitrary property.

    Args:
        path: Isolated test output path.

    Returns:
        GeoJSON path whose preview should contain only display geometry.
    """
    path.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [
                    {
                        "type": "Feature",
                        "properties": {"html": "<script>bad()</script>"},
                        "geometry": {"type": "Point", "coordinates": [0, 2]},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return path


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
    path = write_preview_vector(tmp_path / "changed.geojson")
    captured = Capture()
    verify_source_file(captured, path, path.stat().st_size, "0" * 64)
    assert captured.value is None
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
    media_type: str = "application/geo+json"
    lease_id: str = "lease"


def preview_sources(
    acquire: Callable[[str, str, str], Awaitable[LeasedFile]],
    release: Callable[[str], Awaitable[bool]],
) -> LeasedSourceFiles:
    """Compose test ownership callbacks through the real shared file lifetime.

    Args:
        acquire: Controlled source authority.
        release: Controlled lease release.

    Returns:
        Shared source access with a controlled metadata check and renewal.
    """

    async def check(owner: str, run: str, artifact: str) -> tuple[int, str, str]:
        """Check the controlled authority again before delivery.

        Args:
            owner: Requesting owner.
            run: Run identity.
            artifact: File identity.

        Returns:
            Current published metadata.
        """
        current = await acquire(owner, run, artifact)
        await release(current.lease_id)
        return current.size, current.sha256, current.media_type

    async def renew(lease: str) -> bool:
        """Keep a controlled lease live.

        Args:
            lease: Existing transfer token.

        Returns:
            True for the test authority's live transfer.
        """
        return True

    return LeasedSourceFiles(acquire, release, check, renew)


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
        path = tmp_path / "file"
        path.write_bytes(b"test bytes")
        return LeasedFile(
            path, path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest()
        )

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
        return {"data": {"kind": "vector"}}

    monkeypatch.setattr(
        "eolab_app.rendering.artifact_preview.run_bounded_process", native
    )
    with pytest.raises(SourceFileError):
        asyncio.run(
            ArtifactPreviewService(preview_sources(acquire, release)).read(
                "owner", "run", "file"
            )
        )
    assert len(acquired) == 2 and released == ["lease"]


def test_supervised_native_preview_runs_without_geoserver(tmp_path: Path) -> None:
    """Exercise checksum verification, native-process isolation and complete lease release.

    Args:
        tmp_path: Isolated filesystem root.
    """
    path = write_preview_vector(tmp_path / "native.geojson")
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
        ArtifactPreviewService(preview_sources(acquire, release)).read(
            "owner", "run", "file"
        )
    )
    assert result["kind"] == "vector" and result["sha256"] == file.sha256
    assert result["bounds"] == [0, 2, 0, 2]
    assert result["geojson"]["features"][0]["properties"] == {}
    assert releases == ["lease", "lease"]


def test_tiff_preview_rejection_authorizes_and_releases_without_decoding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reject an authorized TIFF format without starting the retired preview reader.

    Args:
        tmp_path: Isolated immutable-file location.
        monkeypatch: Observe the native preview execution boundary.
    """
    path = tmp_path / "output.tif"
    path.write_bytes(b"not decoded by the preview service")
    file = LeasedFile(
        path,
        path.stat().st_size,
        hashlib.sha256(path.read_bytes()).hexdigest(),
        media_type="image/tiff",
    )
    acquire = AsyncMock(return_value=file)
    release = AsyncMock(return_value=True)
    native = AsyncMock(side_effect=AssertionError("TIFF preview decoding is retired"))
    monkeypatch.setattr(
        "eolab_app.rendering.artifact_preview.run_bounded_process", native
    )
    with pytest.raises(ArtifactPreviewError) as error:
        asyncio.run(
            ArtifactPreviewService(preview_sources(acquire, release)).read(
                "owner", "run", "file"
            )
        )
    assert error.value.status == 422
    assert str(error.value) == (
        "GeoTIFF outputs use ordinary raster rendering. "
        "Download the file or use Show on map."
    )
    acquire.assert_awaited_once_with("owner", "run", "file")
    release.assert_awaited_once_with("lease")
    native.assert_not_awaited()


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
            ArtifactPreviewService(preview_sources(acquire, release)).read(
                "owner", "run", "file"
            )
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
            path = tmp_path / artifact
            path.write_bytes(b"x")
            return LeasedFile(
                path, 1, hashlib.sha256(b"x").hexdigest(), lease_id=artifact
            )

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
        service = ArtifactPreviewService(preview_sources(acquire, release))
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
