"""Validated public models for composite map rendering."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


MAX_COMPOSITE_MAP_LAYERS = 64


class CompositeMapLayerRequest(BaseModel):
    """One top-first authorized layer in a composite render plan."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    layer_name: str = Field(
        alias="layerName",
        min_length=7,
        max_length=256,
        pattern=r"^eolab:[A-Za-z0-9][A-Za-z0-9_.-]*$",
        strict=True,
    )
    style_name: str = Field(
        alias="styleName",
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$",
        strict=True,
    )
    opacity: float = Field(ge=0, le=1, allow_inf_nan=False, strict=True)
    style_environment: str | None = Field(
        default=None,
        alias="styleEnvironment",
        max_length=384,
        strict=True,
    )
    style_definition: dict[str, Any] | None = Field(
        default=None,
        alias="styleDefinition",
    )

    @model_validator(mode="after")
    def require_one_style_representation(self) -> "CompositeMapLayerRequest":
        """Require exactly one feature-owned style representation.

        Returns:
            Validated layer request.

        Raises:
            ValueError: If raster and vector appearance are both present or
                both absent.
        """
        if (self.style_environment is None) == (self.style_definition is None):
            raise ValueError(
                "Exactly one style environment or style definition is required"
            )
        return self


class CompositeMapPlanRequest(BaseModel):
    """A bounded top-first retained-layer render plan."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    layers: tuple[CompositeMapLayerRequest, ...] = Field(
        min_length=1,
        max_length=MAX_COMPOSITE_MAP_LAYERS,
    )

    @model_validator(mode="after")
    def require_unique_layers(self) -> "CompositeMapPlanRequest":
        """Reject duplicate published layer identities.

        Returns:
            Validated composite plan.

        Raises:
            ValueError: If one GeoServer layer appears more than once.
        """
        names = [layer.layer_name for layer in self.layers]
        if len(names) != len(set(names)):
            raise ValueError("Composite map layers must be unique")
        return self


class PublishedCompositeMapPlan(BaseModel):
    """Browser-safe identity and WMS URL for one retained render plan."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    plan_id: str = Field(alias="planId")
    wms_url: str = Field(alias="wmsUrl")
