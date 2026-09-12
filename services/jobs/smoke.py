"""Manual/CI smoke test for an already-running Job service, not runtime code.

Creates and deletes diagnostic jobs through HTTP to verify the deployed image's
startup, execution, error and cancellation paths. Called explicitly by the
application-build workflow or an operator; the service never imports this script.
"""

import json
import os
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4


def request(
    base: str, path: str, method: str = "GET", body: dict | None = None
) -> tuple[int, dict]:
    """Send an authenticated smoke request without printing its credential.

    Args:
        base: Trusted service URL.
        path: API-relative path.
        method: HTTP method.
        body: Optional JSON request.

    Returns:
        Status and parsed JSON body.

    Raises:
        OSError: If the service cannot be reached.
    """
    message = Request(
        base.rstrip("/") + "/api/jobs" + path,
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": "Bearer " + os.environ["JOBS_SMOKE_TOKEN"],
            "Content-Type": "application/json",
            "Idempotency-Key": str(uuid4()),
        },
    )
    try:
        response = urlopen(message, timeout=5)
    except HTTPError as error:
        response = error
    with response:
        data = response.read()
        return response.status, json.loads(data) if data else {}


def main(base: str) -> None:
    """Check real HTTP success, failure and cancellation in a running image.

    Args:
        base: Trusted service URL.

    Raises:
        AssertionError: If any lifecycle contract fails.
    """
    assert request(base, "/health")[1]["acceptsJobs"]
    assert request(base, "/operations")[1]["operations"][0]["name"] == "diagnostic.v1"
    for mode, expected in (
        ("normal", "succeeded"),
        ("exception", "failed"),
        ("delay", "cancelled"),
    ):
        inputs = {"mode": mode, "value": "container smoke"}
        if mode == "delay":
            inputs["seconds"] = 20
        status, submitted = request(
            base, "", "POST", {"operation": "diagnostic.v1", "inputs": inputs}
        )
        assert status == 202, submitted
        path = "/" + submitted["jobId"]
        deadline = time.monotonic() + 10
        snapshot = submitted
        while time.monotonic() < deadline:
            snapshot = request(base, path)[1]
            if mode == "delay" and snapshot["status"] == "running":
                request(base, path + "/cancel", "POST")
            if snapshot["status"] == expected:
                break
            time.sleep(0.05)
        assert snapshot["status"] == expected, snapshot
        if expected == "succeeded":
            assert request(base, path + "/result")[1]["value"] == {
                "value": "container smoke"
            }
        assert request(base, path, "DELETE")[0] == 204
    print("Job container: success, exception, running cancellation and cleanup passed")


if __name__ == "__main__":
    main(sys.argv[1])
