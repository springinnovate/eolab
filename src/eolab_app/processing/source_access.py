"""Adapt Processing artifact ownership to scoped immutable source-file access."""

from eolab_app.processing.models import ArtifactDownload, ProcessingError
from eolab_app.processing.service import ProcessingService
from eolab_app.source_files import LeasedSourceFiles, SourceFileError


def create_model_source_files(service: ProcessingService) -> LeasedSourceFiles:
    """Expose the existing artifact authority without leaking Processing errors to readers.

    Args:
        service: Existing owner of artifact access, retention and transfer limits.

    Returns:
        Source-file adapter shared by raster analysis and output previews.
    """

    async def acquire(owner: str, run_id: str, file_id: str) -> ArtifactDownload:
        """Authorize and retain an immutable run file.

        Args:
            owner: Server-derived session hash.
            run_id: Opaque run identity.
            file_id: Opaque file identity.

        Returns:
            Retained immutable artifact and its transfer token.

        Raises:
            SourceFileError: If Processing rejects access or capacity.
        """
        try:
            return await service.download_model_artifact(owner, run_id, file_id)
        except ProcessingError as error:
            raise SourceFileError(
                error.detail, error.status, code=error.code
            ) from error

    async def check(owner: str, run_id: str, file_id: str) -> tuple[int, str, str]:
        """Reauthorize a file before its derived data is delivered.

        Args:
            owner: Server-derived session hash.
            run_id: Opaque run identity.
            file_id: Opaque file identity.

        Returns:
            Published size, checksum and media type.

        Raises:
            SourceFileError: If Processing no longer authorizes the file.
        """
        try:
            return await service.check_model_artifact(owner, run_id, file_id)
        except ProcessingError as error:
            raise SourceFileError(
                error.detail, error.status, code=error.code
            ) from error

    async def release(lease: str) -> bool:
        """Release a completed reader's file retention.

        Args:
            lease: Owner-issued transfer capability.

        Returns:
            Whether the transfer still existed.
        """
        return await service.transfer_heartbeat(lease, release=True)

    return LeasedSourceFiles(acquire, release, check, service.transfer_heartbeat)
