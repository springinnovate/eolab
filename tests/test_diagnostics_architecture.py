"""Protect rendering diagnostics ownership and dependency direction."""

import ast
from pathlib import Path


DIAGNOSTICS_SOURCE = Path("src/eolab_app/diagnostics")


def imported_modules(source_path: Path) -> set[str]:
    """Return absolute modules imported by one diagnostics source file.

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


def test_diagnostics_dependencies_follow_the_owned_feature_boundaries() -> None:
    """Keep transport out of parsing, models, and request tracking."""
    module_imports = {
        source_path.stem: imported_modules(source_path)
        for source_path in DIAGNOSTICS_SOURCE.glob("*.py")
    }

    assert {
        name
        for name, imports in module_imports.items()
        if "httpx2" in imports
    } == {"service"}
    assert {
        name
        for name, imports in module_imports.items()
        if "pydantic" in imports
    } == {"models"}
    assert all(
        not any(
            module == "fastapi" or module.startswith("fastapi.")
            for module in imports
        )
        for imports in module_imports.values()
    )


def test_diagnostics_module_import_graph_is_acyclic() -> None:
    """Reject circular dependencies hidden by Python import ordering."""
    graph = {}
    for source_path in DIAGNOSTICS_SOURCE.glob("*.py"):
        graph[source_path.stem] = {
            module.removeprefix("eolab_app.diagnostics.").split(".", 1)[0]
            for module in imported_modules(source_path)
            if module.startswith("eolab_app.diagnostics.")
        }

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(module_name: str) -> None:
        """Traverse one module and fail when its path returns to itself.

        Args:
            module_name: Diagnostics module currently being checked.
        """
        assert module_name not in visiting, (
            f"diagnostics import cycle at {module_name}"
        )
        if module_name in visited:
            return
        visiting.add(module_name)
        for dependency in graph[module_name]:
            visit(dependency)
        visiting.remove(module_name)
        visited.add(module_name)

    for module_name in graph:
        visit(module_name)
