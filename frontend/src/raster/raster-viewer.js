/**
 * Application coordinator for one interactive Catalog raster viewer.
 *
 * This module connects publication, Leaflet layers, raster controls,
 * statistics, selected-area sampling, styling, and the pixel probe. It owns
 * their shared lifecycle and stale-work rules while delegating domain logic,
 * HTTP access, DOM presentation, and Leaflet construction to focused modules.
 */
import { getCatalogItemKey } from "../catalog-item-identity.js";
import { publishCatalogRaster } from "./api.js";
import {
    loadCatalogRasterStatistics,
    RasterAnalysisRequestError,
    sampleCatalogRasterPixel,
} from "./analysis-api.js";
import {
    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
    isCanonicalWgs84Position,
} from "./geometry.js";
import {
    createRasterSampleWindowLayer,
    createRasterWmsLayer,
    ensureRasterSampleWindowPane,
} from "./leaflet.js";
import { MapLayerController } from "../map-layers/controller.js";
import { MapLayerStackView } from "../map-layers/layer-stack-view.js";
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
    normalizeRasterSamplingArea,
    rasterStatisticsMatchesSelection,
    WHOLE_RASTER_SAMPLING_AREA,
} from "./statistics.js";
import { RasterStatisticsController } from "./statistics-controller.js";
import {
    applyRasterColorPalette,
    DEFAULT_RASTER_STYLE,
    deriveInitialRasterStyleFromStatistics,
    deriveRasterStyleFromStatistics,
    RASTER_COLOR_PALETTES,
    buildRasterLegend,
} from "./style.js";
import { buildRasterStyleEnvironment } from "./wms.js";
import { RasterControlsView } from "./controls-view.js";

const RASTER_STYLE_DEBOUNCE_MILLISECONDS = 200;

/**
 * Return whether repeating a failed statistics request may change its result.
 *
 * Client and conflict responses describe invalid or currently unsupported
 * intent, so repeating the same request is not presented as recovery. Unknown
 * transport failures, timeouts, rate limits, and server failures remain
 * retryable without coupling the viewer to backend error-message text.
 *
 * @param {Error} error Statistics request failure.
 * @return {boolean} Whether the controls should offer the Retry action.
 */
function canRetryRasterStatistics(error) {
    if (!(error instanceof RasterAnalysisRequestError)) {
        return true;
    }
    return (
        error.status === 408 ||
        error.status === 429 ||
        error.status >= 500
    );
}

/**
 * @typedef {Object} RasterViewer
 * @property {() => void} clear Remove all retained raster interactions.
 * @property {() => void} reset Clear the raster and restore default styling.
 * @property {(item: Object) => Promise<Object|null>} show Publish and retain
 * one selected raster Item.
 * @property {(item:Object) => void} activateAnalysis Start independent raster
 * analysis controls without requiring a renderer.
 * @property {(item:Object|null) => void} deactivateAnalysis Remove a matching
 * analysis-only session and restore retained map-layer controls.
 * @property {(item:Object,style:Object,onStyleChange:(style:Object)=>void)
 * => void} activateSampled Edit one visible browser-rendered sampled raster.
 * @property {(item:Object,style:Object) => void} updateSampledInitialStyle
 * Adopt the first finite sampled range unless the user already edited it.
 * @property {(item:Object) => void} removeSampled Remove matching sampled
 * raster controls without removing its map presentation.
 * @property {(item: Object) => boolean} contains Return whether an Item is
 * retained in the layer stack.
 * @property {(item: Object) => void} remove Remove one Item from the stack.
 * @property {(temporaryAoi: Readonly<Object>|null) => void} setTemporaryAoi
 * Receive ready lifecycle snapshots from the temporary-AOI public boundary.
 * @property {() => void} destroy Permanently detach viewer listeners; the
 * viewer must not be reused afterward.
 * @property {boolean} isDisplayed Whether any raster layer is visible.
 */

/**
 * @typedef {Object} RasterViewerConfiguration
 * @property {string} wmsUrl Browser-facing GeoServer WMS endpoint.
 * @property {Object} leafletMap Initialized Leaflet-compatible map.
 * @property {Object} leaflet Leaflet namespace with WMS and rectangle factories.
 * @property {(message: string, item: Object) => void} onTileError Reports a
 * layer-specific tile error.
 * @property {(layers: Object[]) => void} [onLayersChange] Receives retained
 * layer snapshots after state changes.
 * @property {() => void} [onHistogramRequested] Notifies the composition root
 * that an explicit analysis action should reveal its presentation workspace.
 */

/**
 * @typedef {Object} RasterViewerDependencies
 * @property {RasterControlsView|null} [controlsView=null] Raster-control DOM
 * adapter; null constructs the application view.
 * @property {MapLayerStackView|null} [layerStackView=null] Layer-list DOM
 * adapter created only when the viewer owns its neutral controller.
 * @property {MapLayerController|null} [mapLayerController=null] Neutral shared
 * retained-layer controller supplied by application composition.
 * @property {(item: Object) => Promise<Object>}
 * [publishRaster=publishCatalogRaster] Publishes one Catalog raster.
 * @property {(item: Object, samplingArea:Object, signal:AbortSignal)
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
 * The returned feature boundary owns isolated raster state and controls while
 * consuming the neutral retained map-layer controller.
 *
 * @param {RasterViewerConfiguration} configuration Viewer configuration.
 * @param {RasterViewerDependencies} [dependencies={}] Injectable
 * collaborators.
 * @return {RasterViewer} Raster visualization boundary used by the Catalog.
 * @throws {Error} If the DOM, Leaflet, or injected collaborator contracts are
 * incomplete.
 */
export function initializeRasterViewer(
    {
        wmsUrl,
        leafletMap,
        leaflet,
        onTileError,
        onLayersChange = () => {},
        onHistogramRequested = () => {},
    },
    {
        controlsView = null,
        layerStackView = null,
        mapLayerController = null,
        publishRaster = publishCatalogRaster,
        loadStatistics = loadCatalogRasterStatistics,
        samplePixel = sampleCatalogRasterPixel,
        clock = globalThis,
        viewport = globalThis,
    } = {}
) {
    if (typeof onHistogramRequested !== "function") {
        throw new TypeError("Histogram presentation callback must be callable");
    }
    controlsView ??= new RasterControlsView();
    ensureRasterSampleWindowPane(leafletMap);
    const ownsMapLayerController = mapLayerController === null;
    const mapLayers = mapLayerController ?? new MapLayerController({
        leafletMap,
        view: layerStackView ?? new MapLayerStackView(),
        onLayersChange,
    });
    let sampledRasterSession = null;
    let analysisRasterSession = null;
    let activeLayerKey = null;
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
    let selectedTemporaryAoi = null;
    let availableTemporaryAoi = null;
    let selectedRasterWindowSizeKm = null;
    let activeRasterItem = null;
    let selectedRasterStatistics = null;
    let selectedRasterStatisticsState = "idle";
    let selectedRasterStatisticsError = null;

    /**
     * Return whether the shared controls currently own a sampled raster.
     *
     * @return {boolean} Whether a non-WMS sampled session is active.
     */
    function isActiveSampledRaster() {
        return sampledRasterSession !== null &&
            activeLayerKey === sampledRasterSession.key;
    }

    /**
     * Return whether shared controls own a renderer-independent session.
     *
     * @return {boolean} Whether analysis-only controls are active.
     */
    function isActiveAnalysisRaster() {
        return analysisRasterSession !== null &&
            activeLayerKey === analysisRasterSession.key;
    }

    /**
     * Return the active non-WMS session, if one owns the shared controls.
     *
     * @return {Object|null} Sampled or analysis-only session.
     */
    function activeDetachedRasterSession() {
        if (isActiveSampledRaster()) {
            return sampledRasterSession;
        }
        return isActiveAnalysisRaster() ? analysisRasterSession : null;
    }

    /**
     * Create retained interaction state for one successfully published layer.
     *
     * @param {Object} entry Pure stack entry.
     * @param {Object} publishedRaster GeoServer publication response.
     * @return {Object} Per-layer state restored on activation.
     */
    function createLayerSession(entry, publishedRaster) {
        return {
            key: entry.key,
            item: entry.item,
            label: entry.label,
            publishedRaster,
            rasterStyle: { ...DEFAULT_RASTER_STYLE },
            paletteName: "blue-yellow-red",
            rasterStyleWasEdited: false,
            rasterStatistics: null,
            rasterStatisticsIsApplicable: false,
            wholeRasterStatistics: null,
            wholeRasterStatisticsState: "idle",
            wholeRasterStatisticsError: null,
            selectedRasterBounds: null,
            selectedTemporaryAoi: availableTemporaryAoi,
            selectedRasterWindowSizeKm: null,
            selectedRasterStatistics: null,
            selectedRasterStatisticsState: "idle",
            selectedRasterStatisticsError: null,
            layerHistogramController: null,
            error: null,
        };
    }

    /**
     * Create renderer-independent interaction state for one Catalog raster.
     *
     * The session is deliberately not inserted into the map-layer stack. It
     * gives pixel and statistics analysis an owner while the selected raster
     * has no WMS or adaptive-detail presentation.
     *
     * @param {Object} item Selected Catalog raster Item.
     * @return {Object} Analysis-only interaction state.
     */
    function createAnalysisSession(item) {
        return {
            key: `analysis:${getCatalogItemKey(item)}`,
            item,
            label: `${getCatalogRasterBasename(item)} (analysis only)`,
            rasterStyle: { ...DEFAULT_RASTER_STYLE },
            paletteName: "blue-yellow-red",
            rasterStyleWasEdited: false,
            rasterStatistics: null,
            rasterStatisticsIsApplicable: false,
            wholeRasterStatistics: null,
            wholeRasterStatisticsState: "idle",
            wholeRasterStatisticsError: null,
            selectedRasterBounds: null,
            selectedTemporaryAoi: availableTemporaryAoi,
            selectedRasterWindowSizeKm: null,
            selectedRasterStatistics: null,
            selectedRasterStatisticsState: "idle",
            selectedRasterStatisticsError: null,
        };
    }

    /**
     * Copy renderer-neutral controls and analysis state between sessions.
     *
     * @param {Object} target Newly established renderer session.
     * @param {Object} source Existing analysis-only session for the same Item.
     * @param {boolean} [includeAppearance=true] Whether style and palette state
     * can transfer to the target renderer.
     * @return {void}
     */
    function copyRasterInteractionState(
        target,
        source,
        includeAppearance = true
    ) {
        Object.assign(target, {
            rasterStatistics: source.rasterStatistics,
            rasterStatisticsIsApplicable:
                source.rasterStatisticsIsApplicable,
            wholeRasterStatistics: source.wholeRasterStatistics,
            wholeRasterStatisticsState: source.wholeRasterStatisticsState,
            wholeRasterStatisticsError: source.wholeRasterStatisticsError,
            selectedRasterBounds: source.selectedRasterBounds,
            selectedTemporaryAoi: source.selectedTemporaryAoi,
            selectedRasterWindowSizeKm: source.selectedRasterWindowSizeKm,
            selectedRasterStatistics: source.selectedRasterStatistics,
            selectedRasterStatisticsState: source.selectedRasterStatisticsState,
            selectedRasterStatisticsError: source.selectedRasterStatisticsError,
        });
        if (includeAppearance) {
            Object.assign(target, {
                rasterStyle: { ...source.rasterStyle },
                paletteName: source.paletteName,
                rasterStyleWasEdited: source.rasterStyleWasEdited,
            });
        }
    }

    /**
     * Detach renderer-neutral state from a renderer session.
     *
     * @param {Object} source Active WMS or adaptive-detail session.
     * @return {Object} Analysis-only session with the same area and controls.
     */
    function detachAnalysisSession(source) {
        const session = createAnalysisSession(source.item);
        copyRasterInteractionState(session, source);
        return session;
    }

    /**
     * Return analysis-only state when it belongs to one Catalog raster.
     *
     * @param {Object} item Candidate Catalog raster Item.
     * @return {Object|null} Matching analysis session or null.
     */
    function matchingAnalysisSession(item) {
        const expectedKey = `analysis:${getCatalogItemKey(item)}`;
        return analysisRasterSession?.key === expectedKey
            ? analysisRasterSession
            : null;
    }

    /**
     * Require the retained session paired with one stack entry.
     *
     * @param {string} key Stable retained layer key.
     * @return {Object} Matching per-layer interaction state.
     * @throws {Error} If stack and session state have diverged.
     */
    function requireLayerSession(key) {
        const session = mapLayers.getRecord(key)?.state ?? null;
        if (session === null) {
            throw new Error(`Raster layer session is missing: ${key}`);
        }
        return session;
    }

    /**
     * Persist the shared active-control state into its retained session.
     *
     * @return {void}
     */
    function saveActiveLayerSession() {
        if (activeLayerKey === null) {
            return;
        }
        const session = activeDetachedRasterSession() ??
            requireLayerSession(activeLayerKey);
        Object.assign(session, {
            rasterStyle: { ...rasterStyle },
            paletteName: controlsView.getPaletteName(),
            rasterStyleWasEdited,
            rasterStatistics,
            rasterStatisticsIsApplicable,
            wholeRasterStatistics,
            wholeRasterStatisticsState,
            wholeRasterStatisticsError,
            selectedRasterBounds,
            selectedTemporaryAoi,
            selectedRasterWindowSizeKm,
            selectedRasterStatistics,
            selectedRasterStatisticsState,
            selectedRasterStatisticsError,
        });
    }

    /**
     * Load one retained session into the shared active-control state.
     *
     * @param {Object} session Retained per-layer interaction state.
     * @return {void}
     */
    function loadActiveLayerSession(session) {
        activeLayerKey = session.key;
        activeRasterItem = session.item;
        rasterPixelProbeLabel = session.label;
        rasterStyle = { ...session.rasterStyle };
        rasterStyleWasEdited = session.rasterStyleWasEdited;
        rasterStatistics = session.rasterStatistics;
        rasterStatisticsIsApplicable = session.rasterStatisticsIsApplicable;
        wholeRasterStatistics = session.wholeRasterStatistics;
        wholeRasterStatisticsState = session.wholeRasterStatisticsState;
        wholeRasterStatisticsError = session.wholeRasterStatisticsError;
        selectedRasterBounds = session.selectedRasterBounds;
        selectedTemporaryAoi = session.selectedTemporaryAoi;
        selectedRasterWindowSizeKm = session.selectedRasterWindowSizeKm;
        selectedRasterStatistics = session.selectedRasterStatistics;
        selectedRasterStatisticsState = session.selectedRasterStatisticsState;
        selectedRasterStatisticsError = session.selectedRasterStatisticsError;
    }

    /**
     * Create one Leaflet WMS layer from a successful publication response.
     *
     * @param {{bbox: number[], layerName: string}} publishedRaster Published
     * GeoServer layer details.
     * @param {Object} style Retained style for this layer.
     * @param {() => void} reportTileError Owned tile-error callback.
     * @return {Object} Leaflet-compatible WMS layer.
     */
    function createRasterLayer(publishedRaster, style, reportTileError) {
        return createRasterWmsLayer(
            leaflet,
            wmsUrl,
            publishedRaster,
            buildRasterStyleEnvironment(style),
            reportTileError
        );
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
    const rasterStatisticsController = new RasterStatisticsController(
        loadStatistics,
        (_, samplingArea) => {
            resetPendingRasterStatisticsState();
            if (samplingArea.kind === "wholeRaster") {
                renderWholeRasterStatisticsLoading();
            } else {
                renderSelectedRasterStatisticsLoading();
            }
            renderLayerHistogramSummaries();
        },
        (statistics, _, samplingArea) => {
            if (samplingArea.kind === "wholeRaster") {
                renderWholeRasterStatistics(statistics);
            } else {
                renderSelectedRasterStatistics(statistics);
            }
            renderLayerHistogramSummaries();
        },
        (error, _, samplingArea) => {
            if (samplingArea.kind === "wholeRaster") {
                renderWholeRasterStatisticsError(error);
            } else {
                renderSelectedRasterStatisticsError(error);
            }
            renderLayerHistogramSummaries();
        }
    );

    /**
     * Return the statistics state associated with a retained session's current
     * sampling area.
     *
     * @param {Object} session Raster-owned retained interaction state.
     * @return {{state:string,statistics:Object|null,scope:string}} Compact
     * presentation state for the raster-analysis summary view.
     */
    function getLayerHistogramPresentation(session) {
        if (session.selectedTemporaryAoi !== null) {
            return {
                state: session.selectedRasterStatisticsState,
                statistics: session.selectedRasterStatistics,
                scope: "Uploaded AOI",
            };
        }
        if (session.selectedRasterBounds !== null) {
            return {
                state: session.selectedRasterStatisticsState,
                statistics: session.selectedRasterStatistics,
                scope: session.selectedRasterWindowSizeKm === null
                    ? "Map sample"
                    : `${session.selectedRasterWindowSizeKm} km map sample`,
            };
        }
        return {
            state: session.wholeRasterStatisticsState,
            statistics: session.wholeRasterStatistics,
            scope: "Whole raster",
        };
    }

    /**
     * Build one presentation-ready histogram summary for a retained raster.
     *
     * @param {Object} session Raster-owned retained interaction state.
     * @return {{key:string,label:string,state:string,scope:string,
     * counts:number[]|null}} Histogram summary view model.
     */
    function buildLayerHistogramSummary(session) {
        const presentation = getLayerHistogramPresentation(session);
        const counts = presentation.statistics?.histogram?.counts;
        return {
            key: session.key,
            label: session.label,
            state: presentation.state,
            scope: presentation.scope,
            counts: Array.isArray(counts) ? [...counts] : null,
        };
    }

    /**
     * Publish raster-owned summary state to the focused histogram view.
     *
     * @return {void}
     */
    function renderLayerHistogramSummaries() {
        const summaries = mapLayers.retainedRecords
            .filter(({ adapter }) => adapter === rasterMapLayerAdapter)
            .map(({ state }) => buildLayerHistogramSummary(state));
        const activeRetainedKey = summaries.some(
            ({ key }) => key === activeLayerKey
        )
            ? activeLayerKey
            : null;
        controlsView.renderLayerHistograms(summaries, activeRetainedKey);
    }

    /**
     * Apply one shared user-selected sampling area to an inactive raster
     * session before its independent statistics request starts.
     *
     * @param {Object} session Inactive retained raster session.
     * @param {Readonly<Object>} samplingArea Validated sampling-area union.
     * @return {void}
     */
    function setSessionSamplingArea(session, samplingArea) {
        if (samplingArea.kind === "wholeRaster") {
            session.selectedRasterBounds = null;
            session.selectedTemporaryAoi = null;
            session.selectedRasterWindowSizeKm = null;
            session.selectedRasterStatistics = null;
            session.selectedRasterStatisticsState = "idle";
            session.selectedRasterStatisticsError = null;
            return;
        }
        session.selectedRasterBounds = samplingArea.kind === "selectedArea"
            ? samplingArea.selectedBounds
            : null;
        session.selectedTemporaryAoi = samplingArea.kind === "temporaryAoi"
            ? selectedTemporaryAoi
            : null;
        session.selectedRasterWindowSizeKm = samplingArea.kind === "selectedArea"
            ? selectedRasterWindowSizeKm
            : null;
        session.selectedRasterStatistics = null;
        session.selectedRasterStatisticsState = "idle";
        session.selectedRasterStatisticsError = null;
        session.rasterStatisticsIsApplicable = false;
    }

    /**
     * Store an inactive retained session's successful statistics response.
     *
     * @param {Object} session Retained raster session.
     * @param {Object} statistics Validated statistics response.
     * @param {Readonly<Object>} samplingArea Request sampling area.
     * @return {void}
     */
    function storeLayerHistogramResult(session, statistics, samplingArea) {
        if (samplingArea.kind === "wholeRaster") {
            session.wholeRasterStatistics = statistics;
            session.wholeRasterStatisticsState = "ready";
            session.wholeRasterStatisticsError = null;
        } else {
            session.selectedRasterStatistics = statistics;
            session.selectedRasterStatisticsState = "ready";
            session.selectedRasterStatisticsError = null;
        }
        session.rasterStatistics = statistics;
        session.rasterStatisticsIsApplicable = true;
        renderLayerStack();
    }

    /**
     * Store an inactive retained session's independent statistics failure.
     *
     * @param {Object} session Retained raster session.
     * @param {Error} error Current non-abort request failure.
     * @param {Readonly<Object>} samplingArea Request sampling area.
     * @return {void}
     */
    function storeLayerHistogramError(session, error, samplingArea) {
        if (samplingArea.kind === "wholeRaster") {
            session.wholeRasterStatisticsState = "error";
            session.wholeRasterStatisticsError = error;
        } else {
            session.selectedRasterStatisticsState = "error";
            session.selectedRasterStatisticsError = error;
        }
        session.rasterStatisticsIsApplicable = false;
        renderLayerStack();
    }

    /**
     * Return a request controller dedicated to one inactive layer summary.
     *
     * @param {Object} session Retained raster session.
     * @return {RasterStatisticsController} Independent stale-safe controller.
     */
    function requireLayerHistogramController(session) {
        session.layerHistogramController ??= new RasterStatisticsController(
            loadStatistics,
            (_, samplingArea) => {
                if (samplingArea.kind === "wholeRaster") {
                    session.wholeRasterStatisticsState = "loading";
                    session.wholeRasterStatisticsError = null;
                } else {
                    session.selectedRasterStatisticsState = "loading";
                    session.selectedRasterStatisticsError = null;
                }
                session.rasterStatisticsIsApplicable = false;
                renderLayerStack();
            },
            (statistics, _, samplingArea) => {
                storeLayerHistogramResult(session, statistics, samplingArea);
            },
            (error, _, samplingArea) => {
                storeLayerHistogramError(session, error, samplingArea);
            }
        );
        return session.layerHistogramController;
    }

    /**
     * Refresh every inactive retained raster for one explicit histogram area.
     *
     * The active raster continues through the existing shared controller so
     * detailed status, retries, and percentile applicability remain unchanged.
     *
     * @param {Readonly<Object>} samplingArea Validated sampling-area union.
     * @return {void}
     */
    function refreshRetainedLayerHistograms(samplingArea) {
        saveActiveLayerSession();
        for (const record of mapLayers.retainedRecords) {
            if (
                record.adapter !== rasterMapLayerAdapter ||
                record.entry.key === activeLayerKey
            ) {
                continue;
            }
            const session = record.state;
            setSessionSamplingArea(session, samplingArea);
            void requireLayerHistogramController(session).activate(
                session.item,
                samplingArea
            );
        }
    }

    /**
     * Return the normalized area selected by the parent viewer.
     *
     * @return {Readonly<Object>} Strict whole/bounds/AOI sampling-area union.
     */
    function currentRasterSamplingArea() {
        if (selectedTemporaryAoi !== null) {
            return normalizeRasterSamplingArea({
                kind: "temporaryAoi",
                temporaryAoiId: selectedTemporaryAoi.id
            });
        }
        if (selectedRasterBounds !== null) {
            return normalizeRasterSamplingArea({
                kind: "selectedArea",
                selectedBounds: selectedRasterBounds
            });
        }
        return WHOLE_RASTER_SAMPLING_AREA;
    }

    /**
     * Release a superseded controller request's loading marker.
     *
     * @return {void}
     */
    function resetPendingRasterStatisticsState() {
        if (wholeRasterStatisticsState === "loading") {
            wholeRasterStatisticsState = "idle";
        }
        if (selectedRasterStatisticsState === "loading") {
            selectedRasterStatisticsState = "idle";
        }
    }

    /**
     * Return whether the active raster uses a non-whole sampling area.
     *
     * @return {boolean} Whether bounds or a temporary AOI owns the histogram.
     */
    function hasSelectedRasterSamplingArea() {
        return selectedRasterBounds !== null || selectedTemporaryAoi !== null;
    }

    /**
     * Return the active sampling-area discriminator for control presentation.
     *
     * @return {"wholeRaster"|"selectedArea"|"temporaryAoi"} Active
     * mode.
     */
    function getRasterSamplingAreaMode() {
        if (selectedTemporaryAoi !== null) {
            return "temporaryAoi";
        }
        return selectedRasterBounds === null ? "wholeRaster" : "selectedArea";
    }

    /**
     * Synchronize explicit histogram-area choices with lifecycle state.
     *
     * @return {void}
     */
    function renderRasterSamplingAreaControls() {
        const samplingMode = getRasterSamplingAreaMode();
        controlsView.setTemporaryAoiAvailability(
            availableTemporaryAoi
        );
        controlsView.setClearSampleWindowLabel(
            "Use whole raster"
        );
        controlsView.setClearSampleWindowEnabled(
            hasSelectedRasterSamplingArea()
        );
        const samplingLabel = samplingMode === "selectedArea"
            ? selectedRasterWindowSizeKm === null
                ? "Map sample"
                : `Map sample · ${selectedRasterWindowSizeKm} km × ` +
                  `${selectedRasterWindowSizeKm} km`
            : samplingMode === "temporaryAoi"
                ? `Uploaded AOI · ${selectedTemporaryAoi.filename} · ` +
                  selectedTemporaryAoi.selectedDataset
                : "Whole raster";
        controlsView.setSamplingAreaMode(samplingMode, samplingLabel);
    }

    /**
     * Return whether one active Catalog raster can receive analysis inputs.
     *
     * Renderer visibility is presentation-only. The basemap remains available
     * for bounds selection and pixel positions with WMS, adaptive detail, or
     * no renderer.
     *
     * @return {boolean} Whether a Catalog raster owns the shared controls.
     */
    function canUseActiveRasterMapInteractions() {
        return activeRasterItem !== null;
    }

    /** Feature-owned adapter consumed by the neutral map-layer controller. */
    const rasterMapLayerAdapter = {
        tileErrorMessage: "Map tiles could not be rendered.",
        label: getCatalogRasterBasename,
        publish: publishRaster,
        createState({ entry, publication, item }) {
            const analysisSession = matchingAnalysisSession(item);
            if (analysisSession !== null) {
                saveActiveLayerSession();
            }
            const session = createLayerSession(entry, publication);
            if (analysisSession !== null) {
                copyRasterInteractionState(session, analysisSession);
            }
            return session;
        },
        createLayer(record, reportTileError) {
            return createRasterLayer(
                record.publication,
                record.state.rasterStyle,
                reportTileError
            );
        },
        snapshot(record) {
            if (activeLayerKey === record.entry.key) {
                saveActiveLayerSession();
            }
            const definition = buildRasterLegend(record.state.rasterStyle);
            return {
                legend: {
                    kind: "gradient",
                    gradient: definition.gradient,
                    description: definition.description,
                    labels: [
                        record.state.rasterStyle.minimum,
                        record.state.rasterStyle.midpoint,
                        record.state.rasterStyle.maximum,
                    ],
                },
            };
        },
        prepare(record) {
            const analysisSession = matchingAnalysisSession(record.entry.item);
            if (analysisSession !== null) {
                saveActiveLayerSession();
                copyRasterInteractionState(record.state, analysisSession);
            }
        },
        deactivate(record) {
            if (activeLayerKey === record.entry.key) {
                deactivateActiveLayer();
                analysisRasterSession = null;
            }
        },
        activate(record) {
            record.state.layerHistogramController?.clear();
            if (record.state.wholeRasterStatisticsState === "loading") {
                record.state.wholeRasterStatisticsState = "idle";
            }
            if (record.state.selectedRasterStatisticsState === "loading") {
                record.state.selectedRasterStatisticsState = "idle";
            }
            activateRasterSession(record.entry, record.state);
        },
        beforeRemove(record, { wasActive }) {
            if (!wasActive) {
                return undefined;
            }
            deactivateActiveLayer();
            analysisRasterSession = detachAnalysisSession(record.state);
            return { activateFallback: false };
        },
        removed(record, { wasActive }) {
            record.state.layerHistogramController?.clear();
            if (wasActive && analysisRasterSession !== null) {
                activateDetachedSession(analysisRasterSession);
            }
        },
        visibilityChanged(record, visible) {
            if (activeLayerKey !== record.entry.key) {
                return;
            }
            saveActiveLayerSession();
            controlsView.setActiveLayer(record.entry.label, visible);
            renderRasterSampleWindowGuidance("");
            saveActiveLayerSession();
        },
        tileError(record) {
            onTileError(record.error, record.entry.item);
        },
    };

    /**
     * Render and publish the current retained-layer state.
     *
     * @param {{key:string,action:string}|null} [requestedFocus=null] Optional
     * focus target after a destructive or ordering transition.
     * @return {void}
     */
    function renderLayerStack(requestedFocus = null) {
        renderLayerHistogramSummaries();
        if (activeDetachedRasterSession() !== null) {
            mapLayers.deactivatePresentation();
            return;
        }
        mapLayers.render(requestedFocus);
    }

    /**
     * Reveal the detailed histogram and notify the composition root that its
     * semantic workspace should be visible.
     *
     * @return {void}
     */
    function showHistogramWorkspace() {
        onHistogramRequested();
        controlsView.showHistogramWidget();
    }

    /**
     * Activate the retained raster selected from an analysis summary.
     *
     * @param {string} key Opaque retained-layer identity.
     * @return {void}
     */
    function handleSelectLayerHistogram(key) {
        mapLayers.activate(key, {
            key,
            action: "analysis-histogram",
        });
        renderLayerHistogramSummaries();
        showHistogramWorkspace();
    }

    /**
     * Stop shared active interactions while preserving completed layer state.
     *
     * @return {void}
     */
    function deactivateActiveLayer() {
        if (activeLayerKey === null) {
            return;
        }
        if (rasterStyleCommitTimeout !== null) {
            commitRasterStyle();
        }
        rasterStatisticsController.clear();
        pixelProbeController.clear();
        rasterSampleWindowController.clear();
        controlsView.hidePixelProbe();
        if (wholeRasterStatisticsState === "loading") {
            wholeRasterStatisticsState = "idle";
        }
        if (selectedRasterStatisticsState === "loading") {
            selectedRasterStatisticsState = "idle";
        }
        saveActiveLayerSession();
        activeLayerKey = null;
        activeRasterItem = null;
        rasterPixelProbeLabel = "";
    }

    /**
     * Present cached active statistics or start missing Catalog analysis.
     *
     * Renderer type and visibility never participate in this decision.
     *
     * @return {void}
     */
    function restoreActiveLayerStatistics() {
        if (hasSelectedRasterSamplingArea()) {
            if (selectedRasterStatisticsState === "ready") {
                renderRasterStatistics(selectedRasterStatistics);
            } else if (selectedRasterStatisticsState === "error") {
                renderSelectedRasterStatisticsError(
                    selectedRasterStatisticsError
                );
            } else {
                selectedRasterStatisticsState = "idle";
                void rasterStatisticsController.activate(
                    activeRasterItem,
                    currentRasterSamplingArea()
                );
            }
        } else if (wholeRasterStatisticsState === "ready") {
            renderRasterStatistics(wholeRasterStatistics);
        } else if (wholeRasterStatisticsState === "error") {
            renderRasterStatisticsError(
                wholeRasterStatisticsError,
                "wholeRaster"
            );
        } else {
            wholeRasterStatisticsState = "idle";
            void rasterStatisticsController.activate(
                activeRasterItem,
                WHOLE_RASTER_SAMPLING_AREA
            );
        }
    }

    /**
     * Restore one retained raster session after neutral activation.
     *
     * @param {Object} entry Neutral retained-layer entry.
     * @param {Object} session Raster-owned interaction session.
     * @return {void}
     */
    function activateRasterSession(entry, session) {
        if (activeLayerKey === entry.key) {
            return;
        }
        loadActiveLayerSession(session);
        controlsView.setControlsVisible(true);
        controlsView.setRenderingControlsAvailable(true);
        controlsView.setActiveLayer(entry.label, entry.visible);
        controlsView.setStyle(rasterStyle, session.paletteName);
        controlsView.renderLegend(rasterStyle);
        resetRasterPercentileControls();

        rasterSampleWindowController.setWindowSize(
            selectedRasterWindowSizeKm ?? DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM
        );
        controlsView.setSampleWindowSize(
            rasterSampleWindowController.windowSizeKm
        );
        controlsView.setSampleWindowInvalid(false);
        renderRasterSamplingAreaControls();
        if (selectedRasterBounds !== null) {
            rasterSampleWindowController.restoreSelection(
                selectedRasterBounds
            );
        }
        if (selectedTemporaryAoi === null) {
            rasterSampleWindowController.enable();
        }
        pixelProbeController.activate(activeRasterItem);
        renderRasterSampleWindowGuidance("");

        restoreActiveLayerStatistics();
        saveActiveLayerSession();
    }

    /**
     * Ask the neutral controller to activate one retained raster.
     *
     * @param {string} key Stable retained-layer key.
     * @param {{key:string,action:string}|null} [requestedFocus=null] Focus hint.
     * @return {void}
     */
    function activateLayer(key, requestedFocus = null) {
        mapLayers.activate(key, requestedFocus);
        renderLayerHistogramSummaries();
    }

    /**
     * Restore one renderer-detached session into shared viewer controls.
     *
     * @param {Object} session Sampled-renderer or analysis-only interaction
     * state.
     * @return {void}
     */
    function activateDetachedSession(session) {
        loadActiveLayerSession(session);
        pixelProbeController.activate(session.item);
        controlsView.setControlsVisible(true);
        controlsView.setRenderingControlsAvailable(
            session === sampledRasterSession
        );
        controlsView.setActiveLayer(session.label, true);
        controlsView.setStyle(rasterStyle, session.paletteName);
        controlsView.renderLegend(rasterStyle);
        resetRasterPercentileControls();
        rasterSampleWindowController.setWindowSize(
            selectedRasterWindowSizeKm ?? DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM
        );
        controlsView.setSampleWindowSize(
            rasterSampleWindowController.windowSizeKm
        );
        controlsView.setSampleWindowInvalid(false);
        if (selectedRasterBounds !== null) {
            rasterSampleWindowController.restoreSelection(
                selectedRasterBounds
            );
        }
        if (selectedTemporaryAoi === null) {
            rasterSampleWindowController.enable();
        }
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        restoreActiveLayerStatistics();
        saveActiveLayerSession();
        renderLayerStack();
    }

    /**
     * Activate renderer-independent analysis for one selected Catalog raster.
     *
     * A retained WMS layer or active adaptive-detail layer remains the parent
     * session when one exists. Otherwise this method presents the same pixel,
     * area-selection, histogram, percentile, and color controls without
     * publishing or constructing a map raster layer.
     *
     * @param {Object} item Selected Catalog raster Item.
     * @return {void}
     */
    function activateAnalysis(item) {
        mapLayers.recordIntent();
        const retainedKey = getCatalogItemKey(item);
        const existingSession = matchingAnalysisSession(item);
        if (existingSession !== null && isActiveAnalysisRaster()) {
            return;
        }
        const retainedSession = mapLayers.getRecord(retainedKey)?.state;
        if (retainedSession !== undefined) {
            const analysisSession = matchingAnalysisSession(item);
            if (analysisSession !== null) {
                saveActiveLayerSession();
                copyRasterInteractionState(retainedSession, analysisSession);
            }
            activateLayer(retainedKey);
            return;
        }
        const sampledKey = `detail:${retainedKey}`;
        if (sampledRasterSession?.key === sampledKey) {
            if (!isActiveSampledRaster()) {
                deactivateActiveLayer();
                analysisRasterSession = null;
                activateDetachedSession(sampledRasterSession);
            }
            return;
        }
        deactivateActiveLayer();
        analysisRasterSession = existingSession ?? createAnalysisSession(item);
        activateDetachedSession(analysisRasterSession);
    }

    /**
     * Remove a matching renderer-independent analysis session.
     *
     * @param {Object|null} item Catalog raster to match, or null to remove any
     * analysis-only selection.
     * @return {void}
     */
    function deactivateAnalysis(item) {
        if (analysisRasterSession === null) {
            return;
        }
        if (item !== null && matchingAnalysisSession(item) === null) {
            return;
        }
        mapLayers.recordIntent();
        const wasActive = isActiveAnalysisRaster();
        if (wasActive) {
            deactivateActiveLayer();
        }
        analysisRasterSession = null;
        if (!wasActive) {
            return;
        }
        if (mapLayers.activeKey !== null) {
            activateLayer(mapLayers.activeKey);
        } else {
            controlsView.setControlsVisible(false);
            controlsView.hidePixelProbe();
            renderLayerStack();
        }
    }

    /**
     * Activate shared appearance and click-histogram controls for one sampled
     * raster that is already visible through the detail-preview controller.
     *
     * The session never publishes WMS. Pixel and statistics controllers receive
     * only the active Catalog Item and their own analysis inputs, exactly as
     * they do for a WMS-rendered raster.
     *
     * @param {Object} item Selected overview-limited Catalog raster.
     * @param {Object} style Initial min/median/max shared raster color style.
     * @param {(style:Object) => void} onStyleChange Browser-image recoloring
     * callback owned by the detail-preview controller.
     * @return {void}
     * @throws {TypeError} If the recoloring callback is absent.
     * @throws {Error} If the initial shared raster style is invalid.
     */
    function activateSampled(item, style, onStyleChange) {
        if (typeof onStyleChange !== "function") {
            throw new TypeError("Sampled raster recoloring callback is required");
        }
        buildRasterStyleEnvironment(style);
        mapLayers.recordIntent();
        const analysisSession = matchingAnalysisSession(item);
        deactivateActiveLayer();
        const key = `detail:${getCatalogItemKey(item)}`;
        const initialStyle = Object.freeze({ ...style });
        sampledRasterSession = {
            key,
            item,
            label: `${getCatalogRasterBasename(item)} (sampled raster)`,
            rasterStyle: { ...initialStyle },
            initialStyle,
            onStyleChange,
            paletteName: "blue-yellow-red",
            rasterStyleWasEdited: false,
            rasterStatistics: null,
            rasterStatisticsIsApplicable: false,
            wholeRasterStatistics: null,
            wholeRasterStatisticsState: "idle",
            wholeRasterStatisticsError: null,
            selectedRasterBounds: null,
            selectedTemporaryAoi: availableTemporaryAoi,
            selectedRasterWindowSizeKm: null,
            selectedRasterStatistics: null,
            selectedRasterStatisticsState: "idle",
            selectedRasterStatisticsError: null,
        };
        if (analysisSession !== null) {
            copyRasterInteractionState(
                sampledRasterSession,
                analysisSession,
                false
            );
        }
        analysisRasterSession = null;
        activateDetachedSession(sampledRasterSession);
    }

    /**
     * Adopt a newly established first-finite sampled range when still automatic.
     *
     * An all-nodata base grid initially uses the application fallback. The
     * detail-preview controller can later establish a finite current-view
     * minimum/median/maximum; this method synchronizes the controls without
     * overriding any user style edit.
     *
     * @param {Object} item Catalog Item that may own the sampled session.
     * @param {Object} style Newly established shared sampled-raster style.
     * @return {void}
     * @throws {Error} If a matching session receives an invalid style.
     */
    function updateSampledInitialStyle(item, style) {
        const expectedKey = `detail:${getCatalogItemKey(item)}`;
        if (
            sampledRasterSession?.key !== expectedKey ||
            (
                isActiveSampledRaster()
                    ? rasterStyleWasEdited
                    : sampledRasterSession.rasterStyleWasEdited
            )
        ) {
            return;
        }
        buildRasterStyleEnvironment(style);
        const establishedStyle = Object.freeze({ ...style });
        sampledRasterSession.initialStyle = establishedStyle;
        sampledRasterSession.rasterStyle = { ...establishedStyle };
        if (!isActiveSampledRaster()) {
            return;
        }
        rasterStyle = { ...establishedStyle };
        controlsView.setStyle(
            rasterStyle,
            sampledRasterSession.paletteName
        );
        if (rasterStatistics !== null) {
            controlsView.renderHistogram(rasterStatistics, rasterStyle);
        }
        saveActiveLayerSession();
    }

    /**
     * Remove the shared-control session for a matching sampled raster.
     *
     * @param {Object} item Catalog Item that may own the sampled session.
     * @return {void}
     */
    function removeSampled(item) {
        const expectedKey = `detail:${getCatalogItemKey(item)}`;
        if (sampledRasterSession?.key !== expectedKey) {
            return;
        }
        mapLayers.recordIntent();
        const wasActive = isActiveSampledRaster();
        if (wasActive) {
            deactivateActiveLayer();
        }
        const detachedSession = wasActive
            ? detachAnalysisSession(sampledRasterSession)
            : null;
        sampledRasterSession = null;
        if (detachedSession !== null) {
            analysisRasterSession = detachedSession;
            activateDetachedSession(analysisRasterSession);
            return;
        }
        const nextActiveKey = mapLayers.activeKey;
        if (nextActiveKey === null) {
            controlsView.setControlsVisible(false);
            controlsView.hidePixelProbe();
            renderLayerStack();
            return;
        }
        activateLayer(nextActiveKey);
    }

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
     * Commit one valid control state to the current WMS or sampled layer.
     *
     * @return {void}
     */
    function commitRasterStyle() {
        if (rasterStyleCommitTimeout !== null) {
            clock.clearTimeout(rasterStyleCommitTimeout);
            rasterStyleCommitTimeout = null;
        }
        const candidate = validateRasterStyleControls();
        if (candidate === null) {
            return;
        }
        if (isActiveSampledRaster()) {
            try {
                sampledRasterSession.onStyleChange(candidate.style);
            } catch (error) {
                controlsView.renderStyleError(error);
                return;
            }
            rasterStyle = candidate.style;
            controlsView.renderLegend(rasterStyle);
            if (rasterStatistics !== null) {
                controlsView.renderHistogram(rasterStatistics, rasterStyle);
            }
            saveActiveLayerSession();
            return;
        }
        if (isActiveAnalysisRaster()) {
            rasterStyle = candidate.style;
            controlsView.renderLegend(rasterStyle);
            if (rasterStatistics !== null) {
                controlsView.renderHistogram(rasterStatistics, rasterStyle);
            }
            saveActiveLayerSession();
            return;
        }
        const activeLayer = mapLayers.getLeafletLayer(activeLayerKey);
        if (activeLayer === null) {
            return;
        }
        rasterStyle = candidate.style;
        controlsView.renderLegend(rasterStyle);
        if (rasterStatistics !== null) {
            controlsView.renderHistogram(rasterStatistics, rasterStyle);
        }
        activeLayer.setParams({
            styles: "dynamic-raster",
            env: candidate.environment,
        });
        saveActiveLayerSession();
        renderLayerStack();
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
        rasterStyle = isActiveSampledRaster()
            ? { ...sampledRasterSession.initialStyle }
            : (
                wholeRasterStatistics === null
                    ? { ...DEFAULT_RASTER_STYLE }
                    : deriveRasterStyleFromStatistics(
                        DEFAULT_RASTER_STYLE,
                        wholeRasterStatistics
                    )
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
        saveActiveLayerSession();
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
                ? "Calculating a bounded histogram for the selected area..."
                : "Calculating a bounded whole-raster histogram..."
        );
        saveActiveLayerSession();
    }

    /**
     * Apply the initial whole-raster range unless a manual edit superseded it.
     *
     * @param {Object} statistics Validated whole-raster statistics.
     * @return {boolean} Whether the bounded initial range was applied.
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
     * Present one current whole-raster, map-window, or AOI histogram.
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
            rasterStatisticsMatchesSelection(
                statistics,
                currentRasterSamplingArea()
            );
        controlsView.setStatisticsBusy(false);
        controlsView.setStatisticsRetryVisible(false);
        controlsView.renderHistogram(statistics, rasterStyle);
        const approximationMarker = statistics.estimated ? "≈ " : "";
        controlsView.showHistogramAxis(
            `${approximationMarker}${formatRasterPixelValue(
                statistics.sampleMinimum
            )}`,
            `${approximationMarker}${formatRasterPixelValue(
                statistics.sampleMaximum
            )}`
        );
        controlsView.setPercentileControlsVisible(true);
        resetRasterPercentileControls();
        updateRasterPercentileValues();

        const excludedCount =
            statistics.sampledPixelCount - statistics.validSampleCount;
        const usesSampleGrid = statistics.samplingMethod === "sampleGrid";
        const sourceDescription = statistics.scope === "wholeRaster"
            ? "source raster"
            : "source-cell window";
        const approximation = statistics.estimated ? "approximate" : "exact";
        const scopeDescription = statistics.scope === "temporaryAoi"
            ? `Uploaded AOI ${selectedTemporaryAoi?.filename ?? "area"}, ` +
              `layer ${selectedTemporaryAoi?.selectedDataset ?? "selected"}, ` +
              `${approximation} bounded histogram`
            : statistics.scope === "selectedArea"
                ? `Selected-area ${approximation} bounded histogram`
                : `Whole-raster ${approximation} bounded histogram`;
        const provenance = usesSampleGrid
            ? `${statistics.validSampleCount.toLocaleString()} finite values ` +
              `from a ${statistics.sampleWidth.toLocaleString()} × ` +
              `${statistics.sampleHeight.toLocaleString()} bounded center ` +
              `grid over the ${statistics.sourceWidth.toLocaleString()} × ` +
              `${statistics.sourceHeight.toLocaleString()} ${sourceDescription}`
            : `${statistics.validSampleCount.toLocaleString()} valid pixels ` +
              `from the exact ${statistics.sampleWidth.toLocaleString()} × ` +
              `${statistics.sampleHeight.toLocaleString()} bounded ` +
              sourceDescription;
        const excluded = excludedCount === 0
            ? ""
            : `; ${excludedCount.toLocaleString()} masked, nodata, or ` +
              "nonfinite sample pixels excluded";

        controlsView.setStatisticsStatus(
            initialRangeApplied
                ? `${scopeDescription}: ${provenance}${excluded}. ` +
                  "The 5th, 50th, and 95th percentile range was " +
                  "applied."
                : `${scopeDescription}: ${provenance}${excluded}. ` +
                  "Your current appearance was preserved."
        );
        saveActiveLayerSession();
    }

    /**
     * Keep manual rendering usable after one statistics failure.
     *
     * @param {Error} error Statistics request failure.
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
        controlsView.setStatisticsRetryVisible(
            canRetryRasterStatistics(error)
        );
        controlsView.setStatisticsStatus(
            `${scope === "selectedArea" ? "Selected-area" : "Whole-raster"} ` +
            `histogram unavailable: ${error.message} ` +
            "Manual appearance controls remain available."
        );
        saveActiveLayerSession();
    }

    /**
     * Record and present the start of a whole-raster statistics request.
     *
     * @return {void}
     */
    function renderWholeRasterStatisticsLoading() {
        wholeRasterStatisticsState = "loading";
        wholeRasterStatisticsError = null;
        if (!hasSelectedRasterSamplingArea()) {
            renderRasterStatisticsLoading("wholeRaster");
        }
        saveActiveLayerSession();
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
        const initialRangeApplied = hasSelectedRasterSamplingArea()
            ? false
            : applyInitialWholeRasterStyle(statistics);
        if (!hasSelectedRasterSamplingArea()) {
            renderRasterStatistics(statistics, initialRangeApplied);
        }
        saveActiveLayerSession();
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
        if (!hasSelectedRasterSamplingArea()) {
            renderRasterStatisticsError(error, "wholeRaster");
        }
        saveActiveLayerSession();
    }

    /**
     * Present the start of a bounded map-window or AOI statistics request.
     *
     * @return {void}
     */
    function renderSelectedRasterStatisticsLoading() {
        selectedRasterStatisticsState = "loading";
        selectedRasterStatisticsError = null;
        rasterStatisticsIsApplicable = false;
        controlsView.setStatisticsBusy(true);
        controlsView.setStatisticsRetryVisible(false);
        controlsView.setApplyPercentilesEnabled(false);
        controlsView.setStatisticsStatus(
            rasterStatistics === null
                ? selectedRasterStatisticsLoadingMessage()
                : selectedRasterStatisticsLoadingMessage() + " " +
                  "The previous histogram remains visible for reference and " +
                  "cannot be applied to this selection."
        );
        saveActiveLayerSession();
    }

    /**
     * Describe the active bounded statistics request without map-move chatter.
     *
     * @return {string} Accessible loading announcement for bounds or AOI.
     */
    function selectedRasterStatisticsLoadingMessage() {
        if (selectedTemporaryAoi === null) {
            return "Calculating a bounded histogram for the selected area...";
        }
        return (
            `Calculating a bounded histogram for uploaded AOI ` +
            `${selectedTemporaryAoi.filename}, layer ` +
            `${selectedTemporaryAoi.selectedDataset}...`
        );
    }

    /**
     * Present one successful bounded map-window or AOI response.
     *
     * @param {Object} statistics Validated map-window or AOI statistics.
     * @return {void}
     */
    function renderSelectedRasterStatistics(statistics) {
        selectedRasterStatistics = statistics;
        selectedRasterStatisticsState = "ready";
        selectedRasterStatisticsError = null;
        renderRasterStatistics(statistics);
    }

    /**
     * Present a map-window or AOI failure while retaining prior context.
     *
     * @param {Error} error Statistics request failure.
     * @return {void}
     */
    function renderSelectedRasterStatisticsError(error) {
        selectedRasterStatisticsState = "error";
        selectedRasterStatisticsError = error;
        rasterStatisticsIsApplicable = false;
        if (rasterStatistics === null && wholeRasterStatisticsState === "ready") {
            renderRasterStatistics(wholeRasterStatistics, false, false);
        }
        controlsView.setStatisticsBusy(false);
        controlsView.setStatisticsRetryVisible(
            canRetryRasterStatistics(error)
        );
        controlsView.setApplyPercentilesEnabled(false);
        const areaName = selectedTemporaryAoi === null
            ? "Selected-area"
            : `Uploaded AOI ${selectedTemporaryAoi.filename}, layer ` +
              selectedTemporaryAoi.selectedDataset;
        controlsView.setStatisticsStatus(
            rasterStatistics === null
                ? `${areaName} histogram unavailable: ${error.message} ` +
                  "Manual appearance controls remain available."
                : `${areaName} histogram unavailable: ${error.message} ` +
                  "The previous histogram remains visible for reference but " +
                  "cannot be applied to this selection. Your appearance was " +
                  "preserved."
        );
        saveActiveLayerSession();
    }

    /**
     * Restore whole-raster statistics after clearing a map window or AOI.
     *
     * @return {void}
     */
    function restoreWholeRasterStatistics() {
        rasterStatisticsController.clear();
        resetPendingRasterStatisticsState();
        selectedRasterBounds = null;
        selectedTemporaryAoi = null;
        selectedRasterWindowSizeKm = null;
        selectedRasterStatistics = null;
        selectedRasterStatisticsState = "idle";
        selectedRasterStatisticsError = null;
        rasterSampleWindowController.clearSelection();
        if (canUseActiveRasterMapInteractions()) {
            rasterSampleWindowController.enable();
        }
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        if (wholeRasterStatisticsState === "ready") {
            renderRasterStatistics(wholeRasterStatistics);
        } else if (wholeRasterStatisticsState === "error") {
            renderRasterStatisticsError(
                wholeRasterStatisticsError,
                "wholeRaster"
            );
        } else {
            clearRasterStatisticsPresentation();
            if (canUseActiveRasterMapInteractions()) {
                void rasterStatisticsController.activate(
                    activeRasterItem,
                    WHOLE_RASTER_SAMPLING_AREA
                );
            }
        }
        saveActiveLayerSession();
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
        } else if (selectedTemporaryAoi !== null) {
            nextStatus =
                `Uploaded AOI selected: ${selectedTemporaryAoi.filename}, ` +
                `layer ${selectedTemporaryAoi.selectedDataset}. Map overlay ` +
                "visibility does not change this histogram selection.";
        } else {
            nextStatus = "Whole-raster histogram selected. Move over the " +
                "map and click to display this window's histogram.";
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
        if (!canUseActiveRasterMapInteractions()) {
            return;
        }
        selectedRasterBounds = bounds;
        selectedTemporaryAoi = null;
        selectedRasterWindowSizeKm = rasterSampleWindowController.windowSizeKm;
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        showHistogramWorkspace();
        refreshRetainedLayerHistograms(currentRasterSamplingArea());
        void rasterStatisticsController.activate(
            activeRasterItem,
            currentRasterSamplingArea()
        );
        saveActiveLayerSession();
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
        saveActiveLayerSession();
        return true;
    }

    /**
     * Restore sample controls and map interaction for a changed Item.
     *
     * @return {void}
     */
    function resetRasterSampleWindow() {
        rasterSampleWindowController.clear();
        rasterStatisticsController.clear();
        resetPendingRasterStatisticsState();
        selectedRasterBounds = null;
        selectedTemporaryAoi = null;
        selectedRasterWindowSizeKm = null;
        selectedRasterStatistics = null;
        selectedRasterStatisticsState = "idle";
        selectedRasterStatisticsError = null;
        setRasterSampleWindowSize(DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM);
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
    }

    /**
     * Select the retained ready AOI and disable pointer-window previews.
     *
     * @return {void}
     */
    function useTemporaryAoiForRasterStatistics() {
        if (
            availableTemporaryAoi === null ||
            activeRasterItem === null
        ) {
            return;
        }
        rasterStatisticsController.clear();
        resetPendingRasterStatisticsState();
        selectedRasterBounds = null;
        selectedTemporaryAoi = availableTemporaryAoi;
        selectedRasterWindowSizeKm = null;
        selectedRasterStatistics = null;
        selectedRasterStatisticsState = "idle";
        selectedRasterStatisticsError = null;
        rasterSampleWindowController.clear();
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        showHistogramWorkspace();
        refreshRetainedLayerHistograms(currentRasterSamplingArea());
        if (canUseActiveRasterMapInteractions()) {
            void rasterStatisticsController.activate(
                activeRasterItem,
                currentRasterSamplingArea()
            );
        }
        saveActiveLayerSession();
    }

    /**
     * Leave AOI sampling and enable mouse, touch, and keyboard window choice.
     *
     * The whole-raster distribution is the stable interim scope until the user
     * commits a new map window.
     *
     * @return {void}
     */
    function enableRasterSampleWindowSelection() {
        restoreWholeRasterStatistics();
        if (!canUseActiveRasterMapInteractions()) {
            return;
        }
        rasterSampleWindowController.enable();
        controlsView.setSampleWindowStatus(
            "Map-window selection enabled. Move over the map and click, tap " +
            "Sample map center, or use the keyboard action to choose a window."
        );
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
     * Reset the active style to its bounded whole-raster reference range.
     *
     * @return {void}
     */
    function handleResetStyle() {
        rasterStyleWasEdited = true;
        resetRasterStyle();
        commitRasterStyle();
        if (isActiveSampledRaster()) {
            const provenance = rasterStatistics === null
                ? ""
                : ` The current histogram remains the ${
                    rasterStatistics.samplingMethod === "sampleGrid"
                        ? "approximate sampled-grid"
                        : "exact bounded"
                } histogram.`;
            controlsView.setStatisticsStatus(
                "Reset appearance to the initial minimum, median, and " +
                `maximum for the low-resolution rendering.${provenance}`
            );
        } else if (wholeRasterStatistics !== null) {
            resetRasterPercentileControls();
            updateRasterPercentileValues();
            const scopeNote = !hasSelectedRasterSamplingArea()
                ? ""
                : rasterStatisticsIsApplicable
                    ? " The selected-area histogram remains available."
                    : " The previous histogram remains reference-only " +
                      "and cannot be applied to the current selected area.";
            const provenance = wholeRasterStatistics.estimated
                ? "sampled-grid"
                : "exact bounded";
            controlsView.setStatisticsStatus(
                "Reset appearance to the histogram-estimated whole-raster " +
                `5th, 50th, and 95th percentile range from the ${provenance} ` +
                `histogram.${scopeNote}`
            );
        }
    }

    /**
     * Apply the current ordered histogram-estimated percentile range.
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
            `Rescaled the colors to the selected ${
                rasterStatistics.estimated ? "approximate" : "exact"
            } percentile range.`
        );
    }

    /**
     * Retry statistics for the current selected or whole-raster scope.
     *
     * @return {void}
     */
    function handleRetryStatistics() {
        showHistogramWorkspace();
        refreshRetainedLayerHistograms(currentRasterSamplingArea());
        if (hasSelectedRasterSamplingArea()) {
            selectedRasterStatisticsState = "idle";
            void rasterStatisticsController.activate(
                activeRasterItem,
                currentRasterSamplingArea()
            );
        } else {
            wholeRasterStatisticsState = "idle";
            void rasterStatisticsController.activate(
                activeRasterItem,
                WHOLE_RASTER_SAMPLING_AREA
            );
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
     * Restore whole-raster statistics from an explicit control action and
     * reveal the contextual histogram that receives the restored result.
     *
     * @return {void}
     */
    function handleClearSampleWindow() {
        restoreWholeRasterStatistics();
        refreshRetainedLayerHistograms(WHOLE_RASTER_SAMPLING_AREA);
        showHistogramWorkspace();
    }

    /**
     * Track the pointer synchronously for smooth probe movement.
     *
     * @param {PointerEvent} pointerEvent Browser pointer movement event.
     * @return {void}
     */
    function handleMapPointerMove(pointerEvent) {
        if (canUseActiveRasterMapInteractions()) {
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
     * @param {Object} mapEvent Leaflet mousemove event in the single map world.
     * @return {void}
     */
    function handleMapMouseMove(mapEvent) {
        if (!canUseActiveRasterMapInteractions()) {
            return;
        }
        const point = {
            longitude: mapEvent.latlng.lng,
            latitude: mapEvent.latlng.lat,
        };
        if (!isCanonicalWgs84Position(point)) {
            pixelProbeController.cancel();
            pixelProbeClientPosition = null;
            controlsView.hidePixelProbe();
            return;
        }
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
     * Remove one Catalog Item from the retained layer stack.
     *
     * @param {Object} item Catalog STAC Item.
     * @return {void}
     */
    function remove(item) {
        mapLayers.remove(item);
        renderLayerHistogramSummaries();
    }

    /**
     * Remove every retained raster and interaction.
     *
     * @return {void}
     */
    function clear() {
        if (rasterStyleCommitTimeout !== null) {
            clock.clearTimeout(rasterStyleCommitTimeout);
            rasterStyleCommitTimeout = null;
        }
        deactivateActiveLayer();
        mapLayers.deactivatePresentation();
        sampledRasterSession = null;
        analysisRasterSession = null;
        mapLayers.removeOwned(rasterMapLayerAdapter);
        pixelProbeController.clear();
        rasterStatisticsController.clear();
        rasterSampleWindowController.clear();
        activeRasterItem = null;
        activeLayerKey = null;
        rasterStyle = { ...DEFAULT_RASTER_STYLE };
        rasterStyleWasEdited = false;
        rasterStatistics = null;
        rasterStatisticsIsApplicable = false;
        wholeRasterStatistics = null;
        wholeRasterStatisticsState = "idle";
        wholeRasterStatisticsError = null;
        selectedRasterBounds = null;
        selectedTemporaryAoi = null;
        selectedRasterWindowSizeKm = null;
        selectedRasterStatistics = null;
        selectedRasterStatisticsState = "idle";
        selectedRasterStatisticsError = null;
        pixelProbeClientPosition = null;
        rasterPixelProbeLabel = "";
        controlsView.setControlsVisible(false);
        controlsView.renderLayerHistograms([], null);
        controlsView.hidePixelProbe();
    }

    /**
     * Remove the active raster and restore its default appearance.
     *
     * @return {void}
     */
    function reset() {
        clear();
        resetRasterStyle();
    }

    /**
     * Publish and retain one selected Catalog raster.
     *
     * @param {Object} item Selected mounted GeoTIFF STAC Item.
     * @return {Promise<Object|null>} Published raster or null after invalidation.
     * @throws {Error} If publication or Leaflet layer construction fails.
     */
    async function show(item) {
        const publication = await mapLayers.show(item, rasterMapLayerAdapter);
        renderLayerHistogramSummaries();
        return publication;
    }

    /**
     * Validate one lifecycle snapshot received from the temporary-AOI boundary.
     *
     * @param {Readonly<Object>|null} temporaryAoi Candidate public snapshot.
     * @return {Readonly<Object>|null} Validated immutable snapshot or null.
     * @throws {TypeError} If identity, display, or expiration fields are invalid.
     */
    function validateTemporaryAoiSamplingSnapshot(temporaryAoi) {
        if (temporaryAoi === null) {
            return null;
        }
        if (
            typeof temporaryAoi !== "object" ||
            typeof temporaryAoi.id !== "string" ||
            !/^[A-Za-z0-9_-]{32}$/.test(temporaryAoi.id) ||
            typeof temporaryAoi.filename !== "string" ||
            temporaryAoi.filename.trim() === "" ||
            typeof temporaryAoi.selectedDataset !== "string" ||
            temporaryAoi.selectedDataset.trim() === "" ||
            typeof temporaryAoi.expiresAt !== "string" ||
            !Number.isFinite(Date.parse(temporaryAoi.expiresAt))
        ) {
            throw new TypeError("Temporary AOI sampling snapshot is invalid.");
        }
        return Object.freeze({
            id: temporaryAoi.id,
            filename: temporaryAoi.filename,
            selectedDataset: temporaryAoi.selectedDataset,
            expiresAt: temporaryAoi.expiresAt,
        });
    }

    /**
     * Invalidate a session's selected-area result for an AOI lifecycle change.
     *
     * @param {Object} session Retained raster-layer interaction session.
     * @param {Readonly<Object>|null} nextTemporaryAoi Replacement lifecycle or
     * null when removal or expiration restores whole-raster sampling.
     * @return {void}
     */
    function replaceSessionTemporaryAoi(session, nextTemporaryAoi) {
        session.selectedRasterBounds = null;
        session.selectedTemporaryAoi = nextTemporaryAoi;
        session.selectedRasterWindowSizeKm = null;
        session.selectedRasterStatistics = null;
        session.selectedRasterStatisticsState = "idle";
        session.selectedRasterStatisticsError = null;
        session.rasterStatisticsIsApplicable = false;
    }

    /**
     * Receive one sampleable-AOI change through the public integration.
     *
     * First readiness automatically selects the AOI for retained rasters.
     * Replacement migrates only sessions actively using the previous AOI;
     * removal and expiration restore those sessions to mouse-hover map-window
     * sampling. Overlay visibility remains presentation-only.
     * Overlay geometry never crosses this boundary.
     *
     * @param {Readonly<Object>|null} temporaryAoi Ready lifecycle snapshot or
     * null after removal or expiration.
     * @return {void}
     * @throws {TypeError} If the public snapshot violates its contract.
     */
    function setTemporaryAoi(temporaryAoi) {
        const validatedAoi = validateTemporaryAoiSamplingSnapshot(temporaryAoi);
        const previousAoi = availableTemporaryAoi;
        if (previousAoi?.id === validatedAoi?.id) {
            return;
        }
        saveActiveLayerSession();
        availableTemporaryAoi = validatedAoi;
        const sessions = mapLayers.retainedRecords.map(
            (record) => record.state
        );
        if (sampledRasterSession !== null) {
            sessions.push(sampledRasterSession);
        }
        if (analysisRasterSession !== null) {
            sessions.push(analysisRasterSession);
        }
        for (const session of sessions) {
            const automaticallyEligible = previousAoi === null && validatedAoi !== null;
            const usesPreviousAoi =
                previousAoi !== null &&
                session.selectedTemporaryAoi?.id === previousAoi.id;
            if (automaticallyEligible || usesPreviousAoi) {
                replaceSessionTemporaryAoi(session, validatedAoi);
            }
        }
        controlsView.setTemporaryAoiAvailability(availableTemporaryAoi);
        if (activeLayerKey === null) {
            return;
        }
        const activeSession = activeDetachedRasterSession() ??
            requireLayerSession(activeLayerKey);
        loadActiveLayerSession(activeSession);
        rasterStatisticsController.clear();
        resetPendingRasterStatisticsState();
        if (selectedTemporaryAoi !== null) {
            rasterSampleWindowController.clear();
        } else if (canUseActiveRasterMapInteractions()) {
            rasterSampleWindowController.enable();
        }
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        restoreActiveLayerStatistics();
        saveActiveLayerSession();
    }

    /**
     * Return whether one Catalog Item is retained in the layer stack.
     *
     * @param {Object} item Catalog STAC Item.
     * @return {boolean} Whether the Item is retained.
     */
    function contains(item) {
        return mapLayers.contains(item);
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
        if (ownsMapLayerController) {
            mapLayers.destroy();
        }
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
        onSelectHistogram: handleSelectLayerHistogram,
        onSampleWindowRangeInput: setRasterSampleWindowSize,
        onSampleWindowNumberInput: setRasterSampleWindowSize,
        onSampleWindowNumberChange: handleSampleWindowNumberChange,
        onSampleMapCenter: () => {
            if (canUseActiveRasterMapInteractions()) {
                if (selectedTemporaryAoi !== null) {
                    restoreWholeRasterStatistics();
                }
                rasterSampleWindowController.sampleMapCenter();
            }
        },
        onSelectSampleWindow: enableRasterSampleWindowSelection,
        onClearSampleWindow: handleClearSampleWindow,
        onUseTemporaryAoi: useTemporaryAoiForRasterStatistics,
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
        activateAnalysis,
        deactivateAnalysis,
        activateSampled,
        updateSampledInitialStyle,
        removeSampled,
        contains,
        remove,
        setTemporaryAoi,
        destroy,
        /**
         * Return whether at least one raster layer is currently displayed.
         *
         * @return {boolean} Whether any raster layer is displayed.
         */
        get isDisplayed() {
            return mapLayers.visibleCountFor(rasterMapLayerAdapter) > 0 ||
                sampledRasterSession !== null;
        },
    };
}
