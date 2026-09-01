/** Focused DOM owner for geometry-specific vector symbol controls. */

import {
    categoryValueKey,
    formatCategoryValue,
    normalizeVectorCategorySummary,
    normalizeVectorStyle,
    qualitativeCategoryColor,
    vectorCategoricalFields,
} from "./style.js";

const VECTOR_LABEL_DEFAULTS = Object.freeze({
    fontFamily: "SansSerif",
    fontSize: 12,
    fontWeight: "normal",
    fontColor: "#111827",
    haloColor: "#ffffff",
    haloWidth: 1.5,
    minimumZoom: 0,
});
const LONG_LABEL_NOTE =
    "Long values are not truncated and may be omitted when GeoServer " +
    "cannot place them without a conflict.";

/** Own vector style form state without knowing map or raster implementations. */
export class VectorStyleControls {
    /**
     * Bind the fixed vector symbol controls.
     *
     * @param {Document} [documentContext=globalThis.document] Owning document.
     */
    constructor(documentContext = globalThis.document) {
        this.document = documentContext;
        this.root = documentContext.querySelector("#layer-vector-style");
        this.heading = documentContext.querySelector("#vector-style-heading");
        this.mode = documentContext.querySelector("#vector-style-mode");
        this.categoryFieldsRoot = documentContext.querySelector("#vector-category-fields");
        this.categoryField = documentContext.querySelector("#vector-category-field");
        this.categoryLimit = documentContext.querySelector("#vector-category-limit");
        this.categoryRegenerate = documentContext.querySelector("#vector-category-regenerate");
        this.categoryStatus = documentContext.querySelector("#vector-category-status");
        this.categoryList = documentContext.querySelector("#vector-category-list");
        this.fillGroup = documentContext.querySelector("#vector-style-fill-group");
        this.pointGroup = documentContext.querySelector("#vector-style-point-group");
        this.fillColorControl = documentContext.querySelector("#vector-style-fill-color-control");
        this.strokeColorControl = documentContext.querySelector("#vector-style-stroke-color-control");
        this.fillColor = documentContext.querySelector("#vector-style-fill-color");
        this.fillOpacity = documentContext.querySelector("#vector-style-fill-opacity");
        this.fillOpacityValue = documentContext.querySelector("#vector-style-fill-opacity-value");
        this.strokeColor = documentContext.querySelector("#vector-style-stroke-color");
        this.strokeOpacity = documentContext.querySelector("#vector-style-stroke-opacity");
        this.strokeOpacityValue = documentContext.querySelector("#vector-style-stroke-opacity-value");
        this.strokeWidth = documentContext.querySelector("#vector-style-stroke-width");
        this.pointSize = documentContext.querySelector("#vector-style-point-size");
        this.labelEnabled = documentContext.querySelector("#vector-label-enabled");
        this.labelField = documentContext.querySelector("#vector-label-field");
        this.labelFontFamily = documentContext.querySelector("#vector-label-font-family");
        this.labelFontSize = documentContext.querySelector("#vector-label-font-size");
        this.labelFontWeight = documentContext.querySelector("#vector-label-font-weight");
        this.labelFontColor = documentContext.querySelector("#vector-label-font-color");
        this.labelHaloColor = documentContext.querySelector("#vector-label-halo-color");
        this.labelHaloWidth = documentContext.querySelector("#vector-label-halo-width");
        this.labelPlacement = documentContext.querySelector("#vector-label-placement");
        this.labelMinimumZoom = documentContext.querySelector("#vector-label-minimum-zoom");
        this.labelNote = documentContext.querySelector("#vector-label-note");
        this.applyButton = documentContext.querySelector("#apply-vector-style");
        this.status = documentContext.querySelector("#vector-style-status");
        this.symbolInputs = [
            this.fillColor,
            this.fillOpacity,
            this.strokeColor,
            this.strokeOpacity,
            this.strokeWidth,
            this.pointSize,
        ];
        this.labelInputs = [
            this.labelField,
            this.labelFontFamily,
            this.labelFontSize,
            this.labelFontWeight,
            this.labelFontColor,
            this.labelHaloColor,
            this.labelHaloWidth,
            this.labelPlacement,
            this.labelMinimumZoom,
        ];
        this.labelFields = [];
        this.categoryFields = [];
        this.categorySummary = null;
        this.categoryColors = new Map();
        this.categoryColorInputs = [];
        this.otherColor = "#9ca3af";
        this.missingColor = "#d1d5db";
        this.paletteGeneration = 0;
        this.categoryLoading = false;
        this.categoryRequest = 0;
        this.target = null;
        this.generation = 0;
        this.busy = false;
        this.onRangeInput = () => this.#renderRangeValues();
        this.onLabelInput = () => {
            this.#synchronizeLabelInputs();
            this.#renderLabelNote();
        };
        this.onModeChange = () => void this.#changeCategoryMode();
        this.onCategoryFieldChange = () => {
            this.categorySummary = null;
            this.categoryColors.clear();
            this.paletteGeneration = 0;
            void this.#loadCategories();
        };
        this.onCategoryLimitInput = () => this.#renderCategories();
        this.onCategoryRegenerate = () => this.#regenerateCategoryColors();
        this.onApply = () => void this.#apply();
        this.mode.addEventListener("change", this.onModeChange);
        this.categoryField.addEventListener("change", this.onCategoryFieldChange);
        this.categoryLimit.addEventListener("input", this.onCategoryLimitInput);
        this.categoryRegenerate.addEventListener("click", this.onCategoryRegenerate);
        this.fillOpacity.addEventListener("input", this.onRangeInput);
        this.strokeOpacity.addEventListener("input", this.onRangeInput);
        this.labelEnabled.addEventListener("change", this.onLabelInput);
        this.labelField.addEventListener("change", this.onLabelInput);
        this.labelMinimumZoom.addEventListener("input", this.onLabelInput);
        this.applyButton.addEventListener("click", this.onApply);
    }

    /**
     * Show controls for one composition-provided vector style target.
     *
     * @param {{key:string,style:Object,fields:ReadonlyArray,
     * summarize:(field:string)=>Promise<Object>,
     * apply:(style:Object)=>Promise<Object>}} target
     * Narrow vector target contract.
     * @return {void}
     */
    show(target) {
        const style = normalizeVectorStyle(target.style);
        const changedTarget = this.target?.key !== target.key;
        if (changedTarget) {
            this.generation += 1;
            this.categoryRequest += 1;
            this.categoryLoading = false;
        }
        this.labelFields = Array.isArray(target.fields) ? target.fields : [];
        this.categoryFields = vectorCategoricalFields(this.labelFields);
        this.target = { ...target, fields: this.labelFields };
        this.root.hidden = false;
        if (!changedTarget) return;
        this.heading.textContent = `${style.geometryKind[0].toUpperCase()}${style.geometryKind.slice(1)} style`;
        this.fillGroup.hidden = style.geometryKind === "line";
        this.pointGroup.hidden = style.geometryKind !== "point";
        if (style.fillColor !== null) this.fillColor.value = style.fillColor;
        if (style.fillOpacity !== null) {
            this.fillOpacity.value = String(Math.round(style.fillOpacity * 100));
        }
        this.strokeColor.value = style.strokeColor;
        this.strokeOpacity.value = String(Math.round(style.strokeOpacity * 100));
        this.strokeWidth.value = String(style.strokeWidth);
        if (style.pointSize !== null) this.pointSize.value = String(style.pointSize);
        this.#renderLabelFields();
        this.#renderCategoryFields();
        this.#renderPlacementOptions(style.geometryKind);
        const label = style.label;
        const labelFieldAvailable = label !== null && this.labelFields.some(
            ({ name }) => name === label.field
        );
        this.labelEnabled.checked = labelFieldAvailable;
        this.labelField.value = labelFieldAvailable
            ? label.field : this.labelFields[0]?.name ?? "";
        this.labelFontFamily.value =
            label?.fontFamily ?? VECTOR_LABEL_DEFAULTS.fontFamily;
        this.labelFontSize.value = String(
            label?.fontSize ?? VECTOR_LABEL_DEFAULTS.fontSize,
        );
        this.labelFontWeight.value =
            label?.fontWeight ?? VECTOR_LABEL_DEFAULTS.fontWeight;
        this.labelFontColor.value =
            label?.fontColor ?? VECTOR_LABEL_DEFAULTS.fontColor;
        this.labelHaloColor.value =
            label?.haloColor ?? VECTOR_LABEL_DEFAULTS.haloColor;
        this.labelHaloWidth.value = String(
            label?.haloWidth ?? VECTOR_LABEL_DEFAULTS.haloWidth,
        );
        this.labelPlacement.value = labelFieldAvailable
            ? label.placement : defaultPlacement(style.geometryKind);
        this.labelMinimumZoom.value = String(
            label?.minimumZoom ?? VECTOR_LABEL_DEFAULTS.minimumZoom,
        );
        const categorical = style.categorical;
        this.mode.value = categorical === null ? "single" : "categories";
        this.categorySummary = null;
        this.categoryColors.clear();
        this.paletteGeneration = 0;
        if (categorical !== null) {
            this.categoryField.value = categorical.field;
            this.categoryLimit.value = String(categorical.limit);
            for (const rule of categorical.rules) {
                this.categoryColors.set(categoryValueKey(rule.value), rule.color);
            }
            this.otherColor = categorical.otherColor ?? "#9ca3af";
            this.missingColor = categorical.missingColor ?? "#d1d5db";
        } else {
            this.categoryField.value = this.categoryFields[0]?.name ?? "";
            this.categoryLimit.value = "20";
            this.otherColor = "#9ca3af";
            this.missingColor = "#d1d5db";
        }
        this.status.textContent = "";
        this.categoryStatus.textContent = "";
        this.categoryList.replaceChildren();
        this.#renderRangeValues();
        this.#renderCategoryMode();
        this.#synchronizeLabelInputs();
        this.#renderLabelNote();
        if (this.mode.value === "categories") void this.#loadCategories();
    }

    /** Hide and forget the current target. @return {void} */
    hide() {
        if (this.target !== null) this.generation += 1;
        this.categoryRequest += 1;
        this.target = null;
        this.categoryLoading = false;
        this.#setBusy(false);
        this.root.hidden = true;
    }

    /** Detach direct control listeners. @return {void} */
    destroy() {
        this.hide();
        this.mode.removeEventListener("change", this.onModeChange);
        this.categoryField.removeEventListener("change", this.onCategoryFieldChange);
        this.categoryLimit.removeEventListener("input", this.onCategoryLimitInput);
        this.categoryRegenerate.removeEventListener("click", this.onCategoryRegenerate);
        this.fillOpacity.removeEventListener("input", this.onRangeInput);
        this.strokeOpacity.removeEventListener("input", this.onRangeInput);
        this.labelEnabled.removeEventListener("change", this.onLabelInput);
        this.labelField.removeEventListener("change", this.onLabelInput);
        this.labelMinimumZoom.removeEventListener("input", this.onLabelInput);
        this.applyButton.removeEventListener("click", this.onApply);
    }

    /** Apply the complete form state through the narrow target callback. */
    async #apply() {
        if (this.target === null || this.busy) return;
        let style;
        try {
            style = normalizeVectorStyle({
                geometryKind: this.target.style.geometryKind,
                fillColor: this.fillGroup.hidden ? null : this.fillColor.value,
                fillOpacity: this.fillGroup.hidden
                    ? null : Number(this.fillOpacity.value) / 100,
                strokeColor: this.strokeColor.value,
                strokeOpacity: Number(this.strokeOpacity.value) / 100,
                strokeWidth: Number(this.strokeWidth.value),
                pointSize: this.pointGroup.hidden ? null : Number(this.pointSize.value),
                categorical: this.mode.value === "categories"
                    ? this.#categoricalState() : null,
                label: this.labelEnabled.checked ? this.#labelState() : null,
            });
        } catch (error) {
            this.status.textContent = error.message;
            return;
        }
        const target = this.target;
        const generation = this.generation;
        this.#setBusy(true);
        this.status.textContent = "Applying style...";
        try {
            const appliedStyle = normalizeVectorStyle(await target.apply(style));
            if (this.generation !== generation) return;
            this.target = { ...target, style: appliedStyle };
            this.status.textContent = "Style applied to the map.";
            if (appliedStyle.categorical !== null) {
                this.categoryLimit.value = String(appliedStyle.categorical.limit);
            }
            this.#renderLabelNote();
        } catch (error) {
            if (this.generation === generation) {
                this.status.textContent = error.message;
            }
        } finally {
            if (this.generation === generation) this.#setBusy(false);
        }
    }

    /**
     * Lock or unlock every editable field for one atomic style request.
     *
     * @param {boolean} busy Whether a style request owns the form.
     * @return {void}
     */
    #setBusy(busy) {
        this.busy = busy;
        if (busy) this.root.setAttribute("aria-busy", "true");
        else this.root.removeAttribute("aria-busy");
        this.applyButton.disabled = busy;
        for (const input of this.symbolInputs) input.disabled = busy;
        this.#synchronizeLabelInputs();
        this.#synchronizeCategoryInputs();
    }

    /** Update visible percentage labels for range controls. @return {void} */
    #renderRangeValues() {
        this.fillOpacityValue.textContent = `${this.fillOpacity.value}%`;
        this.strokeOpacityValue.textContent = `${this.strokeOpacity.value}%`;
    }

    /** Switch between single-color and field-category controls. @return {Promise<void>} */
    async #changeCategoryMode() {
        this.#renderCategoryMode();
        if (this.mode.value !== "categories") {
            this.categoryRequest += 1;
            this.categoryLoading = false;
            this.#synchronizeCategoryInputs();
            return;
        }
        if (this.categoryFields.length === 0) {
            this.categoryStatus.textContent =
                "This Item has no text, integer, number, or boolean fields.";
            this.#synchronizeCategoryInputs();
            return;
        }
        if (
            this.categorySummary === null ||
            this.categorySummary.field !== this.categoryField.value
        ) {
            await this.#loadCategories();
        } else {
            this.#renderCategories();
        }
    }

    /** Load one bounded category summary through the composition callback. */
    async #loadCategories() {
        if (
            this.target === null || this.mode.value !== "categories" ||
            !this.categoryFields.some(({ name }) => name === this.categoryField.value)
        ) {
            this.#synchronizeCategoryInputs();
            return;
        }
        const target = this.target;
        const generation = this.generation;
        const categoryRequest = ++this.categoryRequest;
        const field = this.categoryField.value;
        this.categoryLoading = true;
        this.categoryStatus.textContent = "Reading bounded category counts...";
        this.categoryColorInputs = [];
        this.categoryList.replaceChildren();
        this.#synchronizeCategoryInputs();
        try {
            const summary = normalizeVectorCategorySummary(
                await target.summarize(field)
            );
            if (
                this.generation !== generation ||
                this.categoryRequest !== categoryRequest ||
                this.target !== target ||
                this.categoryField.value !== field
            ) return;
            if (summary.field !== field) {
                throw new TypeError("Category summary field changed unexpectedly.");
            }
            this.categorySummary = summary;
            this.categoryLimit.max = String(summary.maximumLimit);
            this.categoryLimit.setAttribute("max", String(summary.maximumLimit));
            const currentLimit = Number(this.categoryLimit.value);
            this.categoryLimit.value = String(
                Number.isInteger(currentLimit)
                    ? Math.min(summary.maximumLimit, Math.max(1, currentLimit))
                    : summary.defaultLimit
            );
            for (const [index, entry] of summary.values.entries()) {
                const key = categoryValueKey(entry.value);
                if (!this.categoryColors.has(key)) {
                    this.categoryColors.set(
                        key,
                        qualitativeCategoryColor(index, this.paletteGeneration),
                    );
                }
            }
            this.#renderCategories();
        } catch (error) {
            if (
                this.generation === generation &&
                this.categoryRequest === categoryRequest
            ) {
                this.categorySummary = null;
                this.categoryStatus.textContent = error.message;
            }
        } finally {
            if (
                this.generation === generation &&
                this.categoryRequest === categoryRequest
            ) {
                this.categoryLoading = false;
                this.#synchronizeCategoryInputs();
            }
        }
    }

    /** Build the complete categorical style block from the current summary. */
    #categoricalState() {
        const summary = this.categorySummary;
        if (summary === null || summary.field !== this.categoryField.value) {
            throw new TypeError("Wait for current category values before applying.");
        }
        const limit = Math.min(
            summary.maximumLimit,
            Math.max(1, Number(this.categoryLimit.value)),
        );
        if (!Number.isInteger(limit)) {
            throw new TypeError("Choose a whole-number category limit.");
        }
        const selectedValues = summary.values.slice(0, limit);
        if (selectedValues.length === 0) {
            throw new TypeError(
                "This field has no bounded non-null values to style individually."
            );
        }
        const hasOther =
            !summary.complete ||
            summary.observedDistinctCount > selectedValues.length ||
            summary.unsupportedValueCount > 0;
        return {
            field: summary.field,
            limit,
            rules: selectedValues.map(({ value }) => ({
                value,
                color: this.categoryColors.get(categoryValueKey(value)),
            })),
            otherColor: hasOther ? this.otherColor : null,
            missingColor: summary.nullCount > 0 ? this.missingColor : null,
        };
    }

    /** Render single/category mode without changing the retained form state. */
    #renderCategoryMode() {
        const categorical = this.mode.value === "categories";
        this.categoryFieldsRoot.hidden = !categorical;
        this.fillColorControl.hidden = categorical;
        this.strokeColorControl.hidden = categorical && this.fillGroup.hidden;
        this.#synchronizeCategoryInputs();
    }

    /** Apply availability, loading, and request state to category controls. */
    #synchronizeCategoryInputs() {
        const categorical = this.mode.value === "categories";
        const unavailable = this.categoryFields.length === 0;
        this.mode.disabled = this.busy;
        const disabled = this.busy || this.categoryLoading || unavailable;
        this.categoryField.disabled = disabled;
        this.categoryLimit.disabled = disabled || !categorical;
        this.categoryRegenerate.disabled =
            disabled || !categorical || this.categorySummary === null;
        for (const input of this.categoryColorInputs) input.disabled = disabled;
        this.applyButton.disabled =
            this.busy || (categorical && (this.categoryLoading || this.categorySummary === null));
    }

    /** Replace the category field selector with eligible Catalog fields. */
    #renderCategoryFields() {
        const options = this.categoryFields.map(({ name, type }) => {
            const option = this.document.createElement("option");
            option.value = name;
            option.textContent = `${name} (${type})`;
            return option;
        });
        this.categoryField.replaceChildren(...options);
    }

    /** Replace every generated color while retaining values and ordering. */
    #regenerateCategoryColors() {
        if (this.categorySummary === null || this.busy || this.categoryLoading) return;
        this.paletteGeneration += 1;
        for (const [index, entry] of this.categorySummary.values.entries()) {
            this.categoryColors.set(
                categoryValueKey(entry.value),
                qualitativeCategoryColor(index, this.paletteGeneration),
            );
        }
        this.#renderCategories();
    }

    /** Render current explicit, Other, and No value category rows. */
    #renderCategories() {
        const summary = this.categorySummary;
        if (summary === null) {
            this.categoryList.replaceChildren();
            this.#synchronizeCategoryInputs();
            return;
        }
        const requestedLimit = Number(this.categoryLimit.value);
        const limit = Number.isInteger(requestedLimit)
            ? Math.min(summary.maximumLimit, Math.max(1, requestedLimit))
            : summary.defaultLimit;
        this.categoryLimit.value = String(limit);
        const selectedValues = summary.values.slice(0, limit);
        this.categoryColorInputs = [];
        const rows = selectedValues.map(({ value, count }) => {
            const key = categoryValueKey(value);
            return this.#categoryRow(
                formatCategoryValue(value),
                String(count),
                this.categoryColors.get(key),
                (nextColor) => this.categoryColors.set(key, nextColor),
            );
        });
        const hasOther =
            !summary.complete ||
            summary.observedDistinctCount > selectedValues.length ||
            summary.unsupportedValueCount > 0;
        if (hasOther) {
            const selectedCount = selectedValues.reduce(
                (total, entry) => total + entry.count, 0
            );
            const observedOther = Math.max(
                0,
                summary.scannedFeatureCount - summary.nullCount - selectedCount,
            );
            rows.push(this.#categoryRow(
                "Other",
                summary.complete ? String(observedOther) : `${observedOther}+`,
                this.otherColor,
                (nextColor) => { this.otherColor = nextColor; },
            ));
        }
        if (summary.nullCount > 0) {
            rows.push(this.#categoryRow(
                "No value",
                summary.complete ? String(summary.nullCount) : `${summary.nullCount}+`,
                this.missingColor,
                (nextColor) => { this.missingColor = nextColor; },
            ));
        }
        this.categoryList.replaceChildren(...rows);
        this.#renderCategoryStatus(selectedValues.length);
        this.#synchronizeCategoryInputs();
    }

    /** Create one compact safe category color row. */
    #categoryRow(label, count, currentColor, onColor) {
        const row = this.document.createElement("label");
        row.className = "vector-category-row";
        const input = this.document.createElement("input");
        input.type = "color";
        input.value = currentColor;
        input.setAttribute("aria-label", `${label} color`);
        input.addEventListener("input", () => onColor(input.value));
        this.categoryColorInputs.push(input);
        const name = this.document.createElement("span");
        name.className = "vector-category-name";
        name.textContent = label;
        name.title = label;
        const featureCount = this.document.createElement("span");
        featureCount.className = "vector-category-count";
        featureCount.textContent = count;
        row.append(input, name, featureCount);
        return row;
    }

    /** Explain category coverage and bounded-read completeness. */
    #renderCategoryStatus(styledCount) {
        const summary = this.categorySummary;
        if (summary === null) return;
        const coverage = summary.complete
            ? `${summary.observedDistinctCount} distinct values across ` +
                `${summary.featureCount} features.`
            : `Observed ${summary.observedDistinctCount} values in the first ` +
                `${summary.scannedFeatureCount} of ${summary.featureCount} features.`;
        const unsupported = summary.unsupportedValueCount > 0
            ? ` ${summary.unsupportedValueCount} long or unsupported values use Other.`
            : "";
        const hasRemaining =
            !summary.complete || summary.observedDistinctCount > styledCount ||
            summary.unsupportedValueCount > 0;
        this.categoryStatus.textContent =
            `${coverage} Styling ${styledCount}` +
            (hasRemaining ? "; remaining values use Other." : ".") + unsupported;
    }

    /** Build complete label state from enabled form fields. @return {Object} */
    #labelState() {
        if (!this.labelFields.some(({ name }) => name === this.labelField.value)) {
            throw new TypeError("Choose a current Catalog attribute field.");
        }
        return {
            field: this.labelField.value,
            fontFamily: this.labelFontFamily.value,
            fontSize: Number(this.labelFontSize.value),
            fontWeight: this.labelFontWeight.value,
            fontColor: this.labelFontColor.value,
            haloColor: this.labelHaloColor.value,
            haloWidth: Number(this.labelHaloWidth.value),
            placement: this.labelPlacement.value,
            minimumZoom: Number(this.labelMinimumZoom.value),
        };
    }

    /** Replace field selector options with current Catalog metadata. @return {void} */
    #renderLabelFields() {
        const options = this.labelFields.map(({ name, type }) => {
            const option = this.document.createElement("option");
            option.value = name;
            option.textContent = `${name} (${type})`;
            return option;
        });
        this.labelField.replaceChildren(...options);
    }

    /** Replace placement options for the current geometry class. @param {string} geometryKind Geometry class. @return {void} */
    #renderPlacementOptions(geometryKind) {
        const placements = geometryKind === "line"
            ? [
                ["follow-line", "Follow line"],
                ["center", "Centered"],
                ["above", "Above line"],
                ["below", "Below line"],
            ]
            : [
                ["center", "Centered"],
                ["above", geometryKind === "point" ? "Above point" : "Above center"],
                ["below", geometryKind === "point" ? "Below point" : "Below center"],
            ];
        this.labelPlacement.replaceChildren(...placements.map(([value, text]) => {
            const option = this.document.createElement("option");
            option.value = value;
            option.textContent = text;
            return option;
        }));
    }

    /** Apply busy, availability, and enabled state to label fields. @return {void} */
    #synchronizeLabelInputs() {
        const unavailable = this.labelFields.length === 0;
        this.labelEnabled.disabled = this.busy || unavailable;
        const fieldsDisabled = this.busy || unavailable || !this.labelEnabled.checked;
        for (const input of this.labelInputs) input.disabled = fieldsDisabled;
    }

    /** Explain current label availability and scale behavior. @return {void} */
    #renderLabelNote() {
        if (this.labelFields.length === 0) {
            this.labelNote.textContent = "This Item has no cataloged attribute fields.";
        } else if (!this.labelEnabled.checked) {
            this.labelNote.textContent = "Labels are off by default.";
        } else {
            this.labelNote.textContent =
                `Labels use ${this.labelField.value} at zoom ` +
                `${this.labelMinimumZoom.value} and closer. ` +
                LONG_LABEL_NOTE;
        }
    }
}

/**
 * Return the initial label placement for one geometry class.
 *
 * @param {string} geometryKind Point, line, or polygon.
 * @return {string} Geometry-appropriate placement value.
 */
function defaultPlacement(geometryKind) {
    return geometryKind === "line" ? "follow-line" : "center";
}
