"""Protect processing, neutral mechanisms, and existing sibling boundaries."""

import ast
from pathlib import Path


def imports(path: Path) -> set[str]:
    """Read actual static imports for an architectural boundary assertion.

    Args:
        path: Python source module.

    Returns:
        Imported module names, including direct import statements.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return {
        node.module
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module
    } | {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    }


def test_processing_has_no_histogram_renderer_or_aoi_implementation_dependency() -> (
    None
):
    """Processing consumes source/area values without sibling implementation state."""
    forbidden = (
        "eolab_app.rendering",
        "eolab_app.temporary_aoi",
        "eolab_app.raster.statistics",
        "eolab_app.raster.pixel",
        "eolab_app.raster.geoserver",
        "eolab_app.raster.publication",
        "eolab_app.raster.detail",
        "eolab_app.raster.assessment",
        "eolab_app.catalog.pgstac",
    )
    for path in Path("src/eolab_app/processing").glob("*.py"):
        assert not {
            module for module in imports(path) if module.startswith(forbidden)
        }, path


def test_mechanisms_and_storage_never_import_application_services() -> None:
    """Keep neutral native execution and storage below their workflow owners."""
    paths = [
        Path("src/eolab_app/execution/bounded_process.py"),
        Path("src/eolab_app/raster/bounded_window.py"),
        Path("src/eolab_app/processing/job_store.py"),
        Path("src/eolab_app/processing/artifacts.py"),
        Path("src/eolab_app/processing/raster_clip.py"),
        Path("src/eolab_app/processing/raster_aggregate.py"),
        Path("src/eolab_app/processing/raster_expression.py"),
        Path("src/eolab_app/processing/raster_input.py"),
        Path("src/eolab_app/processing/ground_area.py"),
        Path("src/eolab_app/processing/area_coverage.py"),
    ]
    for path in paths:
        assert not {
            module
            for module in imports(path)
            if module.endswith((".service", "_service", ".worker"))
        }, path
    assert not {
        module for module in imports(paths[0]) if module.startswith("eolab_app")
    }
    assert not {
        module
        for module in imports(paths[1])
        if module.startswith(("eolab_app.processing", "eolab_app.temporary_aoi"))
    }


def test_processing_deployment_is_separate_bounded_and_source_read_only() -> None:
    """Protect worker isolation and private artifact-volume ownership."""
    compose = Path("docker-compose.yml").read_text()
    worker = compose.split("  processing-worker:\n", 1)[1].split("\n  app:\n", 1)[0]
    app = compose.split("\n  app:\n", 1)[1].split("\nvolumes:\n", 1)[0]
    assert 'command: ["python", "-m", "eolab_app.main", "processing-worker"]' in worker
    assert "mem_limit: 2g" in worker
    assert "cpus: 2" in worker
    assert "read_only: true" in worker
    assert "processing-data:/processing-data" in worker
    assert "processing-data:/processing-data:ro" in app
    assert "GEOSERVER" not in worker
    sql = Path("src/eolab_app/processing/schema.sql").read_text()
    assert "pgstac." not in sql.lower()
    assert "CREATE SCHEMA IF NOT EXISTS processing" in sql


def test_shared_job_models_and_storage_do_not_depend_on_clip_models() -> None:
    """Keep reusable lifecycle contracts independent of any operation's schema."""
    for name in ("models.py", "ports.py", "job_store.py"):
        dependencies = imports(Path("src/eolab_app/processing") / name)
        assert "eolab_app.processing.clip_models" not in dependencies
        assert "eolab_app.processing.aggregate_models" not in dependencies
        assert not {
            module for module in dependencies if module.startswith("eolab_app.raster")
        }


def test_fractional_mask_is_numerical_and_has_no_geometry_or_service_dependency() -> (
    None
):
    """Raster masks consume oriented coordinates rather than pixel geometries."""
    dependencies = imports(Path("src/eolab_app/processing/area_coverage.py"))
    assert not {
        module
        for module in dependencies
        if module.startswith(("eolab_app", "shapely", "rasterio", "pyproj"))
    }
