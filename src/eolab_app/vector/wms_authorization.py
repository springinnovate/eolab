"""Vector-owned authorization for fixed public WMS parameters."""

from collections.abc import Mapping
from dataclasses import dataclass

from pydantic import ValidationError

from eolab_app.rendering.errors import PublishedLayerRequestError
from eolab_app.vector.models import (
    ResolvedVectorSource,
    VectorStyle,
    VectorSourceSignature,
)
from eolab_app.vector.styles import (
    build_vector_sld,
    default_vector_style,
    vector_style_name,
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

    def build_composite_sld(
        self,
        layer_name: str,
        style_name: str,
        style_environment: str | None,
        style_definition: Mapping[str, object] | None,
        opacity: float,
    ) -> bytes:
        """Build one authorized inline vector layer for composite rendering.

        Args:
            layer_name: Current workspace-qualified vector layer identity.
            style_name: Current feature-owned content style identity.
            style_environment: Unsupported raster-style representation.
            style_definition: Required complete vector appearance.
            opacity: Neutral retained-layer opacity from zero through one.

        Returns:
            Complete single-layer SLD document.

        Raises:
            PublishedLayerRequestError: If the style definition is invalid or
                does not produce the currently authorized style identity.
        """
        if (
            style_name != self.style_name
            or style_environment is not None
            or style_definition is None
        ):
            raise PublishedLayerRequestError(
                "Composite vector rendering requires its current vector style"
            )
        try:
            style = VectorStyle.model_validate(style_definition)
        except ValidationError as error:
            raise PublishedLayerRequestError(
                "Composite vector style is invalid"
            ) from error
        resource_name = layer_name.partition(":")[2]
        default_style_name = f"vector-{style.geometry_kind}"
        is_default_style = (
            style_name == default_style_name
            and style == default_vector_style(style.geometry_kind)
        )
        if (
            not is_default_style
            and vector_style_name(resource_name, style) != style_name
        ):
            raise PublishedLayerRequestError(
                "Composite vector style does not match its authorized identity"
            )
        return build_vector_sld(
            style_name,
            style,
            layer_name=layer_name,
            opacity_multiplier=opacity,
        )
