/**
 * Compatibility façade for the raster viewer's DOM controls and readouts.
 *
 * RasterControlsView preserves the viewer-facing contract while delegating
 * subgroup element lookup, direct event listeners, control reads, and
 * presentation to focused appearance, sampling-area, histogram, percentile,
 * and pixel-probe adapters. The façade owns only its composite root visibility
 * and active-raster identity presentation. It contains no fetch, Leaflet,
 * rendering, statistics, or lifecycle decisions.
 */
import { RasterAppearanceControlsView } from "./appearance-controls-view.js";
import { RasterHistogramControlsView } from "./histogram-controls-view.js";
import {
    RasterPercentileControlsView,
} from "./percentile-controls-view.js";
import { RasterPixelProbeView } from "./pixel-probe-view.js";
import { requireRasterControl } from "./required-control.js";
import {
    RasterSamplingAreaControlsView,
} from "./sampling-area-controls-view.js";

/**
 * @typedef {Object} RasterControlHandlers
 * @property {(isColor: boolean) => void} onStyleInput Handles style edits.
 * @property {() => void} onStyleChange Commits a completed style edit.
 * @property {() => void} onPaletteChange Applies a selected color palette.
 * @property {() => void} onResetStyle Restores the initial raster style.
 * @property {() => void} onPercentileInput Updates percentile estimates.
 * @property {() => void} onApplyPercentiles Applies the percentile range.
 * @property {() => void} onRetryStatistics Retries raster statistics.
 * @property {(key: string) => void} onSelectHistogram Activates one retained
 * raster selected from the histogram summaries.
 * @property {(value: string) => void} onSampleWindowRangeInput Changes the
 * sample-window size from the range control.
 * @property {(value: string) => void} onSampleWindowNumberInput Changes the
 * sample-window size from the numeric control.
 * @property {(value: string) => void} onSampleWindowNumberChange Commits the
 * numeric sample-window size.
 * @property {() => void} onSampleMapCenter Selects the map-center window.
 * @property {() => void} onSelectSampleWindow Enables pointer window selection.
 * @property {() => void} onClearSampleWindow Restores whole-raster statistics.
 * @property {() => void} onUseTemporaryAoi Selects the retained uploaded AOI.
 */

/**
 * Preserve the raster viewer's DOM boundary and own composite presentation by
 * composing focused adapters.
 */
export class RasterControlsView {
    #activeLayerLabel;
    #appearanceView;
    #histogramView;
    #percentileView;
    #pixelProbeView;
    #root;
    #samplingAreaView;

    /**
     * Resolve the complete raster-control DOM contract once at startup.
     *
     * @param {Document} [documentContext=globalThis.document] Document that
     * owns the controls.
     * @throws {Error} If any required raster-control element is missing.
     */
    constructor(documentContext = globalThis.document) {
        this.#root = requireRasterControl(
            documentContext,
            "#raster-style-controls"
        );
        this.#activeLayerLabel = requireRasterControl(
            documentContext,
            "#raster-active-layer-label"
        );
        this.#appearanceView = new RasterAppearanceControlsView(documentContext);
        this.#histogramView = new RasterHistogramControlsView(documentContext);
        this.#percentileView = new RasterPercentileControlsView(
            documentContext
        );
        this.#samplingAreaView = new RasterSamplingAreaControlsView(
            documentContext
        );
        this.#pixelProbeView = new RasterPixelProbeView(documentContext);
    }

    /**
     * Add the supported palettes and the user-edited custom option.
     *
     * @param {Object<string, {label: string}>} palettes Palette definitions.
     * @return {void}
     */
    populatePalettes(palettes) {
        this.#appearanceView.populatePalettes(palettes);
    }

    /**
     * Identify the raster analysis target edited by these shared controls.
     *
     * @param {string} label Readable raster basename.
     * @param {boolean} visible Whether its optional renderer is visible on map.
     * @return {void}
     */
    setActiveLayer(label, visible) {
        this.#activeLayerLabel.textContent = visible
            ? label
            : `${label} — not visible on the map`;
        this.#samplingAreaView.enableActiveRasterActions();
        this.#appearanceView.setActiveLayer(label, visible);
        this.#histogramView.setActiveLayer(label);
        this.#histogramView.enableActiveRasterActions();
    }

    /**
     * Render one summary per retained raster without exposing layer-stack DOM.
     *
     * @param {Object[]} summaries Presentation-ready histogram summaries.
     * @param {string|null} activeKey Active retained raster key, or null.
     * @return {void}
     */
    renderLayerHistograms(summaries, activeKey) {
        this.#histogramView.renderLayerHistograms(summaries, activeKey);
    }

    /**
     * Attach every focused adapter to the existing semantic viewer handlers.
     *
     * @param {RasterControlHandlers} handlers Raster-viewer event handlers.
     * @return {void}
     */
    bind(handlers) {
        this.#appearanceView.bind(handlers);
        this.#histogramView.bind(handlers);
        this.#percentileView.bind(handlers);
        this.#samplingAreaView.bind(handlers);
    }

    /** Remove every listener installed by {@link bind}. @return {void} */
    unbind() {
        this.#appearanceView.unbind();
        this.#histogramView.unbind();
        this.#percentileView.unbind();
        this.#samplingAreaView.unbind();
    }

    /**
     * Read a candidate raster style from the appearance controls.
     *
     * @return {Object} Candidate numeric thresholds and color stops.
     */
    readStyle() {
        return this.#appearanceView.readStyle();
    }

    /**
     * Display one committed style and palette in the appearance controls.
     *
     * @param {Object} style Committed numeric thresholds and color stops.
     * @param {string} paletteName Selected palette name.
     * @return {void}
     */
    setStyle(style, paletteName) {
        this.#appearanceView.setStyle(style, paletteName);
    }

    /** Return the currently selected palette name. @return {string} Palette name. */
    getPaletteName() {
        return this.#appearanceView.getPaletteName();
    }

    /**
     * Select one palette without changing any raster style fields.
     *
     * @param {string} paletteName Palette name or `custom`.
     * @return {void}
     */
    setPaletteName(paletteName) {
        this.#appearanceView.setPaletteName(paletteName);
    }

    /**
     * Present a style validation error on the fields it describes.
     *
     * @param {(Error & {fieldGroup?: string})|null} [styleError=null] Error.
     * @return {void}
     */
    renderStyleError(styleError = null) {
        this.#appearanceView.renderStyleError(styleError);
    }

    /**
     * Announce one completed appearance action beside the style controls.
     *
     * @param {string} message Concise result, or an empty string to clear it.
     * @return {void}
     * @throws {TypeError} If the message is not a string.
     */
    setAppearanceStatus(message) {
        this.#appearanceView.setStatus(message);
    }

    /**
     * Render the accessible legend for one committed raster style.
     *
     * @param {Object} style Committed numeric thresholds and color stops.
     * @return {void}
     */
    renderLegend(style) {
        this.#appearanceView.renderLegend(style);
    }

    /**
     * Read the three selected histogram positions as percentages.
     *
     * @return {{lower: number, middle: number, upper: number}} Percentiles.
     */
    readPercentiles() {
        return this.#percentileView.readPercentiles();
    }

    /**
     * Restore percentile controls to the application defaults.
     *
     * @param {{lower: number, middle: number, upper: number}} defaults Defaults.
     * @return {void}
     */
    resetPercentiles(defaults) {
        this.#percentileView.resetPercentiles(defaults);
    }

    /**
     * Present approximate values and ordered-input feedback for percentiles.
     *
     * @param {{lower: number, middle: number, upper: number}} percentiles
     * Selected histogram positions.
     * @param {{lower: string, middle: string, upper: string}} values Formatted
     * approximate raster values.
     * @param {boolean} isOrdered Whether the positions increase strictly.
     * @param {boolean} isApplicable Whether the current histogram applies.
     * @return {void}
     */
    renderPercentileValues(percentiles, values, isOrdered, isApplicable) {
        this.#percentileView.renderPercentileValues(
            percentiles,
            values,
            isOrdered,
            isApplicable
        );
    }

    /** Remove histogram content and hide result-only controls. @return {void} */
    clearStatistics() {
        this.#histogramView.clearStatistics();
        this.#percentileView.setPercentileControlsVisible(false);
    }

    /**
     * Set whether the statistics region is awaiting a response.
     *
     * @param {boolean} isBusy Whether statistics are loading.
     * @return {void}
     */
    setStatisticsBusy(isBusy) {
        this.#histogramView.setStatisticsBusy(isBusy);
    }

    /**
     * Replace the current user-facing statistics status.
     *
     * @param {string} message Statistics status message.
     * @return {void}
     */
    setStatisticsStatus(message) {
        this.#histogramView.setStatisticsStatus(message);
    }

    /**
     * Render the fixed-bin histogram using the committed raster style.
     *
     * @param {Object} statistics Validated raster statistics.
     * @param {Object} style Committed raster style.
     * @return {void}
     */
    renderHistogram(statistics, style) {
        this.#histogramView.renderHistogram(statistics, style);
    }

    /** Hide and empty the fixed-bin histogram chart. @return {void} */
    clearHistogram() {
        this.#histogramView.clearHistogram();
    }

    /**
     * Display formatted sampled minimum and maximum labels.
     *
     * @param {string} minimumLabel Formatted sampled minimum.
     * @param {string} maximumLabel Formatted sampled maximum.
     * @return {void}
     */
    showHistogramAxis(minimumLabel, maximumLabel) {
        this.#histogramView.showHistogramAxis(minimumLabel, maximumLabel);
    }

    /** Hide the sampled minimum and maximum labels. @return {void} */
    hideHistogramAxis() {
        this.#histogramView.hideHistogramAxis();
    }

    /**
     * Set whether the percentile controls are available.
     *
     * @param {boolean} isVisible Whether the controls should be visible.
     * @return {void}
     */
    setPercentileControlsVisible(isVisible) {
        this.#percentileView.setPercentileControlsVisible(isVisible);
    }

    /**
     * Set whether the statistics retry action is available.
     *
     * @param {boolean} isVisible Whether the retry action should be visible.
     * @return {void}
     */
    setStatisticsRetryVisible(isVisible) {
        this.#histogramView.setStatisticsRetryVisible(isVisible);
    }

    /**
     * Set whether the current percentile range can be applied.
     *
     * @param {boolean} isEnabled Whether the apply action should be enabled.
     * @return {void}
     */
    setApplyPercentilesEnabled(isEnabled) {
        this.#percentileView.setApplyPercentilesEnabled(isEnabled);
    }

    /**
     * Synchronize both sample-window size controls.
     *
     * @param {number|string} value Valid sample-window side length.
     * @return {void}
     */
    setSampleWindowSize(value) {
        this.#samplingAreaView.setSampleWindowSize(value);
    }

    /**
     * Set whether the numeric sample-window size violates its contract.
     *
     * @param {boolean} isInvalid Whether the numeric value is invalid.
     * @return {void}
     */
    setSampleWindowInvalid(isInvalid) {
        this.#samplingAreaView.setSampleWindowInvalid(isInvalid);
    }

    /**
     * Replace the current sample-window guidance.
     *
     * @param {string} message Sample-window guidance message.
     * @return {void}
     */
    setSampleWindowStatus(message) {
        this.#samplingAreaView.setSampleWindowStatus(message);
    }

    /**
     * Set whether the whole-raster restore action is available.
     *
     * @param {boolean} isEnabled Whether a selected window can be cleared.
     * @return {void}
     */
    setClearSampleWindowEnabled(isEnabled) {
        this.#samplingAreaView.setClearSampleWindowEnabled(isEnabled);
    }

    /**
     * Label the action that clears a selected histogram window.
     *
     * @param {string} label Whole-raster restore or sampled-histogram clear.
     * @return {void}
     * @throws {TypeError} If the label is empty or non-text.
     */
    setClearSampleWindowLabel(label) {
        this.#samplingAreaView.setClearSampleWindowLabel(label);
    }

    /**
     * Present whether a retained ready AOI can be used for raster statistics.
     *
     * @param {Object|null} temporaryAoi Ready AOI display identity, or null.
     * @return {void}
     */
    setTemporaryAoiAvailability(temporaryAoi) {
        this.#samplingAreaView.setTemporaryAoiAvailability(temporaryAoi);
    }

    /**
     * Mark the active histogram-area choice without changing availability.
     *
     * @param {"none"|"wholeRaster"|"selectedArea"|"temporaryAoi"} mode
     * Active area, or no selected histogram area for a sampled raster.
     * @param {string} [label=""] Optional semantic histogram scope label.
     * @return {void}
     */
    setSamplingAreaMode(mode, label = "") {
        this.#samplingAreaView.setSamplingAreaMode(mode);
        this.#histogramView.setSamplingAreaMode(mode, label);
    }

    /**
     * Reveal the contextual histogram for an explicit sampling request.
     * The current result remains owned by the histogram adapter.
     *
     * @return {void}
     */
    showHistogramWidget() {
        this.#histogramView.showWidget();
    }

    /**
     * Reveal the contextual appearance editor without changing raster style.
     *
     * @return {void}
     */
    showAppearanceWidget() {
        this.#appearanceView.showWidget();
    }

    /**
     * Set whether the active analysis target has a map renderer whose style
     * can be edited. Analysis and histogram visibility remain independent.
     *
     * @param {boolean} isAvailable Whether rendering controls have a target.
     * @return {void}
     */
    setRenderingControlsAvailable(isAvailable) {
        this.#appearanceView.setActiveRasterAvailable(isAvailable);
        this.#percentileView.setRenderingAvailable(isAvailable);
    }

    /**
     * Show or hide the complete composite raster-interpretation workspace.
     *
     * @param {boolean} isVisible Whether a raster is displayed.
     * @return {void}
     */
    setControlsVisible(isVisible) {
        this.#root.hidden = !isVisible;
        this.#histogramView.setActiveRasterAvailable(isVisible);
        if (!isVisible) {
            this.setRenderingControlsAvailable(false);
        }
    }

    /** Return whether the pointer probe is visible. @return {boolean} Visibility. */
    isPixelProbeVisible() {
        return this.#pixelProbeView.isVisible();
    }

    /**
     * Replace the raster name and sampled detail in the pointer probe.
     *
     * @param {string} label Raster display basename.
     * @param {string} detail Formatted coordinate and sample detail.
     * @return {void}
     */
    setPixelProbeContent(label, detail) {
        this.#pixelProbeView.setContent(label, detail);
    }

    /** Show and measure the pointer probe. @return {{width: number, height: number}} Dimensions. */
    showPixelProbe() {
        return this.#pixelProbeView.show();
    }

    /**
     * Move the pointer probe to one browser-viewport position.
     *
     * @param {{x: number, y: number}} position Probe top-left position.
     * @return {void}
     */
    positionPixelProbe(position) {
        this.#pixelProbeView.position(position);
    }

    /** Hide the pointer probe without changing retained content. @return {void} */
    hidePixelProbe() {
        this.#pixelProbeView.hide();
    }
}
