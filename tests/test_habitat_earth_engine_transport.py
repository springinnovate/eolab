"""Exercise Habitat network recovery through the official Earth Engine client."""

from http.client import IncompleteRead
from pathlib import Path
from unittest.mock import Mock

from google.auth.crypt import Signer
from google.oauth2.service_account import Credentials
from httplib2 import Http, Response
import pytest
from shapely.geometry import box

from eolab_app.processing import habitat_earth_engine
from eolab_app.processing.habitat_earth_engine import (
    HabitatEarthEngineSettings,
    get_habitat_tiles,
)
from test_habitat_earth_engine import (
    _load_test_stack,
    _tile_bytes,
    _use_offline_earth_engine,
    reset_earth_engine,
)


def test_transient_requests_recover_through_sdk_backoff(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Retry a timeout, incomplete body and service error before publishing a tile.

    Args:
        tmp_path: Separate private attempt and immutable cache directories.
        monkeypatch: Replace remote responses and elapsed backoff with offline fakes.
    """
    responses = iter(
        [
            TimeoutError("socket read timed out"),
            IncompleteRead(b"partial response", 100),
            ({"status": "503"}, '{"error":{"message":"Service unavailable"}}'),
            ({"status": "200"}, _tile_bytes(7, 31)),
        ]
    )

    def respond(x: float, y: float) -> tuple[dict[str, str], bytes | str]:
        """Supply the next network outcome for the requested test tile.

        Args:
            x: Tile's western origin.
            y: Tile's northern origin.

        Returns:
            Provider status and payload after transient failures.

        Raises:
            TimeoutError: The first request's socket stopped responding.
            IncompleteRead: The next response ended before its body was complete.
        """
        assert (x, y) == (7, 31)
        outcome = next(responses)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    connections: list[tuple[int, Mock]] = []
    requests = _use_offline_earth_engine(monkeypatch, respond, transports=connections)
    sleep = Mock()
    monkeypatch.setattr("googleapiclient.http.time.sleep", sleep)
    monkeypatch.setattr("googleapiclient.http.random.random", lambda: 0.5)
    attempt = tmp_path / "attempt"
    attempt.mkdir()
    result = get_habitat_tiles(
        box(7, 11, 27, 31),
        _load_test_stack(2019),
        HabitatEarthEngineSettings("habitat-test", tmp_path / "key.json"),
        cache_directory=tmp_path / "cache",
        working_directory=attempt,
        progress=Mock(),
        check_cancelled=Mock(),
    )
    assert len(result.tiles) == 1 and result.failures == ()
    assert result.tiles[0].is_file()
    assert [call.args for call in sleep.call_args_list] == [(1.0,), (2.0,), (4.0,)]
    assert (
        sum("image:computePixels" in call.args[0] for call in requests.call_args_list)
        == 4
    )
    assert all(connection.timeout == 360 for _, connection in connections)
    assert sorted(connection.close.call_count for _, connection in connections) == [
        1,
        2,
    ]
    assert list(attempt.iterdir()) == []


def test_exhausted_socket_retries_preserve_other_tiles(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Report one failed tile after the SDK's finite retry budget and continue.

    Args:
        tmp_path: Parent of the cache, attempt and credential fixtures.
        monkeypatch: Replace remote requests and backoff waits with offline fakes.
    """
    attempts: dict[float, int] = {}

    def respond(x: float, y: float) -> tuple[dict[str, str], bytes]:
        """Keep the first tile offline while the second returns valid pixels.

        Args:
            x: Requested tile's western origin.
            y: Requested tile's northern origin.

        Returns:
            Successful provider response for the second tile.

        Raises:
            TimeoutError: Every request for the first tile fails.
        """
        attempts[x] = attempts.get(x, 0) + 1
        if x == 7:
            raise TimeoutError("socket read timed out")
        return {"status": "200"}, _tile_bytes(x, y)

    connections: list[tuple[int, Mock]] = []
    _use_offline_earth_engine(monkeypatch, respond, transports=connections)
    sleep = Mock()
    monkeypatch.setattr("googleapiclient.http.time.sleep", sleep)
    attempt = tmp_path / "attempt"
    attempt.mkdir()
    result = get_habitat_tiles(
        box(7, 11, 47, 31),
        _load_test_stack(2019),
        HabitatEarthEngineSettings("habitat-test", tmp_path / "key.json"),
        cache_directory=tmp_path / "cache",
        working_directory=attempt,
        progress=Mock(),
        check_cancelled=Mock(),
    )
    assert attempts == {7: 6, 27: 1}
    assert sleep.call_count == 5
    assert [path.parent.name for path in result.tiles] == ["1_-1"]
    (failure,) = result.failures
    assert (failure.column, failure.row) == (0, -1)
    assert failure.code == "earth_engine_connection_failed"
    assert result.required_tiles == 2 and result.missing_tiles == 1
    assert list(attempt.iterdir()) == []
    for _, connection in connections:
        connection.close.assert_called_once_with()


def test_credential_refresh_uses_the_bounded_thread_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Use the same finite socket timeout for token refresh and image requests.

    Args:
        monkeypatch: Replace only network I/O beneath the real auth/HTTP adapters.
    """
    signer = Mock(spec=Signer, key_id=None)
    signer.sign.return_value = b"offline-signature"
    credentials = Credentials(
        signer,
        "offline-test@example.org",
        "https://oauth2.googleapis.com/token",
        scopes=["https://www.googleapis.com/auth/earthengine"],
    )
    timeouts: list[float] = []

    def request(
        connection: Http, uri: str, method: str = "GET", **options: object
    ) -> tuple[Response, bytes]:
        """Record the real HTTP instance's socket timeout without using the network.

        Args:
            connection: Underlying HTTP instance supplied by the auth adapter.
            uri: Token or Earth Engine URL.
            method: Method selected by the credential or image request.
            **options: Forwarded HTTP request arguments.

        Returns:
            Token credentials or an empty successful image response.
        """
        timeouts.append(connection.timeout)
        if uri == "https://oauth2.googleapis.com/token":
            return Response({"status": "200"}), (
                b'{"access_token":"offline-test-token","expires_in":3600}'
            )
        assert options["headers"]["authorization"] == "Bearer offline-test-token"
        return Response({"status": "200"}), b"{}"

    monkeypatch.setattr(Http, "request", request)
    transport = habitat_earth_engine._HabitatEarthEngineTransport(credentials)
    try:
        transport.request(
            "https://earthengine.googleapis.com/v1/projects/test/image:computePixels",
            "POST",
        )
    finally:
        transport.close()
    assert timeouts == [360, 360]
    assert credentials.token is None
