"""Deployment-owned caller identities and bounded, single-process capacity."""

import hashlib
import json
import os
import re
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Settings:
    """Single-replica limits; retained records include pending and finished jobs.

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
        if not (1 <= self.queue_capacity < self.record_capacity <= 10000):
            raise ValueError("Invalid Job service capacities")
        if (
            not all(
                0 < value <= 86400
                for value in (
                    self.retention_seconds,
                    self.execution_seconds,
                    self.queue_seconds,
                    self.max_timeout_seconds,
                )
            )
            or max(self.execution_seconds, self.queue_seconds)
            > self.max_timeout_seconds
        ):
            raise ValueError("Invalid Job service deadlines")


def load_settings() -> Settings:
    """Read bearer credentials from JOBS_CALLERS without logging their values.

    Returns:
        Settings with hashed caller credentials. An absent/empty map disables
        admission while leaving health and docs available.

    Raises:
        ValueError: For malformed, duplicate or weakly sized credentials.
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
        return Settings(callers=callers)
    except (ValueError, TypeError):
        raise ValueError(
            "Invalid JOBS_CALLERS; use unique random bearer tokens of 32–256 URL-safe characters"
        ) from None
