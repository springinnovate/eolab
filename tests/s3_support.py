"""Local S3-compatible HTTP fixture service for remote scanner tests."""

import hashlib
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit
from xml.sax.saxutils import escape


@dataclass(frozen=True)
class S3FixtureRequest:
    """One request observed by the local object-storage service.

    Attributes:
        method: HTTP request method.
        path: Decoded request path without query parameters.
        query: Parsed query parameter mapping.
        byte_range: Optional HTTP Range header.
    """

    method: str
    path: str
    query: dict[str, list[str]]
    byte_range: str | None


@dataclass
class S3FixtureObject:
    """One mutable object served by the local fixture.

    Attributes:
        content: Exact object bytes.
        last_modified: UTC-aware object timestamp.
        etag: Unquoted entity tag.
    """

    content: bytes
    last_modified: datetime
    etag: str


class S3FixtureService:
    """Serve a minimal signed-read S3 API on a local TCP endpoint."""

    def __init__(
        self,
        bucket: str = "catalog-fixture",
        access_key_id: str = "fixture-access",
    ) -> None:
        """Configure an empty fixture service.

        Args:
            bucket: Only bucket accepted by the service.
            access_key_id: Access-key identifier required in SigV4 headers.
        """
        self.bucket = bucket
        self.access_key_id = access_key_id
        self.objects: dict[str, S3FixtureObject] = {}
        self.requests: list[S3FixtureRequest] = []
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def endpoint_url(self) -> str:
        """Return the running service origin.

        Returns:
            HTTP origin containing the assigned loopback port.

        Raises:
            RuntimeError: If the service has not been started.
        """
        if self._server is None:
            raise RuntimeError("S3 fixture service is not running")
        host, port = self._server.server_address
        return f"http://{host}:{port}"

    def add_object(
        self,
        key: str,
        content: bytes,
        *,
        last_modified: datetime | None = None,
    ) -> None:
        """Create or replace an object in the fixture bucket.

        Args:
            key: Exact nonempty object key.
            content: Bytes returned by GET and range requests.
            last_modified: Optional UTC-aware timestamp. The default is a
                deterministic fixture time.

        Raises:
            ValueError: If the key is invalid or the timestamp is naive.
        """
        if not key or key.startswith("/") or ".." in PurePosixPath(key).parts:
            raise ValueError("Fixture object key must be a safe relative key")
        modified = last_modified or datetime(
            2025,
            1,
            2,
            3,
            4,
            5,
            tzinfo=timezone.utc,
        )
        if modified.tzinfo is None:
            raise ValueError("Fixture object timestamp must be timezone-aware")
        self.objects[key] = S3FixtureObject(
            content=content,
            last_modified=modified,
            etag=hashlib.md5(content, usedforsecurity=False).hexdigest(),
        )

    def remove_object(self, key: str) -> None:
        """Remove one fixture object if present.

        Args:
            key: Exact object key to remove.
        """
        self.objects.pop(key, None)

    def __enter__(self) -> "S3FixtureService":
        """Start the local service.

        Returns:
            Running fixture service.
        """
        fixture = self

        class RequestHandler(BaseHTTPRequestHandler):
            """Handle the bounded S3 read subset used by scanner tests."""

            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:
                """Serve ListObjectsV2 or one object byte range."""
                if not self._authorized():
                    self._send_error(403, "AccessDenied")
                    return
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query)
                self._record_request(parsed.path, query)
                if query.get("list-type") == ["2"]:
                    self._send_listing(query)
                    return
                self._send_object(parsed.path, include_body=True)

            def do_HEAD(self) -> None:
                """Serve object identity and size headers without a body."""
                if not self._authorized():
                    self._send_error(403, "AccessDenied", include_body=False)
                    return
                parsed = urlsplit(self.path)
                self._record_request(parsed.path, parse_qs(parsed.query))
                self._send_object(parsed.path, include_body=False)

            def log_message(self, format_text: str, *args: Any) -> None:
                """Suppress default stderr request logging.

                Args:
                    format_text: Standard-library log format string, unused.
                    *args: Standard-library log substitutions, unused.
                """
                del format_text, args

            def _authorized(self) -> bool:
                """Validate that SigV4 names the configured access key.

                Returns:
                    Whether the Authorization header contains the expected
                    credential identifier.
                """
                authorization = self.headers.get("Authorization", "")
                return f"Credential={fixture.access_key_id}/" in authorization

            def _record_request(
                self,
                path: str,
                query: dict[str, list[str]],
            ) -> None:
                """Append one immutable request observation.

                Args:
                    path: Encoded URL path.
                    query: Parsed query parameters.
                """
                fixture.requests.append(S3FixtureRequest(
                    method=self.command,
                    path=unquote(path),
                    query=query,
                    byte_range=self.headers.get("Range"),
                ))

            def _send_listing(self, query: dict[str, list[str]]) -> None:
                """Return one deterministic ListObjectsV2 XML page.

                Args:
                    query: Parsed S3 listing parameters.
                """
                prefix = query.get("prefix", [""])[0]
                max_keys = int(query.get("max-keys", ["1000"])[0])
                offset = int(query.get("continuation-token", ["0"])[0])
                keys = sorted(
                    key for key in fixture.objects if key.startswith(prefix)
                )
                page_keys = keys[offset : offset + max_keys]
                next_offset = offset + len(page_keys)
                is_truncated = next_offset < len(keys)
                contents = "".join(
                    self._listing_entry(key, fixture.objects[key])
                    for key in page_keys
                )
                next_token = (
                    "<NextContinuationToken>"
                    f"{next_offset}</NextContinuationToken>"
                    if is_truncated
                    else ""
                )
                body = (
                    '<?xml version="1.0" encoding="UTF-8"?>'
                    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
                    f"<Name>{escape(fixture.bucket)}</Name>"
                    f"<Prefix>{escape(prefix)}</Prefix>"
                    f"<MaxKeys>{max_keys}</MaxKeys>"
                    f"<KeyCount>{len(page_keys)}</KeyCount>"
                    f"<IsTruncated>{str(is_truncated).lower()}</IsTruncated>"
                    f"{contents}{next_token}</ListBucketResult>"
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/xml")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _listing_entry(
                self,
                key: str,
                fixture_object: S3FixtureObject,
            ) -> str:
                """Serialize one listing Content element.

                Args:
                    key: Exact object key.
                    fixture_object: Object metadata to expose.

                Returns:
                    XML fragment accepted by botocore and GDAL.
                """
                modified = fixture_object.last_modified.astimezone(
                    timezone.utc
                ).isoformat().replace("+00:00", "Z")
                return (
                    "<Contents>"
                    f"<Key>{escape(key)}</Key>"
                    f"<LastModified>{modified}</LastModified>"
                    f'<ETag>&quot;{fixture_object.etag}&quot;</ETag>'
                    f"<Size>{len(fixture_object.content)}</Size>"
                    "<StorageClass>STANDARD</StorageClass>"
                    "</Contents>"
                )

            def _send_object(self, path: str, *, include_body: bool) -> None:
                """Return HEAD metadata or a bounded GET response.

                Args:
                    path: Encoded path containing bucket and object key.
                    include_body: Whether to write response bytes.
                """
                path_parts = unquote(path).lstrip("/").split("/", 1)
                if len(path_parts) != 2 or path_parts[0] != fixture.bucket:
                    self._send_error(404, "NoSuchBucket", include_body=include_body)
                    return
                fixture_object = fixture.objects.get(path_parts[1])
                if fixture_object is None:
                    self._send_error(404, "NoSuchKey", include_body=include_body)
                    return
                content = fixture_object.content
                status = 200
                start = 0
                end = len(content) - 1
                byte_range = self.headers.get("Range")
                if byte_range is not None:
                    units, requested_range = byte_range.split("=", 1)
                    start_text, end_text = requested_range.split("-", 1)
                    if units != "bytes" or not start_text:
                        self._send_error(416, "InvalidRange", include_body=include_body)
                        return
                    start = int(start_text)
                    end = min(int(end_text) if end_text else end, end)
                    if start > end:
                        self._send_error(416, "InvalidRange", include_body=include_body)
                        return
                    status = 206
                response_content = content[start : end + 1]
                self.send_response(status)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("ETag", f'"{fixture_object.etag}"')
                self.send_header(
                    "Last-Modified",
                    format_datetime(fixture_object.last_modified, usegmt=True),
                )
                self.send_header("Content-Length", str(len(response_content)))
                if status == 206:
                    self.send_header(
                        "Content-Range",
                        f"bytes {start}-{end}/{len(content)}",
                    )
                self.end_headers()
                if include_body:
                    self.wfile.write(response_content)

            def _send_error(
                self,
                status: int,
                code: str,
                *,
                include_body: bool = True,
            ) -> None:
                """Return an S3-shaped error response.

                Args:
                    status: HTTP status code.
                    code: S3 error code.
                    include_body: Whether to write the XML body.
                """
                body = (
                    f"<Error><Code>{escape(code)}</Code>"
                    "<Message>fixture request rejected</Message></Error>"
                ).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/xml")
                self.send_header(
                    "Content-Length",
                    str(len(body) if include_body else 0),
                )
                self.end_headers()
                if include_body:
                    self.wfile.write(body)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), RequestHandler)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="s3-fixture",
            daemon=True,
        )
        self._thread.start()
        return self

    def __exit__(self, *exception_details: object) -> None:
        """Stop the local service and release its TCP socket.

        Args:
            *exception_details: Context-manager exception information, unused.
        """
        del exception_details
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._server = None
        self._thread = None
