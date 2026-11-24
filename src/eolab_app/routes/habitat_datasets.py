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
        source_years: Coverage of the source archive or fixed map.
        computation_bands: Source band names read by each pinned upstream computation.
        fixed_map: Whether all assessments read the same image.
    """

    label: str
    url: str
    source_years: str
    computation_bands: dict[str, tuple[str, ...]]
    fixed_map: bool = False


# Archive coverage was checked against the linked catalogs in November 2026.
# Band selectors correspond to the pinned upstream build_earth_engine_stack.
_DATASETS: dict[str, DatasetDescription] = {
    "LANDSAT/COMPOSITES/C02/T1_L2_8DAY_NDVI": DatasetDescription(
        "Landsat NDVI composites",
        "https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_COMPOSITES_C02_T1_L2_8DAY_NDVI",
        "1984–2026 (as of Nov 2026)",
        {
            "ndvi_95th_percentile": ("NDVI",),
            "ndvi_median": ("NDVI",),
        },
    ),
    "MODIS/061/MCD12Q2": DatasetDescription(
        "MODIS land-cover dynamics / phenology",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MCD12Q2",
        "2001–2024 (as of Nov 2026)",
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
        "2000–2024",
        {
            "short_vegetation_height": ("height",),
        },
    ),
    "MODIS/061/MOD44B": DatasetDescription(
        "MODIS vegetation cover",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD44B",
        "2000–2024 (as of Nov 2026)",
        {
            "tree_cover": ("Percent_Tree_Cover",),
            "non_tree_vegetation_cover": ("Percent_NonTree_Vegetation",),
            "bare_ground": ("Percent_NonVegetated",),
        },
    ),
    "MODIS/061/MOD15A2H": DatasetDescription(
        "MODIS LAI / FPAR",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD15A2H",
        "2000–2026 (as of Nov 2026)",
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
        "2001–2024 (as of Nov 2026)",
        {
            "npp": ("Npp",),
            "gpp": ("Gpp",),
        },
    ),
    "ECMWF/ERA5/DAILY": DatasetDescription(
        "ERA5 daily aggregates",
        "https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_DAILY",
        "1979–July 2020",
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
        "1979–June 2020",
        {
            "mean_annual_temperature": ("mean_2m_air_temperature",),
            "median_annual_temperature": ("mean_2m_air_temperature",),
        },
    ),
    "GRIDMET/DROUGHT": DatasetDescription(
        "GRIDMET drought",
        "https://developers.google.com/earth-engine/datasets/catalog/GRIDMET_DROUGHT",
        "1980–2026 (as of Nov 2026)",
        {
            "mean_drought": ("spi30d",),
            "drought_fifth_percentile": ("spi30d",),
        },
    ),
    "NASA/VIIRS/002/VNP64A1": DatasetDescription(
        "VIIRS burned area",
        "https://developers.google.com/earth-engine/datasets/catalog/NASA_VIIRS_002_VNP64A1",
        "2012–2026 (as of Nov 2026)",
        {
            "burned_month_count": ("Burn_Date",),
        },
    ),
    "JRC/GSW1_4/MonthlyHistory": DatasetDescription(
        "JRC monthly water",
        "https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_MonthlyHistory",
        "1984–2021",
        {
            "water_presence_variation": ("water",),
        },
    ),
    "MERIT/Hydro/v1_0_1": DatasetDescription(
        "MERIT Hydro",
        "https://developers.google.com/earth-engine/datasets/catalog/MERIT_Hydro_v1_0_1",
        "1987–2017 (catalog period)",
        {
            "distance_to_streams": ("upa",),
        },
        fixed_map=True,
    ),
    "projects/soilgrids-isric/soc_mean": DatasetDescription(
        "SoilGrids organic carbon",
        "https://gee-community-catalog.org/projects/isric/",
        "SoilGrids 2.0, no single observation year",
        {
            "soil_organic_carbon": ("soc_5-15cm_mean",),
        },
        fixed_map=True,
    ),
    "NASA/GLDAS/V021/NOAH/G025/T3H": DatasetDescription(
        "GLDAS",
        "https://developers.google.com/earth-engine/datasets/catalog/NASA_GLDAS_V021_NOAH_G025_T3H",
        "2000–2026 (as of Nov 2026)",
        {
            "soil_moisture": ("SoilMoi10_40cm_inst",),
            "gldas_snow_depth": ("SnowDepth_inst",),
        },
    ),
    "CSP/ERGo/1_0/Global/SRTM_landforms": DatasetDescription(
        "SRTM landforms",
        "https://developers.google.com/earth-engine/datasets/catalog/CSP_ERGo_1_0_Global_SRTM_landforms",
        "2006–2011 (catalog period)",
        {
            "landform_type": ("constant",),
        },
        fixed_map=True,
    ),
    "CSP/ERGo/1_0/Global/ALOS_topoDiversity": DatasetDescription(
        "ALOS topographic diversity",
        "https://developers.google.com/earth-engine/datasets/catalog/CSP_ERGo_1_0_Global_ALOS_topoDiversity",
        "2006–2011 (catalog period)",
        {
            "topographic_diversity": ("constant",),
        },
        fixed_map=True,
    ),
    "MODIS/061/MOD16A2GF": DatasetDescription(
        "MODIS evapotranspiration",
        "https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD16A2GF",
        "2000–2025 (as of Nov 2026)",
        {
            "annual_evapotranspiration": ("ET",),
        },
    ),
    "NASA/SMAP/SPL4SMGP/008": DatasetDescription(
        "SMAP",
        "https://developers.google.com/earth-engine/datasets/catalog/NASA_SMAP_SPL4SMGP_008",
        "March 2015–2026 (as of Nov 2026)",
        {
            "smap_snow_depth": ("snow_depth",),
        },
    ),
}


class HabitatDatasetSource(BaseModel):
    """Describe a linked dataset used by the configured Habitat input bands.

    Attributes:
        id: Stable configured dataset alias used in submitted selections.
        label: Human-readable dataset name shown in model setup.
        url: Catalog page describing the configured Earth Engine source.
        roles: Predictor and/or response roles derived from the configured bands.
        sourceYears: Provider archive coverage, including the catalog check date for growing archives.
        bandsByRole: Earth Engine source band names read by the configured calculations in each role.
        yearsUsed: Explanation of the observations used for each supported assessment year.
        requiredRoles: Roles in which this source must remain selected.
    """

    id: str
    label: str
    url: str
    roles: list[Literal["predictor", "response"]]
    requiredRoles: list[Literal["predictor", "response"]]
    sourceYears: str
    bandsByRole: dict[Literal["predictor", "response"], list[str]]
    yearsUsed: dict[int, str]


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
        bands_by_role = {}
        used_bands = [
            band
            for band in configuration.bands
            if key in band.source_dataset_keys and band.role in roles
        ]
        uses_rainfall_history = any(
            band.computation == "interannual_rainfall_variability"
            for band in used_bands
        )
        for role in roles:
            names = (
                name
                for band in used_bands
                if band.role == role
                for name in source.computation_bands[band.computation]
            )
            bands_by_role[role] = list(dict.fromkeys(names))
        years_used = {}
        for year in range(configuration.minimum_year, configuration.maximum_year + 1):
            if source.fixed_map:
                usage = "Uses the same map for every assessment year."
            elif uses_rainfall_history:
                first = max(
                    configuration.era5_start_year,
                    year - configuration.interannual_rainfall_window_years + 1,
                )
                usage = f"Uses {year} observations and {first}–{year} rainfall totals for rainfall variability."
            else:
                usage = f"Uses {year} observations."
            years_used[year] = usage
        datasets.append(
            HabitatDatasetSource(
                id=key,
                label=source.label,
                url=source.url,
                roles=list(roles),
                requiredRoles=["predictor"] if key in required else [],
                sourceYears=source.source_years,
                bandsByRole=bands_by_role,
                yearsUsed=years_used,
            )
        )
    return datasets
