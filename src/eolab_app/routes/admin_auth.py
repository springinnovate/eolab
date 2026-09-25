"""Administrator authentication shared by the site management endpoints."""

from collections.abc import Callable
import secrets
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBasic, HTTPBasicCredentials


def create_administrator_dependency(password: str) -> Callable[..., None]:
    """Require the configured admin password and same-origin writes.

    Args:
        password: Validated settings value; empty disables administration.

    Returns:
        FastAPI dependency for pages and APIs using the same Basic auth realm.
    """
    basic = HTTPBasic(auto_error=False, realm="EOLab administration")

    def require_administrator(
        request: Request,
        credentials: Annotated[HTTPBasicCredentials | None, Depends(basic)],
    ) -> None:
        """Authenticate a request without granting access through contributor cookies.

        Args:
            request: Incoming page or API request.
            credentials: Browser-managed HTTP Basic credentials, if present.

        Raises:
            HTTPException: If disabled, unauthorized, or a write is not same-origin.
        """
        if not password:
            raise HTTPException(404, "Administration is not configured.")
        username = credentials.username if credentials else ""
        supplied = credentials.password if credentials else ""
        correct_user = secrets.compare_digest(username.encode(), b"admin")
        correct_password = secrets.compare_digest(supplied.encode(), password.encode())
        if not (correct_user and correct_password):
            raise HTTPException(
                401,
                "Sign in as admin with the administrator password.",
                headers={
                    "WWW-Authenticate": 'Basic realm="EOLab administration"',
                    "Cache-Control": "private, no-store",
                },
            )
        if request.method not in {"GET", "HEAD"}:
            origin = request.headers.get("origin")
            if (
                request.headers.get("x-eolab-admin") != "1"
                or request.headers.get("sec-fetch-site") == "cross-site"
                or (origin and urlsplit(origin).netloc != request.url.netloc)
            ):
                raise HTTPException(403, "Use the administrator page on this site.")

    return require_administrator
