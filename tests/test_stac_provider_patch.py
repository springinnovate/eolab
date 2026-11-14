"""Verify that the build-time STAC provider patch fails closed on upstream changes."""

from importlib import util
from pathlib import Path
import subprocess
import tarfile
from typing import Any
from types import ModuleType, SimpleNamespace

import pytest


@pytest.fixture
def provider_patch() -> ModuleType:
    """Load the standalone build script without requiring the API's dependencies.

    Returns:
        An isolated module containing the exact script used by Dockerfile.stac-api.
    """
    path = Path(__file__).resolve().parents[1] / "deployment/patch-stac-nonspatial.py"
    specification = util.spec_from_file_location("stac_provider_patch", path)
    module = util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


def test_patch_preserves_all_other_provider_source(provider_patch: ModuleType) -> None:
    """Keep upstream validation, routes and client lifecycle outside the one block.

    Args:
        provider_patch: The deployment patch script loaded without running it.
    """
    before = "# upstream identities and extension validation\n"
    after = "# upstream collection and expected Item identity validation\n"
    original = before + provider_patch.ORIGINAL_GEOMETRY_CHECK + after
    changed = provider_patch.patch_transactions_source(original)
    assert changed == before + provider_patch.NONSPATIAL_GEOMETRY_CHECK + after


@pytest.mark.parametrize("copies", [0, 2])
def test_patch_rejects_changed_or_ambiguous_upstream_source(
    provider_patch: ModuleType, copies: int
) -> None:
    """Require one exact reviewed validation block before changing installed code.

    Args:
        provider_patch: The deployment patch script loaded without running it.
        copies: An absent or repeated upstream block.
    """
    with pytest.raises(RuntimeError, match="validation block changed"):
        provider_patch.patch_transactions_source(
            provider_patch.ORIGINAL_GEOMETRY_CHECK * copies
        )


def test_installed_patch_rejects_a_different_upstream_version(
    provider_patch: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Stop a provider upgrade before editing its installed transaction module.

    Args:
        provider_patch: The deployment patch script loaded without running it.
        monkeypatch: Scoped replacement for installed-distribution discovery.
    """
    monkeypatch.setattr(provider_patch.metadata, "version", lambda name: "6.3.2")
    with pytest.raises(RuntimeError, match="requires STAC FastAPI pgSTAC 6.3.1"):
        provider_patch.patch_installed_transactions()


def test_installed_patch_writes_the_located_provider_only(
    provider_patch: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Apply the checked replacement to the module located in the pinned image.

    Args:
        provider_patch: The deployment patch script loaded without running it.
        monkeypatch: Scoped installed-version and module-location replacements.
        tmp_path: Test-owned replacement for the provider's installed source.
    """
    installed = tmp_path / "transactions.py"
    installed.write_text(provider_patch.ORIGINAL_GEOMETRY_CHECK, encoding="utf-8")
    monkeypatch.setattr(provider_patch.metadata, "version", lambda name: "6.3.1")
    monkeypatch.setattr(
        provider_patch.util,
        "find_spec",
        lambda name: SimpleNamespace(origin=str(installed)),
    )
    provider_patch.patch_installed_transactions()
    assert (
        installed.read_text(encoding="utf-8")
        == provider_patch.NONSPATIAL_GEOMETRY_CHECK
    )
    with pytest.raises(RuntimeError, match="validation block changed"):
        provider_patch.patch_installed_transactions()


def test_api_image_build_uses_default_dockerfile_from_exact_deployment_recipe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pass Docker an unambiguous tar context containing the deployment API recipe.

    Args:
        monkeypatch: Replace Docker execution while inspecting its actual stdin archive.
    """
    root = Path(__file__).resolve().parents[1]
    monkeypatch.syspath_prepend(str(root / "scripts"))
    specification = util.spec_from_file_location(
        "catalog_postgres_launcher", root / "scripts/test_catalog_postgres.py"
    )
    launcher = util.module_from_spec(specification)
    specification.loader.exec_module(launcher)
    builds: list[list[str]] = []

    def inspect_build(
        command: list[str], **options: Any
    ) -> subprocess.CompletedProcess[str]:
        """Inspect the real Docker input without requiring a running daemon.

        Args:
            command: CLI arguments supplied by the image builder.
            **options: Process options including the completed tar stream.

        Returns:
            A successful Docker result after checking its external input contract.
        """
        builds.append(command)
        assert command[:3] == ["docker", "build", "--pull"]
        assert "--file" not in command and command[-1] == "-"
        context = options["stdin"]
        assert context.read(10) == b"Dockerfile"
        context.seek(0)
        with tarfile.open(fileobj=context, mode="r") as archive:
            assert archive.getnames() == [
                "Dockerfile",
                "deployment/patch-stac-nonspatial.py",
            ]
            assert (
                archive.extractfile("Dockerfile").read()
                == (root / "Dockerfile.stac-api").read_bytes()
            )
            assert (
                archive.extractfile("deployment/patch-stac-nonspatial.py").read()
                == (root / "deployment/patch-stac-nonspatial.py").read_bytes()
            )
        assert options["check"] is True
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(launcher.subprocess, "run", inspect_build)
    image = launcher.build_api_test_image()
    assert len(builds) == 1
    assert builds[0][-2] == image
