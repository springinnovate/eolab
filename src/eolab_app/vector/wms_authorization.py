"""Vector-owned authorization for fixed public WMS parameters."""

from collections.abc import Mapping
from dataclasses import dataclass

from eolab_app.rendering.errors import PublishedLayerRequestError
from eolab_app.vector.models import (
    ResolvedVectorSource,
    VectorSourceSignature,
)


@dataclass(frozen=True)
class PublishedVectorAuthorization:
    """Current vector source plus its feature-owned WMS request policy.

    Attributes:
        source: Exact mounted source and native layer identity.
        source_signature: Complete filesystem identity approved at publication.
        style_name: Only WMS style authorized for this layer.
    """

    source: ResolvedVectorSource
    source_signature: VectorSourceSignature
    style_name: str

    def validate_parameters(
        self,
        operation: str,
        query: Mapping[str, str],
    ) -> None:
        """Reject dynamic substitutions unsupported by fixed vector styles.

        Args:
            operation: Normalized WMS operation.
            query: Normalized, globally bounded query parameters.

        Raises:
            PublishedLayerRequestError: If a dynamic environment is supplied.
        """
        del operation
        if "env" in query:
            raise PublishedLayerRequestError(
                "env is not supported for vector layers"
            )
