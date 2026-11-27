"""Describe the source bands and observation years behind Habitat's prepared datasets."""

from dataclasses import dataclass
from typing import Literal

from nhi_terrestrial_integrity_modeling.analysis_config import RasterStackConfiguration
from pydantic import BaseModel

from eolab_app.processing.habitat_models import (
    get_habitat_dataset_roles,
    get_required_habitat_predictor_datasets,
)


@dataclass(frozen=True)
class DatasetDescription:
    """Describe a linked Earth Engine asset for model setup.

    Attributes:
        label: Dataset name shown beside the selection checkbox.
        url: Provider catalog entry for the exact configured asset.
        computation_bands: Source band names read by each pinned upstream computation.
        fixed_map: Whether all assessments read the same image.
    """

    label: str
    url: str
    computation_bands: dict[str, tuple[str, ...]]
    fixed_map: bool = False


# Band selectors correspond to the pinned upstream build_earth_engine_stack.
_DATASETS: dict[str, DatasetDescription] = {
    "LANDSAT/COMPOSITES/C02/T1_L2_8DAY_NDVI": DatasetDescription(
        "Landsat NDVI composites",
        "https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_COMPOSITES_C02_T1_L2_8DAY_NDVI",
        {
            "ndvi_95th_percentile": ("NDVI",),
            "ndvi_median": ("NDVI",),
        },
    ),
    "MODIS/061/MCD12Q2": DatasetDescription(
        "MODIS land-cover dynamics / phenology",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MCD12Q2",
        {
            "growing_season_length_1": ("Greenup_1", "Senescence_1"),
            "growing_season_length_2": ("Greenup_2", "Senescence_2"),
            "greenup_timing_1": ("Greenup_1",),
            "greenup_timing_2": ("Greenup_2",),
            "growing_season_count": ("NumCycles",),
            "growing_season_temperature": ("Greenup_1", "Senescence_1"),
            "growing_season_precipitation": ("Greenup_1", "Senescence_1"),
        },
    ),
    "projects/global-pasture-watch/assets/gsvh-30m/v1/short-veg-height_m": DatasetDescription(
        "Global Pasture Watch short vegetation height",
        "https://developers.google.com/earth-engine/datasets/catalog/projects_global-pasture-watch_assets_gsvh-30m_v1_short-veg-height_m",
        {
            "short_vegetation_height": ("height",),
        },
    ),
    "MODIS/061/MOD44B": DatasetDescription(
        "MODIS vegetation cover",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD44B",
        {
            "tree_cover": ("Percent_Tree_Cover",),
            "non_tree_vegetation_cover": ("Percent_NonTree_Vegetation",),
            "bare_ground": ("Percent_NonVegetated",),
        },
    ),
    "MODIS/061/MOD15A2H": DatasetDescription(
        "MODIS LAI / FPAR",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD15A2H",
        {
            "maximum_lai": ("Lai_500m",),
            "lai_variability": ("Lai_500m",),
            "mean_fpar": ("Fpar_500m",),
            "fpar_variability": ("Fpar_500m",),
            "maximum_fpar_variability": ("FparStdDev_500m",),
        },
    ),
    "MODIS/061/MOD17A3HGF": DatasetDescription(
        "MODIS annual productivity",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD17A3HGF",
        {
            "npp": ("Npp",),
            "gpp": ("Gpp",),
        },
    ),
    "ECMWF/ERA5/DAILY": DatasetDescription(
        "ERA5 daily aggregates",
        "https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_DAILY",
        {
            "maximum_annual_temperature": ("maximum_2m_air_temperature",),
            "minimum_annual_temperature": ("minimum_2m_air_temperature",),
            "annual_precipitation": ("total_precipitation",),
            "growing_season_temperature": ("mean_2m_air_temperature",),
            "growing_season_precipitation": ("total_precipitation",),
            "interannual_rainfall_variability": ("total_precipitation",),
        },
    ),
    "ECMWF/ERA5/MONTHLY": DatasetDescription(
        "ERA5 monthly aggregates",
        "https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_MONTHLY",
        {
            "mean_annual_temperature": ("mean_2m_air_temperature",),
            "median_annual_temperature": ("mean_2m_air_temperature",),
        },
    ),
    "GRIDMET/DROUGHT": DatasetDescription(
        "GRIDMET drought",
        "https://developers.google.com/earth-engine/datasets/catalog/GRIDMET_DROUGHT",
        {
            "mean_drought": ("spi30d",),
            "drought_fifth_percentile": ("spi30d",),
        },
    ),
    "NASA/VIIRS/002/VNP64A1": DatasetDescription(
        "VIIRS burned area",
        "https://developers.google.com/earth-engine/datasets/catalog/NASA_VIIRS_002_VNP64A1",
        {
            "burned_month_count": ("Burn_Date",),
        },
    ),
    "JRC/GSW1_4/MonthlyHistory": DatasetDescription(
        "JRC monthly water",
        "https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_MonthlyHistory",
        {
            "water_presence_variation": ("water",),
        },
    ),
    "MERIT/Hydro/v1_0_1": DatasetDescription(
        "MERIT Hydro",
        "https://developers.google.com/earth-engine/datasets/catalog/MERIT_Hydro_v1_0_1",
        {
            "distance_to_streams": ("upa",),
        },
        fixed_map=True,
    ),
    "projects/soilgrids-isric/soc_mean": DatasetDescription(
        "SoilGrids organic carbon",
        "https://gee-community-catalog.org/projects/isric/",
        {
            "soil_organic_carbon": ("soc_5-15cm_mean",),
        },
        fixed_map=True,
    ),
    "NASA/GLDAS/V021/NOAH/G025/T3H": DatasetDescription(
        "GLDAS",
        "https://developers.google.com/earth-engine/datasets/catalog/NASA_GLDAS_V021_NOAH_G025_T3H",
        {
            "soil_moisture": ("SoilMoi10_40cm_inst",),
            "gldas_snow_depth": ("SnowDepth_inst",),
        },
    ),
    "CSP/ERGo/1_0/Global/SRTM_landforms": DatasetDescription(
        "SRTM landforms",
        "https://developers.google.com/earth-engine/datasets/catalog/CSP_ERGo_1_0_Global_SRTM_landforms",
        {
            "landform_type": ("constant",),
        },
        fixed_map=True,
    ),
    "CSP/ERGo/1_0/Global/ALOS_topoDiversity": DatasetDescription(
        "ALOS topographic diversity",
        "https://developers.google.com/earth-engine/datasets/catalog/CSP_ERGo_1_0_Global_ALOS_topoDiversity",
        {
            "topographic_diversity": ("constant",),
        },
        fixed_map=True,
    ),
    "MODIS/061/MOD16A2GF": DatasetDescription(
        "MODIS evapotranspiration",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD16A2GF",
        {
            "annual_evapotranspiration": ("ET",),
        },
    ),
    "NASA/SMAP/SPL4SMGP/008": DatasetDescription(
        "SMAP",
        "https://developers.google.com/earth-engine/datasets/catalog/NASA_SMAP_SPL4SMGP_008",
        {
            "smap_snow_depth": ("snow_depth",),
        },
    ),
}


class HabitatBandUse(BaseModel):
    """Identify the source bands and time period used by one model calculation.

    Attributes:
        variable: Display name of the prepared raster produced by this computation.
        bands: Earth Engine band names read from this dataset.
        requiredDatasets: Dataset choices that must all be selected in this role.
        periods: Time period used from this source for each allowed assessment year.
    """

    variable: str
    bands: tuple[str, ...]
    requiredDatasets: tuple[str, ...]
    periods: dict[int, str]


class HabitatDatasetSource(BaseModel):
    """Describe a linked dataset used by the configured Habitat input bands.

    Attributes:
        id: Stable configured dataset alias used in submitted selections.
        label: Human-readable dataset name shown in model setup.
        url: Catalog page describing the configured Earth Engine source.
        roles: Predictor and/or response roles derived from the configured bands.
        inputsByRole: Source bands, periods and selection requirements for each calculation.
        requiredRoles: Roles in which this source must remain selected.
    """

    id: str
    label: str
    url: str
    roles: list[Literal["predictor", "response"]]
    requiredRoles: list[Literal["predictor", "response"]]
    inputsByRole: dict[Literal["predictor", "response"], list[HabitatBandUse]]


def _analysis_period(
    configuration: RasterStackConfiguration,
    dataset_key: str,
    computation: str,
    year: int,
) -> str:
    """Describe when the computation reads observations from this source.

    Args:
        configuration: Installed stack defining the rainfall window and earliest year.
        dataset_key: Source alias used by the computation.
        computation: Name of the pinned scientific calculation.
        year: Selected assessment year.

    Returns:
        Calendar year, growing season, inclusive rainfall window or fixed map.
    """
    if _DATASETS[configuration.datasets[dataset_key]].fixed_map:
        return "Fixed map for every assessment year"
    if computation == "interannual_rainfall_variability":
        first = max(
            configuration.era5_start_year,
            year - configuration.interannual_rainfall_window_years + 1,
        )
        return (
            f"{first}–{year} rainfall variability"
            if first != year
            else f"{year} rainfall variability"
        )
    if dataset_key == "era5_daily" and computation in (
        "growing_season_temperature",
        "growing_season_precipitation",
    ):
        return f"{year} growing season"
    return str(year)


def describe_habitat_datasets(
    configuration: RasterStackConfiguration,
) -> list[HabitatDatasetSource]:
    """List the source bands and years used by each selectable Habitat dataset.

    Args:
        configuration: Installed scientific stack with its allowed assessment years.

    Returns:
        Linked datasets in configured order, with only the bands used in each role.

    Raises:
        KeyError: A configured asset or computation lacks source metadata.
    """
    required = get_required_habitat_predictor_datasets(configuration)
    datasets = []
    for key, roles in get_habitat_dataset_roles(configuration).items():
        source = _DATASETS[configuration.datasets[key]]
        inputs_by_role = {
            role: [
                HabitatBandUse(
                    variable=band.display_name,
                    bands=source.computation_bands[band.computation],
                    requiredDatasets=band.source_dataset_keys,
                    periods={
                        year: _analysis_period(
                            configuration, key, band.computation, year
                        )
                        for year in range(
                            configuration.minimum_year, configuration.maximum_year + 1
                        )
                    },
                )
                for band in configuration.bands
                if band.role == role and key in band.source_dataset_keys
            ]
            for role in roles
        }
        datasets.append(
            HabitatDatasetSource(
                id=key,
                label=source.label,
                url=source.url,
                roles=list(roles),
                requiredRoles=["predictor"] if key in required else [],
                inputsByRole=inputs_by_role,
            )
        )
    return datasets
