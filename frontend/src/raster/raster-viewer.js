import {
    loadCatalogRasterStatistics,
    publishCatalogRaster,
    sampleCatalogRasterPixel,
} from "./api.js";
import { DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM } from "./geometry.js";
import {
    CatalogRasterLayerController,
    createRasterSampleWindowLayer,
    createRasterWmsLayer,
} from "./leaflet.js";
import {
    getCatalogRasterBasename,
    getRasterPixelProbePosition,
    formatRasterPixelValue,
    RasterPixelProbeController,
} from "./pixel-probe.js";
import { RasterSampleWindowController } from "./sample-window-controller.js";
import {
    DEFAULT_RASTER_PERCENTILES,
    estimateRasterHistogramPercentile,
    rasterStatisticsMatchesSelection,
} from "./statistics.js";
import { RasterStatisticsController } from "./statistics-controller.js";
import {
    applyRasterColorPalette,
    DEFAULT_RASTER_STYLE,
    deriveInitialRasterStyleFromStatistics,
    deriveRasterStyleFromStatistics,
    RASTER_COLOR_PALETTES,
} from "./style.js";
import { buildRasterStyleEnvironment } from "./wms.js";
import { RasterControlsView } from "./controls-view.js";

const RASTER_STYLE_DEBOUNCE_MILLISECONDS = 200;

/**
 * @typedef {Object} RasterViewer
 * @property {() => void} clear Remove the displayed raster interactions.
 * @property {() => void} reset Clear the raster and restore default styling.
 * @property {(item: Object) => Promise<Object|null>} show Publish and display
 * one selected raster Item.
 * @property {() => void} destroy Permanently detach viewer listeners; the
 * viewer must not be reused afterward.
 * @property {boolean} isDisplayed Whether one raster layer is displayed.
 */

/**
 * @typedef {Object} RasterViewerConfiguration
 * @property {string} wmsUrl Browser-facing GeoServer WMS endpoint.
 * @property {Object} leafletMap Initialized Leaflet-compatible map.
 * @property {Object} leaflet Leaflet namespace with WMS and rectangle factories.
 * @property {(message: string) => void} onTileError Reports an active tile error.
 */

/**
 * @typedef {Object} RasterViewerDependencies
 * @property {RasterControlsView} [controlsView=new RasterControlsView()]
 * Raster-control DOM adapter.
 * @property {(item: Object) => Promise<Object>}
 * [publishRaster=publishCatalogRaster] Publishes one Catalog raster.
 * @property {(item: Object, signal: AbortSignal, selectedBounds: Object|null)
 * => Promise<Object>} [loadStatistics=loadCatalogRasterStatistics] Loads whole
 * or selected statistics.
 * @property {(item: Object, point: Object, signal: AbortSignal)
 * => Promise<Object>} [samplePixel=sampleCatalogRasterPixel] Samples one raster
 * pixel.
 * @property {{setTimeout: (callback: () => void, delay: number) => *,
 * clearTimeout: (identifier: *) => void}} [clock=globalThis] Timer
 * implementation.
 * @property {Object} [viewport=globalThis] Browser viewport dimensions.
 */

/**
 * Connect raster appearance, statistics, sampling, and Leaflet interactions.
 *
 * The returned feature boundary owns the single rendered raster, its committed
 * style, and every interaction that is valid only while it is displayed.
 *
 * @param {RasterViewerConfiguration} configuration Viewer configuration.
 * @param {RasterViewerDependencies} [dependencies={}] Injectable
 * collaborators.
 * @return {RasterViewer} Raster visualization boundary used by the Catalog.
 * @throws {Error} If the DOM, Leaflet, or injected collaborator contracts are
 * incomplete.
 */
export function initializeRasterViewer(
    { wmsUrl, leafletMap, leaflet, onTileError },
    {
        controlsView = new RasterControlsView(),
        publishRaster = publishCatalogRaster,
        loadStatistics = loadCatalogRasterStatistics,
        samplePixel = sampleCatalogRasterPixel,
        clock = globalThis,
        viewport = globalThis,
    } = {}
) {
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

    /**
     * Create one Leaflet WMS layer from a successful publication response.
     *
     * @param {{bbox: number[], layerName: string}} publishedRaster Published
     * GeoServer layer details.
     * @return {Object} Leaflet-compatible WMS layer.
     */
    function createRasterLayer(publishedRaster) {
        const rasterLayer = createRasterWmsLayer(
            leaflet,
            wmsUrl,
            publishedRaster,
            buildRasterStyleEnvironment(rasterStyle),
            () => {
                if (rasterLayerController.activeLayer === rasterLayer) {
                    onTileError("Map tiles could not be rendered.");
                }
            }
        );
        return rasterLayer;
    }

    /**
     * Create one transient or committed sample-window rectangle.
     *
     * @param {Array} bounds Leaflet rectangle bounds.
     * @param {"preview"|"selection"} layerKind Rectangle purpose.
     * @return {Object} Leaflet-compatible rectangle layer.
     */
    function createSampleWindowLayer(bounds, layerKind) {
        return createRasterSampleWindowLayer(leaflet, bounds, layerKind);
    }

    const rasterLayerController = new CatalogRasterLayerController(
        leafletMap,
        publishRaster,
        createRasterLayer
    );
    const pixelProbeController = new RasterPixelProbeController(
        samplePixel,
        renderRasterPixel,
        renderRasterPixelError
    );
    const rasterSampleWindowController = new RasterSampleWindowController(
        leafletMap,
        createSampleWindowLayer,
        selectRasterSampleWindow,
        renderRasterSampleWindowGuidance
    );
    const wholeRasterStatisticsController = new RasterStatisticsController(
        loadStatistics,
        renderWholeRasterStatisticsLoading,
        renderWholeRasterStatistics,
        renderWholeRasterStatisticsError
    );
    const selectedRasterStatisticsController = new RasterStatisticsController(
        loadStatistics,
        renderSelectedRasterStatisticsLoading,
        renderSelectedRasterStatistics,
        renderSelectedRasterStatisticsError
    );

    /**
     * Validate a candidate style and build its GeoServer environment.
     *
     * @return {{style: Object, environment: string}|null} Valid candidate or
     * null after presenting its contract error.
     */
    function validateRasterStyleControls() {
        const candidateStyle = controlsView.readStyle();
        try {
            const environment = buildRasterStyleEnvironment(candidateStyle);
            controlsView.renderStyleError();
            return { style: candidateStyle, environment };
        } catch (styleError) {
            controlsView.renderStyleError(styleError);
            return null;
        }
    }

    /**
     * Commit one valid control state to the current WMS layer.
     *
     * @return {void}
     */
    function commitRasterStyle() {
        if (rasterStyleCommitTimeout !== null) {
            clock.clearTimeout(rasterStyleCommitTimeout);
            rasterStyleCommitTimeout = null;
        }
        const candidate = validateRasterStyleControls();
        if (candidate === null || rasterLayerController.activeLayer === null) {
            return;
        }
        rasterStyle = candidate.style;
        controlsView.renderLegend(rasterStyle);
        if (rasterStatistics !== null) {
            controlsView.renderHistogram(rasterStatistics, rasterStyle);
        }
        rasterLayerController.activeLayer.setParams({
            styles: "dynamic-raster",
            env: candidate.environment,
        });
    }

    /**
     * Commit the latest valid style after rapid edits settle.
     *
     * @return {void}
     */
    function scheduleRasterStyleCommit() {
        validateRasterStyleControls();
        if (rasterStyleCommitTimeout !== null) {
            clock.clearTimeout(rasterStyleCommitTimeout);
        }
        rasterStyleCommitTimeout = clock.setTimeout(
            commitScheduledRasterStyle,
            RASTER_STYLE_DEBOUNCE_MILLISECONDS
        );
    }

    /**
     * Clear the pending identifier and commit its retained style candidate.
     *
     * @return {void}
     */
    function commitScheduledRasterStyle() {
        rasterStyleCommitTimeout = null;
        commitRasterStyle();
    }

    /**
     * Restore the initial appearance for the active Item.
     *
     * @return {void}
     */
    function resetRasterStyle() {
        rasterStyle = wholeRasterStatistics === null
            ? { ...DEFAULT_RASTER_STYLE }
            : deriveRasterStyleFromStatistics(
                DEFAULT_RASTER_STYLE,
                wholeRasterStatistics
            );
        controlsView.setStyle(rasterStyle, "blue-yellow-red");
    }

    /**
     * Restore histogram percentile selectors to application defaults.
     *
     * @return {void}
     */
    function resetRasterPercentileControls() {
        controlsView.resetPercentiles(DEFAULT_RASTER_PERCENTILES);
    }

    /**
     * Update approximate values and ordered-input feedback for percentiles.
     *
     * @return {{lower: number, middle: number, upper: number}|null} Ordered
     * percentiles, null for invalid ordering or absent statistics.
     */
    function updateRasterPercentileValues() {
        if (rasterStatistics === null) {
            return null;
        }
        const percentiles = controlsView.readPercentiles();
        const isOrdered =
            percentiles.lower < percentiles.middle &&
            percentiles.middle < percentiles.upper;
        const approximateValues = {};
        for (const percentileName of ["lower", "middle", "upper"]) {
            approximateValues[percentileName] = formatRasterPixelValue(
                estimateRasterHistogramPercentile(
                    rasterStatistics,
                    percentiles[percentileName]
                )
            );
        }
        controlsView.renderPercentileValues(
            percentiles,
            approximateValues,
            isOrdered,
            rasterStatisticsIsApplicable
        );
        return isOrdered ? percentiles : null;
    }

    /**
     * Remove histogram data and controls belonging to a previous layer.
     *
     * @return {void}
     */
    function clearRasterStatisticsPresentation() {
        rasterStatistics = null;
        rasterStatisticsIsApplicable = false;
        controlsView.clearStatistics();
        resetRasterPercentileControls();
    }

    /**
     * Present one bounded statistics request without blocking manual styling.
     *
     * @param {"wholeRaster"|"selectedArea"} scope Statistics request scope.
     * @return {void}
     */
    function renderRasterStatisticsLoading(scope) {
        clearRasterStatisticsPresentation();
        controlsView.setStatisticsBusy(true);
        controlsView.setStatisticsStatus(
            scope === "selectedArea"
                ? "Calculating an approximate distribution for the selected area..."
                : "Calculating an approximate whole-raster distribution..."
        );
    }

    /**
     * Apply the initial whole-raster range unless a manual edit superseded it.
     *
     * @param {Object} statistics Validated whole-raster statistics.
     * @return {boolean} Whether the approximate initial range was applied.
     */
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
        controlsView.setStyle(rasterStyle, controlsView.getPaletteName());
        commitRasterStyle();
        return true;
    }

    /**
     * Present one current whole-raster or selected-area histogram.
     *
     * @param {Object} statistics Validated raster statistics.
     * @param {boolean} [initialRangeApplied=false] Whether its range was
     * applied.
     * @param {boolean} [allowApply=true] Whether percentiles apply to the
     * selection.
     * @return {void}
     */
    function renderRasterStatistics(
        statistics,
        initialRangeApplied = false,
        allowApply = true
    ) {
        rasterStatistics = statistics;
        rasterStatisticsIsApplicable =
            allowApply &&
            rasterStatisticsMatchesSelection(statistics, selectedRasterBounds);
        controlsView.setStatisticsBusy(false);
        controlsView.setStatisticsRetryVisible(false);
        controlsView.renderHistogram(statistics, rasterStyle);
        controlsView.showHistogramAxis(
            `≈ ${formatRasterPixelValue(statistics.sampleMinimum)}`,
            `≈ ${formatRasterPixelValue(statistics.sampleMaximum)}`
        );
        controlsView.setPercentileControlsVisible(true);
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

        controlsView.setStatisticsStatus(
            initialRangeApplied
                ? `${scopeDescription}: ${provenance}${excluded}. ` +
                  "The approximate 5th, 50th, and 95th percentile range was " +
                  "applied."
                : `${scopeDescription}: ${provenance}${excluded}. ` +
                  "Your current appearance was preserved."
        );
    }

    /**
     * Keep manual rendering usable after one statistics failure.
     *
     * @param {Error} error Recoverable statistics request failure.
     * @param {"wholeRaster"|"selectedArea"} scope Failed request scope.
     * @return {void}
     */
    function renderRasterStatisticsError(error, scope) {
        rasterStatistics = null;
        rasterStatisticsIsApplicable = false;
        controlsView.setStatisticsBusy(false);
        controlsView.clearHistogram();
        controlsView.hideHistogramAxis();
        controlsView.setPercentileControlsVisible(false);
        controlsView.setStatisticsRetryVisible(true);
        controlsView.setStatisticsStatus(
            `${scope === "selectedArea" ? "Selected-area" : "Whole-raster"} ` +
            `distribution unavailable: ${error.message} ` +
            "Manual appearance controls remain available."
        );
    }

    /**
     * Record and present the start of a whole-raster statistics request.
     *
     * @return {void}
     */
    function renderWholeRasterStatisticsLoading() {
        wholeRasterStatisticsState = "loading";
        wholeRasterStatisticsError = null;
        if (selectedRasterBounds === null) {
            renderRasterStatisticsLoading("wholeRaster");
        }
    }

    /**
     * Retain a successful whole-raster distribution and initialize its style.
     *
     * @param {Object} statistics Validated whole-raster statistics.
     * @return {void}
     */
    function renderWholeRasterStatistics(statistics) {
        wholeRasterStatistics = statistics;
        wholeRasterStatisticsState = "ready";
        wholeRasterStatisticsError = null;
        const initialRangeApplied = applyInitialWholeRasterStyle(statistics);
        if (selectedRasterBounds === null) {
            renderRasterStatistics(statistics, initialRangeApplied);
        }
    }

    /**
     * Retain and present a recoverable whole-raster statistics failure.
     *
     * @param {Error} error Statistics request failure.
     * @return {void}
     */
    function renderWholeRasterStatisticsError(error) {
        wholeRasterStatisticsState = "error";
        wholeRasterStatisticsError = error;
        if (selectedRasterBounds === null) {
            renderRasterStatisticsError(error, "wholeRaster");
        }
    }

    /**
     * Present the start of a selected-area statistics request.
     *
     * @return {void}
     */
    function renderSelectedRasterStatisticsLoading() {
        rasterStatisticsIsApplicable = false;
        controlsView.setStatisticsBusy(true);
        controlsView.setStatisticsRetryVisible(false);
        controlsView.setApplyPercentilesEnabled(false);
        controlsView.setStatisticsStatus(
            rasterStatistics === null
                ? "Calculating an approximate distribution for the selected area..."
                : "Calculating an approximate distribution for the selected area... " +
                  "The previous distribution remains visible for reference and " +
                  "cannot be applied to this selection."
        );
    }

    /**
     * Present one successful selected-area statistics response.
     *
     * @param {Object} statistics Validated selected-area statistics.
     * @return {void}
     */
    function renderSelectedRasterStatistics(statistics) {
        renderRasterStatistics(statistics);
    }

    /**
     * Present a selected-area failure while retaining useful prior context.
     *
     * @param {Error} error Statistics request failure.
     * @return {void}
     */
    function renderSelectedRasterStatisticsError(error) {
        rasterStatisticsIsApplicable = false;
        if (rasterStatistics === null && wholeRasterStatisticsState === "ready") {
            renderRasterStatistics(wholeRasterStatistics, false, false);
        }
        controlsView.setStatisticsBusy(false);
        controlsView.setStatisticsRetryVisible(true);
        controlsView.setApplyPercentilesEnabled(false);
        controlsView.setStatisticsStatus(
            rasterStatistics === null
                ? `Selected-area distribution unavailable: ${error.message} ` +
                  "Manual appearance controls remain available."
                : `Selected-area distribution unavailable: ${error.message} ` +
                  "The previous distribution remains visible for reference but " +
                  "cannot be applied to this selection. Your appearance was " +
                  "preserved."
        );
    }

    /**
     * Restore retained whole-raster statistics after clearing a selected area.
     *
     * @return {void}
     */
    function restoreWholeRasterStatistics() {
        selectedRasterStatisticsController.clear();
        selectedRasterBounds = null;
        selectedRasterWindowSizeKm = null;
        rasterSampleWindowController.clearSelection();
        controlsView.setClearSampleWindowEnabled(false);
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

    /**
     * Describe a persistent sample selection or transient edge guidance.
     *
     * @param {string} guidance Transient controller guidance, if any.
     * @return {void}
     */
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
        controlsView.setSampleWindowStatus(nextStatus);
    }

    /**
     * Commit one map rectangle and replace selected-area statistics.
     *
     * @param {Object} bounds Canonical selected WGS 84 bounds.
     * @return {void}
     */
    function selectRasterSampleWindow(bounds) {
        selectedRasterBounds = bounds;
        selectedRasterWindowSizeKm = rasterSampleWindowController.windowSizeKm;
        controlsView.setClearSampleWindowEnabled(true);
        renderRasterSampleWindowGuidance("");
        void selectedRasterStatisticsController.activate(
            activeRasterItem,
            undefined,
            bounds
        );
    }

    /**
     * Apply one valid size from either synchronized sample-window control.
     *
     * @param {string|number} value Candidate side length in kilometers.
     * @return {boolean} Whether the candidate satisfied the size contract.
     */
    function setRasterSampleWindowSize(value) {
        const sideLengthKm = Number(value);
        try {
            rasterSampleWindowController.setWindowSize(sideLengthKm);
        } catch {
            controlsView.setSampleWindowInvalid(true);
            controlsView.setSampleWindowStatus(
                "Choose a window size from 1 through 300 km."
            );
            return false;
        }
        controlsView.setSampleWindowInvalid(false);
        controlsView.setSampleWindowSize(sideLengthKm);
        renderRasterSampleWindowGuidance("");
        return true;
    }

    /**
     * Restore sample controls and map interaction for a changed Item.
     *
     * @return {void}
     */
    function resetRasterSampleWindow() {
        rasterSampleWindowController.clear();
        selectedRasterStatisticsController.clear();
        selectedRasterBounds = null;
        selectedRasterWindowSizeKm = null;
        setRasterSampleWindowSize(DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM);
        controlsView.setClearSampleWindowEnabled(false);
        renderRasterSampleWindowGuidance("");
    }

    /**
     * Move the pointer probe using cached layout dimensions.
     *
     * @return {void}
     */
    function positionRasterPixelProbe() {
        if (
            pixelProbeClientPosition === null ||
            !controlsView.isPixelProbeVisible()
        ) {
            return;
        }
        controlsView.positionPixelProbe(
            getRasterPixelProbePosition(
                pixelProbeClientPosition,
                pixelProbeSize,
                { width: viewport.innerWidth, height: viewport.innerHeight }
            )
        );
    }

    /**
     * Show and remeasure the pointer probe after its text changes.
     *
     * @return {void}
     */
    function showRasterPixelProbe() {
        pixelProbeSize = controlsView.showPixelProbe();
        positionRasterPixelProbe();
    }

    /**
     * Replace the raster name and sampled detail in the pointer probe.
     *
     * @param {string} detail Formatted coordinate and sample detail.
     * @return {void}
     */
    function setRasterPixelProbeContent(detail) {
        controlsView.setPixelProbeContent(rasterPixelProbeLabel, detail);
    }

    /**
     * Display one current pixel response beside the pointer.
     *
     * @param {{inBounds: boolean, value: number|null}} pixel Pixel response.
     * @param {{longitude: number, latitude: number}} point Sampled position.
     * @return {void}
     */
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

    /**
     * Report a current pixel request failure without affecting the layer.
     *
     * @param {Error} error Pixel sampling failure.
     * @param {{longitude: number, latitude: number}} point Sampled position.
     * @return {void}
     */
    function renderRasterPixelError(error, point) {
        setRasterPixelProbeContent(
            `Lon ${point.longitude.toFixed(5)} · ` +
            `Lat ${point.latitude.toFixed(5)}\nPixel unavailable: ` +
            error.message
        );
        showRasterPixelProbe();
    }

    /**
     * Mark a manual style input and schedule its WMS commit.
     *
     * @param {boolean} isColor Whether a color input changed.
     * @return {void}
     */
    function handleStyleInput(isColor) {
        rasterStyleWasEdited = true;
        if (isColor) {
            controlsView.setPaletteName("custom");
        }
        scheduleRasterStyleCommit();
    }

    /**
     * Apply one selected predefined palette to the current style.
     *
     * @return {void}
     */
    function handlePaletteChange() {
        const paletteName = controlsView.getPaletteName();
        if (paletteName === "custom") {
            return;
        }
        rasterStyleWasEdited = true;
        const candidate = validateRasterStyleControls();
        if (candidate === null) {
            controlsView.setPaletteName("custom");
            return;
        }
        controlsView.setStyle(
            applyRasterColorPalette(candidate.style, paletteName),
            paletteName
        );
        commitRasterStyle();
    }

    /**
     * Reset the active style to its whole-raster approximate range.
     *
     * @return {void}
     */
    function handleResetStyle() {
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
            controlsView.setStatisticsStatus(
                "Reset appearance to the whole-raster approximate 5th, " +
                `50th, and 95th percentile range.${scopeNote}`
            );
        }
    }

    /**
     * Apply the current ordered approximate percentile range to WMS styling.
     *
     * @return {void}
     */
    function handleApplyPercentiles() {
        const percentiles = updateRasterPercentileValues();
        if (percentiles === null || rasterStatistics === null) {
            return;
        }
        rasterStyleWasEdited = true;
        rasterStyle = deriveRasterStyleFromStatistics(
            rasterStyle,
            rasterStatistics,
            percentiles
        );
        controlsView.setStyle(
            rasterStyle,
            controlsView.getPaletteName()
        );
        commitRasterStyle();
        controlsView.setStatisticsStatus(
            "Rescaled the colors to the selected approximate percentile range."
        );
    }

    /**
     * Retry statistics for the current selected or whole-raster scope.
     *
     * @return {void}
     */
    function handleRetryStatistics() {
        if (selectedRasterBounds !== null) {
            void selectedRasterStatisticsController.retry();
        } else {
            void wholeRasterStatisticsController.retry();
        }
    }

    /**
     * Restore the last valid sample-window size after a completed invalid edit.
     *
     * @param {string} value Candidate numeric side length.
     * @return {void}
     */
    function handleSampleWindowNumberChange(value) {
        if (!setRasterSampleWindowSize(value)) {
            setRasterSampleWindowSize(rasterSampleWindowController.windowSizeKm);
        }
    }

    /**
     * Track the pointer synchronously for smooth probe movement.
     *
     * @param {PointerEvent} pointerEvent Browser pointer movement event.
     * @return {void}
     */
    function handleMapPointerMove(pointerEvent) {
        if (rasterLayerController.activeLayer !== null) {
            pixelProbeClientPosition = {
                x: pointerEvent.clientX,
                y: pointerEvent.clientY,
            };
            positionRasterPixelProbe();
        }
    }

    /**
     * Queue a throttled pixel sample for one Leaflet map position.
     *
     * @param {Object} mapEvent Leaflet mousemove event with a wrapped position.
     * @return {void}
     */
    function handleMapMouseMove(mapEvent) {
        if (rasterLayerController.activeLayer === null) {
            return;
        }
        const wrappedPosition = mapEvent.latlng.wrap();
        const point = {
            longitude: wrappedPosition.lng,
            latitude: wrappedPosition.lat,
        };
        if (!controlsView.isPixelProbeVisible()) {
            setRasterPixelProbeContent(
                `Lon ${point.longitude.toFixed(5)} · ` +
                `Lat ${point.latitude.toFixed(5)}\nPixel: Reading…`
            );
            showRasterPixelProbe();
        }
        pixelProbeController.move(point);
    }

    /**
     * Cancel pixel sampling and hide the pointer probe outside the map.
     *
     * @return {void}
     */
    function handleMapMouseLeave() {
        pixelProbeController.cancel();
        pixelProbeClientPosition = null;
        controlsView.hidePixelProbe();
    }

    /**
     * Remove the active raster and every interaction tied to it.
     *
     * @return {void}
     */
    function clear() {
        if (rasterStyleCommitTimeout !== null) {
            clock.clearTimeout(rasterStyleCommitTimeout);
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
        controlsView.setControlsVisible(false);
        controlsView.hidePixelProbe();
    }

    /**
     * Remove the active raster and restore its default appearance.
     *
     * @return {void}
     */
    function reset() {
        clear();
        rasterStyleWasEdited = false;
        resetRasterStyle();
    }

    /**
     * Publish and display one selected Catalog raster.
     *
     * @param {Object} item Selected mounted GeoTIFF STAC Item.
     * @return {Promise<Object|null>} Published raster or null after invalidation.
     * @throws {Error} If publication or Leaflet layer construction fails.
     */
    async function show(item) {
        const publishedRaster = await rasterLayerController.show(item);
        if (publishedRaster !== null) {
            activeRasterItem = item;
            rasterPixelProbeLabel = getCatalogRasterBasename(item);
            controlsView.setControlsVisible(true);
            pixelProbeController.activate(item);
            rasterSampleWindowController.enable();
            renderRasterSampleWindowGuidance("");
            void wholeRasterStatisticsController.activate(item);
        }
        return publishedRaster;
    }

    /**
     * Permanently detach the viewer from DOM and Leaflet event sources.
     * The viewer must not be reused after this call.
     *
     * @return {void}
     */
    function destroy() {
        clear();
        controlsView.unbind();
        mapContainer.removeEventListener("pointermove", handleMapPointerMove);
        mapContainer.removeEventListener("mouseleave", handleMapMouseLeave);
        leafletMap.off("mousemove", handleMapMouseMove);
    }

    controlsView.populatePalettes(RASTER_COLOR_PALETTES);
    controlsView.bind({
        onStyleInput: handleStyleInput,
        onStyleChange: commitRasterStyle,
        onPaletteChange: handlePaletteChange,
        onResetStyle: handleResetStyle,
        onPercentileInput: updateRasterPercentileValues,
        onApplyPercentiles: handleApplyPercentiles,
        onRetryStatistics: handleRetryStatistics,
        onSampleWindowRangeInput: setRasterSampleWindowSize,
        onSampleWindowNumberInput: setRasterSampleWindowSize,
        onSampleWindowNumberChange: handleSampleWindowNumberChange,
        onSampleMapCenter: rasterSampleWindowController.sampleMapCenter.bind(
            rasterSampleWindowController
        ),
        onClearSampleWindow: restoreWholeRasterStatistics,
    });
    const mapContainer = leafletMap.getContainer();
    mapContainer.addEventListener("pointermove", handleMapPointerMove);
    leafletMap.on("mousemove", handleMapMouseMove);
    mapContainer.addEventListener("mouseleave", handleMapMouseLeave);

    resetRasterSampleWindow();
    resetRasterStyle();
    return {
        clear,
        reset,
        show,
        destroy,
        /**
         * Return whether one raster layer is currently displayed.
         *
         * @return {boolean} Whether one raster layer is displayed.
         */
        get isDisplayed() {
            return rasterLayerController.activeLayer !== null;
        },
    };
}
