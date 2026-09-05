/** Focused DOM owner for geometry-specific vector symbol controls. */

import {
    categoryValueKey,
    formatCategoryValue,
    formatNumericRange,
    normalizeVectorCategorySummary,
    normalizeVectorNumericClassification,
    normalizeVectorStyle,
    qualitativeCategoryColor,
    sequentialPaletteColors,
    vectorCategoricalFields,
    vectorNumericFields,
} from "./style.js";

import {
    defaultVectorLabelField,
    defaultVectorLabelPlacement,
    VECTOR_LABEL_DEFAULTS,
    VECTOR_NUMERIC_DEFAULTS,
} from "./defaults.js";
const LONG_LABEL_NOTE =
    "Labels may overlap to keep names visible. Centered and point labels wrap " +
    "across lines and stay anchored as you zoom.";

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
        this.graduatedFieldsRoot = documentContext.querySelector("#vector-graduated-fields");
        this.graduatedField = documentContext.querySelector("#vector-graduated-field");
        this.graduatedMethod = documentContext.querySelector("#vector-graduated-method");
        this.graduatedClassCount = documentContext.querySelector("#vector-graduated-class-count");
        this.graduatedPalette = documentContext.querySelector("#vector-graduated-palette");
        this.graduatedStatus = documentContext.querySelector("#vector-graduated-status");
        this.graduatedList = documentContext.querySelector("#vector-graduated-list");
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
        this.graduatedFields = [];
        this.categorySummary = null;
        this.graduatedSummary = null;
        this.categoryColors = new Map();
        this.categoryColorInputs = [];
        this.otherColor = "#9ca3af";
        this.missingColor = "#d1d5db";
        this.paletteGeneration = 0;
        this.categoryLoading = false;
        this.categoryRequest = 0;
        this.graduatedLoading = false;
        this.graduatedRequest = 0;
        this.graduatedMissingEnabled = false;
        this.graduatedMissingColor = "#d1d5db";
        this.graduatedMissingInputs = [];
        this.target = null;
        this.generation = 0;
        this.busy = false;
        /** Update range-value text after an opacity control changes. @return {void} */
        this.onRangeInput = () => this.#renderRangeValues();
        /** Synchronize label controls and guidance after a label input. @return {void} */
        this.onLabelInput = () => {
            this.#synchronizeLabelInputs();
            this.#renderLabelNote();
        };
        /** Start the asynchronous color-mode transition. @return {void} */
        this.onModeChange = () => void this.#changeColorMode();
        /** Reset and reload categories after the selected field changes. @return {void} */
        this.onCategoryFieldChange = () => {
            this.categorySummary = null;
            this.categoryColors.clear();
            this.paletteGeneration = 0;
            void this.#loadCategories();
        };
        /** Re-render retained category values after the limit changes. @return {void} */
        this.onCategoryLimitInput = () => this.#renderCategories();
        /** Replace generated category colors on explicit user request. @return {void} */
        this.onCategoryRegenerate = () => this.#regenerateCategoryColors();
        /** Reload numeric classes after a server-controlled option changes. @return {void} */
        this.onGraduatedClassificationChange = () => {
            this.graduatedSummary = null;
            void this.#loadGraduated();
        };
        /** Repaint current ranges after the palette changes. @return {void} */
        this.onGraduatedPaletteChange = () => this.#renderGraduated();
        /** Start the asynchronous complete-style application. @return {void} */
        this.onApply = () => void this.#apply();
        this.mode.addEventListener("change", this.onModeChange);
        this.categoryField.addEventListener("change", this.onCategoryFieldChange);
        this.categoryLimit.addEventListener("input", this.onCategoryLimitInput);
        this.categoryRegenerate.addEventListener("click", this.onCategoryRegenerate);
        this.graduatedField.addEventListener("change", this.onGraduatedClassificationChange);
        this.graduatedMethod.addEventListener("change", this.onGraduatedClassificationChange);
        this.graduatedClassCount.addEventListener("change", this.onGraduatedClassificationChange);
        this.graduatedPalette.addEventListener("change", this.onGraduatedPaletteChange);
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
     * @param {{key:string,style:Object,fields:ReadonlyArray,notice?:string,
     * summarize:(field:string)=>Promise<Object>,
     * classify:(field:string,method:string,classCount:number)=>Promise<Object>,
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
            this.graduatedRequest += 1;
            this.graduatedLoading = false;
        }
        this.labelFields = Array.isArray(target.fields) ? target.fields : [];
        this.categoryFields = vectorCategoricalFields(this.labelFields);
        this.graduatedFields = vectorNumericFields(this.labelFields);
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
        this.#renderGraduatedFields();
        this.#renderPlacementOptions(style.geometryKind);
        const label = style.label;
        const labelFieldAvailable = label !== null && this.labelFields.some(
            ({ name }) => name === label.field
        );
        this.labelEnabled.checked = labelFieldAvailable;
        this.labelField.value = labelFieldAvailable
            ? label.field : defaultVectorLabelField(this.labelFields) ?? this.labelFields[0]?.name ?? "";
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
            ? label.placement : defaultVectorLabelPlacement(style.geometryKind);
        this.labelMinimumZoom.value = String(
            label?.minimumZoom ?? VECTOR_LABEL_DEFAULTS.minimumZoom,
        );
        const categorical = style.categorical;
        const graduated = style.graduated;
        this.mode.value = categorical !== null
            ? "categories" : graduated !== null ? "graduated" : "single";
        this.categorySummary = null;
        this.graduatedSummary = null;
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
        this.graduatedField.value = graduated?.field ?? this.graduatedFields[0]?.name ?? "";
        this.graduatedMethod.value = graduated?.method ?? VECTOR_NUMERIC_DEFAULTS.method;
        this.graduatedClassCount.value = String(graduated?.classCount ?? 5);
        this.graduatedPalette.value = graduated?.palette ?? VECTOR_NUMERIC_DEFAULTS.palette;
        this.graduatedMissingEnabled = graduated?.missingColor !== null && graduated !== null;
        this.graduatedMissingColor = graduated?.missingColor ?? "#d1d5db";
        this.status.textContent = target.notice ?? "";
        this.categoryStatus.textContent = "";
        this.categoryList.replaceChildren();
        this.graduatedStatus.textContent = "";
        this.graduatedList.replaceChildren();
        this.#renderRangeValues();
        this.#renderColorMode();
        this.#synchronizeLabelInputs();
        this.#renderLabelNote();
        if (this.mode.value === "categories") void this.#loadCategories();
        if (this.mode.value === "graduated") void this.#loadGraduated();
    }

    /** Hide and forget the current target. @return {void} */
    hide() {
        if (this.target !== null) this.generation += 1;
        this.categoryRequest += 1;
        this.graduatedRequest += 1;
        this.target = null;
        this.categoryLoading = false;
        this.graduatedLoading = false;
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
        this.graduatedField.removeEventListener("change", this.onGraduatedClassificationChange);
        this.graduatedMethod.removeEventListener("change", this.onGraduatedClassificationChange);
        this.graduatedClassCount.removeEventListener("change", this.onGraduatedClassificationChange);
        this.graduatedPalette.removeEventListener("change", this.onGraduatedPaletteChange);
        this.fillOpacity.removeEventListener("input", this.onRangeInput);
        this.strokeOpacity.removeEventListener("input", this.onRangeInput);
        this.labelEnabled.removeEventListener("change", this.onLabelInput);
        this.labelField.removeEventListener("change", this.onLabelInput);
        this.labelMinimumZoom.removeEventListener("input", this.onLabelInput);
        this.applyButton.removeEventListener("click", this.onApply);
    }

    /**
     * Apply the complete form state through the narrow target callback.
     *
     * @return {Promise<void>} Resolves after validation and the current apply
     * request finish, or immediately when no target can accept a request.
     */
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
                graduated: this.mode.value === "graduated"
                    ? this.#graduatedState() : null,
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
            if (appliedStyle.graduated !== null) {
                this.graduatedClassCount.value = String(appliedStyle.graduated.classCount);
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
        this.#synchronizeGraduatedInputs();
    }

    /**
     * Update visible percentage labels from the current range controls.
     *
     * @return {void}
     */
    #renderRangeValues() {
        this.fillOpacityValue.textContent = `${this.fillOpacity.value}%`;
        this.strokeOpacityValue.textContent = `${this.strokeOpacity.value}%`;
    }

    /**
     * Switch between single-color and field-category controls.
     *
     * @return {Promise<void>} Resolves after any required bounded category
     * summary finishes loading.
     */
    async #changeColorMode() {
        this.#renderColorMode();
        if (this.mode.value !== "graduated") {
            this.graduatedRequest += 1;
            this.graduatedLoading = false;
            this.#synchronizeGraduatedInputs();
        }
        if (this.mode.value !== "categories") {
            this.categoryRequest += 1;
            this.categoryLoading = false;
            this.#synchronizeCategoryInputs();
        } else if (this.categoryFields.length === 0) {
            this.categoryStatus.textContent =
                "This Item has no text, integer, number, or boolean fields.";
        } else if (
            this.categorySummary === null ||
            this.categorySummary.field !== this.categoryField.value
        ) {
            await this.#loadCategories();
        } else {
            this.#renderCategories();
        }
        if (this.mode.value === "graduated" && this.graduatedFields.length === 0) {
            this.graduatedStatus.textContent = "This Item has no numeric fields.";
        } else if (
            this.mode.value === "graduated" &&
            !this.#graduatedSummaryMatchesControls()
        ) {
            await this.#loadGraduated();
        } else if (this.mode.value === "graduated") {
            this.#renderGraduated();
        }
        this.#synchronizeCategoryInputs();
        this.#synchronizeGraduatedInputs();
    }

    /**
     * Load the selected field's bounded category summary through the target.
     *
     * @return {Promise<void>} Resolves after the latest request renders or its
     * safe error is presented; stale requests leave current state unchanged.
     */
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

    /**
     * Load server-computed ranges for the selected numeric field and method.
     *
     * @return {Promise<void>} Resolves after the latest classification renders
     * or its safe error is presented; stale requests do not mutate the form.
     */
    async #loadGraduated() {
        const requestedClassCount = Number(this.graduatedClassCount.value);
        if (
            this.target === null || this.mode.value !== "graduated" ||
            !this.graduatedFields.some(({ name }) => name === this.graduatedField.value) ||
            !Number.isInteger(requestedClassCount)
        ) {
            this.#synchronizeGraduatedInputs();
            return;
        }
        const target = this.target;
        const generation = this.generation;
        const graduatedRequest = ++this.graduatedRequest;
        const field = this.graduatedField.value;
        const method = this.graduatedMethod.value;
        this.graduatedLoading = true;
        this.graduatedStatus.textContent = "Computing bounded numeric classes...";
        this.graduatedList.replaceChildren();
        this.#synchronizeGraduatedInputs();
        try {
            const summary = normalizeVectorNumericClassification(
                await target.classify(field, method, requestedClassCount)
            );
            if (
                this.generation !== generation ||
                this.graduatedRequest !== graduatedRequest ||
                this.target !== target ||
                this.graduatedField.value !== field ||
                this.graduatedMethod.value !== method ||
                Number(this.graduatedClassCount.value) !== requestedClassCount
            ) return;
            if (
                summary.field !== field || summary.method !== method ||
                summary.requestedClassCount !== requestedClassCount
            ) {
                throw new TypeError("Numeric classification changed unexpectedly.");
            }
            this.graduatedSummary = summary;
            this.graduatedClassCount.min = String(summary.minimumClassCount);
            this.graduatedClassCount.max = String(summary.maximumClassCount);
            this.#renderGraduated();
        } catch (error) {
            if (
                this.generation === generation &&
                this.graduatedRequest === graduatedRequest
            ) {
                this.graduatedSummary = null;
                this.graduatedStatus.textContent = error.message;
            }
        } finally {
            if (
                this.generation === generation &&
                this.graduatedRequest === graduatedRequest
            ) {
                this.graduatedLoading = false;
                this.#synchronizeGraduatedInputs();
            }
        }
    }

    /**
     * Build the complete graduated style block from current server ranges.
     *
     * @return {Object} Validated numeric field, method, palette, range rules,
     * and optional missing-value presentation.
     * @throws {TypeError} If the current classification is unavailable.
     */
    #graduatedState() {
        const summary = this.graduatedSummary;
        if (summary === null || !this.#graduatedSummaryMatchesControls()) {
            throw new TypeError("Wait for current numeric classes before applying.");
        }
        const colors = sequentialPaletteColors(
            this.graduatedPalette.value,
            summary.actualClassCount,
        );
        return {
            field: summary.field,
            method: summary.method,
            classCount: summary.requestedClassCount,
            palette: this.graduatedPalette.value,
            rules: summary.classes.map((classification, index) => ({
                minimum: classification.minimum,
                maximum: classification.maximum,
                color: colors[index],
            })),
            missingColor: summary.nullCount > 0 && this.graduatedMissingEnabled
                ? this.graduatedMissingColor : null,
        };
    }

    /**
     * Check whether current numeric controls identify the retained summary.
     *
     * @return {boolean} Whether the summary is safe to render and apply.
     */
    #graduatedSummaryMatchesControls() {
        return this.graduatedSummary !== null &&
            this.graduatedSummary.field === this.graduatedField.value &&
            this.graduatedSummary.method === this.graduatedMethod.value &&
            this.graduatedSummary.requestedClassCount === Number(
                this.graduatedClassCount.value
            );
    }

    /**
     * Build the complete categorical style block from the current summary.
     *
     * @return {Object} Validated-input category field, limit, typed rules, and
     * applicable Other and No value colors for the complete style request.
     * @throws {TypeError} If current values are unavailable or the limit is
     * invalid.
     */
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

    /**
     * Render the selected color mode without changing retained form state.
     *
     * @return {void}
     */
    #renderColorMode() {
        const categorical = this.mode.value === "categories";
        const graduated = this.mode.value === "graduated";
        const classified = categorical || graduated;
        this.categoryFieldsRoot.hidden = !categorical;
        this.graduatedFieldsRoot.hidden = !graduated;
        this.fillColorControl.hidden = classified;
        this.strokeColorControl.hidden = classified && this.fillGroup.hidden;
        this.#synchronizeCategoryInputs();
        this.#synchronizeGraduatedInputs();
    }

    /**
     * Apply availability, loading, and request state to category controls.
     *
     * @return {void}
     */
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
            this.busy ||
            (categorical && (this.categoryLoading || this.categorySummary === null)) ||
            (this.mode.value === "graduated" &&
                (this.graduatedLoading || !this.#graduatedSummaryMatchesControls()));
    }

    /**
     * Apply availability, loading, and request state to numeric controls.
     *
     * @return {void}
     */
    #synchronizeGraduatedInputs() {
        const graduated = this.mode.value === "graduated";
        const unavailable = this.graduatedFields.length === 0;
        const disabled = this.busy || this.graduatedLoading || unavailable;
        this.mode.disabled = this.busy;
        this.graduatedField.disabled = disabled;
        this.graduatedMethod.disabled = disabled || !graduated;
        this.graduatedClassCount.disabled = disabled || !graduated;
        this.graduatedPalette.disabled = this.busy || unavailable || !graduated;
        if (this.graduatedMissingInputs.length === 2) {
            const [enabled, missingColor] = this.graduatedMissingInputs;
            enabled.disabled = this.busy || this.graduatedLoading;
            missingColor.disabled =
                this.busy || this.graduatedLoading || !enabled.checked;
        }
        this.applyButton.disabled =
            this.busy ||
            (this.mode.value === "categories" &&
                (this.categoryLoading || this.categorySummary === null)) ||
            (graduated && (this.graduatedLoading || !this.#graduatedSummaryMatchesControls()));
    }

    /**
     * Replace the category selector with the retained eligible Catalog fields.
     *
     * @return {void}
     */
    #renderCategoryFields() {
        const options = this.categoryFields.map(({ name, type }) => {
            const option = this.document.createElement("option");
            option.value = name;
            option.textContent = `${name} (${type})`;
            return option;
        });
        this.categoryField.replaceChildren(...options);
    }

    /**
     * Replace the numeric selector with retained eligible Catalog fields.
     *
     * @return {void}
     */
    #renderGraduatedFields() {
        const options = this.graduatedFields.map(({ name, type }) => {
            const option = this.document.createElement("option");
            option.value = name;
            option.textContent = `${name} (${type})`;
            return option;
        });
        this.graduatedField.replaceChildren(...options);
    }

    /**
     * Replace every generated color while retaining values and ordering.
     *
     * @return {void}
     */
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

    /**
     * Render current explicit, Other, and No value category rows.
     *
     * @return {void}
     */
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

    /**
     * Create one compact category color row using text-only presentation.
     *
     * @param {string} label User-visible bounded category label.
     * @param {string} count User-visible exact or lower-bound feature count.
     * @param {string} currentColor Current validated six-digit hex color.
     * @param {(nextColor:string)=>void} onColor Retained-state color updater.
     * @return {HTMLLabelElement} Detached row ready for the category list.
     */
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

    /**
     * Explain category coverage and bounded-read completeness.
     *
     * @param {number} styledCount Number of explicit value rows being styled.
     * @return {void}
     */
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

    /**
     * Render current numeric ranges, palette swatches, and missing-value style.
     *
     * @return {void}
     */
    #renderGraduated() {
        const summary = this.graduatedSummary;
        if (summary === null || !this.#graduatedSummaryMatchesControls()) {
            this.graduatedList.replaceChildren();
            this.#synchronizeGraduatedInputs();
            return;
        }
        const colors = sequentialPaletteColors(
            this.graduatedPalette.value,
            summary.actualClassCount,
        );
        const rows = summary.classes.map((classification, index) =>
            this.#graduatedRow(
                formatNumericRange(classification),
                summary.complete ? String(classification.count) : `${classification.count}+`,
                colors[index],
            )
        );
        this.graduatedMissingInputs = [];
        if (summary.nullCount > 0) {
            rows.push(this.#graduatedMissingRow(summary));
        }
        this.graduatedList.replaceChildren(...rows);
        const coverage = summary.complete
            ? `${summary.numericValueCount} numeric values across ${summary.featureCount} features.`
            : `Classified ${summary.numericValueCount} numeric values in the first ` +
                `${summary.scannedFeatureCount} of ${summary.featureCount} features.`;
        const collapsed = summary.actualClassCount < summary.requestedClassCount
            ? ` Repeated breaks produced ${summary.actualClassCount} distinct classes.`
            : "";
        const unsupported = summary.unsupportedValueCount > 0
            ? ` ${summary.unsupportedValueCount} non-numeric or non-finite values are not styled.`
            : "";
        this.graduatedStatus.textContent = coverage + collapsed + unsupported;
        this.#synchronizeGraduatedInputs();
    }

    /**
     * Create one read-only numeric class row.
     *
     * @param {string} label User-visible range label.
     * @param {string} count Exact or lower-bound feature count.
     * @param {string} currentColor Sequential palette color.
     * @return {HTMLDivElement} Detached row ready for the numeric list.
     */
    #graduatedRow(label, count, currentColor) {
        const row = this.document.createElement("div");
        row.className = "vector-category-row vector-graduated-row";
        const swatch = this.document.createElement("span");
        swatch.className = "vector-graduated-swatch";
        swatch.style.backgroundColor = currentColor;
        swatch.setAttribute("aria-hidden", "true");
        const name = this.document.createElement("span");
        name.className = "vector-category-name";
        name.textContent = label;
        name.title = label;
        const featureCount = this.document.createElement("span");
        featureCount.className = "vector-category-count";
        featureCount.textContent = count;
        row.append(swatch, name, featureCount);
        return row;
    }

    /**
     * Create optional styling controls for null numeric values.
     *
     * @param {Object} summary Current numeric classification summary.
     * @return {HTMLLabelElement} Detached missing-value row.
     */
    #graduatedMissingRow(summary) {
        const row = this.document.createElement("label");
        row.className = "vector-category-row vector-graduated-row";
        const enabled = this.document.createElement("input");
        enabled.type = "checkbox";
        enabled.checked = this.graduatedMissingEnabled;
        enabled.setAttribute("aria-label", "Style features with no numeric value");
        const color = this.document.createElement("input");
        color.type = "color";
        color.value = this.graduatedMissingColor;
        color.disabled = this.busy || this.graduatedLoading || !enabled.checked;
        color.setAttribute("aria-label", "No value color");
        enabled.addEventListener("change", () => {
            this.graduatedMissingEnabled = enabled.checked;
            color.disabled = this.busy || this.graduatedLoading || !enabled.checked;
        });
        color.addEventListener("input", () => {
            this.graduatedMissingColor = color.value;
        });
        const name = this.document.createElement("span");
        name.className = "vector-category-name";
        name.textContent = "No value";
        const featureCount = this.document.createElement("span");
        featureCount.className = "vector-category-count";
        featureCount.textContent = summary.complete
            ? String(summary.nullCount) : `${summary.nullCount}+`;
        row.append(enabled, color, name, featureCount);
        this.graduatedMissingInputs.push(enabled, color);
        return row;
    }

    /**
     * Build complete label state from enabled form fields.
     *
     * @return {Object} Validated-input label field, typography, placement, and
     * minimum zoom for the complete style request.
     * @throws {TypeError} If the selected field is no longer in Catalog data.
     */
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

    /**
     * Replace label-field options with current Catalog metadata.
     *
     * @return {void}
     */
    #renderLabelFields() {
        const options = this.labelFields.map(({ name, type }) => {
            const option = this.document.createElement("option");
            option.value = name;
            option.textContent = `${name} (${type})`;
            return option;
        });
        this.labelField.replaceChildren(...options);
    }

    /**
     * Replace placement options for the current geometry class.
     *
     * @param {string} geometryKind Point, line, or polygon geometry class.
     * @return {void}
     */
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

    /**
     * Apply busy, availability, and enabled state to label fields.
     *
     * @return {void}
     */
    #synchronizeLabelInputs() {
        const unavailable = this.labelFields.length === 0;
        this.labelEnabled.disabled = this.busy || unavailable;
        const fieldsDisabled = this.busy || unavailable || !this.labelEnabled.checked;
        for (const input of this.labelInputs) input.disabled = fieldsDisabled;
    }

    /**
     * Explain current label availability and scale behavior.
     *
     * @return {void}
     */
    #renderLabelNote() {
        if (this.labelFields.length === 0) {
            this.labelNote.textContent = "This Item has no cataloged attribute fields.";
        } else if (!this.labelEnabled.checked) {
            this.labelNote.textContent = "Labels are off. Enable Show labels and choose Label by.";
        } else {
            this.labelNote.textContent =
                `Labels use ${this.labelField.value} at zoom ` +
                `${this.labelMinimumZoom.value} and closer. ` +
                LONG_LABEL_NOTE;
        }
    }
}
