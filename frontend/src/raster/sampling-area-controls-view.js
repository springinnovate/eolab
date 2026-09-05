/**
 * DOM presentation adapter for raster histogram sampling-area controls.
 *
 * This adapter owns sample-window sizing and whole-window/temporary-AOI
 * controls. Map exploration is coordinated separately by the composition root.
 * It presents state supplied by the raster coordinator and makes no map, AOI
 * lifecycle, statistics, or request decisions.
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
 * @property {() => void} onClearSampleWindow Restores whole-raster statistics.
 * @property {() => void} onUseMapWindow Selects a map-centered sample box.
 * @property {() => void} onUseTemporaryAoi Selects the retained uploaded AOI.
 */

/** Own direct DOM interaction and presentation for histogram sampling areas. */
export class RasterSamplingAreaControlsView {
    #root;

    /**
     * Resolve the required sampling-area elements once at startup.
     *
     * @param {Document} [documentContext=globalThis.document] Document that
     * owns the controls.
     * @throws {Error} If any required sampling-area element is missing.
     */
    constructor(documentContext = globalThis.document) {
        this.#root = requireRasterControl(
            documentContext,
            "#raster-sampling-area-controls"
        );
        this.samplingAreaSummary = requireRasterControl(
            documentContext,
            "#raster-sampling-area-summary"
        );
        this.wholeRasterChoiceLabel = requireRasterControl(
            documentContext,
            "#raster-sampling-area-whole-label"
        );
        this.sampleWindowRange = requireRasterControl(
            documentContext,
            "#raster-sample-window-range"
        );
        this.sampleWindowNumber = requireRasterControl(
            documentContext,
            "#raster-sample-window-number"
        );
        this.clearSampleWindowButton = requireRasterControl(
            documentContext,
            "#clear-raster-sample-window"
        );
        this.useMapWindowButton = requireRasterControl(
            documentContext,
            "#use-map-window-for-raster"
        );
        this.mapBoxControls = requireRasterControl(
            documentContext,
            "#raster-map-box-controls"
        );
        this.useTemporaryAoiButton = requireRasterControl(
            documentContext,
            "#use-temporary-aoi-for-raster"
        );
        this.temporaryAoiDetail = requireRasterControl(
            documentContext,
            "#raster-sampling-aoi-detail"
        );
        this.sampleWindowStatus = requireRasterControl(
            documentContext,
            "#raster-sample-window-status"
        );
        this.temporaryAoi = null;
        this.temporaryAoiCompatible = true;
        this.handlers = null;
        this.boundSampleWindowRangeInput =
            this.#handleSampleWindowRangeInput.bind(this);
        this.boundSampleWindowNumberInput =
            this.#handleSampleWindowNumberInput.bind(this);
        this.boundSampleWindowNumberChange =
            this.#handleSampleWindowNumberChange.bind(this);
        this.boundClearSampleWindow = this.#handleClearSampleWindow.bind(this);
        this.boundUseMapWindow = this.#handleUseMapWindow.bind(this);
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
        this.clearSampleWindowButton.addEventListener(
            "change",
            this.boundClearSampleWindow
        );
        this.useMapWindowButton.addEventListener(
            "change",
            this.boundUseMapWindow
        );
        this.useTemporaryAoiButton.addEventListener(
            "change",
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
        this.clearSampleWindowButton.removeEventListener(
            "change",
            this.boundClearSampleWindow
        );
        this.useMapWindowButton.removeEventListener(
            "change",
            this.boundUseMapWindow
        );
        this.useTemporaryAoiButton.removeEventListener(
            "change",
            this.boundUseTemporaryAoi
        );
        this.handlers = null;
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
        this.wholeRasterChoiceLabel.textContent = label;
    }

    /**
     * Present whether a retained ready AOI can be used for raster statistics.
     *
     * @param {Object|null} temporaryAoi Ready AOI display identity, or null.
     * @return {void}
     */
    setTemporaryAoiAvailability(temporaryAoi) {
        this.temporaryAoi = temporaryAoi;
        this.#synchronizeTemporaryAoiAvailability();
    }

    /**
     * Set whether the active analysis mode accepts temporary AOI lifecycle IDs.
     *
     * @param {boolean} isCompatible Whether temporary AOI selection is allowed.
     * @return {void}
     */
    setTemporaryAoiCompatible(isCompatible) {
        this.temporaryAoiCompatible = isCompatible;
        this.#synchronizeTemporaryAoiAvailability();
    }

    /**
     * Synchronize retained AOI availability with active-mode compatibility.
     *
     * @return {void}
     */
    #synchronizeTemporaryAoiAvailability() {
        const temporaryAoi = this.temporaryAoi;
        this.useTemporaryAoiButton.disabled =
            temporaryAoi === null || !this.temporaryAoiCompatible;
        if (!this.temporaryAoiCompatible) {
            this.useTemporaryAoiButton.removeAttribute("aria-label");
            this.useTemporaryAoiButton.title =
                "This histogram does not support uploaded AOI sampling.";
            this.temporaryAoiDetail.textContent =
                "Unavailable for a two-raster comparison.";
            return;
        }
        if (temporaryAoi === null) {
            this.useTemporaryAoiButton.removeAttribute("aria-label");
            this.useTemporaryAoiButton.title =
                "Upload a polygonal AOI to enable this area.";
            this.temporaryAoiDetail.textContent =
                "Upload an AOI below to enable this area.";
            return;
        }
        const description =
            `Use uploaded AOI ${temporaryAoi.filename}, ` +
            `layer ${temporaryAoi.selectedDataset}`;
        this.useTemporaryAoiButton.setAttribute("aria-label", description);
        this.useTemporaryAoiButton.title = description;
        this.temporaryAoiDetail.textContent =
            `${temporaryAoi.filename} · ${temporaryAoi.selectedDataset}`;
    }

    /**
     * Mark the active histogram-area choice without changing availability.
     *
     * @param {"none"|"wholeRaster"|"selectedArea"|"temporaryAoi"} mode
     * Active area, or no selected histogram area for the raster.
     * @param {string} [label=""] Readable active sampling-area description.
     * @return {void}
     */
    setSamplingAreaMode(mode, label = "") {
        if (!["none", "wholeRaster", "selectedArea", "temporaryAoi"].includes(mode)) {
            throw new RangeError(`Unknown raster sampling-area mode: ${mode}`);
        }
        this.clearSampleWindowButton.checked = mode === "wholeRaster";
        this.useMapWindowButton.checked = mode === "selectedArea";
        this.useTemporaryAoiButton.checked = mode === "temporaryAoi";
        this.mapBoxControls.hidden = mode !== "selectedArea";
        this.samplingAreaSummary.textContent = label || (
            mode === "none" ? "No raster selected" : "Whole raster"
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

    /** Forward whole-raster restoration. @return {void} */
    #handleClearSampleWindow() {
        if (this.clearSampleWindowButton.checked) {
            this.handlers.onClearSampleWindow();
        }
    }

    /** Forward map-centered box selection. @return {void} */
    #handleUseMapWindow() {
        if (this.useMapWindowButton.checked) {
            this.handlers.onUseMapWindow();
        }
    }

    /** Forward temporary-AOI selection. @return {void} */
    #handleUseTemporaryAoi() {
        if (this.useTemporaryAoiButton.checked) {
            this.handlers.onUseTemporaryAoi();
        }
    }
}
