"""Run a diagnostic using the reusable client and a privately prompted token."""

import argparse
import asyncio
import getpass
import json

import httpx2

from eolab_jobs.client import JobFailed, JobsClient


async def demonstrate(
    url: str, mode: str, seconds: float, keep: bool, token: str
) -> int:
    """Submit and observe a real diagnostic operation.

    Args:
        url: Trusted /api/jobs endpoint.
        mode: normal, delay or exception.
        seconds: Delay duration; only used in delay mode.
        keep: Retain terminal state/results for subsequent manual retrieval.
        token: Privately entered caller credential.

    Returns:
        Zero on success, one on an unsuccessful terminal state.

    Raises:
        httpx2.HTTPError: For HTTP failures.
        ValueError: For invalid configuration or protocol responses.
        TimeoutError: If the client deadline expires.
    """
    async with httpx2.AsyncClient(timeout=5, trust_env=False) as http:
        jobs = JobsClient(http, token, url=url)
        try:
            result = await jobs.run(
                {
                    "operation": "diagnostic.v1",
                    "inputs": {
                        "mode": mode,
                        "seconds": seconds if mode == "delay" else 0,
                        "value": "hello from the Python Jobs client",
                    },
                },
                timeout_seconds=60,
                delete_on_completion=not keep,
            )
        except JobFailed as error:
            print(f"{error.snapshot.jobId}: {error.snapshot.status}")
            return 1
        print(f"{result.jobId}: succeeded")
        print(json.dumps(result.value, indent=2))
        return 0


def main() -> int:
    """Read demo arguments and prompt for a token without echoing it.

    Returns:
        Diagnostic success/failure exit code.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8083/api/jobs")
    parser.add_argument(
        "--mode", choices=("normal", "delay", "exception"), default="normal"
    )
    parser.add_argument("--seconds", type=float, default=2)
    parser.add_argument("--keep-result", action="store_true")
    args = parser.parse_args()
    token = getpass.getpass("Jobs caller token: ")
    return asyncio.run(
        demonstrate(args.url, args.mode, args.seconds, args.keep_result, token)
    )


if __name__ == "__main__":
    raise SystemExit(main())
