"""Verify operation-neutral HTTP artifact delivery through its service boundary."""

import hashlib
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from eolab_app.processing.models import ArtifactDownload
from eolab_app.routes.processing import create_processing_router


def test_job_result_delivery_uses_declared_file_type_and_releases_leases(
    tmp_path: Path,
) -> None:
    """Deliver a non-raster artifact without changing the shared job routes.

    Args:
        tmp_path: Isolated private artifact directory for actual HTTP file reads.
    """
    contents = b"year,count\n2024,5\n"
    result_path = tmp_path / "result.bin"
    result_path.write_bytes(contents)
    released: list[str] = []

    class ReportDownloads:
        """Provide only the public download and transfer-lifetime capabilities."""

        async def download(
            self, owner: str, identifier: str, provenance: bool = False
        ) -> ArtifactDownload:
            """Return a validated report artifact from a test operation owner.

            Args:
                owner: Hashed HTTP session capability passed by the route.
                identifier: Requested opaque job identifier.
                provenance: Whether the provenance artifact was requested.

            Returns:
                Owned file descriptor with an explicit non-raster media type.
            """
            assert len(owner) == 64 and identifier == "a" * 32
            assert not provenance
            return ArtifactDownload(
                path=result_path,
                filename="summary.csv",
                size=len(contents),
                sha256=hashlib.sha256(contents).hexdigest(),
                lease_id="report-transfer",
                media_type="text/csv",
            )

        async def transfer_heartbeat(self, lease: str, release: bool = False) -> bool:
            """Record lease release at the public service boundary.

            Args:
                lease: Transfer capability returned with the artifact.
                release: Whether the HTTP response completed its transfer.

            Returns:
                True while the test transfer is available.
            """
            if release:
                released.append(lease)
            return True

    app = FastAPI()
    app.include_router(create_processing_router(ReportDownloads()))
    with TestClient(app, base_url="https://testserver") as client:
        url = f"/api/processing/jobs/{'a' * 32}/result"
        response = client.get(url)
        assert response.status_code == 200
        assert response.content == contents
        assert response.headers["content-type"].startswith("text/csv")
        assert 'filename="summary.csv"' in response.headers["content-disposition"]
        partial = client.get(url, headers={"Range": "bytes=0-3"})
        assert partial.status_code == 206 and partial.content == contents[:4]
    assert released == ["report-transfer", "report-transfer"]
