/**
 * DOM presentation adapter for raster histograms and percentile controls.
 *
 * This adapter owns the histogram region, status, axis, percentile inputs,
 * and their direct listeners. The neutral SVG construction functions remain
 * in histogram-view.js; this class only supplies their owned chart element and
 * presents coordinator-provided state.
 */
import {
    clearRasterHistogramChart,
    renderRasterHistogramChart,
} from "./histogram-view.js";
import { requireRasterControl } from "./required-control.js";

/**
 * @typedef {Object} RasterHistogramHandlers
 * @property {() => void} onPercentileInput Updates percentile estimates.
 * @property {() => void} onApplyPercentiles Applies the percentile range.
 * @property {() => void} onRetryStatistics Retries raster statistics.
 */

/** Own direct DOM interaction and presentation for raster histograms. */
export class RasterHistogramControlsView {
    /**
     * Resolve the required histogram and percentile elements once at startup.
     *
     * @param {Document} [documentContext=globalThis.document] Document that
     * owns the controls and creates histogram SVG nodes.
     * @param {() => void} [onBeforeShow=() => {}] Composite presentation hook
     * used to close another contextual raster widget before this one opens.
     * @throws {Error} If any required histogram element is missing.
     */
    constructor(documentContext = globalThis.document, onBeforeShow = () => {}) {
        this.documentContext = documentContext;
        this.onBeforeShow = onBeforeShow;
        this.histogram = requireRasterControl(
            documentContext,
            "#raster-histogram"
        );
        this.openHistogramButton = requireRasterControl(
            documentContext,
            "#open-raster-histogram-widget"
        );
        this.closeHistogramButton = requireRasterControl(
            documentContext,
            "#close-raster-histogram-widget"
        );
        this.histogramScope = requireRasterControl(
            documentContext,
            "#raster-histogram-scope"
        );
        this.histogramStatus = requireRasterControl(
            documentContext,
            "#raster-histogram-status"
        );
        this.histogramChart = requireRasterControl(
            documentContext,
            "#raster-histogram-chart"
        );
        this.histogramAxis = requireRasterControl(
            documentContext,
            "#raster-histogram-axis"
        );
        this.histogramMinimum = requireRasterControl(
            documentContext,
            "#raster-histogram-minimum"
        );
        this.histogramMaximum = requireRasterControl(
            documentContext,
            "#raster-histogram-maximum"
        );
        this.percentileControls = requireRasterControl(
            documentContext,
            "#raster-percentile-controls"
        );
        this.percentileInputs = {
            lower: requireRasterControl(
                documentContext,
                "#raster-lower-percentile"
            ),
            middle: requireRasterControl(
                documentContext,
                "#raster-middle-percentile"
            ),
            upper: requireRasterControl(
                documentContext,
                "#raster-upper-percentile"
            ),
        };
        this.percentileValues = {
            lower: requireRasterControl(
                documentContext,
                "#raster-lower-percentile-value"
            ),
            middle: requireRasterControl(
                documentContext,
                "#raster-middle-percentile-value"
            ),
            upper: requireRasterControl(
                documentContext,
                "#raster-upper-percentile-value"
            ),
        };
        this.percentileError = requireRasterControl(
            documentContext,
            "#raster-percentile-error"
        );
        this.applyPercentilesButton = requireRasterControl(
            documentContext,
            "#apply-raster-percentiles"
        );
        this.retryStatisticsButton = requireRasterControl(
            documentContext,
            "#retry-raster-statistics"
        );
        this.handlers = null;
        this.boundPercentileInput = this.#handlePercentileInput.bind(this);
        this.boundApplyPercentiles = this.#handleApplyPercentiles.bind(this);
        this.boundRetryStatistics = this.#handleRetryStatistics.bind(this);
        this.boundToggleWidget = this.#handleToggleWidget.bind(this);
        this.boundCloseWidget = this.#handleCloseWidget.bind(this);
        this.boundWidgetKeydown = this.#handleWidgetKeydown.bind(this);
    }

    /**
     * Attach direct histogram-control listeners to semantic handlers.
     *
     * @param {RasterHistogramHandlers} handlers Histogram event handlers.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        for (const input of Object.values(this.percentileInputs)) {
            input.addEventListener("input", this.boundPercentileInput);
        }
        this.applyPercentilesButton.addEventListener(
            "click",
            this.boundApplyPercentiles
        );
        this.retryStatisticsButton.addEventListener(
            "click",
            this.boundRetryStatistics
        );
        this.openHistogramButton.addEventListener(
            "click",
            this.boundToggleWidget
        );
        this.closeHistogramButton.addEventListener(
            "click",
            this.boundCloseWidget
        );
        this.histogram.addEventListener(
            "keydown",
            this.boundWidgetKeydown
        );
    }

    /** Remove every direct listener installed by {@link bind}. @return {void} */
    unbind() {
        for (const input of Object.values(this.percentileInputs)) {
            input.removeEventListener("input", this.boundPercentileInput);
        }
        this.applyPercentilesButton.removeEventListener(
            "click",
            this.boundApplyPercentiles
        );
        this.retryStatisticsButton.removeEventListener(
            "click",
            this.boundRetryStatistics
        );
        this.openHistogramButton.removeEventListener(
            "click",
            this.boundToggleWidget
        );
        this.closeHistogramButton.removeEventListener(
            "click",
            this.boundCloseWidget
        );
        this.histogram.removeEventListener(
            "keydown",
            this.boundWidgetKeydown
        );
        this.handlers = null;
    }

    /**
     * Make the map-associated histogram launcher available for an active
     * raster, or close and hide it when no raster owns the controls.
     *
     * @param {boolean} isAvailable Whether an active raster can own a result.
     * @return {void}
     */
    setActiveRasterAvailable(isAvailable) {
        this.openHistogramButton.hidden = !isAvailable;
        if (!isAvailable) {
            this.hideWidget();
        }
    }

    /**
     * Open the contextual histogram without moving focus from the map action
     * that initiated sampling.
     *
     * @param {boolean} [moveFocus=false] Whether to focus the close control.
     * @return {void}
     */
    showWidget(moveFocus = false) {
        if (this.openHistogramButton.hidden) {
            return;
        }
        if (this.histogram.hidden) {
            this.onBeforeShow();
        }
        this.histogram.hidden = false;
        this.histogram.setAttribute("aria-hidden", "false");
        this.openHistogramButton.setAttribute("aria-expanded", "true");
        this.openHistogramButton.textContent = "Hide histogram";
        if (moveFocus) {
            this.closeHistogramButton.focus();
        }
    }

    /**
     * Hide the histogram presentation while retaining its current result.
     *
     * @param {boolean} [returnFocus=false] Whether to focus its launcher.
     * @return {void}
     */
    hideWidget(returnFocus = false) {
        this.histogram.hidden = true;
        this.histogram.setAttribute("aria-hidden", "true");
        this.openHistogramButton.setAttribute("aria-expanded", "false");
        this.openHistogramButton.textContent = "Histogram";
        if (returnFocus && !this.openHistogramButton.hidden) {
            this.openHistogramButton.focus();
        }
    }

    /**
     * Label the distribution with the geographic area that produced it.
     * Matching map-overlay and widget colors provide the visual connection.
     *
     * @param {"none"|"wholeRaster"|"selectedArea"|"temporaryAoi"} mode
     * Active sampling-area discriminator.
     * @return {void}
     * @throws {TypeError} If the mode is outside the sampling-area contract.
     */
    setSamplingAreaMode(mode) {
        const labels = {
            none: "No sampled area",
            wholeRaster: "Whole raster",
            selectedArea: "Selected blue map window",
            temporaryAoi: "Uploaded purple AOI"
        };
        if (!(mode in labels)) {
            throw new TypeError(`Unsupported histogram sampling area: ${mode}`);
        }
        this.histogram.setAttribute("data-sampling-area", mode);
        this.histogramScope.textContent = labels[mode];
    }

    /** Enable statistics retry for an active raster. @return {void} */
    enableActiveRasterActions() {
        this.retryStatisticsButton.disabled = false;
    }

    /**
     * Read the three selected histogram positions as percentages.
     *
     * @return {{lower: number, middle: number, upper: number}} Percentiles.
     */
    readPercentiles() {
        return {
            lower: Number(this.percentileInputs.lower.value),
            middle: Number(this.percentileInputs.middle.value),
            upper: Number(this.percentileInputs.upper.value),
        };
    }

    /**
     * Restore percentile controls to the application defaults.
     *
     * @param {{lower: number, middle: number, upper: number}} defaults Default
     * ordered histogram positions.
     * @return {void}
     */
    resetPercentiles(defaults) {
        for (const percentileName of ["lower", "middle", "upper"]) {
            this.percentileInputs[percentileName].value =
                defaults[percentileName];
            this.percentileInputs[percentileName].removeAttribute(
                "aria-invalid"
            );
        }
        this.percentileError.textContent = "";
        this.applyPercentilesButton.disabled = false;
    }

    /**
     * Present approximate values and ordered-input feedback for percentiles.
     *
     * @param {{lower: number, middle: number, upper: number}} percentiles
     * Selected histogram positions.
     * @param {{lower: string, middle: string, upper: string}} values Formatted
     * approximate raster values.
     * @param {boolean} isOrdered Whether the positions increase strictly.
     * @param {boolean} isApplicable Whether the current distribution applies.
     * @return {void}
     */
    renderPercentileValues(percentiles, values, isOrdered, isApplicable) {
        for (const percentileName of ["lower", "middle", "upper"]) {
            const input = this.percentileInputs[percentileName];
            if (isOrdered) {
                input.removeAttribute("aria-invalid");
            } else {
                input.setAttribute("aria-invalid", "true");
            }
            this.percentileValues[percentileName].textContent =
                `${percentiles[percentileName]}% ≈ ` + values[percentileName];
        }
        this.percentileError.textContent = isOrdered
            ? ""
            : "Choose lower, middle, and upper percentiles in increasing order.";
        this.applyPercentilesButton.disabled = !isOrdered || !isApplicable;
    }

    /** Remove histogram content and hide distribution-only controls. @return {void} */
    clearStatistics() {
        this.histogram.setAttribute("aria-busy", "false");
        this.histogramStatus.textContent = "";
        clearRasterHistogramChart(this.histogramChart);
        this.histogramAxis.hidden = true;
        this.percentileControls.hidden = true;
        this.retryStatisticsButton.hidden = true;
    }

    /**
     * Set whether the statistics region is awaiting a response.
     *
     * @param {boolean} isBusy Whether statistics are loading.
     * @return {void}
     */
    setStatisticsBusy(isBusy) {
        this.histogram.setAttribute("aria-busy", String(isBusy));
    }

    /**
     * Replace the current user-facing statistics status.
     *
     * @param {string} message Statistics status message.
     * @return {void}
     */
    setStatisticsStatus(message) {
        this.histogramStatus.textContent = message;
    }

    /**
     * Render the fixed-bin histogram using the committed raster style.
     *
     * @param {Object} statistics Validated raster statistics.
     * @param {Object} style Committed raster style.
     * @return {void}
     */
    renderHistogram(statistics, style) {
        renderRasterHistogramChart(
            this.histogramChart,
            statistics,
            style,
            this.documentContext
        );
    }

    /** Hide and empty the fixed-bin histogram chart. @return {void} */
    clearHistogram() {
        clearRasterHistogramChart(this.histogramChart);
    }

    /**
     * Display formatted sampled minimum and maximum labels.
     *
     * @param {string} minimumLabel Formatted sampled minimum.
     * @param {string} maximumLabel Formatted sampled maximum.
     * @return {void}
     */
    showHistogramAxis(minimumLabel, maximumLabel) {
        this.histogramMinimum.textContent = minimumLabel;
        this.histogramMaximum.textContent = maximumLabel;
        this.histogramAxis.hidden = false;
    }

    /** Hide the sampled minimum and maximum labels. @return {void} */
    hideHistogramAxis() {
        this.histogramAxis.hidden = true;
    }

    /**
     * Set whether the percentile controls are available.
     *
     * @param {boolean} isVisible Whether the controls should be visible.
     * @return {void}
     */
    setPercentileControlsVisible(isVisible) {
        this.percentileControls.hidden = !isVisible;
    }

    /**
     * Set whether the statistics retry action is available.
     *
     * @param {boolean} isVisible Whether the retry action should be visible.
     * @return {void}
     */
    setStatisticsRetryVisible(isVisible) {
        this.retryStatisticsButton.hidden = !isVisible;
    }

    /**
     * Set whether the current percentile range can be applied.
     *
     * @param {boolean} isEnabled Whether the apply action should be enabled.
     * @return {void}
     */
    setApplyPercentilesEnabled(isEnabled) {
        this.applyPercentilesButton.disabled = !isEnabled;
    }

    /** Forward one percentile edit to the raster viewer. @return {void} */
    #handlePercentileInput() {
        this.handlers.onPercentileInput();
    }

    /** Forward the apply-percentiles action. @return {void} */
    #handleApplyPercentiles() {
        this.handlers.onApplyPercentiles();
    }

    /** Forward the retry-statistics action. @return {void} */
    #handleRetryStatistics() {
        this.handlers.onRetryStatistics();
    }

    /** Toggle the retained histogram result from its map control. @return {void} */
    #handleToggleWidget() {
        if (this.histogram.hidden) {
            this.showWidget(true);
        } else {
            this.hideWidget(true);
        }
    }

    /** Close the widget without clearing statistics. @return {void} */
    #handleCloseWidget() {
        this.hideWidget(true);
    }

    /**
     * Close only the histogram widget when Escape originates within it.
     *
     * @param {KeyboardEvent} event Widget keyboard event.
     * @return {void}
     */
    #handleWidgetKeydown(event) {
        if (event.key !== "Escape") {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.hideWidget(true);
    }
}
