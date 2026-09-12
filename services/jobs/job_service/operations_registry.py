"""Explicit registration of code-installed operation functions and schemas."""

from dataclasses import dataclass
from typing import Callable

from pydantic import BaseModel

from job_service.models import Operation
from job_service.operations.diagnostic import (
    DiagnosticInput,
    DiagnosticResult,
    diagnostic,
)
from eolab_app.vector.outline_operation import (
    OutlineInput,
    OutlineResult,
    calculate_outline,
)


@dataclass(frozen=True)
class InstalledOperation:
    """Code-installed input/result validators and one executable algorithm."""

    name: str
    description: str
    input_model: type[BaseModel]
    result_model: type[BaseModel]
    execute: Callable[[BaseModel], BaseModel]

    def describe(self) -> Operation:
        """Publish JSON schemas for discovery.

        Returns:
            Public operation contract without executable code or paths.
        """
        return Operation(
            name=self.name,
            description=self.description,
            inputSchema=self.input_model.model_json_schema(),
            resultSchema=self.result_model.model_json_schema(),
        )


OPERATIONS = {
    "diagnostic.v1": InstalledOperation(
        "diagnostic.v1",
        "Echo a value, delay then echo, or raise a controlled exception.",
        DiagnosticInput,
        DiagnosticResult,
        diagnostic,
    ),
    "vector.outline.v1": InstalledOperation(
        "vector.outline.v1",
        "Build a simplified display outline from an immutable catalog selection.",
        OutlineInput,
        OutlineResult,
        calculate_outline,
    ),
}
