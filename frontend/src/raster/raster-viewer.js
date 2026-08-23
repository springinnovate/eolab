/**
 * Application coordinator for one interactive Catalog raster viewer.
 *
 * This module connects publication, Leaflet layers, raster controls,
 * statistics, selected-area sampling, styling, and the pixel probe. It owns
 * their shared lifecycle and stale-work rules while delegating domain logic,
 * HTTP access, DOM presentation, and Leaflet construction to focused modules.
 */
import {
    loadCatalogRasterDetailStatistics,
    loadCatalogRasterStatistics,
    publishCatalogRaster,
    sampleCatalogRasterPixel,
} from "./api.js";
import {
    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
    isCanonicalWgs84Position,
} from "./geometry.js";
import {
    createRasterSampleWindowLayer,
    createRasterWmsLayer,
    RasterLeafletLayerSet,
} from "./leaflet.js";
import {
    getCatalogRasterLayerKey,
    RasterLayerStack,
    RasterLayerVisibilityLimitError,
} from "./layer-stack.js";
import { RasterLayerStackView } from "./layer-stack-view.js";
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
 * @property {() => void} clear Remove all retained raster interactions.
 * @property {() => void} reset Clear the raster and restore default styling.
 * @property {(item: Object) => Promise<Object|null>} show Publish and retain
 * one selected raster Item.
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
 */

/**
 * @typedef {Object} RasterViewerDependencies
 * @property {RasterControlsView} [controlsView=new RasterControlsView()]
 * Raster-control DOM adapter.
 * @property {RasterLayerStackView} [layerStackView=new RasterLayerStackView()]
 * Layer-list DOM adapter.
 * @property {(item: Object) => Promise<Object>}
 * [publishRaster=publishCatalogRaster] Publishes one Catalog raster.
 * @property {(item: Object, signal: AbortSignal, selectedBounds: Object|null,
 * temporaryAoiId: string|null)
 * => Promise<Object>} [loadStatistics=loadCatalogRasterStatistics] Loads whole
 * or selected statistics.
 * @property {(item:Object,signal:AbortSignal,selectedBounds:Object)
 * => Promise<Object>}
 * [loadDetailStatistics=loadCatalogRasterDetailStatistics] Loads one exact
 * bounded sampled-grid histogram.
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
 * The returned feature boundary owns retained raster layers, their isolated
 * presentation state, and the shared controls for the explicitly active layer.
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
    },
    {
        controlsView = new RasterControlsView(),
        layerStackView = new RasterLayerStackView(),
        publishRaster = publishCatalogRaster,
        loadStatistics = loadCatalogRasterStatistics,
        loadDetailStatistics = loadCatalogRasterDetailStatistics,
        samplePixel = sampleCatalogRasterPixel,
        clock = globalThis,
        viewport = globalThis,
    } = {}
) {
    const layerStack = new RasterLayerStack();
    const leafletLayers = new RasterLeafletLayerSet(leafletMap);
    const layerSessions = new Map();
    const publicationGenerations = new Map();
    const pendingPublications = new Map();
    let sampledRasterSession = null;
    let destroyed = false;
    let activationIntentSequence = 0;
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
            error: null,
        };
    }

    /**
     * Require the retained session paired with one stack entry.
     *
     * @param {string} key Stable retained layer key.
     * @return {Object} Matching per-layer interaction state.
     * @throws {Error} If stack and session state have diverged.
     */
    function requireLayerSession(key) {
        const session = layerSessions.get(key);
        if (session === undefined) {
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
        const session = isActiveSampledRaster()
            ? sampledRasterSession
            : requireLayerSession(activeLayerKey);
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
     * @param {string} layerKey Stable retained layer key.
     * @param {{bbox: number[], layerName: string}} publishedRaster Published
     * GeoServer layer details.
     * @param {Object} style Retained style for this layer.
     * @return {Object} Leaflet-compatible WMS layer.
     */
    function createRasterLayer(layerKey, publishedRaster, style) {
        const rasterLayer = createRasterWmsLayer(
            leaflet,
            wmsUrl,
            publishedRaster,
            buildRasterStyleEnvironment(style),
            () => {
                if (leafletLayers.get(layerKey) !== rasterLayer) {
                    return;
                }
                const session = requireLayerSession(layerKey);
                session.error = "Map tiles could not be rendered.";
                renderLayerStack();
                onTileError(session.error, session.item);
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
        async (item, signal, bounds, temporaryAoiId) => {
            if (!isActiveSampledRaster()) {
                return loadStatistics(
                    item,
                    signal,
                    bounds,
                    temporaryAoiId
                );
            }
            if (bounds === null || temporaryAoiId !== null) {
                throw new Error(
                    "Sampled raster histograms require a selected map window."
                );
            }
            return loadDetailStatistics(item, signal, bounds);
        },
        renderSelectedRasterStatisticsLoading,
        renderSelectedRasterStatistics,
        renderSelectedRasterStatisticsError
    );

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
     * @return {"none"|"wholeRaster"|"selectedArea"|"temporaryAoi"} Active
     * mode.
     */
    function getRasterSamplingAreaMode() {
        if (selectedTemporaryAoi !== null) {
            return "temporaryAoi";
        }
        if (isActiveSampledRaster() && selectedRasterBounds === null) {
            return "none";
        }
        return selectedRasterBounds === null ? "wholeRaster" : "selectedArea";
    }

    /**
     * Synchronize explicit histogram-area choices with lifecycle state.
     *
     * @return {void}
     */
    function renderRasterSamplingAreaControls() {
        controlsView.setTemporaryAoiAvailability(
            isActiveSampledRaster() ? null : availableTemporaryAoi
        );
        controlsView.setClearSampleWindowLabel(
            isActiveSampledRaster()
                ? "Clear selected histogram"
                : "Use whole raster"
        );
        controlsView.setClearSampleWindowEnabled(
            hasSelectedRasterSamplingArea()
        );
        controlsView.setSamplingAreaMode(getRasterSamplingAreaMode());
    }

    /**
     * Return whether the active retained layer is attached to the map.
     *
     * @return {boolean} Whether active map interactions are meaningful.
     */
    function isActiveLayerVisible() {
        if (isActiveSampledRaster()) {
            return true;
        }
        return activeLayerKey !== null &&
            layerStack.get(activeLayerKey)?.visible === true;
    }

    /**
     * Build presentation-only snapshots for the layer-list adapter.
     *
     * @return {Object[]} Retained layers in top-first order.
     */
    function getLayerSnapshots() {
        saveActiveLayerSession();
        return layerStack.entries.map((entry) => {
            const session = requireLayerSession(entry.key);
            return {
                ...entry,
                style: { ...session.rasterStyle },
                error: session.error,
            };
        });
    }

    /**
     * Render and publish the current retained-layer state.
     *
     * @param {{key:string,action:string}|null} [requestedFocus=null] Optional
     * focus target after a destructive or ordering transition.
     * @return {void}
     */
    function renderLayerStack(requestedFocus = null) {
        const snapshots = getLayerSnapshots();
        layerStackView.render(
            snapshots,
            isActiveSampledRaster() ? null : layerStack.activeKey,
            requestedFocus
        );
        onLayersChange(snapshots);
    }

    /** Apply top-first stack order to all retained Leaflet layers. */
    function applyLeafletLayerOrder() {
        leafletLayers.setOrder(layerStack.entries.map((entry) => entry.key));
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
        wholeRasterStatisticsController.clear();
        selectedRasterStatisticsController.clear();
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
     * Present cached active statistics and start only visible missing work.
     *
     * Hidden retained layers never begin source reads merely because they are
     * active. Completed distributions remain available for reference.
     *
     * @return {void}
     */
    function restoreActiveLayerStatistics() {
        const visible = isActiveLayerVisible();
        if (
            !isActiveSampledRaster() &&
            wholeRasterStatisticsState === "idle" &&
            visible
        ) {
            wholeRasterStatisticsState = "idle";
            void wholeRasterStatisticsController.activate(activeRasterItem);
        }

        if (hasSelectedRasterSamplingArea()) {
            if (selectedRasterStatisticsState === "ready") {
                renderRasterStatistics(selectedRasterStatistics);
            } else if (selectedRasterStatisticsState === "error") {
                renderSelectedRasterStatisticsError(
                    selectedRasterStatisticsError
                );
            } else if (visible) {
                selectedRasterStatisticsState = "idle";
                void selectedRasterStatisticsController.activate(
                    activeRasterItem,
                    undefined,
                    selectedRasterBounds,
                    selectedTemporaryAoi?.id ?? null
                );
            } else {
                clearRasterStatisticsPresentation();
                controlsView.setStatisticsStatus(
                    "The active raster is hidden. Show it to calculate its " +
                    "selected-area distribution."
                );
            }
        } else if (isActiveSampledRaster()) {
            clearRasterStatisticsPresentation();
            controlsView.setStatisticsStatus(
                "Click the map to calculate a bounded 127 × 127 sampled " +
                "histogram for that window. No whole-raster histogram is read."
            );
        } else if (wholeRasterStatisticsState === "ready") {
            renderRasterStatistics(wholeRasterStatistics);
        } else if (wholeRasterStatisticsState === "error") {
            renderRasterStatisticsError(
                wholeRasterStatisticsError,
                "wholeRaster"
            );
        } else if (!visible) {
            clearRasterStatisticsPresentation();
            controlsView.setStatisticsStatus(
                "The active raster is hidden. Show it to calculate its " +
                "approximate distribution."
            );
        }
    }

    /**
     * Restore the active session's controls, map interactions, and statistics.
     *
     * @param {string} key Stable retained layer key.
     * @param {{key:string,action:string}|null} [requestedFocus=null] Optional
     * focus target for the layer-stack rerender.
     * @return {void}
     */
    function activateLayer(key, requestedFocus = null) {
        if (activeLayerKey === key) {
            layerStack.activate(key);
            renderLayerStack(requestedFocus);
            return;
        }
        deactivateActiveLayer();
        const entry = layerStack.activate(key);
        const session = requireLayerSession(key);
        loadActiveLayerSession(session);
        controlsView.setControlsVisible(true);
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
        if (entry.visible) {
            if (selectedRasterBounds !== null) {
                rasterSampleWindowController.restoreSelection(
                    selectedRasterBounds
                );
            }
            if (selectedTemporaryAoi === null) {
                rasterSampleWindowController.enable();
            }
            pixelProbeController.activate(activeRasterItem);
        }
        renderRasterSampleWindowGuidance("");

        restoreActiveLayerStatistics();
        saveActiveLayerSession();
        renderLayerStack(requestedFocus);
    }

    /**
     * Activate shared appearance and click-histogram controls for one sampled
     * raster that is already visible through the detail-preview controller.
     *
     * The session never publishes WMS, reads whole-raster statistics, enables
     * the published-raster pixel endpoint, or accepts a temporary AOI.
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
        deactivateActiveLayer();
        const key = `detail:${getCatalogRasterLayerKey(item)}`;
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
            wholeRasterStatisticsState: "unavailable",
            wholeRasterStatisticsError: null,
            selectedRasterBounds: null,
            selectedTemporaryAoi: null,
            selectedRasterWindowSizeKm: null,
            selectedRasterStatistics: null,
            selectedRasterStatisticsState: "idle",
            selectedRasterStatisticsError: null,
        };
        loadActiveLayerSession(sampledRasterSession);
        controlsView.setControlsVisible(true);
        controlsView.setActiveLayer(sampledRasterSession.label, true);
        controlsView.setStyle(rasterStyle, sampledRasterSession.paletteName);
        controlsView.renderLegend(rasterStyle);
        resetRasterPercentileControls();
        rasterSampleWindowController.setWindowSize(
            DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM
        );
        controlsView.setSampleWindowSize(
            rasterSampleWindowController.windowSizeKm
        );
        controlsView.setSampleWindowInvalid(false);
        rasterSampleWindowController.enable();
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        restoreActiveLayerStatistics();
        saveActiveLayerSession();
        renderLayerStack();
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
        const expectedKey = `detail:${getCatalogRasterLayerKey(item)}`;
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
        const expectedKey = `detail:${getCatalogRasterLayerKey(item)}`;
        if (sampledRasterSession?.key !== expectedKey) {
            return;
        }
        if (isActiveSampledRaster()) {
            deactivateActiveLayer();
        }
        sampledRasterSession = null;
        const nextActiveKey = layerStack.activeKey;
        if (nextActiveKey === null) {
            controlsView.setControlsVisible(false);
            controlsView.hidePixelProbe();
            renderLayerStack();
            return;
        }
        activateLayer(nextActiveKey);
    }

    /**
     * Record an explicit layer-list activation before applying it.
     *
     * @param {string} key Stable retained layer key.
     * @return {void}
     */
    function handleLayerActivation(key) {
        activationIntentSequence += 1;
        activateLayer(key);
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
        const activeLayer = leafletLayers.get(activeLayerKey);
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
                ? "Calculating an approximate distribution for the selected area..."
                : "Calculating an approximate whole-raster distribution..."
        );
        saveActiveLayerSession();
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
                selectedRasterBounds,
                selectedTemporaryAoi?.id ?? null
            );
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
        const sampledGrid = statistics.samplingMethod === "sampledGrid";
        const sourceDescription = statistics.scope === "wholeRaster"
            ? "source raster"
            : "source-cell window";
        const scopeDescription = statistics.scope === "temporaryAoi"
            ? `Uploaded AOI ${selectedTemporaryAoi?.filename ?? "area"}, ` +
              `layer ${selectedTemporaryAoi?.selectedDataset ?? "selected"}, ` +
              "approximate distribution"
            : statistics.scope === "selectedArea"
                ? "Selected-area approximate distribution"
                : "Whole-raster approximate distribution";
        const provenance = sampledGrid
            ? `${statistics.validSampleCount.toLocaleString()} finite values ` +
              `from an exact ${statistics.sampleWidth.toLocaleString()} × ` +
              `${statistics.sampleHeight.toLocaleString()} bounded point ` +
              "grid spatially placed over the selected map window"
            : `${statistics.validSampleCount.toLocaleString()} valid pixels ` +
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
        saveActiveLayerSession();
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
                  "The previous distribution remains visible for reference and " +
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
            return "Calculating an approximate distribution for the selected area...";
        }
        return (
            `Calculating an approximate distribution for uploaded AOI ` +
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
        controlsView.setStatisticsRetryVisible(true);
        controlsView.setApplyPercentilesEnabled(false);
        const areaName = selectedTemporaryAoi === null
            ? "Selected-area"
            : `Uploaded AOI ${selectedTemporaryAoi.filename}, layer ` +
              selectedTemporaryAoi.selectedDataset;
        controlsView.setStatisticsStatus(
            rasterStatistics === null
                ? `${areaName} distribution unavailable: ${error.message} ` +
                  "Manual appearance controls remain available."
                : `${areaName} distribution unavailable: ${error.message} ` +
                  "The previous distribution remains visible for reference but " +
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
        selectedRasterStatisticsController.clear();
        selectedRasterBounds = null;
        selectedTemporaryAoi = null;
        selectedRasterWindowSizeKm = null;
        selectedRasterStatistics = null;
        selectedRasterStatisticsState = "idle";
        selectedRasterStatisticsError = null;
        rasterSampleWindowController.clearSelection();
        if (isActiveLayerVisible()) {
            rasterSampleWindowController.enable();
        }
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        if (isActiveSampledRaster()) {
            clearRasterStatisticsPresentation();
            controlsView.setStatisticsStatus(
                "Click the map to calculate a bounded 127 × 127 sampled " +
                "histogram for that window. No whole-raster histogram is read."
            );
        } else if (wholeRasterStatisticsState === "ready") {
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
        if (activeLayerKey !== null && !isActiveLayerVisible()) {
            nextStatus =
                "The active raster is hidden. Show it to select a histogram area.";
        } else if (guidance) {
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
                `layer ${selectedTemporaryAoi.selectedDataset}. Hide the AOI ` +
                "to return histogram sampling to the mouse-hover map window.";
        } else {
            nextStatus = isActiveSampledRaster()
                ? "No histogram window selected. Move over the map and click " +
                  "to sample an exact bounded grid at that location."
                : "Whole-raster distribution selected. Move over the map " +
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
        if (!isActiveLayerVisible()) {
            return;
        }
        selectedRasterBounds = bounds;
        selectedTemporaryAoi = null;
        selectedRasterWindowSizeKm = rasterSampleWindowController.windowSizeKm;
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        void selectedRasterStatisticsController.activate(
            activeRasterItem,
            undefined,
            bounds,
            null
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
        selectedRasterStatisticsController.clear();
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
            isActiveSampledRaster() ||
            availableTemporaryAoi === null ||
            activeRasterItem === null
        ) {
            return;
        }
        selectedRasterStatisticsController.clear();
        selectedRasterBounds = null;
        selectedTemporaryAoi = availableTemporaryAoi;
        selectedRasterWindowSizeKm = null;
        selectedRasterStatistics = null;
        selectedRasterStatisticsState = "idle";
        selectedRasterStatisticsError = null;
        rasterSampleWindowController.clear();
        renderRasterSamplingAreaControls();
        renderRasterSampleWindowGuidance("");
        if (isActiveLayerVisible()) {
            void selectedRasterStatisticsController.activate(
                activeRasterItem,
                undefined,
                null,
                selectedTemporaryAoi.id
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
        if (!isActiveLayerVisible()) {
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
     * Reset the active style to its whole-raster approximate range.
     *
     * @return {void}
     */
    function handleResetStyle() {
        rasterStyleWasEdited = true;
        resetRasterStyle();
        commitRasterStyle();
        if (isActiveSampledRaster()) {
            controlsView.setStatisticsStatus(
                "Reset appearance to the sampled raster's approximate " +
                "minimum, median, and maximum."
            );
        } else if (wholeRasterStatistics !== null) {
            resetRasterPercentileControls();
            updateRasterPercentileValues();
            const scopeNote = !hasSelectedRasterSamplingArea()
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
        if (hasSelectedRasterSamplingArea()) {
            selectedRasterStatisticsState = "idle";
            void selectedRasterStatisticsController.activate(
                activeRasterItem,
                undefined,
                selectedRasterBounds,
                selectedTemporaryAoi?.id ?? null
            );
        } else if (!isActiveSampledRaster()) {
            wholeRasterStatisticsState = "idle";
            void wholeRasterStatisticsController.activate(activeRasterItem);
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
        if (isActiveLayerVisible() && !isActiveSampledRaster()) {
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
        if (!isActiveLayerVisible() || isActiveSampledRaster()) {
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
     * Attach or detach one retained layer under the two-visible contract.
     *
     * @param {string} key Stable layer key.
     * @param {boolean} visible Requested visibility.
     * @return {void}
     */
    function handleLayerVisibility(key, visible) {
        let entry;
        try {
            entry = layerStack.setVisible(key, visible);
        } catch (error) {
            if (!(error instanceof RasterLayerVisibilityLimitError)) {
                throw error;
            }
            layerStackView.setStatus(error.message);
            renderLayerStack({ key, action: "visibility" });
            return;
        }
        leafletLayers.setVisible(key, visible);
        if (activeLayerKey === key) {
            saveActiveLayerSession();
            rasterSampleWindowController.clear();
            pixelProbeController.clear();
            controlsView.hidePixelProbe();
            controlsView.setActiveLayer(entry.label, visible);
            if (visible) {
                rasterSampleWindowController.setWindowSize(
                    selectedRasterWindowSizeKm ??
                    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM
                );
                if (selectedRasterBounds !== null) {
                    rasterSampleWindowController.restoreSelection(
                        selectedRasterBounds
                    );
                }
                if (selectedTemporaryAoi === null) {
                    rasterSampleWindowController.enable();
                }
                pixelProbeController.activate(activeRasterItem);
            } else {
                wholeRasterStatisticsController.clear();
                selectedRasterStatisticsController.clear();
                if (wholeRasterStatisticsState === "loading") {
                    wholeRasterStatisticsState = "idle";
                }
                if (selectedRasterStatisticsState === "loading") {
                    selectedRasterStatisticsState = "idle";
                }
            }
            renderRasterSampleWindowGuidance("");
            restoreActiveLayerStatistics();
            saveActiveLayerSession();
        }
        layerStackView.setStatus(
            `${entry.label} is now ${visible ? "visible" : "hidden"}.`
        );
        renderLayerStack({ key, action: "visibility" });
    }

    /**
     * Apply ordinary-overlay opacity to one retained layer.
     *
     * @param {string} key Stable layer key.
     * @param {number} opacity Opacity from zero through one.
     * @return {void}
     */
    function handleLayerOpacity(key, opacity) {
        layerStack.setOpacity(key, opacity);
        leafletLayers.setOpacity(key, opacity);
        onLayersChange(getLayerSnapshots());
    }

    /**
     * Move one retained layer in top-first map order.
     *
     * @param {string} key Stable layer key.
     * @param {"up"|"down"} direction Requested movement.
     * @return {void}
     */
    function handleLayerMove(key, direction) {
        if (!layerStack.move(key, direction)) {
            return;
        }
        const entry = requireLayerSession(key);
        applyLeafletLayerOrder();
        layerStackView.setStatus(
            `${entry.label} moved ${direction} in the map drawing order.`
        );
        renderLayerStack({ key, action: `move-${direction}` });
    }

    /**
     * Invalidate pending publication work for one stable key.
     *
     * @param {string} key Stable layer key.
     * @return {void}
     */
    function invalidatePublication(key) {
        publicationGenerations.set(
            key,
            (publicationGenerations.get(key) ?? 0) + 1
        );
        pendingPublications.delete(key);
    }

    /**
     * Remove one retained or pending layer by stable key.
     *
     * @param {string} key Stable layer key.
     * @return {void}
     */
    function removeLayer(key) {
        requireLayerSession(key);
        activationIntentSequence += 1;
        invalidatePublication(key);
        const removedIndex = layerStack.entries.findIndex(
            (candidate) => candidate.key === key
        );
        const wasActive = activeLayerKey === key;
        if (wasActive) {
            deactivateActiveLayer();
        }
        const { removed: entry, activeKey: nextActiveKey } =
            layerStack.remove(key);
        leafletLayers.remove(key);
        layerSessions.delete(key);
        if (layerStack.entries.length > 0) {
            applyLeafletLayerOrder();
        }
        const focusKey =
            layerStack.entries[removedIndex]?.key ??
            layerStack.entries[removedIndex - 1]?.key ??
            null;
        if (wasActive && nextActiveKey !== null) {
            activateLayer(nextActiveKey, {
                key: nextActiveKey,
                action: "activate",
            });
        } else {
            if (
                layerStack.entries.length === 0 &&
                !isActiveSampledRaster()
            ) {
                activeLayerKey = null;
                activeRasterItem = null;
                controlsView.setControlsVisible(false);
                controlsView.hidePixelProbe();
            }
            renderLayerStack(focusKey === null
                ? null
                : { key: focusKey, action: "activate" });
        }
        layerStackView.setStatus(`${entry.label} was removed from map layers.`);
    }

    /**
     * Remove one Catalog Item from the retained layer stack.
     *
     * @param {Object} item Catalog STAC Item.
     * @return {void}
     */
    function remove(item) {
        removeLayer(getCatalogRasterLayerKey(item));
    }

    /**
     * Remove every retained raster and interaction.
     *
     * @return {void}
     */
    function clear() {
        activationIntentSequence += 1;
        if (rasterStyleCommitTimeout !== null) {
            clock.clearTimeout(rasterStyleCommitTimeout);
            rasterStyleCommitTimeout = null;
        }
        for (const key of pendingPublications.keys()) {
            invalidatePublication(key);
        }
        deactivateActiveLayer();
        sampledRasterSession = null;
        leafletLayers.clear();
        layerStack.clear();
        layerSessions.clear();
        pixelProbeController.clear();
        wholeRasterStatisticsController.clear();
        selectedRasterStatisticsController.clear();
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
        controlsView.hidePixelProbe();
        layerStackView.setStatus("");
        renderLayerStack();
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
        const key = getCatalogRasterLayerKey(item);
        activationIntentSequence += 1;
        const showRequestSequence = activationIntentSequence;
        const retainedSession = layerSessions.get(key);
        if (retainedSession !== undefined) {
            activateLayer(key);
            layerStackView.setStatus(`${retainedSession.label} is active.`);
            return retainedSession.publishedRaster;
        }
        const pendingPublication = pendingPublications.get(key);
        if (pendingPublication !== undefined) {
            const publishedRaster = await pendingPublication;
            if (
                publishedRaster !== null &&
                showRequestSequence === activationIntentSequence &&
                layerSessions.has(key)
            ) {
                activateLayer(key);
            }
            return publishedRaster;
        }

        const generation = (publicationGenerations.get(key) ?? 0) + 1;
        publicationGenerations.set(key, generation);
        const publication = (async () => {
            const publishedRaster = await publishRaster(item);
            if (
                destroyed ||
                publicationGenerations.get(key) !== generation
            ) {
                return null;
            }
            const label = getCatalogRasterBasename(item);
            const previousActiveKey = layerStack.activeKey;
            const { entry } = layerStack.add(
                item,
                label,
                showRequestSequence
            );
            const shouldActivate =
                showRequestSequence === activationIntentSequence ||
                previousActiveKey === null;
            if (!shouldActivate && previousActiveKey !== null) {
                layerStack.activate(previousActiveKey);
            }
            const session = createLayerSession(entry, publishedRaster);
            layerSessions.set(key, session);
            try {
                const layer = createRasterLayer(
                    key,
                    publishedRaster,
                    session.rasterStyle
                );
                leafletLayers.add(key, layer, entry);
                applyLeafletLayerOrder();
                if (shouldActivate) {
                    activateLayer(key);
                } else {
                    renderLayerStack();
                }
            } catch (error) {
                leafletLayers.remove(key);
                layerSessions.delete(key);
                layerStack.remove(key);
                if (
                    previousActiveKey !== null &&
                    layerStack.get(previousActiveKey) !== null
                ) {
                    activateLayer(previousActiveKey);
                } else {
                    renderLayerStack();
                }
                throw error;
            }
            layerStackView.setStatus(
                entry.visible
                    ? `${label} was added and is visible.`
                    : `${label} was added hidden because two raster layers ` +
                      "are already visible. Hide one to show it."
            );
            renderLayerStack();
            return publishedRaster;
        })();
        pendingPublications.set(key, publication);
        try {
            return await publication;
        } finally {
            if (pendingPublications.get(key) === publication) {
                pendingPublications.delete(key);
            }
        }
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
     * hiding, removal, and expiration restore those sessions to mouse-hover
     * map-window sampling. Showing retained geometry selects its AOI again.
     * Overlay geometry never crosses this boundary.
     *
     * @param {Readonly<Object>|null} temporaryAoi Ready lifecycle snapshot or
     * null while hidden or after removal or expiration.
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
        for (const session of layerSessions.values()) {
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
        if (isActiveSampledRaster()) {
            renderRasterSamplingAreaControls();
            saveActiveLayerSession();
            return;
        }
        const activeSession = requireLayerSession(activeLayerKey);
        loadActiveLayerSession(activeSession);
        selectedRasterStatisticsController.clear();
        if (selectedTemporaryAoi !== null) {
            rasterSampleWindowController.clear();
        } else if (isActiveLayerVisible()) {
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
        return layerStack.hasItem(item);
    }

    /**
     * Permanently detach the viewer from DOM and Leaflet event sources.
     * The viewer must not be reused after this call.
     *
     * @return {void}
     */
    function destroy() {
        destroyed = true;
        clear();
        controlsView.unbind();
        layerStackView.unbind();
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
        onSampleMapCenter: () => {
            if (isActiveLayerVisible()) {
                if (selectedTemporaryAoi !== null) {
                    restoreWholeRasterStatistics();
                }
                rasterSampleWindowController.sampleMapCenter();
            }
        },
        onSelectSampleWindow: enableRasterSampleWindowSelection,
        onClearSampleWindow: restoreWholeRasterStatistics,
        onUseTemporaryAoi: useTemporaryAoiForRasterStatistics,
    });
    layerStackView.bind({
        onActivate: handleLayerActivation,
        onVisibility: handleLayerVisibility,
        onOpacity: handleLayerOpacity,
        onMove: handleLayerMove,
        onRemove: removeLayer,
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
            return layerStack.visibleCount > 0 || sampledRasterSession !== null;
        },
    };
}
