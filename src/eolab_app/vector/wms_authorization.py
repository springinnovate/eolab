"""Authorize source-bound vector appearances and build request-local WMS styles."""

from collections.abc import Mapping
from base64 import urlsafe_b64encode
from dataclasses import dataclass, field
import hmac
import json

from pydantic import TypeAdapter, ValidationError
from eolab_app.calculated_fields import (
    CalculatedField,
    CompiledCalculatedField,
    compile_field_expression,
    evaluate_calculated_fields,
)

from eolab_app.rendering.errors import PublishedLayerRequestError
from eolab_app.vector.filters import VectorFilter, filter_ecql, filter_vector_sld
from eolab_app.vector.models import (
    ResolvedVectorSource,
    VectorStyle,
)
from eolab_app.vector.styles import (
    build_vector_sld,
    default_vector_style,
    vector_label_rendering_buffer,
    vector_style_name,
)


@dataclass(frozen=True)
class PublishedVectorAuthorization:
    """Published vector source and its key for approving map appearances.

    Attributes:
        source: Exact mounted source and native layer identity.
        default_style_name: Initializer-owned fixed appearance for this geometry.
        signing_key: Process-local secret shared by appearances of this source.
        geometry_name: GeoServer geometry attribute resolved for fixed labels.
        upstream_layer_name: Original authorized publication for a filtered view.
        filter: Validated per-view predicate, never an arbitrary expression.
        inspection_layer_name: Original-geometry publication used for feature
            inspection and ID-specific highlights when the map uses overviews.
        calculated_fields: Source-validated definitions retained with a filtered view.
    """

    source: ResolvedVectorSource
    default_style_name: str
    signing_key: bytes = field(repr=False)
    geometry_name: str | None = None
    upstream_layer_name: str | None = None
    filter: VectorFilter | None = None
    inspection_layer_name: str | None = None
    calculated_fields: tuple[CalculatedField, ...] = ()

    def sign_style_name(self, style_name: str) -> str:
        """Sign a validated content identity for this immutable vector source.

        Args:
            style_name: Content identity approved by the vector style service.

        Returns:
            Identity and authentication code, without retaining style history.
        """
        signature = hmac.digest(self.signing_key, style_name.encode("utf-8"), "sha256")
        return f"{style_name}.{signature.hex()}"

    def is_style_authorized(self, style_name: str) -> bool:
        """Check whether this source approved a requested style identity.

        Args:
            style_name: Unqualified fixed or signed appearance identity.

        Returns:
            True for the fixed default or a valid source-bound signature.
        """
        if style_name == self.default_style_name:
            return True
        content_name, separator, _signature = style_name.rpartition(".")
        return bool(separator) and hmac.compare_digest(
            self.sign_style_name(content_name).encode("utf-8"),
            style_name.encode("utf-8"),
        )

    def validate_parameters(
        self,
        operation: str,
        query: Mapping[str, str],
    ) -> None:
        """Validate vector inspection options and reject raster substitutions.

        Args:
            operation: Normalized WMS operation.
            query: Normalized, globally bounded query parameters.

        Raises:
            PublishedLayerRequestError: If bounds are requested outside feature
                inspection, their flag is invalid, or raster options are supplied.
        """
        if "vector_feature_bounds" in query and (
            operation != "getfeatureinfo" or query["vector_feature_bounds"] != "true"
        ):
            raise PublishedLayerRequestError(
                "vector_feature_bounds requires GetFeatureInfo and the value true"
            )
        if "raster_style" in query:
            raise PublishedLayerRequestError(
                "raster_style is not supported for vector layers"
            )
        if "env" in query:
            raise PublishedLayerRequestError(
                "env is not supported for vector layers"
            )

    def prepare_query(
        self, operation: str, query: list[tuple[str, str]],
    ) -> list[tuple[str, str]]:
        """Build the authorized appearance, filter and bounded inspection format.

        When feature bounds are requested, GeoServer reads geometry to return
        WGS84 envelopes without serializing full geometry. Requested scalar
        fields are selected inside the writer before response-size validation.
        Attribute-only requests, including hover, keep their native projection.

        Args:
            operation: Validated lowercase WMS operation.
            query: Globally bounded and feature-validated public query entries.

        Returns:
            Server-owned upstream query entries without persistent custom styles.

        Raises:
            PublishedLayerRequestError: If appearance data is absent, malformed,
                or differs from the approved signed identity.
        """
        normalized = {key.lower(): value for key, value in query}
        calculated_fields = self._read_calculated_fields(normalized)
        include_bounds = normalized.get("vector_feature_bounds") == "true"
        upstream_layer = (
            self.inspection_layer_name
            if self.inspection_layer_name is not None
            and (operation == "getfeatureinfo" or "featureid" in normalized)
            else self.upstream_layer_name
        )
        style_parameter = "style" if operation == "getlegendgraphic" else "styles"
        style_name = normalized.get(style_parameter, "").removeprefix("eolab:")
        definition = normalized.get("vector_style")
        if definition is not None:
            try:
                style_definition = json.loads(definition)
            except ValueError as error:
                raise PublishedLayerRequestError("Vector appearance is invalid") from error
            layer_parameter = "layer" if operation == "getlegendgraphic" else "layers"
            layer_name = normalized[layer_parameter]
            style_name = style_name or self.default_style_name
            style, geometry_name = self._require_style(
                layer_name, style_name, style_definition, calculated_fields
            )
            document = build_vector_sld(
                style_name,
                style,
                layer_name=upstream_layer or layer_name,
                geometry_name=geometry_name,
                calculated_fields=calculated_fields,
            )
            query = [
                (key, value)
                for key, value in query
                if key.lower() not in {
                    "vector_style", style_parameter, "tiled", "tilesorigin"
                }
            ] + [(style_parameter, ""), ("sld_body", document.decode("utf-8"))]
            if operation == "getmap":
                query.append(("buffer", str(vector_label_rendering_buffer(style))))
        elif (
            style_name
            and self.is_style_authorized(style_name)
            and style_name != self.default_style_name
        ):
            raise PublishedLayerRequestError("Vector appearance is required for this style")
        elif calculated_fields:
            raise PublishedLayerRequestError(
                "Calculated fields require their approved vector appearance"
            )
        omitted_parameters = {"vector_calculated_fields", "vector_feature_bounds"}
        if include_bounds:
            omitted_parameters.update({"propertyname", "info_format"})
        elif calculated_fields and operation == "getfeatureinfo":
            omitted_parameters.add("propertyname")
        query = [
            (key, value) for key, value in query
            if key.lower() not in omitted_parameters
        ]
        if include_bounds:
            query.append(("info_format", "application/vnd.eolab.feature-info+json"))
            if "propertyname" in normalized and not calculated_fields:
                property_names = json.dumps(
                    normalized["propertyname"].split(",")
                ).encode("utf-8")
                encoded_names = urlsafe_b64encode(property_names).decode("ascii")
                query.append(("format_options", f"eolabProperties:{encoded_names}"))
        if self.filter is None:
            return [
                (
                    key,
                    upstream_layer
                    if upstream_layer is not None
                    and key.lower() in {"layer", "layers", "query_layers"}
                    else value,
                )
                for key, value in query
            ]
        predicate = filter_ecql(self.filter, self.calculated_fields)
        feature_id = normalized.get("featureid")
        if feature_id is not None:
            # The public boundary already restricts this to one safe feature ID.
            predicate = f"({predicate}) AND IN ('{feature_id}')"
        forwarded = [
            (
                key,
                upstream_layer
                if key.lower() in {"layer", "layers", "query_layers"}
                else value,
            )
            for key, value in query
            if key.lower() not in {"tiled", "tilesorigin", "featureid"}
        ]
        if operation != "getlegendgraphic":
            forwarded.append(("cql_filter", predicate))
        return forwarded

    def composite_buffer(self, style_definition: Mapping[str, object] | None) -> int:
        """Return the label query margin for an already validated appearance.

        Args:
            style_definition: Complete vector appearance accepted by the SLD builder.

        Returns:
            Zero without labels, otherwise the bounded pixel margin for labels.
        """
        return vector_label_rendering_buffer(VectorStyle.model_validate(style_definition))

    def composite_interpolation(
        self, style_definition: Mapping[str, object] | None, style_environment: str | None = None
    ) -> str | None:
        """Keep the service interpolation default for vector appearances.

        Args:
            style_definition: Already authorized vector appearance.
            style_environment: Alternative validated style environment.

        Returns:
            None, because vector styling has no raster resampling override.
        """
        return None

    def build_composite_sld(
        self,
        layer_name: str,
        style_name: str,
        style_environment: str | None,
        style_definition: Mapping[str, object] | None,
        opacity: float,
        calculated_fields: tuple[CalculatedField, ...] = (),
    ) -> bytes:
        """Build one authorized inline vector layer for composite rendering.

        Args:
            layer_name: Current workspace-qualified vector layer identity.
            style_name: Approved feature-owned content style identity.
            style_environment: Unsupported raster-style representation.
            style_definition: Required complete vector appearance.
            opacity: Neutral retained-layer opacity from zero through one.
            calculated_fields: View-owned definitions accompanying this appearance.

        Returns:
            Complete single-layer SLD document.

        Raises:
            PublishedLayerRequestError: If the style definition is invalid or
                does not produce the requested approved style identity.
        """
        if style_environment is not None or style_definition is None:
            raise PublishedLayerRequestError(
                "Composite vector rendering requires an approved vector style"
            )
        style, geometry_name = self._require_style(
            layer_name, style_name, style_definition, calculated_fields
        )
        document = build_vector_sld(
            style_name,
            style,
            layer_name=self.upstream_layer_name or layer_name,
            opacity_multiplier=opacity,
            geometry_name=geometry_name,
            calculated_fields=calculated_fields,
        )
        return (
            filter_vector_sld(document, self.filter, self.calculated_fields)
            if self.filter is not None
            else document
        )

    def _require_style(
        self,
        layer_name: str,
        style_name: str,
        style_definition: object,
        calculated_fields: tuple[CalculatedField, ...] = (),
    ) -> tuple[VectorStyle, str | None]:
        """Match browser-supplied appearance data to its source-bound approval.

        Args:
            layer_name: Workspace-qualified original or filtered publication.
            style_name: Fixed default or signed content identity.
            style_definition: Complete untrusted appearance from a WMS or plan
                request.
            calculated_fields: View definitions which must match the signed appearance.

        Returns:
            Validated appearance and the geometry attribute needed for its labels.

        Raises:
            PublishedLayerRequestError: If the appearance is malformed, unsigned,
                or inconsistent with its approved content identity.
        """
        try:
            style = VectorStyle.model_validate(style_definition)
        except ValidationError as error:
            raise PublishedLayerRequestError(
                "Vector appearance is invalid"
            ) from error
        layer_name = self.upstream_layer_name or layer_name
        if self.calculated_fields and self.calculated_fields != calculated_fields:
            raise PublishedLayerRequestError(
                "Calculated fields do not match this filtered view"
            )
        if calculated_fields and style_name == self.default_style_name:
            raise PublishedLayerRequestError(
                "Calculated fields require their approved vector appearance"
            )
        resource_name = layer_name.partition(":")[2]
        geometry_name = (
            self.geometry_name
            if style.label is not None and (
                style.geometry_kind == "polygon"
                or (style.geometry_kind == "line" and style.label.placement == "center")
            )
            else None
        )
        is_default_style = (
            style_name == self.default_style_name
            and style_name == f"vector-{style.geometry_kind}"
            and style == default_vector_style(style.geometry_kind)
            and not calculated_fields
        )
        try:
            content_name = vector_style_name(
                resource_name,
                style,
                geometry_name=geometry_name,
                calculated_fields=calculated_fields,
            )
        except ValueError as error:
            raise PublishedLayerRequestError(str(error)) from error
        if not is_default_style and self.sign_style_name(content_name) != style_name:
            raise PublishedLayerRequestError(
                "Vector appearance does not match its approved identity"
            )
        return style, geometry_name

    def _read_calculated_fields(
        self, query: Mapping[str, str]
    ) -> tuple[CalculatedField, ...]:
        """Read view definitions carried with an appearance before checking its signature.

        Args:
            query: Normalized public WMS parameters.

        Returns:
            Structurally valid definitions, still requiring source-bound style approval.

        Raises:
            PublishedLayerRequestError: If the field definition representation is invalid.
        """
        try:
            return TypeAdapter(tuple[CalculatedField, ...]).validate_json(
                query.get("vector_calculated_fields", "[]")
            )
        except ValueError as error:
            raise PublishedLayerRequestError(
                "Calculated field definitions are invalid"
            ) from error

    def prepare_feature_info(self, content: bytes, query: Mapping[str, str]) -> bytes:
        """Append approved view values to original-geometry feature information.

        Args:
            content: Bounded GeoServer GeoJSON response for this authorized request.
            query: Original normalized parameters whose appearance was already approved.

        Returns:
            GeoJSON with consistent calculated attributes for each returned feature.

        Raises:
            PublishedLayerRequestError: If GeoServer returned malformed feature information.
        """
        definitions = self._read_calculated_fields(query)
        if not definitions:
            return content
        compiled = tuple(
            CompiledCalculatedField(
                value, compile_field_expression(value.expression), ()
            )
            for value in definitions
        )
        try:
            document = json.loads(content)
            for feature in document["features"]:
                properties = feature["properties"]
                properties.update(evaluate_calculated_fields(compiled, properties))
            return json.dumps(document, allow_nan=False, separators=(",", ":")).encode(
                "utf-8"
            )
        except (KeyError, TypeError, ValueError, AttributeError) as error:
            raise PublishedLayerRequestError(
                "The rendering service returned invalid feature information"
            ) from error
