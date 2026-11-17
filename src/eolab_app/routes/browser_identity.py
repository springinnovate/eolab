"""Recognize browser ownership across same-origin HTTP APIs."""

import hashlib
import re
import secrets
from urllib.parse import urlsplit

from fastapi import HTTPException, Request, Response

COOKIE = "__Host-eolab-annotations"


def establish_browser_identity(request: Request, response: Response) -> str:
    """Set the private ownership cookie before browser features begin requests.

    The same-origin startup request establishes an identity before uploads and
    shared layers run concurrently. Existing API boundaries also use this helper
    after checking their own mutation headers.

    Args:
        request: Incoming request with an existing cookie, if any.
        response: Response that renews the Secure, HttpOnly, SameSite Strict
            cookie for one year; its caller must prevent response caching.

    Returns:
        SHA-256 of the existing valid cookie or a newly generated random token.
        The raw token is sent only in the private cookie.
    """
    token = request.cookies.get(COOKIE, "")
    if not re.fullmatch(r"[a-f0-9]{64}", token):
        token = secrets.token_hex(32)
    response.set_cookie(
        COOKIE,
        token,
        max_age=365 * 86400,
        secure=True,
        httponly=True,
        samesite="strict",
        path="/",
    )
    return hashlib.sha256(token.encode()).hexdigest()


def get_browser_owner_hash(
    request: Request, response: Response, *, mutation_header: str
) -> str:
    """Identify a browser with a private cookie and check its mutation header.

    Args:
        request: Incoming request, including its browser cookie and origin.
        response: Response that renews the private cookie for one year.
        mutation_header: Header selected by the owning API; non-GET requests
            must send it with the value ``1``.

    Returns:
        SHA-256 of the browser's random cookie for server-side ownership lookups.
        The raw cookie stays Secure, HttpOnly and SameSite Strict.

    Raises:
        HTTPException: If a non-GET request is cross-site, has a different origin
            host, or lacks the API's required header value.
    """
    if request.method != "GET":
        origin = request.headers.get("origin")
        if (
            request.headers.get("sec-fetch-site") == "cross-site"
            or (origin and urlsplit(origin).netloc != request.url.netloc)
            or request.headers.get(mutation_header) != "1"
        ):
            raise HTTPException(
                403, f"Use a same-origin request with {mutation_header}: 1."
            )
    return establish_browser_identity(request, response)
