"""Verify concurrent real suites plus failed and interrupted Docker cleanup."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

from test_processing_postgres import LABEL, ROOT, docker


def verify_run(arguments: list[str], *, interrupt: bool = False) -> tuple[int, str]:
    """Execute a launcher and independently check that its resources disappear.

    Args:
        arguments: Launcher options, including optional failure injection.
        interrupt: Send SIGTERM after its real test container starts.

    Returns:
        Launcher exit status and unique run name after verified cleanup.

    Raises:
        RuntimeError: If startup, process completion or cleanup violates the contract.
    """
    with tempfile.TemporaryDirectory(
        prefix="eolab-processing-verification-"
    ) as directory:
        log_path = Path(directory) / "launcher.log"
        log = log_path.open("w", encoding="utf-8")
        process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "scripts/test_processing_postgres.py"),
                *arguments,
            ],
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        try:
            if interrupt:
                deadline = time.monotonic() + 1200
                while process.poll() is None and time.monotonic() < deadline:
                    if "Processing test runner started:" in log_path.read_text(
                        encoding="utf-8"
                    ):
                        process.send_signal(signal.SIGTERM)
                        break
                    time.sleep(0.2)
                else:
                    raise RuntimeError(
                        "Interrupted test runner did not reach its startup checkpoint"
                    )
            status = process.wait(timeout=1800)
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=90)
            log.close()
            output = log_path.read_text(encoding="utf-8")
            print(output, flush=True)
        names = re.findall(
            r"Processing test run: (eolab_processing_test_[0-9a-f]{32})", output
        )
        if len(names) != 1:
            raise RuntimeError(
                "Expected exactly one uniquely identified disposable database"
            )
        name = names[0]
        if f"Processing test cleanup verified: {name}" not in output:
            raise RuntimeError(f"Cleanup was not confirmed for {name}")
        if docker("ps", "-aq", "--filter", f"label={LABEL}={name}") or docker(
            "network", "ls", "-q", "--filter", f"label={LABEL}={name}"
        ):
            raise RuntimeError(f"Resources survived launcher exit: {name}")
        return status, name


def main() -> int:
    """Exercise the real lifecycle acceptance checks on a Linux Docker host.

    Returns:
        Zero after two successful suites and verified failure/interruption cleanup.

    Raises:
        RuntimeError: If any lifecycle acceptance check fails.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--application-image")
    args = parser.parse_args()
    if sys.platform == "win32":
        parser.error(
            "SIGTERM cleanup verification requires Linux; use the normal launcher on Windows"
        )
    options = (
        ["--application-image", args.application_image]
        if args.application_image
        else []
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(verify_run, [options, options]))
    if [status for status, _ in results] != [0, 0]:
        raise RuntimeError(f"Concurrent real PostgreSQL suites failed: {results}")
    if len({name for _, name in results}) != 2:
        raise RuntimeError("Concurrent runs did not use distinct database identities")
    if verify_run([*options, "--inject-failure"])[0] != 1:
        raise RuntimeError("Injected pytest failure did not propagate exit status 1")
    if verify_run(options, interrupt=True)[0] != 130:
        raise RuntimeError("Interrupted launcher did not report exit status 130")
    print("Verified concurrent suites, injected pytest failure and SIGTERM cleanup")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
