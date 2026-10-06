/**
 * DOM presentation adapter for raster appearance controls.
 *
 * This adapter owns palette and color-stop lookup, appearance listeners,
 * candidate-style reads, legend rendering, and validation presentation. It
 * contains no raster lifecycle, renderer, statistics, or request decisions.
 */
import { requireRasterControl } from "./required-control.js";
import { buildRasterLegend } from "./style.js";
import { CategoricalRasterEditorView } from "./categorical-editor-view.js";

/**
 * @typedef {Object} RasterAppearanceHandlers
 * @property {(isColor: boolean) => void} onStyleInput Handles style edits.
 * @property {() => void} onStyleChange Commits a completed style edit.
 * @property {() => void} onPaletteChange Applies a selected color palette.
 * @property {() => void} onResetStyle Restores the initial raster style.
 * @property {(mode: "continuous"|"categorical") => void} onAppearanceModeChange
 * Selects a retained appearance mode or starts a categorical draft.
 * @property {() => void} onCategoricalStyleInput Validates a category draft.
 * @property {() => void} onCategoricalStyleChange Commits a completed category edit.
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
        this.activeLayerLabel = requireRasterControl(
            documentContext,
            "#raster-appearance-layer"
        );
        this.palette = requireRasterControl(documentContext, "#raster-palette");
        this.appearanceMode = requireRasterControl(documentContext, "#raster-appearance-mode");
        this.continuousControls = requireRasterControl(documentContext, "#raster-continuous-controls");
        this.categoricalEditor = new CategoricalRasterEditorView(documentContext);
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
            minimumOpacity: requireRasterControl(documentContext, "#raster-minimum-opacity"),
            midpointOpacity: requireRasterControl(documentContext, "#raster-midpoint-opacity"),
            maximumOpacity: requireRasterControl(documentContext, "#raster-maximum-opacity"),
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
        this.status = requireRasterControl(
            documentContext,
            "#raster-appearance-status"
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
        this.boundAppearanceModeChange = () => {
            this.setAppearanceMode(this.appearanceMode.value);
            this.handlers?.onAppearanceModeChange?.(this.appearanceMode.value);
        };
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
        this.appearanceMode.addEventListener("change", this.boundAppearanceModeChange);
        this.categoricalEditor.bind(handlers);
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
        this.appearanceMode.removeEventListener("change", this.boundAppearanceModeChange);
        this.categoricalEditor.unbind();
        this.handlers = null;
    }

    /**
     * Show appearance controls for a styleable raster, or hide them when no
     * raster owns the shared controls.
     *
     * @param {boolean} isAvailable Whether an active raster can be styled.
     * @return {void}
     */
    setActiveRasterAvailable(isAvailable) {
        this.#root.hidden = !isAvailable;
        this.#root.setAttribute("aria-hidden", String(!isAvailable));
    }

    /**
     * Identify the rendered raster edited by these appearance controls.
     *
     * @param {string} label Readable raster label.
     * @param {boolean} visible Whether the retained layer is map-visible.
     * @return {void}
     */
    setActiveLayer(label, visible) {
        this.activeLayerLabel.textContent = visible
            ? label
            : `${label} — currently hidden on the map`;
        this.setStatus("");
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
            ...Object.fromEntries(["minimum", "midpoint", "maximum"].map((stop) => {
                const field = `${stop}Opacity`;
                const value = this.styleInputs[field].value;
                return [field, value === "" ? Number.NaN : Number(value) / 100];
            })),
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
            this.styleInputs[fieldName].value = fieldName.endsWith("Opacity")
                ? Math.round((style[fieldName] ?? 1) * 10000) / 100
                : style[fieldName];
        }
        this.palette.value = paletteName;
        this.renderLegend(style);
        this.renderStyleError();
    }

    /**
     * Select the editor presentation without deciding which style is rendered.
     * A categorical draft may be shown while the last valid style remains active.
     * @param {"continuous"|"categorical"} mode Selected appearance editor.
     * @return {void}
     */
    setAppearanceMode(mode) {
        this.appearanceMode.value = mode;
        const categorical = mode === "categorical";
        this.continuousControls.hidden = categorical;
        this.categoricalEditor.root.hidden = !categorical;
        this.resetStyleButton.hidden = categorical;
    }

    /**
     * Restore one layer's retained categorical appearance or empty starter draft.
     * @param {Readonly<import("./categorical-style.js").CategoricalRasterStyle>|null}
     * style Committed appearance, or null when no categories have been defined.
     * @return {void}
     */
    setCategoricalStyle(style) {
        this.categoricalEditor.setStyle(style);
    }

    /**
     * Read a complete, validated category draft without changing rendered state.
     * @return {Readonly<import("./categorical-style.js").CategoricalRasterStyle>}
     * Normalized immutable categorical appearance.
     * @throws {Error} If the category table or unmapped appearance is invalid.
     */
    readCategoricalStyle() {
        return this.categoricalEditor.readStyle();
    }

    /**
     * Present category-table validation feedback beside the editor.
     * @param {Error|null} [error=null] Validation error, or null to clear it.
     * @return {void}
     */
    renderCategoricalError(error = null) {
        this.categoricalEditor.renderError(error);
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
            : styleError.fieldGroup === "opacities"
                ? ["minimumOpacity", "midpointOpacity", "maximumOpacity"]
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
        this.legend.style.backgroundImage = legend.gradient +
            ", repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%)";
        this.legend.style.backgroundSize = "100% 100%, 10px 10px";
        this.legend.setAttribute("aria-label", legend.description);
        for (const thresholdName of ["minimum", "midpoint", "maximum"]) {
            this.legendLabels[thresholdName].textContent = style[thresholdName];
        }
    }

    /**
     * Set whether ordinary single-raster appearance editing is available.
     *
     * @param {boolean} isEnabled Whether ordinary appearance inputs may edit.
     * @return {void}
     */
    setEnabled(isEnabled) {
        for (const input of Object.values(this.styleInputs)) {
            input.disabled = !isEnabled;
        }
        this.palette.disabled = !isEnabled;
        this.appearanceMode.disabled = !isEnabled;
        this.categoricalEditor.setEnabled(isEnabled);
        this.resetStyleButton.disabled = !isEnabled;
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

    /**
     * Announce the result of an appearance action beside the style controls.
     *
     * @param {string} message Concise result, or an empty string to clear it.
     * @return {void}
     * @throws {TypeError} If the message is not a string.
     */
    setStatus(message) {
        if (typeof message !== "string") {
            throw new TypeError("Raster appearance status must be a string");
        }
        this.status.textContent = message;
    }

}
