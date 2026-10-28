"""Regression tests for the lane's required-coverage and build-input boundaries."""

import subprocess
import tarfile
from typing import Any, Literal

import pytest

from scripts.processing_postgres_suite import SUITES
from scripts import test_processing_postgres as launcher

pytest_plugins = ["pytester"]


@pytest.mark.parametrize("wait_result", [0, 1, "timeout"])
def test_runner_logs_precede_cleanup_after_exit_or_timeout(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    wait_result: int | Literal["timeout"],
) -> None:
    """Keep runner output before removal and preserve its exit or timeout outcome.

    Args:
        monkeypatch: Replace Docker subprocesses without changing launcher flow.
        capsys: Capture runner output and the launcher's cleanup confirmation.
        wait_result: Container exit code, or a simulated Docker wait timeout.
    """
    commands: list[list[str]] = []

    def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        """Record Docker commands and supply the requested runner outcome.

        Args:
            args: Docker command and arguments.
            kwargs: Subprocess timeout and output options.

        Returns:
            Successful Docker response, including the container's exit code.

        Raises:
            subprocess.TimeoutExpired: When the runner wait simulates a timeout.
        """
        commands.append(args)
        if args[1] == "wait":
            assert kwargs["timeout"] == 900
            if wait_result == "timeout":
                raise subprocess.TimeoutExpired(args, kwargs["timeout"])
            return subprocess.CompletedProcess(args, 0, str(wait_result))
        if args[1] == "logs":
            assert kwargs["stdout"] is None
            print("Runner output before cleanup")
        return subprocess.CompletedProcess(args, 0, "")

    monkeypatch.setattr(subprocess, "run", run)
    if wait_result == "timeout":
        with pytest.raises(subprocess.TimeoutExpired):
            launcher.run_suite("eolab-application:test")
    else:
        assert launcher.run_suite("eolab-application:test") == wait_result

    logs = next(i for i, command in enumerate(commands) if command[1] == "logs")
    removal = next(i for i, command in enumerate(commands) if command[1] == "rm")
    assert logs < removal
    assert commands[logs][-1] == commands[removal][-1]
    output = capsys.readouterr().out
    assert "Runner output before cleanup" in output
    assert "Processing test cleanup verified:" in output


@pytest.mark.parametrize("skip", [False, True])
def test_lane_turns_skips_into_failure(pytester: pytest.Pytester, skip: bool) -> None:
    """Use real pytest reports to prove a green skipped suite becomes nonzero.

    Args:
        pytester: Isolated pytest project for testing the coverage plugin itself.
        skip: Whether the synthetic store fixture skips its callers.
    """
    pytester.makeconftest(
        f"import sys\nsys.path.insert(0, {str(launcher.ROOT / 'scripts')!r})\n"
        "from processing_postgres_suite import RequiredDatabaseTests\n"
        "def pytest_configure(config):\n"
        "    config.pluginmanager.register(RequiredDatabaseTests())\n"
        "import pytest\n@pytest.fixture\ndef store():\n    "
        + ("pytest.skip('no database')" if skip else "return object()")
    )
    for name in SUITES:
        pytester.makepyfile(
            **{name.removesuffix(".py"): "def test_contract(store): pass"}
        )
    result = pytester.runpytest_subprocess("-q")
    assert result.ret == (pytest.ExitCode.TESTS_FAILED if skip else pytest.ExitCode.OK)


def test_lane_rejects_missing_module(pytester: pytest.Pytester) -> None:
    """Prevent a narrowed selection from masquerading as complete DB coverage.

    Args:
        pytester: Independent pytest collection project.
    """
    pytester.makepyfile(test_processing_jobs="def test_incomplete(): pass")
    pytester.makeconftest(
        f"import sys\nsys.path.insert(0, {str(launcher.ROOT / 'scripts')!r})\n"
        "from processing_postgres_suite import RequiredDatabaseTests\n"
        "def pytest_configure(config):\n"
        "    config.pluginmanager.register(RequiredDatabaseTests())\n"
    )
    result = pytester.runpytest_subprocess("-q")
    assert result.ret == pytest.ExitCode.USAGE_ERROR


def test_application_image_context_excludes_sources_and_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Inspect the real archive sent to Docker when validating installed packaging.

    Args:
        monkeypatch: Capture the build boundary without requiring a Docker daemon.
    """

    def inspect(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        """Check build inputs at the subprocess boundary.

        Args:
            args: Docker build argument vector.
            kwargs: Standard input archive and subprocess options.

        Returns:
            Successful Docker build result after archive assertions.
        """
        assert args[:2] == ["docker", "build"]
        with tarfile.open(fileobj=kwargs["stdin"], mode="r") as archive:
            names = archive.getnames()
            assert not any(name.startswith("src/") for name in names)
            assert not any(".env" in name or ".git" in name for name in names)
            assert "tests/test_processing_events_postgres.py" in names
            recipe = archive.extractfile("Dockerfile").read().decode()
            assert recipe.startswith("FROM eolab-application:test\n")
            assert "pip install --no-cache-dir ." not in recipe
            assert "ENTRYPOINT []" in recipe
        return subprocess.CompletedProcess(args, 0, "")

    monkeypatch.setattr(subprocess, "run", inspect)
    assert launcher.build_image("eolab-application:test").startswith(
        "eolab-processing-test:"
    )
