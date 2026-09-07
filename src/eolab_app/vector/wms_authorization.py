"""Vector-owned authorization for fixed public WMS parameters."""

from collections.abc import Mapping
from dataclasses import dataclass

from pydantic import ValidationError

from eolab_app.rendering.errors import PublishedLayerRequestError
from eolab_app.vector.filters import VectorFilter, filter_ecql, filter_vector_sld
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
        geometry_name: GeoServer geometry attribute retained with the style.
        upstream_layer_name: Original authorized publication for a filtered view.
        filter: Validated per-view predicate, never an arbitrary expression.
    """

    source: ResolvedVectorSource
    source_signature: VectorSourceSignature
    style_name: str
    geometry_name: str | None = None
    upstream_layer_name: str | None = None
    filter: VectorFilter | None = None

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

    def prepare_query(
        self, operation: str, query: list[tuple[str, str]],
    ) -> list[tuple[str, str]]:
        """Translate authorized public identities into an upstream WMS request.

        Args:
            operation: Validated lowercase WMS operation.
            query: Globally bounded and feature-validated public query entries.

        Returns:
            Server-owned upstream query entries.
        """
        if self.filter is None:
            return query
        normalized = {key.lower(): value for key, value in query}
        predicate = filter_ecql(self.filter)
        feature_id = normalized.get("featureid")
        if feature_id is not None:
            # The public boundary already restricts this to one safe feature ID.
            predicate = f"({predicate}) AND IN ('{feature_id}')"
        forwarded = [
            (key, self.upstream_layer_name if key.lower() in {"layer", "layers", "query_layers"} else value)
            for key, value in query
            if key.lower() not in {"tiled", "tilesorigin", "featureid"}
        ]
        if operation != "getlegendgraphic":
            forwarded.append(("cql_filter", predicate))
        return forwarded

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
        layer_name = self.upstream_layer_name or layer_name
        resource_name = layer_name.partition(":")[2]
        default_style_name = f"vector-{style.geometry_kind}"
        is_default_style = (
            style_name == default_style_name
            and style == default_vector_style(style.geometry_kind)
        )
        try:
            matches_style = is_default_style or vector_style_name(
                resource_name, style, geometry_name=self.geometry_name,
            ) == style_name
        except ValueError as error:
            raise PublishedLayerRequestError("Composite vector label geometry is unavailable") from error
        if not matches_style:
            raise PublishedLayerRequestError(
                "Composite vector style does not match its authorized identity"
            )
        document = build_vector_sld(
            style_name,
            style,
            layer_name=layer_name,
            opacity_multiplier=opacity,
            geometry_name=self.geometry_name,
        )
        return filter_vector_sld(document, self.filter) if self.filter is not None else document
