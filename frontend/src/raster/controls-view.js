/**
 * DOM adapter for the raster viewer's controls and readouts.
 *
 * This module owns required element lookup, control event binding, and visual
 * presentation of styles, histograms, sample-window status, and pixel values.
 * It contains no fetch, Leaflet, or raster lifecycle decisions.
 */
import { buildRasterLegend } from "./style.js";
import {
    clearRasterHistogramChart,
    renderRasterHistogramChart,
} from "./histogram-view.js";

/**
 * Resolve one required raster-control element from the application document.
 *
 * @param {Document} documentContext Document that owns the raster controls.
 * @param {string} selector CSS selector for the required element.
 * @return {Element} The matching raster-control element.
 * @throws {Error} If the application document violates the control contract.
 */
function requireRasterControl(documentContext, selector) {
    const element = documentContext.querySelector(selector);
    if (element === null) {
        throw new Error(`Required raster control is missing: ${selector}`);
    }
    return element;
}

/**
 * @typedef {Object} RasterControlHandlers
 * @property {(isColor: boolean) => void} onStyleInput Handles style edits.
 * @property {() => void} onStyleChange Commits a completed style edit.
 * @property {() => void} onPaletteChange Applies a selected color palette.
 * @property {() => void} onResetStyle Restores the initial raster style.
 * @property {() => void} onPercentileInput Updates percentile estimates.
 * @property {() => void} onApplyPercentiles Applies the percentile range.
 * @property {() => void} onRetryStatistics Retries raster statistics.
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
 * Own the DOM elements and event listeners for raster visualization controls.
 */
export class RasterControlsView {
    /**
     * Resolve the complete raster-control DOM contract once at startup.
     *
     * @param {Document} [documentContext=globalThis.document] Document that
     * owns the controls.
     * @throws {Error} If any required raster-control element is missing.
     */
    constructor(documentContext = globalThis.document) {
        this.documentContext = documentContext;
        this.controls = requireRasterControl(
            documentContext,
            "#raster-style-controls"
        );
        this.activeLayerLabel = requireRasterControl(
            documentContext,
            "#raster-active-layer-label"
        );
        this.palette = requireRasterControl(
            documentContext,
            "#raster-palette"
        );
        this.styleInputs = {
            minimum: requireRasterControl(documentContext, "#raster-minimum"),
            midpoint: requireRasterControl(documentContext, "#raster-midpoint"),
            maximum: requireRasterControl(documentContext, "#raster-maximum"),
            minimumColor: requireRasterControl(
                documentContext,
                "#raster-minimum-color"
            ),
            midpointColor: requireRasterControl(
                documentContext,
                "#raster-midpoint-color"
            ),
            maximumColor: requireRasterControl(
                documentContext,
                "#raster-maximum-color"
            ),
        };
        this.legend = requireRasterControl(documentContext, "#raster-legend");
        this.legendLabels = {
            minimum: requireRasterControl(
                documentContext,
                "#raster-legend-minimum"
            ),
            midpoint: requireRasterControl(
                documentContext,
                "#raster-legend-midpoint"
            ),
            maximum: requireRasterControl(
                documentContext,
                "#raster-legend-maximum"
            ),
        };
        this.styleError = requireRasterControl(
            documentContext,
            "#raster-style-error"
        );
        this.resetStyleButton = requireRasterControl(
            documentContext,
            "#reset-raster-style"
        );
        this.histogram = requireRasterControl(
            documentContext,
            "#raster-histogram"
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
        this.sampleWindowRange = requireRasterControl(
            documentContext,
            "#raster-sample-window-range"
        );
        this.sampleWindowNumber = requireRasterControl(
            documentContext,
            "#raster-sample-window-number"
        );
        this.sampleMapCenterButton = requireRasterControl(
            documentContext,
            "#sample-raster-map-center"
        );
        this.selectSampleWindowButton = requireRasterControl(
            documentContext,
            "#select-raster-sample-window"
        );
        this.clearSampleWindowButton = requireRasterControl(
            documentContext,
            "#clear-raster-sample-window"
        );
        this.useTemporaryAoiButton = requireRasterControl(
            documentContext,
            "#use-temporary-aoi-for-raster"
        );
        this.sampleWindowStatus = requireRasterControl(
            documentContext,
            "#raster-sample-window-status"
        );
        this.pixelProbe = requireRasterControl(
            documentContext,
            "#raster-pixel-probe"
        );
        this.pixelProbeName = requireRasterControl(
            documentContext,
            "#raster-pixel-probe-name"
        );
        this.pixelProbeReading = requireRasterControl(
            documentContext,
            "#raster-pixel-probe-reading"
        );
        this.handlers = null;
        this.boundStyleInput = this.#handleStyleInput.bind(this);
        this.boundStyleChange = this.#handleStyleChange.bind(this);
        this.boundPaletteChange = this.#handlePaletteChange.bind(this);
        this.boundResetStyle = this.#handleResetStyle.bind(this);
        this.boundPercentileInput = this.#handlePercentileInput.bind(this);
        this.boundApplyPercentiles = this.#handleApplyPercentiles.bind(this);
        this.boundRetryStatistics = this.#handleRetryStatistics.bind(this);
        this.boundSampleWindowRangeInput =
            this.#handleSampleWindowRangeInput.bind(this);
        this.boundSampleWindowNumberInput =
            this.#handleSampleWindowNumberInput.bind(this);
        this.boundSampleWindowNumberChange =
            this.#handleSampleWindowNumberChange.bind(this);
        this.boundSampleMapCenter = this.#handleSampleMapCenter.bind(this);
        this.boundSelectSampleWindow =
            this.#handleSelectSampleWindow.bind(this);
        this.boundClearSampleWindow =
            this.#handleClearSampleWindow.bind(this);
        this.boundUseTemporaryAoi =
            this.#handleUseTemporaryAoi.bind(this);
    }

    /**
     * Add the supported palettes and the user-edited custom option.
     *
     * @param {Object<string, {label: string}>} palettes Palette definitions.
     * @return {void}
     */
    populatePalettes(palettes) {
        for (const [paletteName, palette] of Object.entries(palettes)) {
            const option = this.documentContext.createElement("option");
            option.value = paletteName;
            option.textContent = palette.label;
            this.palette.append(option);
        }
        const customOption = this.documentContext.createElement("option");
        customOption.value = "custom";
        customOption.textContent = "Custom";
        this.palette.append(customOption);
    }

    /**
     * Identify the retained layer edited by these shared controls.
     *
     * @param {string} label Readable raster basename.
     * @param {boolean} visible Whether the active raster is attached to map.
     * @return {void}
     */
    setActiveLayer(label, visible) {
        this.activeLayerLabel.textContent = visible
            ? `Editing ${label}.`
            : `Editing ${label}; this layer is hidden from the map.`;
        this.sampleMapCenterButton.disabled = !visible;
        this.selectSampleWindowButton.disabled = !visible;
        this.retryStatisticsButton.disabled = !visible;
    }

    /**
     * Attach every raster-control listener to semantic viewer handlers.
     *
     * @param {RasterControlHandlers} handlers Raster-viewer event handlers.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
        for (const input of Object.values(this.styleInputs)) {
            input.addEventListener("input", this.boundStyleInput);
            input.addEventListener("change", this.boundStyleChange);
        }
        this.palette.addEventListener("change", this.boundPaletteChange);
        this.resetStyleButton.addEventListener("click", this.boundResetStyle);
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
        this.sampleWindowRange.addEventListener(
            "input",
            this.boundSampleWindowRangeInput
        );
        this.sampleWindowNumber.addEventListener(
            "input",
            this.boundSampleWindowNumberInput
        );
        this.sampleWindowNumber.addEventListener(
            "change",
            this.boundSampleWindowNumberChange
        );
        this.sampleMapCenterButton.addEventListener(
            "click",
            this.boundSampleMapCenter
        );
        this.selectSampleWindowButton.addEventListener(
            "click",
            this.boundSelectSampleWindow
        );
        this.clearSampleWindowButton.addEventListener(
            "click",
            this.boundClearSampleWindow
        );
        this.useTemporaryAoiButton.addEventListener(
            "click",
            this.boundUseTemporaryAoi
        );
    }

    /**
     * Remove every listener installed by {@link bind}.
     *
     * @return {void}
     */
    unbind() {
        for (const input of Object.values(this.styleInputs)) {
            input.removeEventListener("input", this.boundStyleInput);
            input.removeEventListener("change", this.boundStyleChange);
        }
        this.palette.removeEventListener("change", this.boundPaletteChange);
        this.resetStyleButton.removeEventListener(
            "click",
            this.boundResetStyle
        );
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
        this.sampleWindowRange.removeEventListener(
            "input",
            this.boundSampleWindowRangeInput
        );
        this.sampleWindowNumber.removeEventListener(
            "input",
            this.boundSampleWindowNumberInput
        );
        this.sampleWindowNumber.removeEventListener(
            "change",
            this.boundSampleWindowNumberChange
        );
        this.sampleMapCenterButton.removeEventListener(
            "click",
            this.boundSampleMapCenter
        );
        this.selectSampleWindowButton.removeEventListener(
            "click",
            this.boundSelectSampleWindow
        );
        this.clearSampleWindowButton.removeEventListener(
            "click",
            this.boundClearSampleWindow
        );
        this.useTemporaryAoiButton.removeEventListener(
            "click",
            this.boundUseTemporaryAoi
        );
        this.handlers = null;
    }

    /**
     * Read a candidate raster style from the appearance controls.
     *
     * @return {Object} Candidate numeric thresholds and color stops.
     */
    readStyle() {
        return {
            minimum: this.styleInputs.minimum.value === ""
                ? Number.NaN
                : Number(this.styleInputs.minimum.value),
            midpoint: this.styleInputs.midpoint.value === ""
                ? Number.NaN
                : Number(this.styleInputs.midpoint.value),
            maximum: this.styleInputs.maximum.value === ""
                ? Number.NaN
                : Number(this.styleInputs.maximum.value),
            minimumColor: this.styleInputs.minimumColor.value,
            midpointColor: this.styleInputs.midpointColor.value,
            maximumColor: this.styleInputs.maximumColor.value,
        };
    }

    /**
     * Display one committed style and palette in the appearance controls.
     *
     * @param {Object} style Committed numeric thresholds and color stops.
     * @param {string} paletteName Selected palette name.
     * @return {void}
     */
    setStyle(style, paletteName) {
        for (const fieldName of Object.keys(this.styleInputs)) {
            this.styleInputs[fieldName].value = style[fieldName];
        }
        this.palette.value = paletteName;
        this.renderLegend(style);
        this.renderStyleError();
    }

    /**
     * Return the currently selected palette name.
     *
     * @return {string} Selected palette name or `custom`.
     */
    getPaletteName() {
        return this.palette.value;
    }

    /**
     * Select one palette without changing any raster style fields.
     *
     * @param {string} paletteName Palette name or `custom`.
     * @return {void}
     */
    setPaletteName(paletteName) {
        this.palette.value = paletteName;
    }

    /**
     * Present a style validation error on the fields it describes.
     *
     * @param {(Error & {fieldGroup?: string})|null} [styleError=null] Error to
     * show.
     * @return {void}
     */
    renderStyleError(styleError = null) {
        this.styleError.textContent = styleError?.message ?? "";
        for (const input of Object.values(this.styleInputs)) {
            input.removeAttribute("aria-invalid");
        }
        if (styleError === null) {
            return;
        }
        const invalidFields = styleError.fieldGroup === "colors"
            ? ["minimumColor", "midpointColor", "maximumColor"]
            : ["minimum", "midpoint", "maximum"];
        for (const fieldName of invalidFields) {
            this.styleInputs[fieldName].setAttribute("aria-invalid", "true");
        }
    }

    /**
     * Render the accessible legend for one committed raster style.
     *
     * @param {Object} style Committed numeric thresholds and color stops.
     * @return {void}
     */
    renderLegend(style) {
        const legend = buildRasterLegend(style);
        this.legend.style.background = legend.gradient;
        this.legend.setAttribute("aria-label", legend.description);
        this.legendLabels.midpoint.style.left =
            `${legend.midpointPosition}%`;
        for (const thresholdName of ["minimum", "midpoint", "maximum"]) {
            this.legendLabels[thresholdName].textContent = style[thresholdName];
        }
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

    /**
     * Remove histogram content and hide distribution-only controls.
     *
     * @return {void}
     */
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

    /**
     * Hide and empty the fixed-bin histogram chart.
     *
     * @return {void}
     */
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

    /**
     * Hide the sampled minimum and maximum labels.
     *
     * @return {void}
     */
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

    /**
     * Synchronize both sample-window size controls.
     *
     * @param {number|string} value Valid sample-window side length.
     * @return {void}
     */
    setSampleWindowSize(value) {
        this.sampleWindowRange.value = String(value);
        this.sampleWindowNumber.value = String(value);
    }

    /**
     * Set whether the numeric sample-window size violates its contract.
     *
     * @param {boolean} isInvalid Whether the numeric value is invalid.
     * @return {void}
     */
    setSampleWindowInvalid(isInvalid) {
        if (isInvalid) {
            this.sampleWindowNumber.setAttribute("aria-invalid", "true");
        } else {
            this.sampleWindowNumber.removeAttribute("aria-invalid");
        }
    }

    /**
     * Replace the current sample-window guidance.
     *
     * @param {string} message Sample-window guidance message.
     * @return {void}
     */
    setSampleWindowStatus(message) {
        if (this.sampleWindowStatus.textContent !== message) {
            this.sampleWindowStatus.textContent = message;
        }
    }

    /**
     * Set whether the whole-raster restore action is available.
     *
     * @param {boolean} isEnabled Whether a selected window can be cleared.
     * @return {void}
     */
    setClearSampleWindowEnabled(isEnabled) {
        this.clearSampleWindowButton.disabled = !isEnabled;
    }

    /**
     * Label the action that clears a selected histogram window.
     *
     * @param {string} label Whole-raster restore or sampled-histogram clear
     * wording owned by the active rendering mode.
     * @return {void}
     * @throws {TypeError} If the label is empty or non-text.
     */
    setClearSampleWindowLabel(label) {
        if (typeof label !== "string" || label.trim() === "") {
            throw new TypeError("Histogram clear label must not be blank");
        }
        this.clearSampleWindowButton.textContent = label;
    }

    /**
     * Present whether a retained ready AOI can be used for raster statistics.
     *
     * @param {Object|null} temporaryAoi Ready AOI display identity, or null.
     * @return {void}
     */
    setTemporaryAoiAvailability(temporaryAoi) {
        this.useTemporaryAoiButton.disabled = temporaryAoi === null;
        if (temporaryAoi === null) {
            this.useTemporaryAoiButton.removeAttribute("aria-label");
            this.useTemporaryAoiButton.title = "Upload a polygonal AOI to enable this area.";
            return;
        }
        const description =
            `Use uploaded AOI ${temporaryAoi.filename}, ` +
            `layer ${temporaryAoi.selectedDataset}`;
        this.useTemporaryAoiButton.setAttribute("aria-label", description);
        this.useTemporaryAoiButton.title = description;
    }

    /**
     * Mark the active histogram-area choice without changing availability.
     *
     * @param {"none"|"wholeRaster"|"selectedArea"|"temporaryAoi"} mode
     * Active area, or no selected histogram area for a sampled raster.
     * @return {void}
     */
    setSamplingAreaMode(mode) {
        this.clearSampleWindowButton.setAttribute(
            "aria-pressed",
            String(mode === "wholeRaster")
        );
        this.selectSampleWindowButton.setAttribute(
            "aria-pressed",
            String(mode === "selectedArea")
        );
        this.useTemporaryAoiButton.setAttribute(
            "aria-pressed",
            String(mode === "temporaryAoi")
        );
    }

    /**
     * Show or hide the complete raster-appearance control group.
     *
     * @param {boolean} isVisible Whether a raster is displayed.
     * @return {void}
     */
    setControlsVisible(isVisible) {
        this.controls.hidden = !isVisible;
    }

    /**
     * Return whether the pointer probe is currently visible.
     *
     * @return {boolean} Whether the pointer probe is visible.
     */
    isPixelProbeVisible() {
        return !this.pixelProbe.hidden;
    }

    /**
     * Replace the raster name and sampled detail in the pointer probe.
     *
     * @param {string} label Raster display basename.
     * @param {string} detail Formatted coordinate and sample detail.
     * @return {void}
     */
    setPixelProbeContent(label, detail) {
        this.pixelProbeName.textContent = label;
        this.pixelProbeName.title = label;
        this.pixelProbeReading.textContent = detail;
    }

    /**
     * Show and measure the pointer probe after its content changes.
     *
     * @return {{width: number, height: number}} Probe dimensions.
     */
    showPixelProbe() {
        this.pixelProbe.hidden = false;
        const bounds = this.pixelProbe.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
    }

    /**
     * Move the pointer probe to one browser-viewport position.
     *
     * @param {{x: number, y: number}} position Probe top-left position.
     * @return {void}
     */
    positionPixelProbe(position) {
        this.pixelProbe.style.transform =
            `translate3d(${position.x}px, ${position.y}px, 0)`;
    }

    /**
     * Hide the pointer probe without changing its retained content.
     *
     * @return {void}
     */
    hidePixelProbe() {
        this.pixelProbe.hidden = true;
    }

    /**
     * Forward one style-input event to the raster viewer.
     *
     * @param {Event} event Style input event.
     * @return {void}
     */
    #handleStyleInput(event) {
        this.handlers.onStyleInput(event.currentTarget.type === "color");
    }

    /**
     * Forward one completed style edit to the raster viewer.
     *
     * @return {void}
     */
    #handleStyleChange() {
        this.handlers.onStyleChange();
    }

    /**
     * Forward one palette selection to the raster viewer.
     *
     * @return {void}
     */
    #handlePaletteChange() {
        this.handlers.onPaletteChange();
    }

    /**
     * Forward the reset-style action to the raster viewer.
     *
     * @return {void}
     */
    #handleResetStyle() {
        this.handlers.onResetStyle();
    }

    /**
     * Forward one percentile edit to the raster viewer.
     *
     * @return {void}
     */
    #handlePercentileInput() {
        this.handlers.onPercentileInput();
    }

    /**
     * Forward the apply-percentiles action to the raster viewer.
     *
     * @return {void}
     */
    #handleApplyPercentiles() {
        this.handlers.onApplyPercentiles();
    }

    /**
     * Forward the retry-statistics action to the raster viewer.
     *
     * @return {void}
     */
    #handleRetryStatistics() {
        this.handlers.onRetryStatistics();
    }

    /**
     * Forward one range-based sample-window edit to the raster viewer.
     *
     * @return {void}
     */
    #handleSampleWindowRangeInput() {
        this.handlers.onSampleWindowRangeInput(this.sampleWindowRange.value);
    }

    /**
     * Forward one numeric sample-window edit to the raster viewer.
     *
     * @return {void}
     */
    #handleSampleWindowNumberInput() {
        this.handlers.onSampleWindowNumberInput(this.sampleWindowNumber.value);
    }

    /**
     * Forward one completed numeric sample-window edit to the raster viewer.
     *
     * @return {void}
     */
    #handleSampleWindowNumberChange() {
        this.handlers.onSampleWindowNumberChange(this.sampleWindowNumber.value);
    }

    /**
     * Forward the keyboard/touch map-center action to the raster viewer.
     *
     * @return {void}
     */
    #handleSampleMapCenter() {
        this.handlers.onSampleMapCenter();
    }

    /**
     * Forward the explicit pointer-window selection action.
     *
     * @return {void}
     */
    #handleSelectSampleWindow() {
        this.handlers.onSelectSampleWindow();
    }

    /**
     * Forward the whole-raster restore action to the raster viewer.
     *
     * @return {void}
     */
    #handleClearSampleWindow() {
        this.handlers.onClearSampleWindow();
    }

    /**
     * Forward the retained temporary-AOI sampling action.
     *
     * @return {void}
     */
    #handleUseTemporaryAoi() {
        this.handlers.onUseTemporaryAoi();
    }
}
