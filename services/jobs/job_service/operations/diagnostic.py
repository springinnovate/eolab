"""Diagnostic algorithm and its operation-specific input/result contracts."""

import json
import time
from typing import Literal

from pydantic import BaseModel, Field, JsonValue, model_validator

from job_service.models import Contract


class DiagnosticInput(Contract):
    """Echo a bounded JSON value, optionally after waiting or raising an error."""

    mode: Literal["normal", "delay", "exception"] = "normal"
    seconds: float = Field(default=0, ge=0, le=300, allow_inf_nan=False, strict=True)
    value: JsonValue = None

    @model_validator(mode="after")
    def validate_work(self) -> "DiagnosticInput":
        """Check mode-specific arguments and bound retained echo data.

        Returns:
            This validated request.

        Raises:
            ValueError: For inconsistent delay arguments or an oversized value.
        """
        if (self.mode == "delay") != (self.seconds > 0):
            raise ValueError("Use positive seconds only with delay mode")
        if len(json.dumps(self.value, allow_nan=False).encode()) > 8192:
            raise ValueError("Diagnostic value exceeds 8192 bytes")
        return self


class DiagnosticResult(Contract):
    """The supplied value, unchanged after successful execution."""

    value: JsonValue


def diagnostic(inputs: BaseModel) -> BaseModel:
    """Execute the diagnostic algorithm inside the supervised child process.

    Args:
        inputs: Validated DiagnosticInput from this operation's registry entry.

    Returns:
        Echo result for normal and delay modes.

    Raises:
        RuntimeError: Deliberately in exception mode.
    """
    request = DiagnosticInput.model_validate(inputs)
    if request.mode == "exception":
        raise RuntimeError("Requested diagnostic exception")
    if request.mode == "delay":
        time.sleep(request.seconds)
    return DiagnosticResult(value=request.value)
