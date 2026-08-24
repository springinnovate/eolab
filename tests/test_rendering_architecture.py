"""Protect shared rendering dependency direction."""

import ast
from pathlib import Path


RENDERING_SOURCE = Path("src/eolab_app/rendering")
WMS_PROXY_SOURCE = Path("src/eolab_app/routes/wms_proxy.py")


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

    assert application_imports <= {"eolab_app.rendering.errors"}


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
    }
