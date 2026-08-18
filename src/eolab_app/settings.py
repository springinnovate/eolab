"""Load and validate EOLab application settings from the environment."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    """Validated runtime settings for the EOLab application."""

    app_title: str
    app_subtitle: str
    app_version: str
    catalog_url: str | None
    basemap_url: str
    basemap_attribution: str
    initial_latitude: float
    initial_longitude: float
    initial_zoom: float

    def __post_init__(self) -> None:
        """Validate the application settings contract.

        Raises:
            ValueError: If a required text setting is blank or a map value is
                outside its documented range.
        """
        required_text_settings = {
            "EOLAB_APP_TITLE": self.app_title,
            "EOLAB_APP_SUBTITLE": self.app_subtitle,
            "EOLAB_APP_VERSION": self.app_version,
            "EOLAB_BASEMAP_URL": self.basemap_url,
            "EOLAB_BASEMAP_ATTRIBUTION": self.basemap_attribution,
        }
        for environment_variable_name, setting_value in required_text_settings.items():
            if not setting_value:
                raise ValueError(f"{environment_variable_name} must not be blank")

        if not -90 <= self.initial_latitude <= 90:
            raise ValueError("EOLAB_INITIAL_LATITUDE must be between -90 and 90")
        if not -180 <= self.initial_longitude <= 180:
            raise ValueError("EOLAB_INITIAL_LONGITUDE must be between -180 and 180")
        if not 0 <= self.initial_zoom <= 22:
            raise ValueError("EOLAB_INITIAL_ZOOM must be between 0 and 22")

    def as_public_dict(self) -> dict[str, object]:
        """Serialize settings for the public browser configuration endpoint.

        Returns:
            Browser configuration containing application identity strings,
            ``catalogUrl`` as a URL string or ``None``, basemap URL and
            attribution strings, and numeric initial-view latitude, longitude,
            and zoom values.
        """
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


def load_settings() -> Settings:
    """Load application settings from the process environment.

    Returns:
        Validated settings with surrounding whitespace removed from text,
        a blank catalog URL normalized to ``None``, and map values parsed as
        floating-point numbers.

    Raises:
        KeyError: If a required environment variable is missing.
        ValueError: If a setting violates its type or range contract.
    """
    catalog_url = os.environ["EOLAB_CATALOG_URL"].strip()
    return Settings(
        app_title=os.environ["EOLAB_APP_TITLE"].strip(),
        app_subtitle=os.environ["EOLAB_APP_SUBTITLE"].strip(),
        app_version=os.environ["EOLAB_APP_VERSION"].strip(),
        catalog_url=catalog_url or None,
        basemap_url=os.environ["EOLAB_BASEMAP_URL"].strip(),
        basemap_attribution=os.environ["EOLAB_BASEMAP_ATTRIBUTION"].strip(),
        initial_latitude=float(os.environ["EOLAB_INITIAL_LATITUDE"]),
        initial_longitude=float(os.environ["EOLAB_INITIAL_LONGITUDE"]),
        initial_zoom=float(os.environ["EOLAB_INITIAL_ZOOM"]),
    )
