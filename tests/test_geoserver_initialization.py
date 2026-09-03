"""Test the idempotent EOLab GeoServer bootstrap contract."""

import json
from pathlib import Path
from xml.etree import ElementTree

import pytest

from geoserver.initialize import (
    geowebcache_disk_quota_document,
    geowebcache_layer_document,
    initialize_geoserver,
    initialize_geowebcache,
    main,
    web_mercator_gridset_document,
)


class RecordingGeoServerClient:
    """Return planned HTTP (status, body) pairs while recording requests."""

    def __init__(
        self,
        responses: list[tuple[int, bytes]],
        application_responses: list[tuple[int, bytes]] | None = None,
    ) -> None:
        """Create response plans and empty request recordings.

        Args:
            responses: Planned GeoServer REST responses.
            application_responses: Planned application-root REST responses.

        Returns:
            None.
        """
        self.responses = iter(responses)
        self.application_responses = iter(application_responses or [])
        self.requests: list[tuple[str, str, bytes | None, str | None]] = []
        self.application_requests: list[
            tuple[str, str, bytes | None, str | None]
        ] = []

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

    def request_application(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> tuple[int, bytes]:
        """Record one application-root request and return its response.

        Args:
            method: HTTP request method.
            path: Application-relative request path.
            body: Optional request body.
            content_type: Optional request media type.

        Returns:
            Next planned HTTP status and response body.
        """
        self.application_requests.append((method, path, body, content_type))
        return next(self.application_responses)


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


def test_initialization_converges_every_fixed_vector_style() -> None:
    """Create or update default and selection-outline vector styles."""
    client = RecordingGeoServerClient(
        [
            (200, b'{"oldMasterPassword":"new-master-password"}'),
            (200, b""),
            (200, b""),
            (200, b""),
            (200, b""),
            (200, b""),
            (404, b""),
            (201, b""),
            (200, b""),
            (200, b""),
            (404, b""),
            (201, b""),
            (404, b""),
            (201, b""),
            (404, b""),
            (201, b""),
            (404, b""),
            (201, b""),
        ]
    )
    vector_styles = {
        "vector-point": b"<point/>",
        "vector-line": b"<line/>",
        "vector-polygon": b"<polygon/>",
        "vector-highlight-point": b"<highlight-point/>",
        "vector-highlight-line": b"<highlight-line/>",
        "vector-highlight-polygon": b"<highlight-polygon/>",
    }

    initialize_geoserver(
        client,
        "new-master-password",
        b"<raster/>",
        vector_styles,
    )

    style_writes = [
        request for request in client.requests
        if request[0] in {"POST", "PUT"}
        and "/styles" in request[1]
    ]
    assert [(request[1], request[2]) for request in style_writes] == [
        ("/workspaces/eolab/styles/dynamic-raster", b"<raster/>"),
        ("/workspaces/eolab/styles?name=vector-point", b"<point/>"),
        ("/workspaces/eolab/styles/vector-line", b"<line/>"),
        ("/workspaces/eolab/styles?name=vector-polygon", b"<polygon/>"),
        (
            "/workspaces/eolab/styles?name=vector-highlight-point",
            b"<highlight-point/>",
        ),
        (
            "/workspaces/eolab/styles?name=vector-highlight-line",
            b"<highlight-line/>",
        ),
        (
            "/workspaces/eolab/styles?name=vector-highlight-polygon",
            b"<highlight-polygon/>",
        ),
    ]


def test_initialization_rejects_unexpected_geoserver_response() -> None:
    """Fail deployment rather than guessing after an undocumented response."""
    client = RecordingGeoServerClient([(401, b"")])

    with pytest.raises(RuntimeError, match="401 for GET /security/masterpw.json"):
        initialize_geoserver(client, "new-master-password", b"<sld/>")


def test_geowebcache_initialization_uses_only_epsg3857_and_bounded_storage() -> None:
    """Converge existing EOLab layers, quota, and direct WMS integration."""
    layer_list = (
        b"<layers><layer><name>eolab:raster</name></layer>"
        b"<layer><name>external:ignored</name></layer></layers>"
    )
    client = RecordingGeoServerClient(
        [(200, b""), (200, b"")],
        [
            (404, b""),
            (200, b""),
            (200, layer_list),
            (200, b""),
            (200, b""),
        ],
    )
    configuration = (
        Path(__file__).parents[1] / "geoserver" / "gwc-gs.xml"
    ).read_bytes()

    initialize_geowebcache(client, configuration, 25)

    assert [request[:2] for request in client.application_requests] == [
        ("GET", "/gwc/rest/gridsets/EPSG:3857.xml"),
        ("PUT", "/gwc/rest/gridsets/EPSG:3857.xml"),
        ("GET", "/gwc/rest/layers.xml"),
        ("PUT", "/gwc/rest/layers/eolab%3Araster.xml"),
        ("PUT", "/gwc/rest/diskquota.xml"),
    ]
    assert [request[:2] for request in client.requests] == [
        ("PUT", "/resource/gwc-gs.xml"),
        ("POST", "/reload"),
    ]
    assert b"EPSG:3857" in configuration
    assert b"900913" not in configuration
    assert b"<directWMSIntegrationEnabled>true" in configuration
    quota = ElementTree.fromstring(client.application_requests[-1][2])
    assert quota.findtext("globalExpirationPolicyName") == "LRU"
    assert quota.findtext("globalQuota/value") == "25"
    assert quota.findtext("globalQuota/units") == "GiB"


def test_epsg3857_grid_and_layer_documents_match_leaflet_tiles() -> None:
    """Pin one global 256-pixel Web Mercator pyramid and bounded ENV key."""
    grid = ElementTree.fromstring(web_mercator_gridset_document())
    layer = ElementTree.fromstring(geowebcache_layer_document("eolab:raster"))
    quota = ElementTree.fromstring(geowebcache_disk_quota_document(7))

    assert grid.findtext("name") == "EPSG:3857"
    assert grid.findtext("srs/number") == "3857"
    assert grid.findtext("tileWidth") == grid.findtext("tileHeight") == "256"
    assert len(grid.findall("resolutions/double")) == 25
    assert len(grid.findall("scaleNames/string")) == 25
    assert grid.findtext("resolutions/double") == "156543.03392804097"
    assert layer.findtext("gridSubsets/gridSubset/gridSetName") == "EPSG:3857"
    assert layer.find("gridSubsets/gridSubset/extent") is None
    assert layer.findtext("parameterFilters/regexParameterFilter/key") == "ENV"
    assert layer.findtext("parameterFilters/regexParameterFilter/regex") == (
        r"[^\r\n]{1,384}"
    )
    assert quota.findtext("globalQuota/value") == "7"
    assert b"900913" not in web_mercator_gridset_document()


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


def test_main_rejects_invalid_geowebcache_quota(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject an unbounded or malformed persistent tile cache.

    Args:
        monkeypatch: Pytest environment mutation fixture.

    Returns:
        None.
    """
    monkeypatch.setenv("GEOSERVER_INTERNAL_URL", "http://geoserver/geoserver")
    monkeypatch.setenv("GEOSERVER_ADMIN_USER", "eolab")
    monkeypatch.setenv("GEOSERVER_ADMIN_PASSWORD", "valid-admin-password")
    monkeypatch.setenv("GEOSERVER_MASTER_PASSWORD", "valid-master-password")
    monkeypatch.setenv("GEOWEBCACHE_DISK_QUOTA_GIB", "0")

    with pytest.raises(ValueError, match="must be a positive integer"):
        main()
