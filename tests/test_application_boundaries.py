"""Protect application boundaries against architectural drift."""

import ast
from pathlib import Path


APPLICATION_SOURCE = Path("src/eolab_app")
GEOSERVER_INITIALIZER = Path("geoserver/initialize.py")
ROOT_GENERIC_MODULE_NAMES = {
    "constants.py",
    "helpers.py",
    "utilities.py",
    "utils.py",
}


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


def reads_process_environment(source_path: Path) -> bool:
    """Report whether a module reads ``os.environ`` or calls ``os.getenv``.

    Both direct imports and aliased imports are recognized so the guardrail
    expresses the configuration boundary rather than one import style.

    Args:
        source_path: Python module to inspect.

    Returns:
        Whether the module contains a process-environment access.
    """
    syntax_tree = ast.parse(source_path.read_text(encoding="utf-8"))
    os_module_names = {"os"}
    environment_names: set[str] = set()
    for node in syntax_tree.body:
        if isinstance(node, ast.Import):
            os_module_names.update(
                alias.asname or alias.name
                for alias in node.names
                if alias.name == "os"
            )
        elif isinstance(node, ast.ImportFrom) and node.module == "os":
            environment_names.update(
                alias.asname or alias.name
                for alias in node.names
                if alias.name in {"environ", "getenv"}
            )

    for node in ast.walk(syntax_tree):
        if isinstance(node, ast.Name) and node.id in environment_names:
            return True
        if not isinstance(node, ast.Attribute):
            continue
        if (
            isinstance(node.value, ast.Name)
            and node.value.id in os_module_names
            and node.attr in {"environ", "getenv"}
        ):
            return True
    return False


def test_settings_is_the_only_application_environment_boundary() -> None:
    """Require features to receive validated dependencies from composition."""
    environment_readers = {
        source_path.relative_to(APPLICATION_SOURCE).as_posix()
        for source_path in APPLICATION_SOURCE.rglob("*.py")
        if reads_process_environment(source_path)
    }

    assert environment_readers == {"settings.py"}
    settings_consumers = {
        source_path.relative_to(APPLICATION_SOURCE).as_posix()
        for source_path in APPLICATION_SOURCE.rglob("*.py")
        if "eolab_app.settings" in imported_modules(source_path)
    }
    assert settings_consumers == {"main.py"}


def test_deployment_and_asset_tools_do_not_enter_the_runtime_package() -> None:
    """Keep standalone GeoServer and icon programs outside application code."""
    application_imports = {
        imported_module
        for source_path in APPLICATION_SOURCE.rglob("*.py")
        for imported_module in imported_modules(source_path)
    }

    assert not any(
        imported_module == "geoserver"
        or imported_module.startswith("geoserver.")
        or imported_module == "icon"
        or imported_module.startswith("icon.")
        for imported_module in application_imports
    )
    assert not any(
        imported_module == "eolab_app"
        or imported_module.startswith("eolab_app.")
        for imported_module in imported_modules(GEOSERVER_INITIALIZER)
    )
    assert not (APPLICATION_SOURCE / "icon.py").exists()
    assert not (APPLICATION_SOURCE / "icon").exists()


def test_application_root_has_no_generic_shared_module() -> None:
    """Keep unrelated feature constants and helpers out of a common sink."""
    assert not {
        source_path.name
        for source_path in APPLICATION_SOURCE.glob("*.py")
    }.intersection(ROOT_GENERIC_MODULE_NAMES)


def test_raster_analysis_does_not_depend_on_rendering_or_http_composition() -> None:
    """Keep bounded pixel/statistics work independent of renderer state."""
    analysis_modules = {
        APPLICATION_SOURCE / "raster" / module_name
        for module_name in {
            "exact_source.py",
            "pixel.py",
            "pixel_service.py",
            "sample_grid.py",
            "source_contract.py",
            "statistics.py",
            "statistics_service.py",
        }
    }
    forbidden_prefixes = {
        "eolab_app.rendering",
        "eolab_app.raster.detail_preview",
        "eolab_app.raster.eligibility",
        "eolab_app.raster.geoserver",
        "eolab_app.raster.publication",
        "eolab_app.routes",
    }

    violations = {
        f"{source_path.relative_to(APPLICATION_SOURCE).as_posix()} -> {imported_module}"
        for source_path in analysis_modules
        for imported_module in imported_modules(source_path)
        if any(
            imported_module == prefix
            or imported_module.startswith(f"{prefix}.")
            for prefix in forbidden_prefixes
        )
    }

    assert violations == set()
