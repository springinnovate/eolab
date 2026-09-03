"""Initialize the EOLab-owned GeoServer configuration."""

import base64
import json
import os
import re
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


WORKSPACE_NAME = "eolab"
RASTER_STYLE_NAME = "dynamic-raster"
RASTER_STYLE_PATH = Path(__file__).with_name(f"{RASTER_STYLE_NAME}.sld")
VECTOR_STYLE_NAMES = (
    "vector-point",
    "vector-line",
    "vector-polygon",
    "vector-highlight-point",
    "vector-highlight-line",
    "vector-highlight-polygon",
)
VECTOR_STYLE_PATHS = {
    style_name: Path(__file__).with_name(f"{style_name}.sld")
    for style_name in VECTOR_STYLE_NAMES
}
SCAN_SOURCE_URL_CHECK_NAME = "eolab-scan-source"
SCAN_SOURCE_URL_PATTERN = r"^file:///scan-source/.*$"
ADMIN_PASSWORD_PATTERN = re.compile(r"[A-Za-z0-9._-]{16,}")


class GeoServerRestClient:
    """Issue authenticated requests to GeoServer's internal REST API."""

    def __init__(self, base_url: str, username: str, password: str) -> None:
        """Configure the REST endpoint and administrator credentials.

        Args:
            base_url: Internal GeoServer application URL.
            username: GeoServer administrator username.
            password: GeoServer administrator password.
        """
        self.base_url = base_url.rstrip("/")
        encoded_credentials = base64.b64encode(
            f"{username}:{password}".encode()
        ).decode()
        self.authorization_header = f"Basic {encoded_credentials}"

    def request(
        self,
        method: str,
        path: str,
        body: bytes | None = None,
        content_type: str | None = None,
    ) -> tuple[int, bytes]:
        """Send one REST request and return its status and body.

        HTTP error responses are returned to the caller because initialization
        decisions distinguish an absent resource from every other failure.

        Args:
            method: HTTP request method.
            path: Path below GeoServer's ``/rest`` endpoint.
            body: Optional request body.
            content_type: Media type for a supplied body.

        Returns:
            HTTP status and response bytes.
        """
        headers = {
            "Accept": "application/json",
            "Authorization": self.authorization_header,
        }
        if content_type is not None:
            headers["Content-Type"] = content_type
        request = Request(
            f"{self.base_url}/rest{path}",
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=15) as response:
                return response.status, response.read()
        except HTTPError as error:
            return error.code, error.read()


def _require_status(
    actual_status: int,
    expected_status: int,
    method: str,
    path: str,
) -> None:
    """Reject a REST response outside the operation's documented contract.

    Args:
        actual_status: HTTP status returned by GeoServer.
        expected_status: Only accepted status for the operation.
        method: HTTP method used for diagnostic context.
        path: GeoServer REST path used for diagnostic context.

    Raises:
        RuntimeError: If GeoServer returns a different status.
    """
    if actual_status != expected_status:
        raise RuntimeError(
            f"GeoServer returned {actual_status} for {method} {path}"
        )


def initialize_geoserver(
    client: GeoServerRestClient,
    master_password: str,
    raster_style: bytes,
    vector_styles: dict[str, bytes] | None = None,
) -> None:
    """Ensure the EOLab security and rendering configuration.

    Args:
        client: Authenticated internal GeoServer REST client.
        master_password: Desired keystore password.
        raster_style: SLD document for the shared raster style.
        vector_styles: Geometry-specific vector SLD documents keyed by their
            initialized style names. ``None`` preserves the legacy test seam.

    Raises:
        KeyError: If GeoServer returns an invalid master-password document.
        RuntimeError: If a GeoServer operation violates its status contract.
        ValueError: If a vector style name is outside the initializer contract.
    """
    master_password_path = "/security/masterpw.json"
    status, response_body = client.request("GET", master_password_path)
    _require_status(status, 200, "GET", master_password_path)
    current_master_password = json.loads(response_body)["oldMasterPassword"]
    if current_master_password != master_password:
        status, _ = client.request(
            "PUT",
            master_password_path,
            json.dumps(
                {
                    "oldMasterPassword": current_master_password,
                    "newMasterPassword": master_password,
                }
            ).encode(),
            "application/json",
        )
        _require_status(status, 200, "PUT", master_password_path)

    url_check_path = f"/urlchecks/{SCAN_SOURCE_URL_CHECK_NAME}"
    status, _ = client.request("GET", f"{url_check_path}.json")
    url_check = json.dumps(
        {
            "regexUrlCheck": {
                "name": SCAN_SOURCE_URL_CHECK_NAME,
                "description": (
                    "Allow GeoServer to publish files from EOLab's "
                    "read-only scan mount"
                ),
                "enabled": True,
                "regex": SCAN_SOURCE_URL_PATTERN,
            }
        }
    ).encode()
    if status == 404:
        status, _ = client.request(
            "POST",
            "/urlchecks",
            url_check,
            "application/json",
        )
        _require_status(status, 201, "POST", "/urlchecks")
    else:
        _require_status(status, 200, "GET", url_check_path)
        status, _ = client.request(
            "PUT",
            url_check_path,
            url_check,
            "application/json",
        )
        _require_status(status, 200, "PUT", url_check_path)

    workspace_path = f"/workspaces/{WORKSPACE_NAME}.json"
    status, _ = client.request(
        "GET",
        f"{workspace_path}?quietOnNotFound=true",
    )
    if status == 404:
        status, _ = client.request(
            "POST",
            "/workspaces",
            json.dumps({"workspace": {"name": WORKSPACE_NAME}}).encode(),
            "application/json",
        )
        _require_status(status, 201, "POST", "/workspaces")
    else:
        _require_status(status, 200, "GET", workspace_path)

    style_path = f"/workspaces/{WORKSPACE_NAME}/styles/{RASTER_STYLE_NAME}"
    status, _ = client.request(
        "GET",
        f"{style_path}.sld?quietOnNotFound=true",
    )
    if status == 404:
        create_style_path = (
            f"/workspaces/{WORKSPACE_NAME}/styles?name={RASTER_STYLE_NAME}"
        )
        status, _ = client.request(
            "POST",
            create_style_path,
            raster_style,
            "application/vnd.ogc.sld+xml",
        )
        _require_status(status, 201, "POST", create_style_path)
    else:
        _require_status(status, 200, "GET", style_path)
        status, _ = client.request(
            "PUT",
            style_path,
            raster_style,
            "application/vnd.ogc.sld+xml",
        )
        _require_status(status, 200, "PUT", style_path)

    for style_name, style_document in (vector_styles or {}).items():
        if style_name not in VECTOR_STYLE_NAMES:
            raise ValueError(f"Unsupported initialized vector style: {style_name}")
        vector_style_path = (
            f"/workspaces/{WORKSPACE_NAME}/styles/{style_name}"
        )
        status, _ = client.request(
            "GET",
            f"{vector_style_path}.sld?quietOnNotFound=true",
        )
        if status == 404:
            create_style_path = (
                f"/workspaces/{WORKSPACE_NAME}/styles?name={style_name}"
            )
            status, _ = client.request(
                "POST",
                create_style_path,
                style_document,
                "application/vnd.ogc.sld+xml",
            )
            _require_status(status, 201, "POST", create_style_path)
        else:
            _require_status(status, 200, "GET", vector_style_path)
            status, _ = client.request(
                "PUT",
                vector_style_path,
                style_document,
                "application/vnd.ogc.sld+xml",
            )
            _require_status(status, 200, "PUT", vector_style_path)


def main() -> None:
    """Load the deployment contract and initialize GeoServer.

    Raises:
        KeyError: If a required deployment variable is absent.
        OSError: If an initializer-owned SLD cannot be read.
        RuntimeError: If GeoServer violates an operation status contract.
        ValueError: If credentials or initialized styles violate their
            contracts.
    """
    base_url = os.environ["GEOSERVER_INTERNAL_URL"].strip()
    username = os.environ["GEOSERVER_ADMIN_USER"].strip()
    admin_password = os.environ["GEOSERVER_ADMIN_PASSWORD"]
    master_password = os.environ["GEOSERVER_MASTER_PASSWORD"]
    if not base_url or not username or not admin_password:
        raise ValueError(
            "GeoServer URL and administrator credentials must not be blank"
        )
    if ADMIN_PASSWORD_PATTERN.fullmatch(admin_password) is None:
        raise ValueError(
            "GEOSERVER_ADMIN_PASSWORD must contain at least 16 letters, "
            "numbers, hyphens, underscores, or periods"
        )
    if master_password != master_password.strip() or len(master_password) < 8:
        raise ValueError(
            "GEOSERVER_MASTER_PASSWORD must contain at least eight characters "
            "and have no surrounding whitespace"
        )
    if master_password == admin_password:
        raise ValueError(
            "GEOSERVER_MASTER_PASSWORD must differ from "
            "GEOSERVER_ADMIN_PASSWORD"
        )

    initialize_geoserver(
        GeoServerRestClient(base_url, username, admin_password),
        master_password,
        RASTER_STYLE_PATH.read_bytes(),
        {
            style_name: style_path.read_bytes()
            for style_name, style_path in VECTOR_STYLE_PATHS.items()
        },
    )
    print("EOLab GeoServer security and rendering configuration are ready.")


if __name__ == "__main__":
    main()
