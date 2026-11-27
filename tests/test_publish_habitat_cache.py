"""Verify bulk cache publication through the CLI and Catalog GeoTIFF reader."""

import json
from pathlib import Path
import subprocess
import sys

import numpy as np
import rasterio
from rasterio.transform import from_origin

from eolab_app.catalog.geotiff import build_stac_item
from scripts.publish_habitat_cache import installed_stacks


def test_publish_years_bands_masks_and_resume(tmp_path: Path) -> None:
    """Publish two assessment years, inspect seam and gap values, then resume a partial export.

    Args:
        tmp_path: Empty test workspace for the cache, finished rasters and catalog root.
    """
    cache = tmp_path / "habitat-cache"
    output = tmp_path / "published"
    command = [
        sys.executable,
        str(Path(__file__).parents[1] / "scripts/publish_habitat_cache.py"),
        str(cache),
        str(output),
    ]
    years = (2015, 2019)
    expected = {}
    for stack in installed_stacks().values():
        if stack.year not in years:
            continue
        namespace = cache / stack.raster_configuration_sha256
        bands = {
            name: band
            for name, band in zip(stack.band_names(), stack.bands, strict=True)
            if band.role in ("response", "predictor")
        }
        # The span forces a zoomed-out overview. Adjacent tiles cover a seam;
        # the distant tile leaves a gap of uncached but geometrically valid cells.
        for column in (0, 1, 150):
            directory = namespace / f"{column}_0"
            directory.mkdir(parents=True)
            with rasterio.open(
                directory / "tile.tif",
                "w",
                driver="GTiff",
                width=4,
                height=4,
                count=len(bands),
                dtype="float32",
                crs="EPSG:6933",
                transform=from_origin(column * 2000, 0, 500, 500),
                nodata=None if column == 1 else -9999,
            ) as dataset:
                dataset.descriptions = tuple(bands)
                for i in range(1, len(bands) + 1):
                    values = np.full((4, 4), stack.year + i + column, dtype="float32")
                    values[1, 0] = 0
                    values[1, 1] = -9999
                    dataset.write(values, i)
                if column == 1:
                    mask = np.full((4, 4), 255, dtype="uint8")
                    mask[1, 1] = 0
                    dataset.write_mask(mask)
        if stack.year == 2019:
            (namespace / "configuration.json").write_text(
                json.dumps({"year": stack.year, "configuration_sha256": namespace.name})
            )
        for i, (name, band) in enumerate(bands.items(), 1):
            expected[name] = (stack.year, i, band.display_name, band.role)

    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    rasters = sorted(output.rglob("*.tif"))
    assert {p.stem for p in rasters} == expected.keys()
    assert {value[0] for value in expected.values()} == set(years)
    for path in rasters:
        year, i, label, role = expected[path.stem]
        with rasterio.open(path) as dataset:
            assert dataset.count == 1
            assert dataset.descriptions == (label,)
            assert dataset.overviews(1)
            assert dataset.tags(ns="IMAGE_STRUCTURE")["LAYOUT"] == "COG"
            assert dataset.transform == from_origin(0, 0, 500, 500)
            pixels = dataset.read(1, masked=True)
            assert (pixels[0, 3], pixels[0, 4]) == (year + i, year + i + 1)
            assert pixels[1, 0] == 0 and pixels.mask[1, 1]
            assert pixels[1, 4] == 0 and pixels.mask[1, 5]
            assert pixels.mask[0, 8] and pixels[0, 600] == year + i + 150
        item = build_stac_item(output, path)
        assert item["properties"]["title"] == f"{label} (assessment year {year})"
        assert item["properties"]["description"].startswith(
            f"Prepared Ecosystem Condition {role} for assessment year {year}."
        )
        assert item["assets"]["data"]["raster:bands"][0]["description"] == label

    preserved = rasters[0].stat().st_mtime_ns
    rasters[-1].unlink()
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert "Already published" in result.stdout
    assert rasters[0].stat().st_mtime_ns == preserved and rasters[-1].exists()

    # A later snapshot must not silently reuse an older mosaic with less coverage.
    tile = next(cache.rglob("tile.tif"))
    (tile.parent.parent / "7_0").mkdir()
    (tile.parent.parent / "7_0" / "tile.tif").hardlink_to(tile)
    result = subprocess.run(command, capture_output=True, text=True)
    assert result.returncode and "Tile coverage changed" in result.stderr
