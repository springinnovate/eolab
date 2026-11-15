"""Build-time native and manual/CI HTTP smoke tests for the Job service.

Creates and deletes diagnostic jobs through HTTP to verify the deployed image's
startup, execution, error and cancellation paths. Called explicitly by the
application-build workflow or an operator; the service never imports this script.
The image build also runs ``--native`` against its packaged attribute reader.
"""

import json
import os
import sys
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4


def native_smoke() -> None:
    """Read four real features and calculate fields using the packaged OGR bindings.

    A temporary GeoPackage exercises numeric text, division, chained arithmetic,
    and missing values through the same native Arrow reader used by Jobs.

    Raises:
        AssertionError: If source reading or calculated values disagree.
        ImportError: If the image omits a required native dependency.
    """
    from pathlib import Path
    from tempfile import TemporaryDirectory
    from threading import Event

    import fiona

    from eolab_app.calculated_fields import CalculatedField, validate_calculated_fields
    from eolab_app.vector.field_calculation_operation import scan_calculated_fields
    from eolab_app.vector_fields import visit_vector_fields

    fields = {"Population": "float", "Area km2": "float", "Numeric text": "str"}
    definitions = (
        CalculatedField(name="Density", expression="'Population' / 'Area km2'"),
        CalculatedField(name="Scaled", expression="'Density' * 10 + 2"),
        CalculatedField(
            name="Converted", expression="'Numeric text'", numericText=True
        ),
    )
    with TemporaryDirectory(prefix="eolab-jobs-smoke-") as directory:
        path = Path(directory) / "regions.gpkg"
        with fiona.open(
            path,
            "w",
            driver="GPKG",
            layer="regions",
            crs="EPSG:4326",
            schema={"geometry": "Point", "properties": fields},
        ) as dataset:
            rows = (
                (100.0, 2.0, " 1e2 "),
                (10.0, 0.0, "12abc"),
                (None, 4.0, ""),
                (9.0, 3.0, "-2.5e1"),
            )
            for index, values in enumerate(rows):
                dataset.write(
                    {
                        "geometry": {"type": "Point", "coordinates": (index, index)},
                        "properties": dict(zip(fields, values)),
                    }
                )
        result = scan_calculated_fields(path, "regions", fields, definitions)
        assert result.featureCount == 4, result
        assert result.missingCounts == {
            "Density": 2,
            "Scaled": 2,
            "Converted": 2,
        }, result
        assert result.calculatedFields == definitions, result
        assert result.fields == {
            **fields,
            "Density": "float",
            "Scaled": "float",
            "Converted": "float",
        }, result
        observed: list[tuple[float | None, ...]] = []
        complete = visit_vector_fields(
            str(path),
            "regions",
            ("Density", "Scaled", "Converted"),
            None,
            Event(),
            lambda properties: observed.append(tuple(properties.values())),
            calculated_fields=validate_calculated_fields(definitions, fields),
        )
        assert complete
        assert observed == [
            (50.0, 502.0, 100.0),
            (None, None, None),
            (None, None, None),
            (3.0, 32.0, -25.0),
        ], observed
    print("Job container: native Arrow reading and four-feature arithmetic passed")


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
    if sys.argv[1] == "--native":
        native_smoke()
    else:
        main(sys.argv[1])
