import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
    buildCatalogItemDetails,
    CatalogFootprintController,
    CatalogResultStream,
    CatalogSearchClient,
    CatalogSearchSyntaxError,
    createDebouncedAction,
    formatCatalogItemCount,
    formatScanReconciliation,
    formatScanTiming,
    formatScanStatusSummary,
    getRasterVisualization,
    MOUNTED_DATASET_TYPES,
} from "./catalog.js";
import {
    applyRasterColorPalette,
    assessCatalogRaster,
    buildRasterLegend,
    CatalogRasterLayerController,
    clearRasterHistogramChart,
    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
    DEFAULT_RASTER_PERCENTILES,
    DEFAULT_RASTER_STYLE,
    deriveInitialRasterStyleFromStatistics,
    deriveRasterStyleFromStatistics,
    estimateRasterHistogramPercentile,
    formatRasterPixelValue,
    getCatalogRasterBasename,
    getRasterPixelProbePosition,
    loadCatalogRasterStatistics,
    loadWmsCapabilities,
    RASTER_COLOR_PALETTES,
    RasterPixelProbeController,
    renderRasterHistogramChart,
    RasterSampleWindowController,
    RasterStatisticsController,
    publishCatalogRaster,
    rasterStatisticsMatchesSelection,
    sampleCatalogRasterPixel,
    serializeRasterStyle,
} from "./rendering.js";
import "./style.css";

const CATALOG_SEARCH_DEBOUNCE_MILLISECONDS = 300;
const CATALOG_LOAD_ROOT_MARGIN = "300px 0px";
const CONTROL_PANEL_TRANSITION_MILLISECONDS = 240;
const RASTER_STYLE_DEBOUNCE_MILLISECONDS = 200;
const RENDERING_RETRY_MILLISECONDS = 5000;
const RENDERING_MONITOR_MILLISECONDS = 60000;

let scanPollTimeout = null;

/**
 * Browser-safe application settings loaded from the backend.
 *
 * @typedef {Object} AppGlobalConfiguration
 * @property {string} appTitle Application title.
 * @property {string} appSubtitle Application subtitle.
 * @property {string} appVersion Deployed application version.
 * @property {string} catalogUrl Browser-facing STAC catalog URL.
 * @property {string} wmsUrl Browser-facing WMS endpoint.
 * @property {string} scanDisplayPathPrefix User-facing root for mounted files.
 * @property {{url: string, attribution: string}} basemap Basemap settings.
 * @property {{latitude: number, longitude: number, zoom: number}} initialView Initial map view.
 */

/**
 * Loads the browser-safe application settings.
 *
 * @return {Promise<AppGlobalConfiguration>} The application settings.
 * @throws {Error} If the settings endpoint does not return a successful response.
 */
async function loadAppGlobalConfiguration() {
    const configurationResponse = await fetch("/api/config", {
        headers: { Accept: "application/json" }
    });

    if (!configurationResponse.ok) {
        throw new Error(
            `Runtime configuration returned ${configurationResponse.status}`
        );
    }

    return configurationResponse.json();
}

/**
 * Creates the Leaflet map from the application settings.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @return {L.Map} The initialized Leaflet map.
 */
function initializeMap(appGlobalConfiguration) {
    const leafletMap = L.map("map", {
        zoomControl: false,
        minZoom: 0,
        maxZoom: 22
    }).setView(
        [
            appGlobalConfiguration.initialView.latitude,
            appGlobalConfiguration.initialView.longitude
        ],
        appGlobalConfiguration.initialView.zoom
    );

    L.control.zoom({ position: "bottomleft" }).addTo(leafletMap);
    L.tileLayer(appGlobalConfiguration.basemap.url, {
        attribution: appGlobalConfiguration.basemap.attribution,
        maxZoom: 22
    }).addTo(leafletMap);

    const mapPositionElement = document.querySelector("#map-position");

    /**
     * Displays a geographic position reported by Leaflet.
     *
     * @param {{latlng: L.LatLng}} mapPositionEvent Leaflet position event.
     * @return {void}
     */
    function updateMapPosition(mapPositionEvent) {
        mapPositionElement.textContent =
            `${mapPositionEvent.latlng.lat.toFixed(3)}, ` +
            mapPositionEvent.latlng.lng.toFixed(3);
    }

    updateMapPosition({ latlng: leafletMap.getCenter() });
    leafletMap.on("mousemove", updateMapPosition);

    return leafletMap;
}

/**
 * Applies application identity and catalog state to the interface.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @return {void}
 */
function applyAppGlobalConfiguration(appGlobalConfiguration) {
    document.title = appGlobalConfiguration.appTitle;
    document.querySelector("#app-title").textContent =
        appGlobalConfiguration.appTitle;
    document.querySelector("#app-subtitle").textContent =
        appGlobalConfiguration.appSubtitle;
    document.querySelector("#app-version").textContent =
        appGlobalConfiguration.appVersion;
    document
        .querySelector("#map")
        .setAttribute(
            "aria-label",
            `${appGlobalConfiguration.appTitle} interactive map`
        );
    document
        .querySelector("#control-panel")
        .setAttribute(
            "aria-label",
            `${appGlobalConfiguration.appTitle} controls`
        );
    document.querySelector("#open-panel").textContent =
        `Open ${appGlobalConfiguration.appTitle}`;

    const systemStateElement = document.querySelector("#system-state");
    const systemStateTextElement = document.querySelector("#system-state-text");
    const catalogLinkElement = document.querySelector("#catalog-link");

    systemStateElement.classList.remove("is-connected", "is-warning");
    systemStateTextElement.textContent = "Connecting to catalog";
    catalogLinkElement.href = appGlobalConfiguration.catalogUrl;
}

/**
 * Reports GeoServer readiness independently from Catalog availability.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @return {void}
 */
function initializeRendering(appGlobalConfiguration) {
    const renderingStateElement = document.querySelector("#rendering-state");
    const renderingStateTextElement = document.querySelector(
        "#rendering-state-text"
    );
    const capabilitiesLinkElement = document.querySelector(
        "#wms-capabilities-link"
    );
    let renderingServiceWasReady = false;

    /** Monitor WMS, retrying more frequently while it is unavailable. */
    async function checkRenderingService() {
        try {
            capabilitiesLinkElement.href = await loadWmsCapabilities(
                appGlobalConfiguration.wmsUrl
            );
            capabilitiesLinkElement.hidden = false;
            renderingStateElement.classList.remove("is-warning");
            renderingStateElement.classList.add("is-connected");
            if (!renderingServiceWasReady) {
                renderingStateTextElement.textContent =
                    "Rendering service ready";
            }
            renderingServiceWasReady = true;
            window.setTimeout(
                checkRenderingService,
                RENDERING_MONITOR_MILLISECONDS
            );
        } catch {
            capabilitiesLinkElement.hidden = true;
            if (
                renderingServiceWasReady ||
                !renderingStateElement.classList.contains("is-warning")
            ) {
                renderingStateElement.classList.remove("is-connected");
                renderingStateElement.classList.add("is-warning");
                renderingStateTextElement.textContent =
                    "Rendering service unavailable";
            }
            renderingServiceWasReady = false;
            window.setTimeout(
                checkRenderingService,
                RENDERING_RETRY_MILLISECONDS
            );
        }
    }

    void checkRenderingService();
}

/**
 * Creates a selected or preview Leaflet layer for one STAC Item.
 *
 * @param {Object} item STAC Item.
 * @param {string} visualState Either selected or preview.
 * @return {L.GeoJSON} Leaflet footprint layer.
 */
function createCatalogFootprintLayer(item, visualState) {
    return L.geoJSON(item, {
        style: { className: `catalog-footprint is-${visualState}` }
    });
}

/**
 * Loads and validates the catalog's STAC Collections document.
 *
 * @param {string} catalogUrl Browser-facing STAC root URL.
 * @return {Promise<Object>} Validated Collections response.
 */
async function loadCatalogCollections(catalogUrl) {
    const collectionsResponse = await fetch(`${catalogUrl}/collections`, {
        headers: { Accept: "application/json" }
    });
    if (!collectionsResponse.ok) {
        throw new Error(
            `STAC Collections returned ${collectionsResponse.status}`
        );
    }
    const collectionsDocument = await collectionsResponse.json();
    if (!Array.isArray(collectionsDocument.collections)) {
        throw new Error("STAC Collections response has no collections array");
    }
    return collectionsDocument;
}

/**
 * Creates a semantic metadata list whose labels are application display text
 * and whose values come from the selected STAC Item and Collection.
 *
 * @param {{label: string, value: string}[]} metadata Inspector metadata.
 * @return {HTMLDListElement} Definition list containing the metadata.
 */
function createCatalogMetadataList(metadata) {
    const metadataList = document.createElement("dl");
    metadataList.className = "catalog-metadata";
    for (const metadataEntry of metadata) {
        const metadataTerm = document.createElement("dt");
        metadataTerm.textContent = metadataEntry.label;
        const metadataDescription = document.createElement("dd");
        metadataDescription.textContent = metadataEntry.value;
        metadataList.append(metadataTerm, metadataDescription);
    }
    return metadataList;
}

/**
 * Displays the selected STAC Item in the inspector.
 *
 * @param {Object|null} item Selected STAC Item, or null for the empty state.
 * @param {Object[]} collections STAC Collections available to the Catalog.
 * @param {string} scanDisplayPathPrefix User-facing root for mounted files.
 * @return {void}
 */
function renderCatalogItemInspector(
    item,
    collections,
    scanDisplayPathPrefix
) {
    const inspectorHeading = document.querySelector(
        "#catalog-inspector-heading"
    );
    const inspectorContent = document.querySelector(
        "#catalog-inspector-content"
    );
    const inspectorStatus = document.querySelector(
        "#catalog-inspector-status"
    );
    inspectorContent.replaceChildren();

    // Render the empty state when no Item is selected.
    if (item === null) {
        inspectorHeading.textContent = "Item inspector";
        const emptyInspector = document.createElement("div");
        emptyInspector.className = "catalog-inspector-empty";
        const emptyHeading = document.createElement("strong");
        emptyHeading.textContent = "No item selected";
        const emptyMessage = document.createElement("p");
        emptyMessage.textContent =
            "Select a Catalog result to inspect its metadata.";
        emptyInspector.append(emptyHeading, emptyMessage);
        inspectorContent.append(emptyInspector);
        inspectorStatus.textContent = "No Catalog Item is selected.";
        return;
    }

    // Render the Item's identity, description, and core metadata.
    const inspector = buildCatalogItemDetails(
        item,
        collections,
        scanDisplayPathPrefix
    );
    inspectorHeading.textContent = inspector.title;
    if (inspector.description !== null) {
        const description = document.createElement("p");
        description.className = "catalog-inspector-description";
        description.textContent = inspector.description;
        inspectorContent.append(description);
    }
    inspectorContent.append(createCatalogMetadataList(inspector.metadata));

    if (inspector.fields.length > 0) {
        const fieldsHeading = document.createElement("h4");
        fieldsHeading.textContent = "Fields";
        inspectorContent.append(
            fieldsHeading,
            createCatalogMetadataList(inspector.fields)
        );
    }

    // Introduce the Item's Asset records or their empty state.
    const assetsHeading = document.createElement("h4");
    assetsHeading.textContent = "Assets";
    inspectorContent.append(assetsHeading);
    if (inspector.assets.length === 0) {
        const noAssetsMessage = document.createElement("p");
        noAssetsMessage.className = "catalog-inspector-note";
        noAssetsMessage.textContent = "No Assets are recorded for this Item.";
        inspectorContent.append(noAssetsMessage);
    }

    // Render the metadata for each Asset.
    for (const asset of inspector.assets) {
        const assetCard = document.createElement("article");
        assetCard.className = "catalog-asset";
        const assetHeading = document.createElement("h5");
        assetHeading.textContent = asset.title;
        const assetKey = document.createElement("p");
        assetKey.className = "catalog-asset-key";
        assetKey.textContent = `Asset key: ${asset.key}`;
        assetCard.append(
            assetHeading,
            assetKey,
            createCatalogMetadataList(asset.metadata)
        );

        // Render Raster extension band metadata when the Asset supplies it.
        if (asset.bands.length > 0) {
            const bandsHeading = document.createElement("strong");
            bandsHeading.className = "catalog-bands-heading";
            bandsHeading.textContent = "Raster bands";
            const bandList = document.createElement("ul");
            bandList.className = "catalog-band-list";
            for (const band of asset.bands) {
                const bandItem = document.createElement("li");
                const bandHeading = document.createElement("strong");
                bandHeading.textContent = band.title;
                const bandDetails = document.createElement("span");
                bandDetails.textContent = band.metadata
                    .map(
                        (metadataEntry) =>
                            `${metadataEntry.label}: ${metadataEntry.value}`
                    )
                    .join(" · ");
                bandItem.append(bandHeading, bandDetails);
                bandList.append(bandItem);
            }
            assetCard.append(bandsHeading, bandList);
        }
        inspectorContent.append(assetCard);
    }

    // Announce the selected Item to assistive technologies.
    inspectorStatus.textContent = `Showing details for ${inspector.title}.`;
}

/**
 * Connects raster appearance controls and pointer probing to the Leaflet map.
 *
 * The returned boundary owns the single rendered raster, its committed style,
 * and every interaction that is valid only while that raster is displayed.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @param {L.Map} leafletMap The initialized Leaflet map.
 * @param {HTMLElement} catalogLayerStatus Raster action status text.
 * @return {{
 *   clear: Function,
 *   reset: Function,
 *   show: Function,
 *   readonly isDisplayed: boolean
 * }} Raster visualization controls used by the Catalog selection workflow.
 */
function initializeRasterVisualization(
    appGlobalConfiguration,
    leafletMap,
    catalogLayerStatus
) {
    const rasterStyleControls = document.querySelector(
        "#raster-style-controls"
    );
    const rasterPalette = document.querySelector("#raster-palette");
    const rasterStyleInputs = {
        minimum: document.querySelector("#raster-minimum"),
        midpoint: document.querySelector("#raster-midpoint"),
        maximum: document.querySelector("#raster-maximum"),
        minimumColor: document.querySelector("#raster-minimum-color"),
        midpointColor: document.querySelector("#raster-midpoint-color"),
        maximumColor: document.querySelector("#raster-maximum-color")
    };
    const rasterLegend = document.querySelector("#raster-legend");
    const rasterLegendLabels = {
        minimum: document.querySelector("#raster-legend-minimum"),
        midpoint: document.querySelector("#raster-legend-midpoint"),
        maximum: document.querySelector("#raster-legend-maximum")
    };
    const rasterStyleError = document.querySelector("#raster-style-error");
    const resetRasterStyleButton = document.querySelector(
        "#reset-raster-style"
    );
    const rasterHistogram = document.querySelector("#raster-histogram");
    const rasterHistogramStatus = document.querySelector(
        "#raster-histogram-status"
    );
    const rasterHistogramChart = document.querySelector(
        "#raster-histogram-chart"
    );
    const rasterHistogramAxis = document.querySelector(
        "#raster-histogram-axis"
    );
    const rasterHistogramMinimum = document.querySelector(
        "#raster-histogram-minimum"
    );
    const rasterHistogramMaximum = document.querySelector(
        "#raster-histogram-maximum"
    );
    const rasterPercentileControls = document.querySelector(
        "#raster-percentile-controls"
    );
    const rasterPercentileInputs = {
        lower: document.querySelector("#raster-lower-percentile"),
        middle: document.querySelector("#raster-middle-percentile"),
        upper: document.querySelector("#raster-upper-percentile")
    };
    const rasterPercentileValues = {
        lower: document.querySelector("#raster-lower-percentile-value"),
        middle: document.querySelector("#raster-middle-percentile-value"),
        upper: document.querySelector("#raster-upper-percentile-value")
    };
    const rasterPercentileError = document.querySelector(
        "#raster-percentile-error"
    );
    const applyRasterPercentilesButton = document.querySelector(
        "#apply-raster-percentiles"
    );
    const retryRasterStatisticsButton = document.querySelector(
        "#retry-raster-statistics"
    );
    const rasterSampleWindowRange = document.querySelector(
        "#raster-sample-window-range"
    );
    const rasterSampleWindowNumber = document.querySelector(
        "#raster-sample-window-number"
    );
    const sampleRasterMapCenterButton = document.querySelector(
        "#sample-raster-map-center"
    );
    const clearRasterSampleWindowButton = document.querySelector(
        "#clear-raster-sample-window"
    );
    const rasterSampleWindowStatus = document.querySelector(
        "#raster-sample-window-status"
    );
    const rasterPixelProbe = document.querySelector("#raster-pixel-probe");
    const rasterPixelProbeName = document.querySelector(
        "#raster-pixel-probe-name"
    );
    const rasterPixelProbeReading = document.querySelector(
        "#raster-pixel-probe-reading"
    );
    let rasterStyle = { ...DEFAULT_RASTER_STYLE };
    let rasterPixelProbeLabel = "";
    let pixelProbeClientPosition = null;
    let pixelProbeSize = { width: 0, height: 0 };
    let rasterStyleCommitTimeout = null;
    let rasterStyleWasEdited = false;
    let rasterStatistics = null;
    let rasterStatisticsIsApplicable = false;
    let wholeRasterStatistics = null;
    let wholeRasterStatisticsState = "idle";
    let wholeRasterStatisticsError = null;
    let selectedRasterBounds = null;
    let selectedRasterWindowSizeKm = null;
    let activeRasterItem = null;

    const rasterLayerController = new CatalogRasterLayerController(
        leafletMap,
        publishCatalogRaster,
        (publishedRaster) => {
            const [west, south, east, north] = publishedRaster.bbox;
            const rasterLayer = L.tileLayer.wms(
                appGlobalConfiguration.wmsUrl,
                {
                    layers: publishedRaster.layerName,
                    styles: "dynamic-raster",
                    env: serializeRasterStyle(rasterStyle),
                    format: "image/png",
                    transparent: true,
                    version: "1.3.0",
                    bounds: [
                        [south, west],
                        [north, east]
                    ]
                }
            );
            rasterLayer.once("tileerror", () => {
                if (rasterLayerController.activeLayer === rasterLayer) {
                    catalogLayerStatus.textContent =
                        "Map tiles could not be rendered.";
                }
            });
            return rasterLayer;
        }
    );
    const pixelProbeController = new RasterPixelProbeController(
        sampleCatalogRasterPixel,
        renderRasterPixel,
        renderRasterPixelError
    );
    const rasterSampleWindowController = new RasterSampleWindowController(
        leafletMap,
        (bounds, layerKind) => L.rectangle(bounds, layerKind === "preview"
            ? {
                color: "#f97316",
                weight: 2,
                fill: false,
                interactive: false
            }
            : {
                color: "#2563eb",
                weight: 2,
                fillColor: "#3b82f6",
                fillOpacity: 0.12,
                interactive: false
            }),
        selectRasterSampleWindow,
        renderRasterSampleWindowGuidance
    );
    const wholeRasterStatisticsController = new RasterStatisticsController(
        loadCatalogRasterStatistics,
        renderWholeRasterStatisticsLoading,
        renderWholeRasterStatistics,
        renderWholeRasterStatisticsError
    );
    const selectedRasterStatisticsController = new RasterStatisticsController(
        loadCatalogRasterStatistics,
        renderSelectedRasterStatisticsLoading,
        renderSelectedRasterStatistics,
        renderSelectedRasterStatisticsError
    );

    for (const [paletteName, palette] of Object.entries(
        RASTER_COLOR_PALETTES
    )) {
        const paletteOption = document.createElement("option");
        paletteOption.value = paletteName;
        paletteOption.textContent = palette.label;
        rasterPalette.append(paletteOption);
    }
    const customPaletteOption = document.createElement("option");
    customPaletteOption.value = "custom";
    customPaletteOption.textContent = "Custom";
    rasterPalette.append(customPaletteOption);

    /** Read a candidate style from the appearance controls. */
    function readRasterStyleControls() {
        return {
            minimum: rasterStyleInputs.minimum.value === ""
                ? Number.NaN
                : Number(rasterStyleInputs.minimum.value),
            midpoint: rasterStyleInputs.midpoint.value === ""
                ? Number.NaN
                : Number(rasterStyleInputs.midpoint.value),
            maximum: rasterStyleInputs.maximum.value === ""
                ? Number.NaN
                : Number(rasterStyleInputs.maximum.value),
            minimumColor: rasterStyleInputs.minimumColor.value,
            midpointColor: rasterStyleInputs.midpointColor.value,
            maximumColor: rasterStyleInputs.maximumColor.value
        };
    }

    /** Present one style validation error on the fields it describes. */
    function reportRasterStyleError(styleError = null) {
        rasterStyleError.textContent = styleError?.message ?? "";
        for (const input of Object.values(rasterStyleInputs)) {
            input.removeAttribute("aria-invalid");
        }
        if (styleError === null) {
            return;
        }
        const invalidFields = styleError.fieldGroup === "colors"
            ? ["minimumColor", "midpointColor", "maximumColor"]
            : ["minimum", "midpoint", "maximum"];
        for (const fieldName of invalidFields) {
            rasterStyleInputs[fieldName].setAttribute(
                "aria-invalid",
                "true"
            );
        }
    }

    /** Render the legend for one committed raster style. */
    function renderRasterStyleLegend(style) {
        const legend = buildRasterLegend(style);
        rasterLegend.style.background = legend.gradient;
        rasterLegend.setAttribute("aria-label", legend.description);
        rasterLegendLabels.midpoint.style.left =
            `${legend.midpointPosition}%`;
        for (const thresholdName of ["minimum", "midpoint", "maximum"]) {
            rasterLegendLabels[thresholdName].textContent =
                style[thresholdName];
        }
    }

    /** Validate the current controls without changing the committed legend. */
    function validateRasterStyleControls() {
        const candidateStyle = readRasterStyleControls();
        try {
            const environment = serializeRasterStyle(candidateStyle);
            reportRasterStyleError();
            return { style: candidateStyle, environment };
        } catch (styleError) {
            reportRasterStyleError(styleError);
            return null;
        }
    }

    /** Display one style in the controls without changing the map layer. */
    function setRasterStyleControls(style, paletteName) {
        for (const fieldName of Object.keys(rasterStyleInputs)) {
            rasterStyleInputs[fieldName].value = style[fieldName];
        }
        rasterPalette.value = paletteName;
        renderRasterStyleLegend(style);
        reportRasterStyleError();
    }

    /** Commit one valid control state to the current WMS layer. */
    function commitRasterStyle() {
        if (rasterStyleCommitTimeout !== null) {
            window.clearTimeout(rasterStyleCommitTimeout);
            rasterStyleCommitTimeout = null;
        }
        const candidate = validateRasterStyleControls();
        if (
            candidate === null ||
            rasterLayerController.activeLayer === null
        ) {
            return;
        }
        rasterStyle = candidate.style;
        renderRasterStyleLegend(rasterStyle);
        if (rasterStatistics !== null) {
            renderRasterHistogramChart(
                rasterHistogramChart,
                rasterStatistics,
                rasterStyle
            );
        }
        rasterLayerController.activeLayer.setParams({
            styles: "dynamic-raster",
            env: candidate.environment
        });
    }

    /** Commit the latest valid style after rapid edits settle. */
    function scheduleRasterStyleCommit() {
        validateRasterStyleControls();
        if (rasterStyleCommitTimeout !== null) {
            window.clearTimeout(rasterStyleCommitTimeout);
        }
        rasterStyleCommitTimeout = window.setTimeout(
            () => {
                rasterStyleCommitTimeout = null;
                commitRasterStyle();
            },
            RASTER_STYLE_DEBOUNCE_MILLISECONDS
        );
    }

    /** Restore the initial appearance for a newly selected Item. */
    function resetRasterStyle() {
        rasterStyle = wholeRasterStatistics === null
            ? { ...DEFAULT_RASTER_STYLE }
            : deriveRasterStyleFromStatistics(
                DEFAULT_RASTER_STYLE,
                wholeRasterStatistics
            );
        setRasterStyleControls(rasterStyle, "blue-yellow-red");
    }

    /** Restore the histogram percentile selectors to the application default. */
    function resetRasterPercentileControls() {
        for (const percentileName of ["lower", "middle", "upper"]) {
            rasterPercentileInputs[percentileName].value =
                DEFAULT_RASTER_PERCENTILES[percentileName];
            rasterPercentileInputs[percentileName].removeAttribute(
                "aria-invalid"
            );
        }
        rasterPercentileError.textContent = "";
        applyRasterPercentilesButton.disabled = false;
    }

    /** Read the three selected histogram positions as percentages. */
    function readRasterPercentiles() {
        return {
            lower: Number(rasterPercentileInputs.lower.value),
            middle: Number(rasterPercentileInputs.middle.value),
            upper: Number(rasterPercentileInputs.upper.value)
        };
    }

    /** Update approximate values and ordered-input feedback for the selectors. */
    function updateRasterPercentileValues() {
        if (rasterStatistics === null) {
            return null;
        }
        const percentiles = readRasterPercentiles();
        const isOrdered =
            percentiles.lower < percentiles.middle &&
            percentiles.middle < percentiles.upper;
        for (const percentileName of ["lower", "middle", "upper"]) {
            const input = rasterPercentileInputs[percentileName];
            if (isOrdered) {
                input.removeAttribute("aria-invalid");
            } else {
                input.setAttribute("aria-invalid", "true");
            }
            const approximateValue = estimateRasterHistogramPercentile(
                rasterStatistics,
                percentiles[percentileName]
            );
            rasterPercentileValues[percentileName].textContent =
                `${percentiles[percentileName]}% ≈ ` +
                formatRasterPixelValue(approximateValue);
        }
        rasterPercentileError.textContent = isOrdered
            ? ""
            : "Choose lower, middle, and upper percentiles in increasing order.";
        applyRasterPercentilesButton.disabled =
            !isOrdered || !rasterStatisticsIsApplicable;
        return isOrdered ? percentiles : null;
    }

    /** Remove histogram data and controls belonging to a previous layer. */
    function clearRasterStatisticsPresentation() {
        rasterStatistics = null;
        rasterStatisticsIsApplicable = false;
        rasterHistogram.setAttribute("aria-busy", "false");
        rasterHistogramStatus.textContent = "";
        clearRasterHistogramChart(rasterHistogramChart);
        rasterHistogramAxis.hidden = true;
        rasterPercentileControls.hidden = true;
        retryRasterStatisticsButton.hidden = true;
        resetRasterPercentileControls();
    }

    /** Present one bounded statistics request without blocking manual styling. */
    function renderRasterStatisticsLoading(scope) {
        clearRasterStatisticsPresentation();
        rasterHistogram.setAttribute("aria-busy", "true");
        rasterHistogramStatus.textContent =
            scope === "selectedArea"
                ? "Calculating an approximate distribution for the selected area..."
                : "Calculating an approximate whole-raster distribution...";
    }

    /** Apply the initial whole-raster range if no manual edit superseded it. */
    function applyInitialWholeRasterStyle(statistics) {
        const initialStyle = deriveInitialRasterStyleFromStatistics(
            rasterStyle,
            statistics,
            rasterStyleWasEdited
        );
        if (initialStyle === null) {
            return false;
        }
        rasterStyle = initialStyle;
        setRasterStyleControls(rasterStyle, rasterPalette.value);
        commitRasterStyle();
        return true;
    }

    /** Present one current whole-raster or selected-area histogram. */
    function renderRasterStatistics(
        statistics,
        initialRangeApplied = false,
        allowApply = true
    ) {
        rasterStatistics = statistics;
        rasterStatisticsIsApplicable =
            allowApply &&
            rasterStatisticsMatchesSelection(statistics, selectedRasterBounds);
        rasterHistogram.setAttribute("aria-busy", "false");
        retryRasterStatisticsButton.hidden = true;
        renderRasterHistogramChart(
            rasterHistogramChart,
            statistics,
            rasterStyle
        );
        rasterHistogramMinimum.textContent =
            `≈ ${formatRasterPixelValue(statistics.sampleMinimum)}`;
        rasterHistogramMaximum.textContent =
            `≈ ${formatRasterPixelValue(statistics.sampleMaximum)}`;
        rasterHistogramAxis.hidden = false;
        rasterPercentileControls.hidden = false;
        resetRasterPercentileControls();
        updateRasterPercentileValues();

        const excludedCount =
            statistics.sampledPixelCount - statistics.validSampleCount;
        const sourceDescription = statistics.scope === "selectedArea"
            ? "source-cell window"
            : "source raster";
        const scopeDescription = statistics.scope === "selectedArea"
            ? "Selected-area approximate distribution"
            : "Whole-raster approximate distribution";
        const provenance =
            `${statistics.validSampleCount.toLocaleString()} valid pixels ` +
            `from a ${statistics.sampleWidth.toLocaleString()} × ` +
            `${statistics.sampleHeight.toLocaleString()} sample of the ` +
            `${statistics.sourceWidth.toLocaleString()} × ` +
            `${statistics.sourceHeight.toLocaleString()} ${sourceDescription}`;
        const excluded = excludedCount === 0
            ? ""
            : `; ${excludedCount.toLocaleString()} masked, nodata, or ` +
              "nonfinite sample pixels excluded";

        if (initialRangeApplied) {
            rasterHistogramStatus.textContent =
                `${scopeDescription}: ${provenance}${excluded}. ` +
                "The approximate 5th, 50th, and 95th percentile range was " +
                "applied.";
        } else {
            rasterHistogramStatus.textContent =
                `${scopeDescription}: ${provenance}${excluded}. ` +
                "Your current appearance was preserved.";
        }
    }

    /** Keep manual rendering usable after one recoverable statistics failure. */
    function renderRasterStatisticsError(error, scope) {
        rasterStatistics = null;
        rasterStatisticsIsApplicable = false;
        rasterHistogram.setAttribute("aria-busy", "false");
        clearRasterHistogramChart(rasterHistogramChart);
        rasterHistogramAxis.hidden = true;
        rasterPercentileControls.hidden = true;
        retryRasterStatisticsButton.hidden = false;
        rasterHistogramStatus.textContent =
            `${scope === "selectedArea" ? "Selected-area" : "Whole-raster"} ` +
            `distribution unavailable: ${error.message} ` +
            "Manual appearance controls remain available.";
    }

    function renderWholeRasterStatisticsLoading() {
        wholeRasterStatisticsState = "loading";
        wholeRasterStatisticsError = null;
        if (selectedRasterBounds === null) {
            renderRasterStatisticsLoading("wholeRaster");
        }
    }

    function renderWholeRasterStatistics(statistics) {
        wholeRasterStatistics = statistics;
        wholeRasterStatisticsState = "ready";
        wholeRasterStatisticsError = null;
        const initialRangeApplied = applyInitialWholeRasterStyle(
            statistics
        );
        if (selectedRasterBounds === null) {
            renderRasterStatistics(statistics, initialRangeApplied);
        }
    }

    function renderWholeRasterStatisticsError(error) {
        wholeRasterStatisticsState = "error";
        wholeRasterStatisticsError = error;
        if (selectedRasterBounds === null) {
            renderRasterStatisticsError(error, "wholeRaster");
        }
    }

    function renderSelectedRasterStatisticsLoading() {
        rasterStatisticsIsApplicable = false;
        rasterHistogram.setAttribute("aria-busy", "true");
        retryRasterStatisticsButton.hidden = true;
        applyRasterPercentilesButton.disabled = true;
        rasterHistogramStatus.textContent = rasterStatistics === null
            ? "Calculating an approximate distribution for the selected area..."
            : "Calculating an approximate distribution for the selected area... " +
              "The previous distribution remains visible for reference and " +
              "cannot be applied to this selection.";
    }

    function renderSelectedRasterStatistics(statistics) {
        renderRasterStatistics(statistics);
    }

    function renderSelectedRasterStatisticsError(error) {
        rasterStatisticsIsApplicable = false;
        if (
            rasterStatistics === null &&
            wholeRasterStatisticsState === "ready"
        ) {
            renderRasterStatistics(wholeRasterStatistics, false, false);
        }
        rasterHistogram.setAttribute("aria-busy", "false");
        retryRasterStatisticsButton.hidden = false;
        applyRasterPercentilesButton.disabled = true;
        rasterHistogramStatus.textContent = rasterStatistics === null
            ? `Selected-area distribution unavailable: ${error.message} ` +
              "Manual appearance controls remain available."
            : `Selected-area distribution unavailable: ${error.message} ` +
              "The previous distribution remains visible for reference but " +
              "cannot be applied to this selection. Your appearance was " +
              "preserved.";
    }

    /** Return the retained dataset distribution after clearing an area. */
    function restoreWholeRasterStatistics() {
        selectedRasterStatisticsController.clear();
        selectedRasterBounds = null;
        selectedRasterWindowSizeKm = null;
        rasterSampleWindowController.clearSelection();
        clearRasterSampleWindowButton.disabled = true;
        renderRasterSampleWindowGuidance("");
        if (wholeRasterStatisticsState === "ready") {
            renderRasterStatistics(wholeRasterStatistics);
        } else if (wholeRasterStatisticsState === "loading") {
            renderRasterStatisticsLoading("wholeRaster");
        } else if (wholeRasterStatisticsState === "error") {
            renderRasterStatisticsError(
                wholeRasterStatisticsError,
                "wholeRaster"
            );
        } else {
            clearRasterStatisticsPresentation();
        }
    }

    /** Describe the persistent selection separately from a transient preview. */
    function renderRasterSampleWindowGuidance(guidance) {
        let nextStatus;
        if (guidance) {
            nextStatus = guidance;
        } else if (selectedRasterBounds !== null) {
            const { west, south, east, north } = selectedRasterBounds;
            nextStatus =
                `Approximately ${selectedRasterWindowSizeKm} km × ` +
                `${selectedRasterWindowSizeKm} km window selected: ` +
                `W ${west.toFixed(3)}, S ${south.toFixed(3)}, ` +
                `E ${east.toFixed(3)}, N ${north.toFixed(3)}. ` +
                "Move and click again to replace it.";
        } else {
            nextStatus =
                "Whole-raster distribution selected. Move over the map " +
                "and click to display this window's histogram.";
        }
        if (rasterSampleWindowStatus.textContent !== nextStatus) {
            rasterSampleWindowStatus.textContent = nextStatus;
        }
    }

    /** Commit one map rectangle and replace only selected-area statistics. */
    function selectRasterSampleWindow(bounds) {
        selectedRasterBounds = bounds;
        selectedRasterWindowSizeKm =
            rasterSampleWindowController.windowSizeKm;
        clearRasterSampleWindowButton.disabled = false;
        renderRasterSampleWindowGuidance("");
        void selectedRasterStatisticsController.activate(
            activeRasterItem,
            undefined,
            bounds
        );
    }

    /** Apply one valid size from either synchronized control. */
    function setRasterSampleWindowSize(value) {
        const sideLengthKm = Number(value);
        try {
            rasterSampleWindowController.setWindowSize(sideLengthKm);
        } catch {
            rasterSampleWindowNumber.setAttribute("aria-invalid", "true");
            rasterSampleWindowStatus.textContent =
                "Choose a window size from 1 through 300 km.";
            return false;
        }
        rasterSampleWindowNumber.removeAttribute("aria-invalid");
        rasterSampleWindowRange.value = String(sideLengthKm);
        rasterSampleWindowNumber.value = String(sideLengthKm);
        renderRasterSampleWindowGuidance("");
        return true;
    }

    /** Restore controls and map interaction for a removed or changed Item. */
    function resetRasterSampleWindow() {
        rasterSampleWindowController.clear();
        selectedRasterStatisticsController.clear();
        selectedRasterBounds = null;
        selectedRasterWindowSizeKm = null;
        setRasterSampleWindowSize(DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM);
        clearRasterSampleWindowButton.disabled = true;
        renderRasterSampleWindowGuidance("");
    }

    /** Move the readout using only cached layout dimensions. */
    function positionRasterPixelProbe() {
        if (pixelProbeClientPosition === null || rasterPixelProbe.hidden) {
            return;
        }
        const position = getRasterPixelProbePosition(
            pixelProbeClientPosition,
            pixelProbeSize,
            { width: window.innerWidth, height: window.innerHeight }
        );
        rasterPixelProbe.style.transform =
            `translate3d(${position.x}px, ${position.y}px, 0)`;
    }

    /** Show and remeasure the readout after its text changes. */
    function showRasterPixelProbe() {
        rasterPixelProbe.hidden = false;
        const bounds = rasterPixelProbe.getBoundingClientRect();
        pixelProbeSize = { width: bounds.width, height: bounds.height };
        positionRasterPixelProbe();
    }

    /** Replace the filename and sampled detail shown in the pointer readout. */
    function setRasterPixelProbeContent(detail) {
        rasterPixelProbeName.textContent = rasterPixelProbeLabel;
        rasterPixelProbeName.title = rasterPixelProbeLabel;
        rasterPixelProbeReading.textContent = detail;
    }

    /** Display one current pixel response beside the pointer. */
    function renderRasterPixel(pixel, point) {
        let pixelValue = "Outside raster";
        if (pixel.inBounds) {
            pixelValue = pixel.value === null
                ? "No data"
                : formatRasterPixelValue(pixel.value);
        }
        setRasterPixelProbeContent(
            `Lon ${point.longitude.toFixed(5)} · ` +
            `Lat ${point.latitude.toFixed(5)}\nPixel: ${pixelValue}`
        );
        showRasterPixelProbe();
    }

    /** Report a current pixel request failure without affecting the layer. */
    function renderRasterPixelError(error, point) {
        setRasterPixelProbeContent(
            `Lon ${point.longitude.toFixed(5)} · ` +
            `Lat ${point.latitude.toFixed(5)}\nPixel unavailable: ` +
            error.message
        );
        showRasterPixelProbe();
    }

    /** Remove the active raster and every interaction tied to it. */
    function clear() {
        if (rasterStyleCommitTimeout !== null) {
            window.clearTimeout(rasterStyleCommitTimeout);
            rasterStyleCommitTimeout = null;
        }
        rasterLayerController.clear();
        pixelProbeController.clear();
        wholeRasterStatisticsController.clear();
        resetRasterSampleWindow();
        clearRasterStatisticsPresentation();
        activeRasterItem = null;
        wholeRasterStatistics = null;
        wholeRasterStatisticsState = "idle";
        wholeRasterStatisticsError = null;
        pixelProbeClientPosition = null;
        rasterPixelProbeLabel = "";
        rasterStyleControls.hidden = true;
        rasterPixelProbe.hidden = true;
    }

    /** Remove the active raster and restore the default appearance. */
    function reset() {
        clear();
        rasterStyleWasEdited = false;
        resetRasterStyle();
    }

    /** Publish and display one selected Catalog raster. */
    async function show(item) {
        const publishedRaster = await rasterLayerController.show(item);
        if (publishedRaster !== null) {
            activeRasterItem = item;
            rasterPixelProbeLabel = getCatalogRasterBasename(item);
            rasterStyleControls.hidden = false;
            pixelProbeController.activate(item);
            rasterSampleWindowController.enable();
            renderRasterSampleWindowGuidance("");
            void wholeRasterStatisticsController.activate(item);
        }
        return publishedRaster;
    }

    for (const input of Object.values(rasterStyleInputs)) {
        input.addEventListener("input", () => {
            rasterStyleWasEdited = true;
            if (input.type === "color") {
                rasterPalette.value = "custom";
            }
            scheduleRasterStyleCommit();
        });
        input.addEventListener("change", commitRasterStyle);
    }
    rasterPalette.addEventListener("change", () => {
        if (rasterPalette.value === "custom") {
            return;
        }
        rasterStyleWasEdited = true;
        const candidate = validateRasterStyleControls();
        if (candidate === null) {
            rasterPalette.value = "custom";
            return;
        }
        setRasterStyleControls(
            applyRasterColorPalette(
                candidate.style,
                rasterPalette.value
            ),
            rasterPalette.value
        );
        commitRasterStyle();
    });
    resetRasterStyleButton.addEventListener("click", () => {
        rasterStyleWasEdited = true;
        resetRasterStyle();
        commitRasterStyle();
        if (wholeRasterStatistics !== null) {
            resetRasterPercentileControls();
            updateRasterPercentileValues();
            const scopeNote = selectedRasterBounds === null
                ? ""
                : rasterStatisticsIsApplicable
                    ? " The selected-area distribution remains available."
                    : " The previous distribution remains reference-only " +
                      "and cannot be applied to the current selected area.";
            rasterHistogramStatus.textContent =
                "Reset appearance to the whole-raster approximate 5th, " +
                `50th, and 95th percentile range.${scopeNote}`;
        }
    });
    for (const input of Object.values(rasterPercentileInputs)) {
        input.addEventListener("input", updateRasterPercentileValues);
    }
    applyRasterPercentilesButton.addEventListener("click", () => {
        const percentiles = updateRasterPercentileValues();
        if (percentiles === null || rasterStatistics === null) {
            return;
        }
        const histogramStyle = deriveRasterStyleFromStatistics(
            rasterStyle,
            rasterStatistics,
            percentiles
        );
        rasterStyleWasEdited = true;
        rasterStyle = histogramStyle;
        setRasterStyleControls(rasterStyle, rasterPalette.value);
        commitRasterStyle();
        rasterHistogramStatus.textContent =
            "Rescaled the colors to the selected approximate percentile " +
            "range.";
    });
    retryRasterStatisticsButton.addEventListener("click", () => {
        if (selectedRasterBounds !== null) {
            void selectedRasterStatisticsController.retry();
        } else {
            void wholeRasterStatisticsController.retry();
        }
    });
    rasterSampleWindowRange.addEventListener("input", () => {
        setRasterSampleWindowSize(rasterSampleWindowRange.value);
    });
    rasterSampleWindowNumber.addEventListener("input", () => {
        setRasterSampleWindowSize(rasterSampleWindowNumber.value);
    });
    rasterSampleWindowNumber.addEventListener("change", () => {
        if (!setRasterSampleWindowSize(rasterSampleWindowNumber.value)) {
            setRasterSampleWindowSize(
                rasterSampleWindowController.windowSizeKm
            );
        }
    });
    sampleRasterMapCenterButton.addEventListener("click", () => {
        rasterSampleWindowController.sampleMapCenter();
    });
    clearRasterSampleWindowButton.addEventListener("click", () => {
        restoreWholeRasterStatistics();
    });
    leafletMap
        .getContainer()
        .addEventListener("pointermove", (pointerEvent) => {
            if (rasterLayerController.activeLayer !== null) {
                pixelProbeClientPosition = {
                    x: pointerEvent.clientX,
                    y: pointerEvent.clientY
                };
                positionRasterPixelProbe();
            }
        });
    leafletMap.on("mousemove", (mapEvent) => {
        if (rasterLayerController.activeLayer === null) {
            return;
        }
        const wrappedPosition = mapEvent.latlng.wrap();
        const point = {
            longitude: wrappedPosition.lng,
            latitude: wrappedPosition.lat
        };
        if (rasterPixelProbe.hidden) {
            setRasterPixelProbeContent(
                `Lon ${point.longitude.toFixed(5)} · ` +
                `Lat ${point.latitude.toFixed(5)}\nPixel: Reading…`
            );
            showRasterPixelProbe();
        }
        pixelProbeController.move(point);
    });
    leafletMap.getContainer().addEventListener("mouseleave", () => {
        pixelProbeController.cancel();
        pixelProbeClientPosition = null;
        rasterPixelProbe.hidden = true;
    });

    resetRasterSampleWindow();
    resetRasterStyle();
    return {
        clear,
        reset,
        show,
        get isDisplayed() {
            return rasterLayerController.activeLayer !== null;
        }
    };
}

/**
 * Connects Catalog search, progressive loading, selection, and refresh controls.
 *
 * @param {AppGlobalConfiguration} appGlobalConfiguration Application settings.
 * @param {L.Map} leafletMap The initialized Leaflet map.
 * @return {Promise<Function>} Function that reloads the active catalog search.
 */
async function initializeCatalog(appGlobalConfiguration, leafletMap) {
    const systemStateElement = document.querySelector("#system-state");
    const systemStateTextElement = document.querySelector("#system-state-text");
    const catalogMessageElement = document.querySelector("#catalog-message");
    const catalogSummaryElement = document.querySelector("#catalog-summary");
    const catalogResultsElement = document.querySelector("#catalog-results");
    const catalogResultsScrollElement = document.querySelector(
        "#catalog-results-scroll"
    );
    const catalogSearchInput = document.querySelector("#catalog-search");
    const catalogSearchError = document.querySelector("#catalog-search-error");
    const refreshCatalogButton = document.querySelector("#refresh-catalog");
    const streamStatusElement = document.querySelector(
        "#catalog-stream-status"
    );
    const retryPageButton = document.querySelector("#retry-catalog-page");
    const loadSentinelElement = document.querySelector(
        "#catalog-load-sentinel"
    );
    const streamAnnouncementElement = document.querySelector(
        "#catalog-stream-announcement"
    );
    const catalogMapActionsElement = document.querySelector(
        "#catalog-map-actions"
    );
    const catalogLayerToggle = document.querySelector(
        "#toggle-catalog-layer"
    );
    const catalogLayerStatus = document.querySelector(
        "#catalog-layer-status"
    );
    const catalogUrl = appGlobalConfiguration.catalogUrl.replace(/\/$/, "");
    const resultStream = new CatalogResultStream(
        new CatalogSearchClient(catalogUrl)
    );
    const footprintController = new CatalogFootprintController(
        leafletMap,
        createCatalogFootprintLayer
    );
    const rasterVisualization = initializeRasterVisualization(
        appGlobalConfiguration,
        leafletMap,
        catalogLayerStatus
    );
    const catalogState = {
        collectionsDocument: null,
        searchSequence: 0,
        searchText: "",
        selectedButton: null,
        selectedItem: null
    };
    /** Apply the scanner-owned visualization decision to the map action. */
    function updateCatalogMapAction(item) {
        const visualization = getRasterVisualization(item);
        catalogMapActionsElement.hidden = visualization === null;
        catalogMapActionsElement.setAttribute("aria-busy", "false");
        catalogLayerToggle.disabled = false;
        catalogLayerToggle.hidden = visualization?.eligible === false;
        catalogLayerToggle.textContent = visualization === undefined
            ? "Assess for visualization"
            : "View on map";
        catalogLayerStatus.textContent = visualization?.reason ?? "";
    }

    /** Clears the selected result, footprint, and inspector together. */
    function clearCatalogSelection() {
        footprintController.clear();
        rasterVisualization.reset();
        catalogState.selectedButton = null;
        catalogState.selectedItem = null;
        updateCatalogMapAction(null);
        renderCatalogItemInspector(
            null,
            catalogState.collectionsDocument?.collections ?? [],
            appGlobalConfiguration.scanDisplayPathPrefix
        );
    }

    /**
     * Appends one successful Item Search page to the active result stream.
     *
     * @param {Object} itemCollection STAC ItemCollection response.
     * @param {boolean} isInitialPage Whether this starts a new result stream.
     * @return {void}
     */
    function appendCatalogPage(itemCollection, isInitialPage) {
        const returnedItemCount = itemCollection.features.length;
        if (isInitialPage) {
            const isFiltered = catalogState.searchText.trim() !== "";
            const itemCountLabel = formatCatalogItemCount(
                itemCollection,
                isFiltered
            );
            const collections = catalogState.collectionsDocument.collections;
            const collectionLabel =
                collections.length === 1
                    ? (collections[0].title ?? collections[0].id)
                    : `${collections.length} collections`;
            systemStateElement.classList.add("is-connected");
            systemStateTextElement.textContent =
                `Catalog connected · ${itemCountLabel}`;
            catalogMessageElement.textContent = isFiltered
                ? "Matching records were returned from the complete STAC catalog."
                : "Records were returned from the deployed STAC catalog.";
            catalogSummaryElement.textContent =
                `${collectionLabel} · ${itemCountLabel}`;

            const pageBounds = L.geoJSON(itemCollection).getBounds();
            if (pageBounds.isValid()) {
                leafletMap.fitBounds(pageBounds.pad(0.15), { maxZoom: 8 });
            }
        }

        for (const item of itemCollection.features) {
            const itemButton = document.createElement("button");
            itemButton.className = "catalog-result";
            itemButton.type = "button";
            itemButton.setAttribute("aria-pressed", "false");

            const itemTitle = document.createElement("strong");
            itemTitle.textContent = item.properties.title ?? item.id;
            const itemDescription = document.createElement("span");
            itemDescription.textContent =
                item.properties.description ?? item.id;
            const itemSummary = document.createElement("small");
            const datasetType = MOUNTED_DATASET_TYPES.get(item.collection);
            const itemDatetime =
                item.properties.datetime ?? "Datetime unavailable";
            itemSummary.textContent = datasetType === undefined
                ? itemDatetime
                : `${datasetType} · ${itemDatetime}`;

            itemButton.append(itemTitle, itemDescription, itemSummary);
            itemButton.addEventListener("click", () => {
                const selectionChanged = catalogState.selectedItem !== item;
                if (catalogState.selectedButton !== null) {
                    catalogState.selectedButton.classList.remove("is-selected");
                    catalogState.selectedButton.setAttribute(
                        "aria-pressed",
                        "false"
                    );
                }
                if (selectionChanged) {
                    rasterVisualization.reset();
                }
                catalogState.selectedButton = itemButton;
                catalogState.selectedItem = item;
                itemButton.classList.add("is-selected");
                itemButton.setAttribute("aria-pressed", "true");
                footprintController.select(item);
                renderCatalogItemInspector(
                    item,
                    catalogState.collectionsDocument.collections,
                    appGlobalConfiguration.scanDisplayPathPrefix
                );
                if (selectionChanged) {
                    updateCatalogMapAction(item);
                }
            });
            itemButton.addEventListener("pointerenter", () => {
                footprintController.preview(item);
            });
            itemButton.addEventListener("pointerleave", () => {
                footprintController.clearPreview();
            });
            itemButton.addEventListener("focus", () => {
                footprintController.preview(item);
            });
            itemButton.addEventListener("blur", () => {
                footprintController.clearPreview();
            });
            catalogResultsElement.append(itemButton);
        }

        if (catalogResultsElement.childElementCount === 0) {
            const emptyCatalogMessage = document.createElement("p");
            emptyCatalogMessage.className = "catalog-empty";
            emptyCatalogMessage.textContent = catalogState.searchText.trim()
                ? `No Items matched “${catalogState.searchText.trim()}”.`
                : "The catalog is connected but has no Items.";
            catalogResultsElement.append(emptyCatalogMessage);
        }

        if (!isInitialPage) {
            streamAnnouncementElement.textContent =
                `${returnedItemCount.toLocaleString()} additional Items loaded.`;
        }
    }

    /** Prepare one page ahead, then watch for the user to reach it. */
    async function prefetchNextCatalogPage() {
        const searchSequence = catalogState.searchSequence;
        retryPageButton.hidden = true;
        streamStatusElement.textContent = "Preparing more Catalog Items…";
        try {
            const bufferedPage = await resultStream.prefetchNextPage();
            if (
                searchSequence !== catalogState.searchSequence ||
                bufferedPage === null
            ) {
                return;
            }
            streamStatusElement.textContent =
                "More Items are ready as you scroll.";
            if (!resultStream.isLoading) {
                pageObserver.observe(loadSentinelElement);
            }
        } catch (catalogError) {
            if (searchSequence !== catalogState.searchSequence) {
                return;
            }
            pageObserver.unobserve(loadSentinelElement);
            streamStatusElement.textContent =
                `Additional Items could not be prepared: ${catalogError.message}`;
            retryPageButton.hidden = false;
        }
    }

    /** Prepare another page or display the end of the active stream. */
    function observeNextCatalogPage() {
        pageObserver.unobserve(loadSentinelElement);
        retryPageButton.hidden = true;
        if (!resultStream.hasNextPage) {
            streamStatusElement.textContent = "End of results.";
            return;
        }
        void prefetchNextCatalogPage();
    }

    /** Start a new search and replace every result from the previous stream. */
    async function loadCatalog(reloadCollections = false) {
        const searchSequence = ++catalogState.searchSequence;
        catalogState.searchText = catalogSearchInput.value;
        catalogSearchInput.removeAttribute("aria-invalid");
        catalogSearchError.textContent = "";
        pageObserver.unobserve(loadSentinelElement);
        retryPageButton.hidden = true;
        clearCatalogSelection();
        catalogResultsElement.replaceChildren();
        catalogResultsElement.setAttribute("aria-busy", "true");
        systemStateElement.classList.remove("is-connected", "is-warning");
        systemStateTextElement.textContent = "Searching catalog";
        catalogMessageElement.textContent =
            "Requesting Collections and Items from the STAC API.";
        catalogSummaryElement.textContent = "Loading catalog contents";
        streamStatusElement.textContent = "Loading Catalog Items…";
        refreshCatalogButton.disabled = true;

        try {
            const collectionsRequest =
                reloadCollections || catalogState.collectionsDocument === null
                    ? loadCatalogCollections(catalogUrl)
                    : Promise.resolve(catalogState.collectionsDocument);
            const [collectionsDocument, itemCollection] = await Promise.all([
                collectionsRequest,
                resultStream.restart(catalogState.searchText)
            ]);
            if (
                searchSequence !== catalogState.searchSequence ||
                itemCollection === null
            ) {
                return;
            }
            catalogState.collectionsDocument = collectionsDocument;
            appendCatalogPage(itemCollection, true);
            observeNextCatalogPage();
        } catch (catalogError) {
            if (searchSequence !== catalogState.searchSequence) {
                return;
            }
            if (catalogError instanceof CatalogSearchSyntaxError) {
                catalogSearchInput.setAttribute("aria-invalid", "true");
                catalogSearchError.textContent = catalogError.message;
                systemStateTextElement.textContent =
                    "Catalog search needs correction";
                catalogMessageElement.textContent =
                    "Correct the field filter and try again.";
                catalogSummaryElement.textContent = catalogError.message;
                streamStatusElement.textContent = "Catalog search was not sent.";
                return;
            }
            systemStateElement.classList.add("is-warning");
            systemStateTextElement.textContent = "Catalog unavailable";
            catalogMessageElement.textContent =
                "Check the catalog services and try again.";
            catalogSummaryElement.textContent = catalogError.message;
            streamStatusElement.textContent = "Catalog search failed.";
        } finally {
            if (searchSequence === catalogState.searchSequence) {
                catalogResultsElement.setAttribute("aria-busy", "false");
                refreshCatalogButton.disabled = false;
            }
        }
    }

    /** Append the provider's next page while retaining existing results. */
    async function loadNextCatalogPage() {
        if (resultStream.isLoading || !resultStream.hasNextPage) {
            return;
        }

        const searchSequence = catalogState.searchSequence;
        pageObserver.unobserve(loadSentinelElement);
        retryPageButton.hidden = true;
        streamStatusElement.textContent = "Loading more Catalog Items…";
        catalogResultsElement.setAttribute("aria-busy", "true");
        try {
            const itemCollection = await resultStream.loadNextPage();
            if (
                searchSequence !== catalogState.searchSequence ||
                itemCollection === null
            ) {
                return;
            }
            appendCatalogPage(itemCollection, false);
            observeNextCatalogPage();
        } catch (catalogError) {
            if (searchSequence !== catalogState.searchSequence) {
                return;
            }
            streamStatusElement.textContent =
                `Additional Items could not be loaded: ${catalogError.message}`;
            retryPageButton.hidden = false;
        } finally {
            if (searchSequence === catalogState.searchSequence) {
                catalogResultsElement.setAttribute("aria-busy", "false");
            }
        }
    }

    const pageObserver = new IntersectionObserver(
        (entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
                void loadNextCatalogPage();
            }
        },
        {
            root: catalogResultsScrollElement,
            rootMargin: CATALOG_LOAD_ROOT_MARGIN,
        }
    );

    const scheduleCatalogSearch = createDebouncedAction(
        loadCatalog.bind(null, false),
        CATALOG_SEARCH_DEBOUNCE_MILLISECONDS,
        window
    );
    catalogSearchInput.addEventListener("input", scheduleCatalogSearch);
    refreshCatalogButton.addEventListener(
        "click",
        loadCatalog.bind(null, true)
    );
    retryPageButton.addEventListener("click", prefetchNextCatalogPage);
    catalogLayerToggle.addEventListener("click", async () => {
        const selectedItem = catalogState.selectedItem;
        if (getRasterVisualization(selectedItem) === undefined) {
            catalogMapActionsElement.setAttribute("aria-busy", "true");
            catalogLayerToggle.disabled = true;
            catalogLayerToggle.textContent = "Assessing...";
            catalogLayerStatus.textContent =
                "Inspecting the selected raster.";
            try {
                const assessedItem = await assessCatalogRaster(selectedItem);
                if (catalogState.selectedItem !== selectedItem) {
                    return;
                }
                Object.assign(selectedItem, assessedItem);
                renderCatalogItemInspector(
                    selectedItem,
                    catalogState.collectionsDocument.collections,
                    appGlobalConfiguration.scanDisplayPathPrefix
                );
                updateCatalogMapAction(selectedItem);
            } catch (assessmentError) {
                if (catalogState.selectedItem === selectedItem) {
                    catalogLayerToggle.textContent =
                        "Assess for visualization";
                    catalogLayerStatus.textContent = assessmentError.message;
                }
            } finally {
                if (catalogState.selectedItem === selectedItem) {
                    catalogMapActionsElement.setAttribute("aria-busy", "false");
                    catalogLayerToggle.disabled = false;
                }
            }
            return;
        }

        if (rasterVisualization.isDisplayed) {
            rasterVisualization.clear();
            catalogLayerToggle.textContent = "View on map";
            catalogLayerStatus.textContent = "Raster removed from the map.";
            return;
        }

        catalogMapActionsElement.setAttribute("aria-busy", "true");
        catalogLayerToggle.disabled = true;
        catalogLayerToggle.textContent = "Adding to map…";
        catalogLayerStatus.textContent = "Preparing the selected raster.";
        try {
            const publishedRaster = await rasterVisualization.show(
                selectedItem
            );
            if (
                publishedRaster === null ||
                catalogState.selectedItem !== selectedItem
            ) {
                return;
            }
            catalogLayerToggle.textContent = "Remove from map";
            catalogLayerStatus.textContent =
                "Raster displayed. Hover over the map to inspect pixels.";
        } catch (renderingError) {
            if (catalogState.selectedItem === selectedItem) {
                catalogLayerToggle.textContent = "View on map";
                catalogLayerStatus.textContent = renderingError.message;
            }
        } finally {
            if (catalogState.selectedItem === selectedItem) {
                catalogMapActionsElement.setAttribute("aria-busy", "false");
                catalogLayerToggle.disabled = false;
            }
        }
    });

    await loadCatalog(true);
    return loadCatalog.bind(null, true);
}

/**
 * Displays the current mounted-directory scan state.
 *
 * @param {Object} scanStatus Scan progress returned by the backend.
 * @return {void}
 */
function renderScanStatus(scanStatus) {
    const startScanButton = document.querySelector("#start-scan");
    const scanStatusDisclosureElement = document.querySelector(
        "#scan-status-disclosure"
    );
    const scanStatusSummaryElement = document.querySelector(
        "#scan-status-summary"
    );
    const scanStatusElement = document.querySelector("#scan-status");
    const scanProgressElement = document.querySelector("#scan-progress");
    const scanCountsElement = document.querySelector("#scan-counts");
    const scanReconciliationElement = document.querySelector(
        "#scan-reconciliation"
    );
    const scanTimingElement = document.querySelector("#scan-timing");
    const scanTimingValuesElement = document.querySelector(
        "#scan-timing-values"
    );
    const scanErrorsDisclosureElement = document.querySelector(
        "#scan-errors-disclosure"
    );
    const scanErrorsSummaryElement = document.querySelector(
        "#scan-errors-summary"
    );
    const scanErrorsElement = document.querySelector("#scan-errors");
    const isRunning = ["discovering", "scanning"].includes(scanStatus.state);
    const wasRunning = scanStatusDisclosureElement.dataset.running === "true";

    startScanButton.disabled = isRunning;
    startScanButton.textContent = isRunning ? "Scanning…" : "Scan directories";
    scanStatusSummaryElement.textContent = formatScanStatusSummary(scanStatus);
    // Set the default only when a scan starts or stops so polling does not
    // override a user's disclosure choice during the same run.
    if (isRunning !== wasRunning) {
        scanStatusDisclosureElement.open = isRunning;
    }
    scanStatusDisclosureElement.dataset.running = String(isRunning);
    scanProgressElement.hidden = scanStatus.state === "not_started";
    scanProgressElement.max = Math.max(scanStatus.discovered, 1);
    scanProgressElement.value = scanStatus.processed;
    const newlyCataloged = scanStatus.indexed - scanStatus.alreadyInCatalog;
    scanCountsElement.textContent =
        scanStatus.state === "not_started"
            ? ""
            : `${scanStatus.discovered.toLocaleString()} discovered · ` +
              `${scanStatus.processed.toLocaleString()} processed · ` +
              `${newlyCataloged.toLocaleString()} newly cataloged · ` +
              `${scanStatus.alreadyInCatalog.toLocaleString()} ` +
              `already in catalog · ` +
              `${scanStatus.failed.toLocaleString()} failed`;
    scanReconciliationElement.hidden = scanStatus.state === "not_started";
    scanReconciliationElement.textContent = formatScanReconciliation(
        scanStatus.reconciliation
    );
    scanReconciliationElement.classList.toggle(
        "is-error",
        scanStatus.reconciliation.state === "failed"
    );

    scanTimingElement.hidden = scanStatus.state === "not_started";
    scanTimingValuesElement.replaceChildren();
    for (const timingRow of formatScanTiming(
        scanStatus.timing,
        scanStatus.workerCount,
        scanStatus.writerCount,
        scanStatus.batchSize
    )) {
        const timingLabel = document.createElement("dt");
        timingLabel.textContent = timingRow.label;
        const timingValue = document.createElement("dd");
        timingValue.textContent = timingRow.value;
        scanTimingValuesElement.append(timingLabel, timingValue);
    }

    const statusMessages = {
        not_started: "No scan has been started.",
        discovering:
            "Discovering geospatial datasets in the mounted directories.",
        scanning: scanStatus.currentFile
            ? `Latest file: ${scanStatus.currentFile}`
            : "Preparing discovered geospatial datasets.",
        completed: "Scan completed. The catalog has been refreshed.",
        failed: "The scan stopped before it could complete."
    };
    scanStatusElement.textContent =
        statusMessages[scanStatus.state] ??
        `Unknown scan state: ${scanStatus.state}`;

    scanErrorsDisclosureElement.hidden =
        scanStatus.state === "not_started" || scanStatus.errors.length === 0;
    scanErrorsSummaryElement.textContent = scanStatus.errorsTruncated
        ? `Error details (${scanStatus.errors.length.toLocaleString()} shown)`
        : `Error details (${scanStatus.errors.length.toLocaleString()})`;
    scanErrorsElement.replaceChildren();
    for (const scanError of scanStatus.errors) {
        const errorItem = document.createElement("li");
        errorItem.textContent = scanError.path
            ? `${scanError.path}: ${scanError.error}`
            : scanError.error;
        scanErrorsElement.append(errorItem);
    }
    if (scanStatus.errorsTruncated) {
        const truncatedErrorsMessage = document.createElement("li");
        truncatedErrorsMessage.textContent =
            "Additional file failures are not shown.";
        scanErrorsElement.append(truncatedErrorsMessage);
    }
}

/**
 * Polls scan progress until the current scan finishes.
 *
 * @param {Function} refreshCatalog Reloads the active Catalog search.
 * @param {boolean} refreshWhenComplete Whether completion should refresh STAC.
 * @return {Promise<void>} Resolves after the current status is displayed.
 */
async function pollScan(refreshCatalog, refreshWhenComplete) {
    const scanResponse = await fetch("/api/scans/current", {
        headers: { Accept: "application/json" }
    });
    if (!scanResponse.ok) {
        throw new Error(`Scan status returned ${scanResponse.status}`);
    }

    const scanStatus = await scanResponse.json();
    renderScanStatus(scanStatus);
    if (["discovering", "scanning"].includes(scanStatus.state)) {
        scanPollTimeout = window.setTimeout(
            pollScan.bind(null, refreshCatalog, true),
            750
        );
    } else if (refreshWhenComplete && scanStatus.state === "completed") {
        await refreshCatalog();
    }
}

/**
 * Starts a mounted-directory scan from the Catalog panel.
 *
 * @param {Function} refreshCatalog Reloads the active Catalog search.
 * @return {Promise<void>} Resolves after polling has been scheduled.
 */
async function startScan(refreshCatalog) {
    try {
        if (scanPollTimeout !== null) {
            window.clearTimeout(scanPollTimeout);
        }
        document.querySelector("#scan-status-disclosure").open = true;
        document.querySelector("#scan-errors-disclosure").open = false;
        const startResponse = await fetch("/api/scans", {
            method: "POST",
            headers: { Accept: "application/json" }
        });
        if (!startResponse.ok && startResponse.status !== 409) {
            throw new Error(`Starting scan returned ${startResponse.status}`);
        }
        await pollScan(refreshCatalog, true);
    } catch (scanError) {
        document.querySelector("#start-scan").disabled = false;
        document.querySelector("#scan-status").textContent = scanError.message;
    }
}

/**
 * Connects the mounted-directory scanner controls.
 *
 * @param {Function} refreshCatalog Reloads the active Catalog search.
 * @return {Promise<void>} Resolves after current scan state is displayed.
 */
async function initializeScanner(refreshCatalog) {
    document
        .querySelector("#start-scan")
        .addEventListener("click", startScan.bind(null, refreshCatalog));
    await pollScan(refreshCatalog, false);
}

/**
 * Enables collapsing and reopening the control panel.
 *
 * @param {L.Map} leafletMap The initialized Leaflet map.
 * @return {void}
 */
function initializeControlPanel(leafletMap) {
    const appElement = document.querySelector("#app");
    const controlPanelElement = document.querySelector("#control-panel");
    const openPanelButton = document.querySelector("#open-panel");
    const catalogWorkspaceToggle = document.querySelector(
        "#toggle-catalog-workspace"
    );
    const catalogInspector = document.querySelector(
        "#catalog-item-inspector"
    );
    let catalogWorkspaceIsExpanded = true;

    /**
     * Sets whether the Catalog uses the expanded workspace.
     *
     * @param {boolean} isExpanded Whether the workspace is expanded.
     * @return {void}
     */
    function setCatalogWorkspaceExpanded(isExpanded) {
        if (isExpanded === catalogWorkspaceIsExpanded) {
            return;
        }
        catalogWorkspaceIsExpanded = isExpanded;
        appElement.classList.toggle("is-catalog-workspace", isExpanded);
        catalogWorkspaceToggle.setAttribute(
            "aria-expanded",
            String(isExpanded)
        );
        catalogWorkspaceToggle.textContent = isExpanded
            ? "Minimize catalog"
            : "Expand catalog";
        catalogInspector.setAttribute("aria-hidden", String(!isExpanded));
        window.setTimeout(
            () => leafletMap.invalidateSize(),
            CONTROL_PANEL_TRANSITION_MILLISECONDS
        );
    }

    /**
     * Sets whether the control panel is collapsed.
     *
     * @param {boolean} isCollapsed Whether the panel should be collapsed.
     * @return {void}
     */
    function setControlPanelCollapsed(isCollapsed) {
        const catalogWorkspaceWasExpanded = catalogWorkspaceIsExpanded;
        if (isCollapsed) {
            setCatalogWorkspaceExpanded(false);
        }
        controlPanelElement.classList.toggle("is-collapsed", isCollapsed);
        openPanelButton.hidden = !isCollapsed;
        if (!catalogWorkspaceWasExpanded) {
            window.setTimeout(
                () => leafletMap.invalidateSize(),
                CONTROL_PANEL_TRANSITION_MILLISECONDS
            );
        }
    }

    catalogWorkspaceToggle.addEventListener("click", () => {
        setCatalogWorkspaceExpanded(!catalogWorkspaceIsExpanded);
    });
    document.addEventListener("keydown", (keyboardEvent) => {
        if (keyboardEvent.key === "Escape" && catalogWorkspaceIsExpanded) {
            keyboardEvent.preventDefault();
            setCatalogWorkspaceExpanded(false);
            catalogWorkspaceToggle.focus();
        }
    });
    document
        .querySelector("#collapse-panel")
        .addEventListener("click", setControlPanelCollapsed.bind(null, true));
    openPanelButton.addEventListener(
        "click",
        setControlPanelCollapsed.bind(null, false)
    );
}

/**
 * Starts the browser application from its runtime contract.
 *
 * @return {Promise<void>} Resolves after the interface is initialized.
 */
async function startApplication() {
    const appGlobalConfiguration = await loadAppGlobalConfiguration();
    applyAppGlobalConfiguration(appGlobalConfiguration);
    initializeRendering(appGlobalConfiguration);
    const leafletMap = initializeMap(appGlobalConfiguration);
    initializeControlPanel(leafletMap);
    const refreshCatalog = await initializeCatalog(
        appGlobalConfiguration,
        leafletMap
    );
    await initializeScanner(refreshCatalog);
}

startApplication();
