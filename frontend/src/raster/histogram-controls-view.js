/**
 * DOM presentation adapter for raster histograms.
 *
 * This adapter owns the histogram region, status, chart, axis, retry and
 * result visibility, and its direct listeners. The neutral SVG
 * construction functions remain in histogram-view.js; this class only
 * supplies their owned chart element and presents coordinator-provided state.
 */
import {
    clearRasterHistogramChart,
    renderRasterHistogramChart,
} from "./histogram-view.js";
import { requireRasterControl } from "./required-control.js";

/**
 * @typedef {Object} RasterHistogramHandlers
 * @property {() => void} onRetryStatistics Retries raster statistics.
 * @property {(key: string) => void} onSelectHistogram Activates one retained
 * raster whose histogram summary was selected.
 */

/**
 * @typedef {Object} RasterHistogramSummary
 * @property {string} key Opaque retained-layer identity.
 * @property {string} label Readable raster basename.
 * @property {"idle"|"loading"|"ready"|"error"} state Statistics lifecycle.
 * @property {string} scope Readable geographic sampling scope.
 * @property {number[]|null} counts Histogram bin counts when ready.
 */

/** Own direct DOM interaction and presentation for raster histograms. */
export class RasterHistogramControlsView {
    /**
     * Resolve the required histogram elements once at startup.
     *
     * @param {Document} [documentContext=globalThis.document] Document that
     * owns the controls and creates histogram SVG nodes.
     * @throws {Error} If any required histogram element is missing.
     */
    constructor(documentContext = globalThis.document) {
        this.documentContext = documentContext;
        this.histogram = requireRasterControl(
            documentContext,
            "#raster-histogram"
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
        this.retryStatisticsButton = requireRasterControl(
            documentContext,
            "#retry-raster-statistics"
        );
        this.histogramList = requireRasterControl(
            documentContext,
            "#raster-histogram-list"
        );
        this.histogramEmpty = requireRasterControl(
            documentContext,
            "#raster-histogram-empty"
        );
        this.histogramDetailLayer = requireRasterControl(
            documentContext,
            "#raster-histogram-detail-layer"
        );
        this.summaryButtons = [];
        this.activeHistogramKey = null;
        this.handlers = null;
        this.boundRetryStatistics = this.#handleRetryStatistics.bind(this);
        this.isAvailable = false;
        this.modeIsCompatible = true;
    }

    /**
     * Attach direct histogram-control listeners to semantic handlers.
     *
     * @param {RasterHistogramHandlers} handlers Histogram event handlers.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        this.retryStatisticsButton.addEventListener(
            "click",
            this.boundRetryStatistics
        );
    }

    /** Remove every direct listener installed by {@link bind}. @return {void} */
    unbind() {
        this.retryStatisticsButton.removeEventListener(
            "click",
            this.boundRetryStatistics
        );
        this.#clearSummaryButtonListeners();
        this.handlers = null;
    }

    /**
     * Render one clearly labeled histogram summary for every retained raster.
     * Dynamic buttons own their direct listeners and are replaced atomically,
     * so repeated lifecycle renders cannot double-bind an action.
     *
     * @param {RasterHistogramSummary[]} summaries Presentation-ready summaries.
     * @param {string|null} activeKey Active retained raster key, or null when
     * analysis is detached from the layer stack.
     * @return {void}
     * @throws {TypeError} If a summary violates the view boundary contract.
     */
    renderLayerHistograms(summaries, activeKey) {
        if (!Array.isArray(summaries)) {
            throw new TypeError("Raster histogram summaries must be an array");
        }
        const focusedKey = this.summaryButtons.find(
            ({ button }) => button === this.documentContext.activeElement
        )?.key ?? null;
        this.#clearSummaryButtonListeners();
        this.activeHistogramKey = activeKey;
        this.automatic = summaries.some((summary) => summary.automatic);
        this.histogram.hidden = !this.isAvailable || !this.modeIsCompatible || this.automatic;
        const buttons = summaries.map((summary) =>
            this.#createSummaryButton(summary)
        );
        this.histogramList.replaceChildren(...buttons);
        this.histogramEmpty.hidden = summaries.length > 0;
        this.#synchronizeSummaryExpansion();
        if (focusedKey !== null) {
            this.summaryButtons.find(({ key }) => key === focusedKey)
                ?.button.focus();
        }
    }

    /**
     * Identify the raster represented by the detailed histogram.
     *
     * @param {string} label Readable raster label.
     * @return {void}
     */
    setActiveLayer(label) {
        this.histogramDetailLayer.textContent = label;
    }

    /**
     * Show the detailed histogram for an active raster, or hide it when no
     * raster owns the controls.
     *
     * @param {boolean} isAvailable Whether an active raster can own a result.
     * @return {void}
     */
    setActiveRasterAvailable(isAvailable) {
        this.isAvailable = isAvailable;
        const isVisible = isAvailable && this.modeIsCompatible && !this.automatic;
        this.histogram.hidden = !isVisible;
        this.histogram.setAttribute("aria-hidden", String(!isVisible));
        this.#synchronizeSummaryExpansion();
    }

    /**
     * Set whether the active comparison mode accepts a univariate histogram.
     *
     * @param {boolean} isCompatible Whether the detailed histogram may show.
     * @return {void}
     */
    setModeCompatible(isCompatible) {
        this.modeIsCompatible = isCompatible;
        this.histogramList.hidden = !isCompatible;
        const isVisible = isCompatible && this.isAvailable && !this.automatic;
        this.histogram.hidden = !isVisible;
        this.histogram.setAttribute("aria-hidden", String(!isVisible));
        this.#synchronizeSummaryExpansion();
    }

    /**
     * Reveal the contextual histogram. By default this preserves focus on the
     * action that initiated sampling; callers may instead focus the chart.
     * The presentation scrolls only its containing workspace enough to keep
     * the requested result in view.
     *
     * @param {boolean} [moveFocus=false] Whether to focus the chart.
     * @return {void}
     */
    showWidget(moveFocus = false) {
        if (!this.isAvailable || !this.modeIsCompatible || this.automatic) {
            return;
        }
        this.histogram.hidden = false;
        this.histogram.setAttribute("aria-hidden", "false");
        this.#synchronizeSummaryExpansion();
        this.histogram.scrollIntoView?.({
            block: "nearest",
            inline: "nearest",
        });
        if (moveFocus) {
            this.histogramChart.focus?.();
        }
    }

    /**
     * Hide the histogram presentation while retaining its current result.
     *
     * @return {void}
     */
    hideWidget() {
        this.histogram.hidden = true;
        this.histogram.setAttribute("aria-hidden", "true");
        this.#synchronizeSummaryExpansion();
    }

    /**
     * Label the histogram with the geographic area that produced it.
     * Matching map-overlay and widget colors provide the visual connection.
     *
     * @param {"none"|"wholeRaster"|"selectedArea"|"temporaryAoi"} mode
     * Active sampling-area discriminator.
     * @param {string} [label=""] Optional semantic sampling-area description.
     * @return {void}
     * @throws {TypeError} If the mode is outside the sampling-area contract.
     */
    setSamplingAreaMode(mode, label = "") {
        const labels = {
            none: "No sampled area",
            wholeRaster: "Whole raster",
            selectedArea: "Map sample",
            temporaryAoi: "Uploaded AOI"
        };
        if (!(mode in labels)) {
            throw new TypeError(`Unsupported histogram sampling area: ${mode}`);
        }
        this.histogram.setAttribute("data-sampling-area", mode);
        this.histogramScope.textContent = label || labels[mode];
    }

    /** Enable statistics retry for an active raster. @return {void} */
    enableActiveRasterActions() {
        this.retryStatisticsButton.disabled = false;
    }

    /** Remove histogram content and hide result-only controls. @return {void} */
    clearStatistics() {
        this.histogram.setAttribute("aria-busy", "false");
        this.histogramStatus.textContent = "";
        clearRasterHistogramChart(this.histogramChart);
        this.histogramAxis.hidden = true;
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
     * Set whether the statistics retry action is available.
     *
     * @param {boolean} isVisible Whether the retry action should be visible.
     * @return {void}
     */
    setStatisticsRetryVisible(isVisible) {
        this.retryStatisticsButton.hidden = !isVisible;
    }

    /**
     * Construct one retained-raster histogram summary button.
     *
     * @param {RasterHistogramSummary} summary Validated view model.
     * @return {HTMLButtonElement} Bound accessible summary button.
     * @throws {TypeError} If required identity or presentation fields are bad.
     */
    #createSummaryButton(summary) {
        const allowedStates = new Set(["idle", "loading", "ready", "error"]);
        if (
            summary === null ||
            typeof summary !== "object" ||
            typeof summary.key !== "string" ||
            summary.key === "" ||
            typeof summary.label !== "string" ||
            summary.label === "" ||
            typeof summary.scope !== "string" ||
            summary.scope === "" ||
            !allowedStates.has(summary.state) ||
            !(
                summary.counts === null ||
                (
                    Array.isArray(summary.counts) &&
                    summary.counts.every(
                        (count) => Number.isFinite(count) && count >= 0
                    )
                )
            )
        ) {
            throw new TypeError("Raster histogram summary is invalid");
        }
        const button = this.documentContext.createElement(summary.automatic ? "article" : "button");
        button.type = "button";
        button.className = "raster-histogram-summary";
        button.setAttribute("aria-label", `Histogram — ${summary.label}`);
        if (!summary.automatic) {
            button.setAttribute("aria-controls", "raster-histogram");
            button.setAttribute("aria-expanded", "false");
        }

        const name = this.documentContext.createElement("span");
        name.className = "raster-histogram-summary-name";
        name.textContent = summary.label;
        const scope = this.documentContext.createElement("span");
        scope.className = "raster-histogram-summary-scope";
        scope.textContent = summary.scope;
        const status = this.documentContext.createElement("span");
        status.className = "raster-histogram-summary-status";
        status.textContent = {
            idle: "Waiting for histogram",
            loading: "Updating histogram…",
            ready: "Histogram ready",
            error: "Histogram unavailable",
        }[summary.state];
        button.append(name, scope, status);
        if (summary.automatic && summary.statistics) {
            const chart = this.documentContext.createElementNS(
                "http://www.w3.org/2000/svg", "svg"
            );
            chart.classList.add("raster-histogram-chart");
            renderRasterHistogramChart(
                chart, summary.statistics, summary.style, this.documentContext
            );
            const axis = this.documentContext.createElement("p");
            axis.className = "raster-histogram-summary-scope";
            axis.textContent = `Range: ${summary.minimumLabel} to ${summary.maximumLabel}`;
            button.append(chart, axis);
        } else if (summary.counts !== null && summary.counts.length > 0) {
            button.append(this.#createSummaryPreview(summary));
        }
        if (summary.automatic) {
            if (summary.canRetry) {
                const retry = this.documentContext.createElement("button");
                retry.type = "button";
                retry.className = "secondary-button";
                retry.textContent = "Retry histogram";
                retry.setAttribute("aria-label", `Retry histogram for ${summary.label}`);
                retry.addEventListener("click", () =>
                    this.handlers?.onRetryHistogram(summary.key)
                );
                button.append(retry);
            }
            return button;
        }
        const handleSelect = () => {
            this.handlers?.onSelectHistogram(summary.key);
        };
        button.addEventListener("click", handleSelect);
        this.summaryButtons.push({ button, handleSelect, key: summary.key });
        return button;
    }

    /**
     * Draw a compact, non-interactive bar preview for one summary.
     *
     * @param {RasterHistogramSummary} summary Ready histogram summary.
     * @return {SVGElement} Accessible-hidden preview SVG.
     */
    #createSummaryPreview(summary) {
        const preview = this.documentContext.createElementNS(
            "http://www.w3.org/2000/svg",
            "svg"
        );
        preview.classList.add("raster-histogram-summary-preview");
        preview.setAttribute("viewBox", `0 0 ${summary.counts.length} 24`);
        preview.setAttribute("preserveAspectRatio", "none");
        preview.setAttribute("aria-hidden", "true");
        const maximum = Math.max(...summary.counts, 1);
        for (const [index, count] of summary.counts.entries()) {
            const height = 22 * count / maximum;
            const bar = this.documentContext.createElementNS(
                "http://www.w3.org/2000/svg",
                "rect"
            );
            bar.setAttribute("x", String(index));
            bar.setAttribute("y", String(23 - height));
            bar.setAttribute("width", "0.8");
            bar.setAttribute("height", String(height));
            preview.append(bar);
        }
        return preview;
    }

    /** Remove listeners owned by superseded summary buttons. @return {void} */
    #clearSummaryButtonListeners() {
        for (const { button, handleSelect } of this.summaryButtons) {
            button.removeEventListener("click", handleSelect);
        }
        this.summaryButtons = [];
    }

    /** Synchronize active-summary disclosure state. @return {void} */
    #synchronizeSummaryExpansion() {
        for (const { button, key } of this.summaryButtons) {
            button.setAttribute(
                "aria-expanded",
                String(key === this.activeHistogramKey && !this.histogram.hidden)
            );
        }
    }

    /** Forward the retry-statistics action. @return {void} */
    #handleRetryStatistics() {
        this.handlers.onRetryStatistics();
    }

}
