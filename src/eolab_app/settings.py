"""Load and validate EOLab application settings from the environment."""

import os
from dataclasses import dataclass
from pathlib import Path


APPLICATION_VERSION_PATH = Path("/app/version")


@dataclass(frozen=True)
class Settings:
    """Validated runtime settings for the EOLab application."""

    app_title: str
    app_subtitle: str
    app_version: str
    catalog_url: str
    catalog_internal_url: str
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
            "APP_TITLE": self.app_title,
            "APP_SUBTITLE": self.app_subtitle,
            "application version": self.app_version,
            "CATALOG_URL": self.catalog_url,
            "CATALOG_INTERNAL_URL": self.catalog_internal_url,
            "BASEMAP_URL": self.basemap_url,
            "BASEMAP_ATTRIBUTION": self.basemap_attribution,
        }
        for environment_variable_name, setting_value in required_text_settings.items():
            if not setting_value:
                raise ValueError(f"{environment_variable_name} must not be blank")

        if not -90 <= self.initial_latitude <= 90:
            raise ValueError("INITIAL_LATITUDE must be between -90 and 90")
        if not -180 <= self.initial_longitude <= 180:
            raise ValueError("INITIAL_LONGITUDE must be between -180 and 180")
        if not 0 <= self.initial_zoom <= 22:
            raise ValueError("INITIAL_ZOOM must be between 0 and 22")

    def as_public_dict(self) -> dict[str, object]:
        """Serialize settings for the public browser configuration endpoint.

        Returns:
            Browser configuration containing application identity strings,
            the browser-facing ``catalogUrl``, basemap URL and attribution
            strings, and numeric initial-view latitude, longitude, and zoom
            values. The internal catalog service URL is not exposed.
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


def load_settings(
    version_file_path: Path = APPLICATION_VERSION_PATH,
) -> Settings:
    """Load application settings from the environment and baked version file.

    Args:
        version_file_path: File containing the Git-derived application version.

    Returns:
        Validated settings with surrounding whitespace removed from text,
        map values parsed as floating-point numbers, and the application
        version read from the baked version file.

    Raises:
        FileNotFoundError: If the baked version file does not exist.
        KeyError: If a required environment variable is missing.
        ValueError: If a setting violates its type or range contract.
    """
    return Settings(
        app_title=os.environ["APP_TITLE"].strip(),
        app_subtitle=os.environ["APP_SUBTITLE"].strip(),
        app_version=version_file_path.read_text(encoding="utf-8").strip(),
        catalog_url=os.environ["CATALOG_URL"].strip(),
        catalog_internal_url=os.environ["CATALOG_INTERNAL_URL"].strip(),
        basemap_url=os.environ["BASEMAP_URL"].strip(),
        basemap_attribution=os.environ["BASEMAP_ATTRIBUTION"].strip(),
        initial_latitude=float(os.environ["INITIAL_LATITUDE"]),
        initial_longitude=float(os.environ["INITIAL_LONGITUDE"]),
        initial_zoom=float(os.environ["INITIAL_ZOOM"]),
    )
