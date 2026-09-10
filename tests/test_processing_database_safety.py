"""Prove destructive PostgreSQL fixtures refuse unsafe targets before mutation."""

from types import SimpleNamespace
from typing import Any

import psycopg
import pytest

import test_processing_jobs as jobs


@pytest.mark.parametrize(
    "dsn",
    [
        "postgresql://user@localhost/production",
        "dbname=eolab_processing",
        "dbname=prefix_eolab_processing_test",
        "host=localhost",
        "",
    ],
)
def test_unsafe_dsn_never_connects(dsn: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Reject unsafe and implicit database names without opening a connection.

    Args:
        dsn: Unsafe explicit test input; no live database is used.
        monkeypatch: Guard against accidental network access.
    """

    def unexpected(*args: Any, **kwargs: Any) -> None:
        """Fail if a rejected DSN reaches the database driver.

        Args:
            args: Unexpected connection arguments.
            kwargs: Unexpected connection keyword arguments.
        """
        pytest.fail("Unsafe DSN reached psycopg.connect")

    monkeypatch.setattr(psycopg, "connect", unexpected)
    request = SimpleNamespace(config=SimpleNamespace(getoption=lambda _: dsn))
    with pytest.raises(pytest.fail.Exception, match="explicit disposable"):
        jobs.store.__wrapped__(request)


def test_connected_database_guard_precedes_migration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Retain the resolved server database guard even after DSN validation.

    Args:
        monkeypatch: Supply a connection that reports an unsafe resolved database.
    """
    from unittest.mock import MagicMock

    connection = MagicMock()
    connection.__enter__.return_value.info.dbname = "production"
    monkeypatch.setattr(psycopg, "connect", lambda _: connection)
    request = SimpleNamespace(
        config=SimpleNamespace(getoption=lambda _: "dbname=eolab_processing_test_guard")
    )
    with pytest.raises(pytest.fail.Exception, match="disposable"):
        jobs.store.__wrapped__(request)
    connection.execute.assert_not_called()
