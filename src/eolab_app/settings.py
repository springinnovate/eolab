import os
from dataclasses import dataclass


def _text(name: str, default: str, *, allow_blank: bool = False) -> str:
    value = os.getenv(name)
    if value is None:
        return default

    value = value.strip()
    if value or allow_blank:
        return value
    return default


def _optional_text(name: str) -> str | None:
    value = os.getenv(name, "").strip()
    return value or None


def _number(
    name: str,
    default: float,
    *,
    minimum: float,
    maximum: float,
) -> float:
    raw_value = os.getenv(name)
    if raw_value is None:
        return default

    try:
        value = float(raw_value)
    except ValueError:
        return default

    return max(minimum, min(maximum, value))


@dataclass(frozen=True)
class Settings:
    app_title: str
    app_subtitle: str
    app_version: str
    catalog_url: str | None
    basemap_url: str
    basemap_attribution: str
    initial_latitude: float
    initial_longitude: float
    initial_zoom: float

    def as_public_dict(self) -> dict[str, object]:
        return {
            "appTitle": self.app_title,
            "appSubtitle": self.app_subtitle,
            "appVersion": self.app_version,
            "catalogUrl": self.catalog_url,
            "basemap": {
                "url": self.basemap_url,
                "attribution": self.basemap_attribution,
            },
            "initialView": {
                "latitude": self.initial_latitude,
                "longitude": self.initial_longitude,
                "zoom": self.initial_zoom,
            },
        }


def get_settings() -> Settings:
    return Settings(
        app_title=_text("EOLAB_APP_TITLE", "EOLab"),
        app_subtitle=_text(
            "EOLAB_APP_SUBTITLE",
            "Catalog-driven Earth observation",
        ),
        app_version=_text("EOLAB_APP_VERSION", "dev"),
        catalog_url=_optional_text("EOLAB_CATALOG_URL"),
        basemap_url=_text(
            "EOLAB_BASEMAP_URL",
            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        ),
        basemap_attribution=_text(
            "EOLAB_BASEMAP_ATTRIBUTION",
            "&copy; OpenStreetMap contributors",
        ),
        initial_latitude=_number(
            "EOLAB_INITIAL_LATITUDE",
            20,
            minimum=-90,
            maximum=90,
        ),
        initial_longitude=_number(
            "EOLAB_INITIAL_LONGITUDE",
            0,
            minimum=-180,
            maximum=180,
        ),
        initial_zoom=_number(
            "EOLAB_INITIAL_ZOOM",
            2,
            minimum=0,
            maximum=22,
        ),
    )
