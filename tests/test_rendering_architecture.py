"""Protect shared rendering dependency direction."""

import ast
from pathlib import Path


RENDERING_SOURCE = Path("src/eolab_app/rendering")
WMS_PROXY_SOURCE = Path("src/eolab_app/routes/wms_proxy.py")
COMPOSITE_MAP_SOURCE = Path("src/eolab_app/routes/composite_map.py")
HTTP_DISCONNECT_SOURCE = Path("src/eolab_app/routes/http_disconnect.py")
GEOTIFF_CATALOG_SOURCE = Path("src/eolab_app/catalog/geotiff.py")
APPLICATION_COMPOSITION_SOURCE = Path("src/eolab_app/main.py")


def imported_modules(source_path: Path) -> set[str]:
    """Return absolute modules imported by one Python source file.

    Args:
        source_path: Python module to parse.

    Returns:
        Absolute import names declared by the module.
    """
    syntax_tree = ast.parse(source_path.read_text(encoding="utf-8"))
    modules = set()
    for node in ast.walk(syntax_tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module is not None:
            modules.add(node.module)
    return modules


def test_shared_rendering_has_no_dataset_feature_dependency() -> None:
    """Keep assessment and publication policy in owning feature packages."""
    application_imports = {
        module
        for source_path in RENDERING_SOURCE.glob("*.py")
        for module in imported_modules(source_path)
        if module.startswith("eolab_app.")
    }

    assert all(
        module.startswith("eolab_app.rendering.")
        for module in application_imports
    )


def test_composite_map_route_depends_only_on_neutral_rendering() -> None:
    """Keep composite delivery independent from dataset implementations."""
    application_imports = {
        module
        for module in imported_modules(COMPOSITE_MAP_SOURCE)
        if module.startswith("eolab_app.")
    }

    assert not {
        module
        for module in application_imports
        if module.startswith("eolab_app.raster")
        or module.startswith("eolab_app.vector")
        or module.startswith("eolab_app.catalog")
    }


def test_restricted_wms_route_depends_only_on_neutral_authorization() -> None:
    """Keep the shared HTTP route independent from dataset implementations."""
    application_imports = {
        module
        for module in imported_modules(WMS_PROXY_SOURCE)
        if module.startswith("eolab_app.")
    }

    assert application_imports == {
        "eolab_app.diagnostics.tracker",
        "eolab_app.rendering.errors",
        "eolab_app.rendering.ports",
        "eolab_app.routes.geoserver_map",
    }


def test_disconnect_coordination_is_dataset_neutral() -> None:
    """Keep shared request cancellation independent from feature packages."""
    application_imports = {
        module
        for module in imported_modules(HTTP_DISCONNECT_SOURCE)
        if module.startswith("eolab_app.")
    }

    assert application_imports == set()


def test_raster_discovery_has_no_geoserver_or_publication_dependency() -> None:
    """Keep prepared-raster discovery neutral and side-effect free."""
    imports = imported_modules(GEOTIFF_CATALOG_SOURCE)

    assert not {
        module
        for module in imports
        if module.startswith("eolab_app.raster.geoserver")
        or module.startswith("eolab_app.raster.publication")
        or module.startswith("eolab_app.rendering")
    }


def test_raster_preflight_and_approximate_view_edges_are_removed() -> None:
    """Prevent composition from restoring deleted raster rendering policy."""
    removed_sources = (
        Path("src/eolab_app/raster/assessment.py"),
        Path("src/eolab_app/raster/eligibility.py"),
        Path("src/eolab_app/raster/detail_preview.py"),
        Path("src/eolab_app/raster/detail_preview_service.py"),
        Path("src/eolab_app/raster/exact_detail.py"),
    )
    composition_imports = imported_modules(APPLICATION_COMPOSITION_SOURCE)

    assert not any(source.exists() for source in removed_sources)
    assert "eolab_app.raster.assessment" not in composition_imports
    assert "eolab_app.raster.eligibility" not in composition_imports
