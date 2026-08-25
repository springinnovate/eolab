/**
 * DOM presentation adapter for raster histogram sampling-area controls.
 *
 * This adapter owns sample-window sizing and whole/map-window/temporary-AOI
 * controls. It presents state supplied by the raster coordinator and makes no
 * map, AOI lifecycle, statistics, or request decisions.
 */
import { requireRasterControl } from "./required-control.js";

/**
 * @typedef {Object} RasterSamplingAreaHandlers
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

/** Own direct DOM interaction and presentation for histogram sampling areas. */
export class RasterSamplingAreaControlsView {
    /**
     * Resolve the required sampling-area elements once at startup.
     *
     * @param {Document} [documentContext=globalThis.document] Document that
     * owns the controls.
     * @throws {Error} If any required sampling-area element is missing.
     */
    constructor(documentContext = globalThis.document) {
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
        this.handlers = null;
        this.boundSampleWindowRangeInput =
            this.#handleSampleWindowRangeInput.bind(this);
        this.boundSampleWindowNumberInput =
            this.#handleSampleWindowNumberInput.bind(this);
        this.boundSampleWindowNumberChange =
            this.#handleSampleWindowNumberChange.bind(this);
        this.boundSampleMapCenter = this.#handleSampleMapCenter.bind(this);
        this.boundSelectSampleWindow = this.#handleSelectSampleWindow.bind(this);
        this.boundClearSampleWindow = this.#handleClearSampleWindow.bind(this);
        this.boundUseTemporaryAoi = this.#handleUseTemporaryAoi.bind(this);
    }

    /**
     * Attach direct sampling-area listeners to semantic handlers.
     *
     * @param {RasterSamplingAreaHandlers} handlers Sampling-area handlers.
     * @return {void}
     */
    bind(handlers) {
        this.handlers = handlers;
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

    /** Remove every direct listener installed by {@link bind}. @return {void} */
    unbind() {
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
     * Enable map-dependent sampling actions for an active raster.
     *
     * @return {void}
     */
    enableActiveRasterActions() {
        this.sampleMapCenterButton.disabled = false;
        this.selectSampleWindowButton.disabled = false;
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
     * Replace the current sample-window guidance when it has changed.
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
            this.useTemporaryAoiButton.title =
                "Upload a polygonal AOI to enable this area.";
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

    /** Forward a range size edit with its current text value. @return {void} */
    #handleSampleWindowRangeInput() {
        this.handlers.onSampleWindowRangeInput(this.sampleWindowRange.value);
    }

    /** Forward a numeric size edit with its current text value. @return {void} */
    #handleSampleWindowNumberInput() {
        this.handlers.onSampleWindowNumberInput(this.sampleWindowNumber.value);
    }

    /** Forward a committed numeric size edit. @return {void} */
    #handleSampleWindowNumberChange() {
        this.handlers.onSampleWindowNumberChange(this.sampleWindowNumber.value);
    }

    /** Forward the map-center sampling action. @return {void} */
    #handleSampleMapCenter() {
        this.handlers.onSampleMapCenter();
    }

    /** Forward pointer-window selection. @return {void} */
    #handleSelectSampleWindow() {
        this.handlers.onSelectSampleWindow();
    }

    /** Forward whole-raster restoration. @return {void} */
    #handleClearSampleWindow() {
        this.handlers.onClearSampleWindow();
    }

    /** Forward temporary-AOI selection. @return {void} */
    #handleUseTemporaryAoi() {
        this.handlers.onUseTemporaryAoi();
    }
}
