/**
 * DOM presentation adapter for raster appearance controls.
 *
 * This adapter owns palette and color-stop lookup, appearance listeners,
 * candidate-style reads, legend rendering, and validation presentation. It
 * contains no raster lifecycle, renderer, statistics, or request decisions.
 */
import { requireRasterControl } from "./required-control.js";
import { buildRasterLegend, MAX_RASTER_COLOR_RANGES } from "./style.js";
import { CategoricalRasterEditorView } from "./categorical-editor-view.js";

const opacityPercentFormat = new Intl.NumberFormat("en-US", {
    style: "percent", useGrouping: false, maximumSignificantDigits: 17,
});

/**
 * Show the full saved opacity as a decimal percentage in a number input.
 * @param {number} opacity Fraction from zero through one.
 * @return {string} Input text without the percent sign already in the label.
 */
function formatOpacityPercent(opacity) {
    return opacityPercentFormat.format(opacity).slice(0, -1);
}

/**
 * Convert percent text to a fraction before rounding it to a JavaScript number.
 * @param {HTMLInputElement} input Numeric percentage, optionally in scientific notation.
 * @return {number} Opacity fraction, or NaN for an empty field.
 */
function readOpacityPercent(input) {
    const [digits, exponent = "0"] = String(input.value).toLowerCase().split("e");
    return digits === "" ? NaN : Number(`${digits}e${Number(exponent) - 2}`);
}

/**
 * Read an optional numeric bound while preserving an unfinished number for validation.
 * @param {HTMLInputElement} input Inclusive lower or upper bound.
 * @return {number|null} Finite input, null for an open bound, or NaN for invalid text.
 */
function readRangeBound(input) {
    if (input.validity?.badInput) return NaN;
    return input.value === "" ? null : Number(input.value);
}

/**
 * @typedef {Object} RangeRow
 * @property {HTMLFieldSetElement} root Editable range.
 * @property {HTMLLegendElement} legend Range position in matching order.
 * @property {Record<"minimum"|"maximum"|"color"|"opacity",HTMLInputElement>} inputs Style fields.
 * @property {HTMLButtonElement} remove Button for removing this rule.
 */

/**
 * @typedef {Object} RasterAppearanceHandlers
 * @property {(isColor: boolean) => void} onStyleInput Handles style edits.
 * @property {() => void} onValueOverrideInput Previews exact-value and range edits independently of the gradient.
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
     * @param {Pick<Document,"querySelector"|"createElement">} [documentContext=globalThis.document]
     * Document or scoped DOM adapter that owns this instance's controls.
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
        this.reverseColorsButton = requireRasterControl(documentContext, "#reverse-raster-colors");
        this.appearanceMode = requireRasterControl(documentContext, "#raster-appearance-mode");
        this.continuousControls = requireRasterControl(documentContext, "#raster-continuous-controls");
        this.categoricalEditor = new CategoricalRasterEditorView(documentContext);
        this.overrideEnabled = requireRasterControl(documentContext, "#raster-value-override-enabled");
        this.overrideFields = requireRasterControl(documentContext, "#raster-value-override-fields");
        this.overrideError = requireRasterControl(documentContext, "#raster-override-error");
        this.rangeList = requireRasterControl(documentContext, "#raster-color-ranges");
        this.rangeGuidance = requireRasterControl(documentContext, "#raster-range-guidance");
        this.rangeError = requireRasterControl(documentContext, "#raster-range-error");
        this.addRange = requireRasterControl(documentContext, "#add-raster-color-range");
        /** @type {RangeRow[]} */
        this.rangeRows = [];
        this.overrideInputs = {
            overrideValue: requireRasterControl(documentContext, "#raster-override-value"),
            overrideColor: requireRasterControl(documentContext, "#raster-override-color"),
            overrideOpacity: requireRasterControl(documentContext, "#raster-override-opacity"),
        };
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
        this.overrideLegend = requireRasterControl(documentContext, "#raster-override-legend");
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
        this.boundOverrideInput = () => {
            this.overrideFields.hidden = !this.overrideEnabled.checked;
            this.handlers.onValueOverrideInput();
        };
        this.boundAddRange = () => {
            const row = this.#appendRange();
            this.#refreshRangeControls();
            row.inputs.minimum.focus();
            this.handlers.onValueOverrideInput();
        };
        this.boundRemoveRange = event => {
            const index = this.rangeRows.findIndex(row => row.remove === event.target);
            if (index < 0) return;
            const [row] = this.rangeRows.splice(index, 1);
            row.root.remove();
            this.#refreshRangeControls();
            (this.rangeRows[index]?.remove ?? this.addRange).focus();
            this.handlers.onStyleChange();
        };
        this.boundPaletteChange = this.#handlePaletteChange.bind(this);
        this.boundReverseColors = this.#reverseColors.bind(this);
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
        this.addRange.addEventListener("click", this.boundAddRange);
        this.rangeList.addEventListener("click", this.boundRemoveRange);
        this.rangeList.addEventListener("input", this.boundOverrideInput);
        this.rangeList.addEventListener("change", this.boundStyleChange);
        for (const input of [this.overrideEnabled, ...Object.values(this.overrideInputs)]) {
            input.addEventListener("input", this.boundOverrideInput);
            input.addEventListener("change", this.boundStyleChange);
        }
        this.reverseColorsButton.addEventListener("click", this.boundReverseColors);
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
        this.addRange.removeEventListener("click", this.boundAddRange);
        this.rangeList.removeEventListener("click", this.boundRemoveRange);
        this.rangeList.removeEventListener("input", this.boundOverrideInput);
        this.rangeList.removeEventListener("change", this.boundStyleChange);
        for (const input of [this.overrideEnabled, ...Object.values(this.overrideInputs)]) {
            input.removeEventListener("input", this.boundOverrideInput);
            input.removeEventListener("change", this.boundStyleChange);
        }
        this.reverseColorsButton.removeEventListener("click", this.boundReverseColors);
        this.resetStyleButton.removeEventListener("click", this.boundResetStyle);
        this.appearanceMode.removeEventListener("change", this.boundAppearanceModeChange);
        this.categoricalEditor.unbind();
        this.handlers = null;
    }

    /**
     * Show appearance controls for a styleable raster, or hide them when no
     * raster owns the shared controls and cancel its transient CSV import.
     *
     * @param {boolean} isAvailable Whether an active raster can be styled.
     * @return {void}
     */
    setActiveRasterAvailable(isAvailable) {
        if (!isAvailable) this.cancelCategoricalImport();
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
     * @return {import("./style.js").RasterStyle} Gradient stops and the enabled
     * exact-value and range rules. A blank range bound leaves that end open.
     */
    readStyle() {
        const {overrideValue, overrideColor, overrideOpacity} = this.overrideInputs;
        return {
            ...(this.rangeRows.length ? {rangeOverrides: this.rangeRows.map(({inputs}) => ({
                minimum: readRangeBound(inputs.minimum),
                maximum: readRangeBound(inputs.maximum),
                color: inputs.color.value,
                opacity: readOpacityPercent(inputs.opacity),
            }))} : {}),
            ...(this.overrideEnabled.checked ? {valueOverride: {
                value: overrideValue.value === "" ? NaN : Number(overrideValue.value),
                color: overrideColor.value,
                opacity: readOpacityPercent(overrideOpacity),
            }} : {}),
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
                return [field, readOpacityPercent(this.styleInputs[field])];
            })),
        };
    }

    /**
     * Display one committed style and palette in the appearance controls.
     *
     * @param {import("./style.js").RasterStyle} style Committed ramp and optional exact-value and range styles.
     * @param {string} paletteName Selected palette name.
     * @return {void}
     */
    setStyle(style, paletteName) {
        const override = style.valueOverride;
        this.overrideEnabled.checked = Boolean(override);
        this.overrideFields.hidden = !override;
        this.overrideInputs.overrideValue.value = override?.value ?? 0;
        this.overrideInputs.overrideColor.value = override?.color ?? "#e57149";
        this.overrideInputs.overrideOpacity.value = formatOpacityPercent(override?.opacity ?? 0);
        this.rangeList.replaceChildren();
        this.rangeRows = [];
        for (const range of style.rangeOverrides ?? []) this.#appendRange(range);
        this.#refreshRangeControls();
        for (const fieldName of Object.keys(this.styleInputs)) {
            this.styleInputs[fieldName].value = fieldName.endsWith("Opacity")
                ? formatOpacityPercent(style[fieldName] ?? 1)
                : style[fieldName];
        }
        this.palette.value = paletteName;
        this.renderLegend(style);
        this.renderStyleError();
    }

    /**
     * Append the inputs for an inclusive color range in matching order.
     * @param {import("./style.js").RasterColorRange} [range] Saved range, or a new blank draft.
     * @return {RangeRow} Attached controls for reading, validation, and focus.
     */
    #appendRange(range = {minimum: null, maximum: null, color: "#ff00ff", opacity: 1}) {
        const doc = this.documentContext;
        const root = doc.createElement("fieldset");
        root.className = "raster-category-row";
        root.setAttribute("aria-describedby", "raster-range-guidance raster-range-error");
        const legend = doc.createElement("legend");
        const fields = doc.createElement("div");
        fields.className = "raster-category-fields";
        const inputs = {};
        for (const [key, caption] of Object.entries({
            minimum: "From (inclusive)", maximum: "Through (inclusive)", color: "Color", opacity: "Opacity %",
        })) {
            const label = doc.createElement("label");
            label.textContent = caption;
            const input = doc.createElement("input");
            input.type = key === "color" ? "color" : "number";
            if (input.type === "number") input.step = "any";
            if (key === "opacity") {
                input.min = "0";
                input.max = "100";
                input.value = formatOpacityPercent(range.opacity);
            } else {
                input.value = range[key] ?? "";
                if (key === "minimum") input.placeholder = "No minimum";
                if (key === "maximum") input.placeholder = "No maximum";
            }
            input.setAttribute("aria-describedby", "raster-range-error");
            label.append(input);
            fields.append(label);
            inputs[key] = input;
        }
        const actions = doc.createElement("div");
        actions.className = "raster-category-actions";
        const remove = doc.createElement("button");
        remove.type = "button";
        remove.className = "secondary-button";
        remove.textContent = "Remove range";
        actions.append(remove);
        root.append(legend, fields, actions);
        this.rangeList.append(root);
        const row = {root, legend, inputs, remove};
        this.rangeRows.push(row);
        return row;
    }

    /** Update row numbering and availability after a range or editing target changes. @return {void} */
    #refreshRangeControls() {
        this.rangeGuidance.hidden = this.rangeRows.length === 0;
        this.addRange.disabled = this.overrideEnabled.disabled || this.rangeRows.length >= MAX_RASTER_COLOR_RANGES;
        for (const [index, row] of this.rangeRows.entries()) {
            row.legend.textContent = `Range ${index + 1}`;
            row.remove.setAttribute("aria-label", `Remove range ${index + 1}`);
            row.root.disabled = this.overrideEnabled.disabled;
        }
    }

    /**
     * Select the editor presentation without deciding which style is rendered.
     * A categorical draft may be shown while the last valid style remains active.
     * Leaving categorical mode cancels its preview and any pending CSV read.
     * @param {"continuous"|"categorical"} mode Selected appearance editor.
     * @return {void}
     */
    setAppearanceMode(mode) {
        this.appearanceMode.value = mode;
        const categorical = mode === "categorical";
        if (!categorical) this.cancelCategoricalImport();
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
     * Discard a pending CSV preview or read without changing category drafts.
     * @return {void}
     */
    cancelCategoricalImport() {
        this.categoricalEditor.cancelCategoricalImport();
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
     * @param {(Error & {fieldGroup?: string,rangeIndex?:number,rangeFields?:string[]})|null} [styleError=null] Error to
     * show.
     * @return {void}
     */
    renderStyleError(styleError = null) {
        const overrideInput = this.overrideInputs[styleError?.fieldGroup];
        const rangeError = styleError?.fieldGroup === "ranges";
        this.styleError.textContent = overrideInput || rangeError ? "" : styleError?.message ?? "";
        this.overrideError.textContent = overrideInput ? styleError.message : "";
        this.rangeError.textContent = rangeError ? styleError.message : "";
        for (const {inputs} of this.rangeRows) {
            for (const input of Object.values(inputs)) input.removeAttribute("aria-invalid");
        }
        for (const input of [...Object.values(this.styleInputs), ...Object.values(this.overrideInputs)]) {
            input.removeAttribute("aria-invalid");
        }
        if (overrideInput) {
            overrideInput.setAttribute("aria-invalid", "true");
            return;
        }
        if (rangeError) {
            for (const key of styleError.rangeFields ?? []) {
                this.rangeRows[styleError.rangeIndex].inputs[key].setAttribute("aria-invalid", "true");
            }
            return;
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
     * @param {import("./style.js").RasterStyle} style Committed gradient and optional override swatches.
     * @return {void}
     */
    renderLegend(style) {
        const legend = buildRasterLegend(style);
        this.legend.style.backgroundImage = legend.gradient +
            ", repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%)";
        this.legend.style.backgroundSize = "100% 100%, 10px 10px";
        this.legend.setAttribute("aria-label", legend.description);
        this.overrideLegend.hidden = !legend.overrides;
        this.overrideLegend.replaceChildren();
        for (const {label, color, opacity} of legend.overrides ?? []) {
            const doc = this.documentContext;
            const item = doc.createElement("li");
            const swatch = doc.createElement("span");
            swatch.className = "map-layer-legend-gradient";
            swatch.setAttribute("aria-hidden", "true");
            const fill = doc.createElement("span");
            fill.style.backgroundColor = color;
            fill.style.opacity = String(opacity);
            swatch.append(fill);
            const text = doc.createElement("span");
            text.textContent = label;
            item.append(swatch, text);
            this.overrideLegend.append(item);
        }
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
        for (const input of [this.overrideEnabled, ...Object.values(this.overrideInputs), ...Object.values(this.styleInputs)]) {
            input.disabled = !isEnabled;
        }
        this.palette.disabled = !isEnabled;
        this.reverseColorsButton.disabled = !isEnabled;
        this.appearanceMode.disabled = !isEnabled;
        this.categoricalEditor.setEnabled(isEnabled);
        this.#refreshRangeControls();
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

    /**
     * Swap endpoint colors and commit through the ordinary color-edit handlers.
     * Other input values, including any unfinished numeric edits, are unchanged.
     *
     * @return {void}
     */
    #reverseColors() {
        const { minimumColor, maximumColor } = this.styleInputs;
        [minimumColor.value, maximumColor.value] = [maximumColor.value, minimumColor.value];
        this.setStatus("");
        this.handlers.onStyleInput(true);
        this.handlers.onStyleChange();
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
