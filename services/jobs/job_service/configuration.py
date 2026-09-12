"""Deployment-owned caller identities and bounded, single-process capacity."""

import hashlib
import json
import math
import os
import re
from dataclasses import dataclass, field
from collections.abc import Callable
from typing import TypeVar

Number = TypeVar("Number", int, float)


@dataclass(frozen=True)
class Settings:
    """Limits for one Job service instance, including pending and finished jobs.

    Caller keys are stable owner names; values are SHA-256 credential digests.
    Records and idempotency keys expire together after retention_seconds and
    are lost on restart. A full record store rejects admission, never evicts
    another caller's unexpired result.
    """

    callers: dict[str, str] = field(default_factory=dict, repr=False)
    queue_capacity: int = 32
    record_capacity: int = 128
    retention_seconds: float = 3600
    execution_seconds: float = 60
    queue_seconds: float = 60
    max_timeout_seconds: float = 300

    def __post_init__(self) -> None:
        """Reject invalid capacity/deadline configuration.

        Raises:
            ValueError: If configuration cannot provide bounded execution.
        """
        for name in ("queue_capacity", "record_capacity"):
            value = getattr(self, name)
            if type(value) is not int or not 1 <= value <= 10000:
                raise ValueError(f"{name} must be an integer between 1 and 10000")
        if self.queue_capacity >= self.record_capacity:
            raise ValueError("record_capacity must exceed queue_capacity")
        for name in (
            "retention_seconds",
            "execution_seconds",
            "queue_seconds",
            "max_timeout_seconds",
        ):
            value = getattr(self, name)
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or not 0 < value <= 86400
            ):
                raise ValueError(
                    f"{name} must be finite, positive and at most 86400 seconds"
                )
        if max(self.execution_seconds, self.queue_seconds) > self.max_timeout_seconds:
            raise ValueError(
                "Default queue/execution timeouts must not exceed max_timeout_seconds"
            )


def _environment_number(
    name: str, default: Number, parser: Callable[[str], Number]
) -> Number:
    """Parse an optional numeric setting; explicitly blank values are invalid.

    Args:
        name: Environment variable name.
        default: Value used only when the variable is absent.
        parser: Integer or floating-point conversion.

    Returns:
        Parsed value; Settings validates its range and related limits.

    Raises:
        ValueError: If the supplied text cannot be parsed.
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        return parser(raw)
    except ValueError:
        raise ValueError(f"{name} must be a valid {parser.__name__}") from None


def load_settings() -> Settings:
    """Read caller credentials and limits from the process environment once.

    Returns:
        Settings with hashed caller credentials. An absent/empty map disables
        admission while leaving health and docs available.

    Raises:
        ValueError: For invalid credentials, numeric settings or limit combinations.
    """
    try:
        raw = json.loads(os.environ.get("JOBS_CALLERS") or "{}")
        if not isinstance(raw, dict) or len(raw) > 32:
            raise ValueError
        callers = {}
        for owner, token in raw.items():
            if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", owner):
                raise ValueError
            if not isinstance(token, str) or not re.fullmatch(
                r"[A-Za-z0-9._~-]{32,256}", token
            ):
                raise ValueError
            digest = hashlib.sha256(token.encode()).hexdigest()
            if digest in callers.values():
                raise ValueError
            callers[owner] = digest
    except (ValueError, TypeError):
        raise ValueError(
            "Invalid JOBS_CALLERS; use unique random bearer tokens of 32–256 URL-safe characters"
        ) from None
    defaults = Settings()
    return Settings(
        callers=callers,
        queue_capacity=_environment_number(
            "JOBS_QUEUE_CAPACITY", defaults.queue_capacity, int
        ),
        record_capacity=_environment_number(
            "JOBS_RECORD_CAPACITY", defaults.record_capacity, int
        ),
        retention_seconds=_environment_number(
            "JOBS_RETENTION_SECONDS", defaults.retention_seconds, float
        ),
        execution_seconds=_environment_number(
            "JOBS_EXECUTION_TIMEOUT_SECONDS", defaults.execution_seconds, float
        ),
        queue_seconds=_environment_number(
            "JOBS_QUEUE_TIMEOUT_SECONDS", defaults.queue_seconds, float
        ),
        max_timeout_seconds=_environment_number(
            "JOBS_MAX_TIMEOUT_SECONDS", defaults.max_timeout_seconds, float
        ),
    )
