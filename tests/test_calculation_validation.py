"""The editor validates through Processing's grammar without any I/O dependency."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError

from eolab_app.processing.aggregate_models import (
    AggregatePlanRequest,
    AggregateValidationRequest,
)
from eolab_app.routes.processing import create_processing_router
from test_raster_clips import SOURCE
from pathlib import Path
from html import unescape
import re

from eolab_app.processing.raster_expression import FUNCTIONS, compile_expression


def test_validation_http_needs_no_service_source_storage_or_native_reader() -> None:
    """A router with no service can validate but cannot possibly plan or enqueue."""
    app = FastAPI()
    app.include_router(create_processing_router(None))
    with TestClient(app, base_url="https://testserver") as client:
        url = "/api/processing/raster-calculations/validate"
        body = {
            "alias": "a",
            "calculations": [{"label": "Matches", "expression": "count(a > 10)"}],
        }
        response = client.post(url, json=body, headers={"X-EOLab-Processing": "1"})
        assert response.status_code == 200
        assert response.json() == {"valid": True}
        assert response.headers["cache-control"] == "private, no-store"
        assert client.post(url, json=body).status_code == 403
        assert (
            client.post(
                url,
                json=body,
                headers={"X-EOLab-Processing": "1", "Origin": "https://elsewhere.test"},
            ).status_code
            == 403
        )
        assert client.post(url, content=b"x" * 17000).status_code == 413
        body["calculations"][0]["expression"] = "sum(a[0])"
        invalid = client.post(url, json=body, headers={"X-EOLab-Processing": "1"})
        assert invalid.status_code == 422
        assert (
            "expression" in invalid.text.lower() or "unexpected" in invalid.text.lower()
        )


@pytest.mark.parametrize(
    "expression",
    [
        "count(a > 10)",
        "sum(a, where=a > 10)",
        "mean(a > 10)",
        "sum(b)",
        "areaha(a == 4)",
        "max(min(a))",
        "__import__('os')",
    ],
)
def test_validation_and_planning_use_identical_language(expression: str) -> None:
    """Both entry points accept/reject exactly the same typed language.

    Args:
        expression: A valid or invalid scalar calculation.
    """
    calculations = [{"label": "Result", "expression": expression}]
    accepted = []
    for model, extra in [
        (AggregateValidationRequest, {"alias": "a"}),
        (AggregatePlanRequest, {"sources": {"a": SOURCE}, "wholeRaster": True}),
    ]:
        try:
            model(calculations=calculations, **extra)
            accepted.append(True)
        except ValidationError:
            accepted.append(False)
    assert accepted[0] == accepted[1]


def test_expression_help_lists_every_function_with_valid_examples() -> None:
    """Keep the visible function list complete and its copyable examples accepted."""
    markup = Path("frontend/index.html").read_text(encoding="utf-8")
    help_text = markup.split('id="calculations-help"', 1)[1].split("</details>", 1)[0]
    function_list = help_text.split('<ul class="calculation-functions">', 1)[1].split(
        "</ul>", 1
    )[0]
    examples = [
        unescape(value)
        for value in re.findall(r"<li><code>(.*?)</code>", function_list)
    ]
    assert {value.split("(", 1)[0] for value in examples} == FUNCTIONS
    for value in re.findall(r"<code>(.*?)</code>", help_text):
        expression = unescape(value)
        if "(" in expression:
            compile_expression(expression, "a")
