"""HTTP routes for mounted-dataset catalog scans."""

from typing import Any, Protocol

from fastapi import APIRouter, HTTPException


class ScanController(Protocol):
    """Application operations exposed by the scan router."""

    def status(self) -> dict[str, Any]:
        """Return the current scan snapshot.

        Returns:
            Active or most recently completed scan status.
        """

    async def start(self) -> dict[str, Any]:
        """Start a scan unless one is active.

        Returns:
            Initial status for the accepted scan.

        Raises:
            RuntimeError: If a scan is already running.
        """


def create_scan_router(scan_controller: ScanController) -> APIRouter:
    """Create scan routes bound to one application-owned controller.

    Args:
        scan_controller: Single-active-scan application boundary.

    Returns:
        Router exposing the existing scan HTTP contract.
    """
    router = APIRouter(prefix="/api/scans", tags=["catalog"])

    @router.get("/current")
    async def current_scan() -> dict[str, Any]:
        """Return current mounted-dataset scan progress.

        Returns:
            Active or most recently completed scan snapshot.
        """
        return scan_controller.status()

    @router.post("", status_code=202)
    async def start_scan() -> dict[str, Any]:
        """Start a recursive scan of the configured read-only source.

        Returns:
            Initial progress for the new scan.

        Raises:
            HTTPException: If another scan is still running.
        """
        try:
            return await scan_controller.start()
        except RuntimeError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    return router
