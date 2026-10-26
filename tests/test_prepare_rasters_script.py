"""Exercise the preparation CLI with real rasters and repeatable batch failures."""

from pathlib import Path
import runpy
import subprocess
import sys

import numpy as np
from osgeo import gdal, osr
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "prepare_rasters.py"


def write_raster(path: Path, *, epsg: int = 4326, bands: int = 1) -> None:
    """Create a raster with valid zero, declared NoData and a separate mask hole.

    Args:
        path: New GeoTIFF filename in an existing directory.
        epsg: Source coordinate system.
        bands: Number of bands, for exercising unsupported multiband input.
    """
    with osr.ExceptionMgr():
        crs = osr.SpatialReference()
        crs.ImportFromEPSG(epsg)
    values = np.full((600, 600), 7, dtype=np.int16)
    values[:100, :100] = 0
    values[200:300, 200:300] = -9999
    mask = np.full(values.shape, 255, dtype=np.uint8)
    mask[400:500, 400:500] = 0
    with (
        gdal.ExceptionMgr(),
        gdal.GetDriverByName("GTiff").Create(
            str(path), 600, 600, bands, gdal.GDT_Int16
        ) as source,
    ):
        source.SetProjection(crs.ExportToWkt())
        source.SetGeoTransform((10, 0.01, 0, 20, 0, -0.01))
        band = source.GetRasterBand(1)
        band.SetNoDataValue(-9999)
        band.SetUnitType("kg")
        band.WriteArray(values)
        band.CreateMaskBand(gdal.GMF_PER_DATASET)
        band.GetMaskBand().WriteArray(mask)


def run_script(*arguments: str) -> subprocess.CompletedProcess[str]:
    """Run the actual script from its directory, as an administrator would.

    Args:
        arguments: Explicit filenames, globs and CLI options.

    Returns:
        Process exit status and captured output.
    """
    return subprocess.run(
        [sys.executable, str(SCRIPT), *arguments],
        cwd=SCRIPT.parent,
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.mark.parametrize("epsg", [4326, 3857])
def test_prepares_single_band_cog_with_validity(tmp_path: Path, epsg: int) -> None:
    """Reproject or preserve the grid while retaining both kinds of invalid cell.

    Args:
        tmp_path: Isolated input and output directory.
        epsg: Original geographic or already projected coordinate system.
    """
    source = tmp_path / "values.tif"
    destination = tmp_path / "prepared"
    write_raster(source, epsg=epsg)
    result = run_script(str(source), "--destination", str(destination))
    assert result.returncode == 0, result.stderr
    output = destination / "values_cog_epsg3857.tif"
    with gdal.ExceptionMgr(), gdal.Open(str(output)) as dataset:
        assert dataset.GetSpatialRef().GetAuthorityCode(None) == "3857"
        assert dataset.GetMetadata("IMAGE_STRUCTURE")["LAYOUT"] == "COG"
        assert dataset.RasterCount == 1
        band = dataset.GetRasterBand(1)
        assert band.GetOverviewCount() > 0
        assert band.GetNoDataValue() == -9999
        assert band.GetUnitType() == "kg"
        values = band.ReadAsArray()
        validity = band.GetMaskBand().ReadAsArray()
        assert np.any((values == 0) & (validity != 0))
        assert np.any(validity == 0)
        assert not np.any((values == -9999) & (validity != 0))
        assert set(values[validity != 0]) == {0, 7}
        if epsg == 3857:
            assert not validity[200:300, 200:300].any()
            assert not validity[400:500, 400:500].any()
            assert validity[100:200, 100:200].all()
    assert list(destination.iterdir()) == [output]


def test_globs_lists_and_existing_outputs(tmp_path: Path) -> None:
    """Deduplicate overlapping inputs and skip existing outputs without reading them.

    Args:
        tmp_path: Isolated input and output directory.
    """
    first = tmp_path / "first [raster].tif"
    second = tmp_path / "second raster.tif"
    write_raster(first)
    write_raster(second)
    destination = tmp_path / "prepared"
    arguments = (
        str(first),
        str(second),
        str(tmp_path / "*.tif"),
        "-d",
        str(destination),
    )
    result = run_script(*arguments)
    assert result.returncode == 0, result.stderr
    assert "Converted: 2; skipped: 0; failed: 0" in result.stdout
    outputs = {path.name: path.read_bytes() for path in destination.iterdir()}
    first.write_text("Source is no longer readable, but its output already exists.")
    result = run_script(*arguments)
    assert result.returncode == 0, result.stderr
    assert "Converted: 0; skipped: 2; failed: 0" in result.stdout
    assert outputs == {path.name: path.read_bytes() for path in destination.iterdir()}


def test_rejects_colliding_names_and_unmatched_glob(tmp_path: Path) -> None:
    """Report ambiguous or missing input before producing any output.

    Args:
        tmp_path: Isolated input and output directory.
    """
    (tmp_path / "one").mkdir()
    (tmp_path / "two").mkdir()
    for folder in ("one", "two"):
        write_raster(tmp_path / folder / "values.tif")
    destination = tmp_path / "prepared"
    result = run_script(str(tmp_path / "*" / "values.tif"), "-d", str(destination))
    assert result.returncode == 2
    assert "Output name collision" in result.stderr
    assert not destination.exists()
    result = run_script(str(tmp_path / "missing*.tif"), "-d", str(destination))
    assert result.returncode == 2
    assert "No files matched" in result.stderr


def test_failed_input_does_not_stop_other_files(tmp_path: Path) -> None:
    """Reject a multiband input without preventing the next raster from converting.

    Args:
        tmp_path: Isolated input and output directory.
    """
    invalid, valid = tmp_path / "multiband.tif", tmp_path / "valid.tif"
    write_raster(invalid, bands=2)
    write_raster(valid)
    destination = tmp_path / "prepared"
    result = run_script(str(invalid), str(valid), "-d", str(destination))
    assert result.returncode == 1
    assert "Expected one data band" in result.stderr
    assert "Converted: 1; skipped: 0; failed: 1" in result.stdout
    assert [path.name for path in destination.iterdir()] == ["valid_cog_epsg3857.tif"]


def test_partial_conversion_is_removed_and_can_be_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A GDAL write failure leaves no final output that a retry could skip.

    Args:
        tmp_path: Isolated input and output directory.
        monkeypatch: Scoped GDAL failure injection.
    """
    source = tmp_path / "values.tif"
    write_raster(source)
    destination = tmp_path / "prepared"
    main = runpy.run_path(str(SCRIPT))["main"]
    translate = gdal.Translate

    def fail_cog_write(
        filename: str, source: gdal.Dataset, **options: object
    ) -> gdal.Dataset:
        """Simulate a failed COG encoder after it writes a partial file.

        Args:
            filename: Temporary output path selected by the CLI.
            source: Open raster passed to GDAL.
            **options: GDAL Translate keyword options.

        Returns:
            The normal GDAL dataset for intermediate VRTs.

        Raises:
            RuntimeError: When the final COG encoder is invoked.
        """
        if options["format"] == "COG":
            Path(filename).write_bytes(b"incomplete")
            raise RuntimeError("Simulated output write failure")
        return translate(filename, source, **options)

    with monkeypatch.context() as patch:
        patch.setattr(gdal, "Translate", fail_cog_write)
        assert main([str(source), "-d", str(destination)]) == 1
    assert not list(destination.iterdir())
    assert main([str(source), "-d", str(destination)]) == 0
    assert (destination / "values_cog_epsg3857.tif").is_file()


def test_destination_created_during_conversion_is_not_overwritten(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Skip an output published by another batch while the raster is encoding.

    Args:
        tmp_path: Isolated input and output directory.
        monkeypatch: Scoped simulation of a concurrent output publication.
    """
    source = tmp_path / "values.tif"
    write_raster(source)
    destination = tmp_path / "prepared"
    output = destination / "values_cog_epsg3857.tif"
    main = runpy.run_path(str(SCRIPT))["main"]
    translate = gdal.Translate

    def publish_other_output(
        filename: str, source: gdal.Dataset, **options: object
    ) -> gdal.Dataset:
        """Place another batch's final output before the COG encoder returns.

        Args:
            filename: Temporary output path selected by the CLI.
            source: Open raster passed to GDAL.
            **options: GDAL Translate keyword options.

        Returns:
            The real GDAL output dataset.
        """
        result = translate(filename, source, **options)
        if options["format"] == "COG":
            output.write_bytes(b"other completed output")
        return result

    with monkeypatch.context() as patch:
        patch.setattr(gdal, "Translate", publish_other_output)
        assert main([str(source), "-d", str(destination)]) == 0
    assert output.read_bytes() == b"other completed output"
    assert list(destination.iterdir()) == [output]
