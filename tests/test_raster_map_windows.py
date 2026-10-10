"""Original-cell viewport rendering, format limits and cancellation boundaries."""

import asyncio
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin, Affine
from rasterio.warp import transform

from eolab_app.raster import map_rendering as map_window
from eolab_app.raster.map_rendering import (
    RasterMapGrid,
    RasterMapWindowRequest,
    RasterMapWindows,
    read_raster_map_window,
)
from eolab_app.raster.source_access import RasterReadSource
from eolab_app.source_files import SourceFileError


def raster(path: Path) -> Path:
    """Write a native grid with sub-preview detail, invalid cells and a valid zero.

    Args:
        path: Temporary TIFF path.

    Returns:
        Written original source.
    """
    with (
        rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True),
        rasterio.open(
            path,
            "w",
            driver="GTiff",
            width=1024,
            height=16,
            count=1,
            dtype="float32",
            crs="EPSG:4326",
            transform=from_origin(0, 1, 1 / 1024, 1 / 1024),
            tiled=True,
            blockxsize=256,
            blockysize=16,
            nodata=-9999,
        ) as dataset,
    ):
        values = np.tile(np.arange(1024, dtype="float32"), (16, 1))
        values[0, 1:4] = [-9999, np.nan, np.inf]
        dataset.write(values, 1)
        mask = np.full((16, 1024), 255, dtype="uint8")
        mask[0, 4] = 0
        dataset.write_mask(mask)
    return path


def grid(west: float = 0, east: float = 1, width: int = 512) -> RasterMapGrid:
    """Choose a top-row viewport with native nearest-cell display sampling.

    Args:
        west: Left edge in degrees.
        east: Right edge in degrees.
        width: Display column count.

    Returns:
        Validated single-row viewport grid.
    """
    return RasterMapGrid(
        bounds={"west": west, "east": east, "south": 1 - 1 / 1024, "north": 1},
        width=width,
        height=1,
    )


def test_zoom_reads_detail_missing_from_the_whole_raster_display(
    tmp_path: Path,
) -> None:
    """Zoom reveals original cells while masks, NoData and valid zero remain distinct.

    Args:
        tmp_path: Isolated source directory.
    """
    path = raster(tmp_path / "detail.tif")
    whole = read_raster_map_window(path, grid())
    zoom = read_raster_map_window(path, grid(0, 8 / 1024, 8))
    assert zoom["values"] == [0, None, None, None, None, 5, 6, 7]
    assert 7 not in whole["values"]
    assert read_raster_map_window(path, grid(-1, -0.5, 2))["values"] == [None, None]


@pytest.mark.parametrize("rotation", [0, 17])
def test_projected_rotated_source_uses_its_native_affine(
    tmp_path: Path, rotation: int
) -> None:
    """A geographic viewport samples the correct cell of projected and rotated grids.

    Args:
        tmp_path: Isolated native source directory.
        rotation: Source-grid rotation in degrees.
    """
    path = tmp_path / "projected.tif"
    affine = (
        Affine.translation(1000, 2000)
        * Affine.rotation(rotation)
        * Affine.scale(10, -10)
    )
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=16,
        height=16,
        count=1,
        dtype="int16",
        crs="EPSG:3857",
        transform=affine,
    ) as dataset:
        dataset.write(np.arange(256, dtype="int16").reshape(16, 16), 1)
    x, y = affine * (3.5, 4.5)
    longitude, latitude = transform(
        "EPSG:3857", "EPSG:4326", [x - 1, x + 1], [y - 1, y + 1]
    )
    request = RasterMapGrid(
        bounds={
            "west": longitude[0],
            "south": latitude[0],
            "east": longitude[1],
            "north": latitude[1],
        },
        width=1,
        height=1,
    )
    assert read_raster_map_window(path, request)["values"] == [67]


@pytest.mark.parametrize("limit", ["MAX_WINDOW_BLOCKS", "MAX_WINDOW_DECODED_BYTES"])
def test_display_admits_native_work_before_any_pixel_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, limit: str
) -> None:
    """A large view fails before decoding instead of silently doing unrestricted work.

    Args:
        tmp_path: Isolated source directory.
        monkeypatch: Scoped dependency replacements.
        limit: Independently exceeded block or decoded-byte budget.
    """
    path = raster(tmp_path / "limited.tif")
    monkeypatch.setattr(map_window, limit, 1)

    def reject_read(*args: Any) -> None:
        """Reject a native read before work admission.

        Args:
            args: Reader arguments which must never be used.

        Raises:
            AssertionError: If native reading starts.
        """
        raise AssertionError("Native data was read before admission")

    monkeypatch.setattr(map_window, "read_native_raster_block", reject_read)
    with pytest.raises(ValueError, match="Zoom in"):
        read_raster_map_window(path, grid())


def test_display_rejects_external_validity_and_invalid_dimensions(
    tmp_path: Path,
) -> None:
    """Unsigned sidecars and oversized viewports cannot bypass the source contracts.

    Args:
        tmp_path: Isolated source directory.
    """
    path = raster(tmp_path / "external.tif")
    with (
        rasterio.Env(GDAL_TIFF_INTERNAL_MASK=False),
        rasterio.open(path, "r+") as dataset,
    ):
        dataset.update_tags(test="external auxiliary")
    for width in (0, 513, True):
        with pytest.raises(ValueError):
            grid(width=width)
    # GDAL loads external auxiliary metadata as a separate dependency.
    Path(str(path) + ".aux.xml").write_text(
        '<PAMDataset><Metadata><MDI key="test">unsigned</MDI></Metadata></PAMDataset>'
    )
    with pytest.raises(ValueError, match="sidecars"):
        read_raster_map_window(path, grid())


def test_display_capacity_and_cancellation_release_the_original_source(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Cancellation unwinds supervised reads before their source scopes are released.

    Args:
        monkeypatch: Native boundary replacement for deterministic scheduling.
        tmp_path: Isolated source directory.
    """
    events: list[str] = []

    class Sources:
        """Expose only the neutral original-source lifetime port."""

        @asynccontextmanager
        async def open(
            self, reference: Any, owner: str | None = None
        ) -> AsyncIterator[RasterReadSource]:
            """Retain a source for the supplied owner until the read stops.

            Args:
                reference: Original opaque identity.
                owner: Server-derived requesting owner.

            Yields:
                Original-file metadata for this test.
            """
            events.append("open")
            try:
                yield RasterReadSource(
                    tmp_path / "source.tif", (owner,), "a" * 64, True
                )
            finally:
                events.append("release")

    async def read(*args: Any) -> dict[str, Any]:
        """Wait until cancellation and record native completion.

        Args:
            args: Reader function and its authorized arguments.

        Returns:
            No result; this test cancels every admitted read.
        """
        try:
            await asyncio.Event().wait()
        finally:
            events.append("stopped")

    monkeypatch.setattr(map_window, "read_private_raster", read)

    async def scenario() -> None:
        """Fill capacity, reject excess work and cancel admitted reads."""
        windows = RasterMapWindows(Sources())
        request = RasterMapWindowRequest(
            source={"kind": "runArtifact", "jobId": "a" * 32, "artifactId": "b" * 32},
            **grid().model_dump(),
        )
        tasks = [asyncio.create_task(windows.read(request, "owner")) for _ in range(2)]
        await asyncio.sleep(0)
        with pytest.raises(SourceFileError) as error:
            await windows.read(request, "owner")
        assert error.value.status == 429
        for task in tasks:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        assert events == ["open", "open", "stopped", "release", "stopped", "release"]
        assert not windows.slots.locked()

    asyncio.run(scenario())
