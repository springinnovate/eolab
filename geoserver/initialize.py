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
    """Reject a REST response outside the operation's documented contract."""
    if actual_status != expected_status:
        raise RuntimeError(
            f"GeoServer returned {actual_status} for {method} {path}"
        )


def initialize_geoserver(
    client: GeoServerRestClient,
    master_password: str,
    raster_style: bytes,
) -> None:
    """Ensure the EOLab master password, workspace, and raster style.

    Args:
        client: Authenticated internal GeoServer REST client.
        master_password: Desired keystore password.
        raster_style: SLD document for the shared raster style.
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


def main() -> None:
    """Load the deployment contract and initialize GeoServer."""
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
    )
    print("EOLab GeoServer workspace and raster style are ready.")


if __name__ == "__main__":
    main()
