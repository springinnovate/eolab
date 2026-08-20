"""Test the idempotent EOLab GeoServer bootstrap contract."""

import json

import pytest

from geoserver.initialize import initialize_geoserver, main


class RecordingGeoServerClient:
    """Return planned REST responses while recording every request."""

    def __init__(self, responses: list[tuple[int, bytes]]) -> None:
        self.responses = iter(responses)
        self.requests: list[tuple[str, str, bytes | None, str | None]] = []

    def request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> tuple[int, bytes]:
        """Record one request and return the next planned response."""
        self.requests.append((method, path, body, content_type))
        return next(self.responses)


def test_initialization_creates_only_missing_eolab_resources() -> None:
    """Create the scan-source rule, workspace, and style when absent."""
    client = RecordingGeoServerClient(
        [
            (200, b'{"oldMasterPassword":"geoserver"}'),
            (200, b""),
            (404, b""),
            (201, b""),
            (404, b""),
            (201, b""),
            (404, b""),
            (201, b""),
        ]
    )

    initialize_geoserver(client, "new-master-password", b"<sld/>")

    assert [request[0] for request in client.requests] == [
        "GET",
        "PUT",
        "GET",
        "POST",
        "GET",
        "POST",
        "GET",
        "POST",
    ]
    assert all(request[0] != "DELETE" for request in client.requests)
    assert json.loads(client.requests[1][2]) == {
        "oldMasterPassword": "geoserver",
        "newMasterPassword": "new-master-password",
    }
    assert client.requests[2][1] == "/urlchecks/eolab-scan-source.json"
    assert client.requests[3][1] == "/urlchecks"
    assert client.requests[3][3] == "application/json"
    assert json.loads(client.requests[3][2]) == {
        "regexUrlCheck": {
            "name": "eolab-scan-source",
            "description": (
                "Allow GeoServer to publish files from EOLab's "
                "read-only scan mount"
            ),
            "enabled": True,
            "regex": r"^file:///scan-source/.*$",
        }
    }
    assert json.loads(client.requests[5][2]) == {
        "workspace": {"name": "eolab"}
    }
    assert client.requests[7][1] == (
        "/workspaces/eolab/styles?name=dynamic-raster"
    )
    assert client.requests[7][2] == b"<sld/>"


def test_initialization_updates_existing_style_without_destructive_changes() -> None:
    """Repair the URL rule and style without destructive changes on rerun."""
    client = RecordingGeoServerClient(
        [
            (200, b'{"oldMasterPassword":"new-master-password"}'),
            (200, b""),
            (200, b""),
            (200, b""),
            (200, b"<old-style/>"),
            (200, b""),
        ]
    )

    initialize_geoserver(client, "new-master-password", b"<current-style/>")

    assert [request[0] for request in client.requests] == [
        "GET",
        "GET",
        "PUT",
        "GET",
        "GET",
        "PUT",
    ]
    assert client.requests[2][1] == "/urlchecks/eolab-scan-source"
    assert json.loads(client.requests[2][2])["regexUrlCheck"]["regex"] == (
        r"^file:///scan-source/.*$"
    )
    assert client.requests[-1][1] == (
        "/workspaces/eolab/styles/dynamic-raster"
    )
    assert client.requests[-1][2] == b"<current-style/>"
    assert all(request[0] != "DELETE" for request in client.requests)


def test_initialization_rejects_unexpected_geoserver_response() -> None:
    """Fail deployment rather than guessing after an undocumented response."""
    client = RecordingGeoServerClient([(401, b"")])

    with pytest.raises(RuntimeError, match="401 for GET /security/masterpw.json"):
        initialize_geoserver(client, "new-master-password", b"<sld/>")


@pytest.mark.parametrize(
    ("admin_password", "master_password", "expected_error"),
    (
        ("admin-password", "valid-master-password", "at least 16"),
        ("invalid*admin-password", "valid-master-password", "at least 16"),
        ("valid-admin-password", "short", "at least eight characters"),
        ("valid-admin-password", " padded-password ", "at least eight characters"),
        ("same-long-password", "same-long-password", "must differ"),
    ),
)
def test_main_rejects_invalid_passwords(
    monkeypatch: pytest.MonkeyPatch,
    admin_password: str,
    master_password: str,
    expected_error: str,
) -> None:
    """Reject credentials the official image or GeoServer would reinterpret."""
    monkeypatch.setenv("GEOSERVER_INTERNAL_URL", "http://geoserver/geoserver")
    monkeypatch.setenv("GEOSERVER_ADMIN_USER", "eolab")
    monkeypatch.setenv("GEOSERVER_ADMIN_PASSWORD", admin_password)
    monkeypatch.setenv("GEOSERVER_MASTER_PASSWORD", master_password)

    with pytest.raises(ValueError, match=expected_error):
        main()
