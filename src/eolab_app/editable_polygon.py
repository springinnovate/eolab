"""Validate polygon geometry supported by EOLab's hand-drawing editor."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator
from shapely.geometry import Polygon

Coordinate = tuple[
    Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False, strict=True)],
    Annotated[
        float, Field(ge=-85.05112878, le=85.05112878, allow_inf_nan=False, strict=True)
    ],
]


class PolygonGeometry(BaseModel):
    """One valid, closed polygon without holes, in editable longitude/latitude."""

    model_config = ConfigDict(extra="forbid")
    type: Literal["Polygon"] = "Polygon"
    coordinates: Annotated[
        list[Annotated[list[Coordinate], Field(min_length=4, max_length=2001)]],
        Field(min_length=1, max_length=1),
    ]

    @model_validator(mode="after")
    def validate_polygon(self) -> Self:
        """Reject rings the editor cannot reopen, including repeated vertices and near-zero area.

        Returns:
            This geometry when the exterior ring is usable by the editor.

        Raises:
            ValueError: If the ring does not describe a valid polygon.
        """
        ring = self.coordinates[0]
        if ring[0] != ring[-1]:
            raise ValueError("The polygon ring must end at its starting coordinate.")
        if len(set(ring[:-1])) != len(ring) - 1:
            raise ValueError("Two polygon vertices occupy the same position.")
        polygon = Polygon(ring)
        if not polygon.is_valid or polygon.area == 0:
            raise ValueError(
                "The polygon must have at least three distinct vertices and must not cross itself."
            )
        # Match the editor's longitude/latitude shoelace arithmetic and tolerance,
        # including its operation order for small polygons at offset coordinates.
        doubled_area = 0.0
        for point, following in zip(ring, ring[1:]):
            doubled_area = (
                doubled_area + point[0] * following[1] - following[0] * point[1]
            )
        if abs(doubled_area) < 1e-12:
            raise ValueError(
                "Polygon vertices must enclose an area the editor can retain."
            )
        return self
