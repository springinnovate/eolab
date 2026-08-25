/**
 * DOM presentation adapter for raster appearance controls.
 *
 * This adapter owns palette and color-stop lookup, appearance listeners,
 * candidate-style reads, legend rendering, and validation presentation. It
 * contains no raster lifecycle, renderer, statistics, or request decisions.
 */
import { requireRasterControl } from "./required-control.js";
import { buildRasterLegend } from "./style.js";

/**
 * @typedef {Object} RasterAppearanceHandlers
 * @property {(isColor: boolean) => void} onStyleInput Handles style edits.
 * @property {() => void} onStyleChange Commits a completed style edit.
 * @property {() => void} onPaletteChange Applies a selected color palette.
 * @property {() => void} onResetStyle Restores the initial raster style.
 */

/**
 * Own the DOM contract and direct listeners for raster appearance controls.
 */
export class RasterAppearanceControlsView {
    #root;

    /**
     * Resolve the required raster-appearance elements once at startup.
     *
     * @param {Document} [documentContext=globalThis.document] Document that
     * owns the controls.
     * @throws {Error} If any required appearance element is missing.
     */
    constructor(documentContext = globalThis.document) {
        this.documentContext = documentContext;
        this.#root = requireRasterControl(
            documentContext,
            "#raster-appearance-controls"
        );
        this.palette = requireRasterControl(documentContext, "#raster-palette");
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
        this.handlers = null;
        this.boundStyleInput = this.#handleStyleInput.bind(this);
        this.boundStyleChange = this.#handleStyleChange.bind(this);
        this.boundPaletteChange = this.#handlePaletteChange.bind(this);
        this.boundResetStyle = this.#handleResetStyle.bind(this);
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
     * Attach direct appearance-control listeners to semantic handlers.
     *
     * @param {RasterAppearanceHandlers} handlers Appearance event handlers.
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
    }

    /**
     * Remove every direct listener installed by {@link bind}.
     *
     * @return {void}
     */
    unbind() {
        for (const input of Object.values(this.styleInputs)) {
            input.removeEventListener("input", this.boundStyleInput);
            input.removeEventListener("change", this.boundStyleChange);
        }
        this.palette.removeEventListener("change", this.boundPaletteChange);
        this.resetStyleButton.removeEventListener("click", this.boundResetStyle);
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
        this.legendLabels.midpoint.style.left = `${legend.midpointPosition}%`;
        for (const thresholdName of ["minimum", "midpoint", "maximum"]) {
            this.legendLabels[thresholdName].textContent = style[thresholdName];
        }
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

    /** Forward one completed style edit to the raster viewer. @return {void} */
    #handleStyleChange() {
        this.handlers.onStyleChange();
    }

    /** Forward one palette selection to the raster viewer. @return {void} */
    #handlePaletteChange() {
        this.handlers.onPaletteChange();
    }

    /** Forward the reset-style action to the raster viewer. @return {void} */
    #handleResetStyle() {
        this.handlers.onResetStyle();
    }
}
