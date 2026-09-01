/** Focused DOM owner for geometry-specific vector symbol controls. */

import { normalizeVectorStyle } from "./style.js";

const VECTOR_LABEL_DEFAULTS = Object.freeze({
    fontFamily: "SansSerif",
    fontSize: 12,
    fontWeight: "normal",
    fontColor: "#111827",
    haloColor: "#ffffff",
    haloWidth: 1.5,
    minimumZoom: 0,
});

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
        this.fillGroup = documentContext.querySelector("#vector-style-fill-group");
        this.pointGroup = documentContext.querySelector("#vector-style-point-group");
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
        this.target = null;
        this.generation = 0;
        this.busy = false;
        this.onRangeInput = () => this.#renderRangeValues();
        this.onLabelInput = () => {
            this.#synchronizeLabelInputs();
            this.#renderLabelNote();
        };
        this.onApply = () => void this.#apply();
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
     * apply:(style:Object)=>Promise<Object>}} target
     * Narrow vector target contract.
     * @return {void}
     */
    show(target) {
        const style = normalizeVectorStyle(target.style);
        const changedTarget = this.target?.key !== target.key;
        if (changedTarget) this.generation += 1;
        this.labelFields = Array.isArray(target.fields) ? target.fields : [];
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
        this.status.textContent = "";
        this.#renderRangeValues();
        this.#synchronizeLabelInputs();
        this.#renderLabelNote();
    }

    /** Hide and forget the current target. @return {void} */
    hide() {
        if (this.target !== null) this.generation += 1;
        this.target = null;
        this.#setBusy(false);
        this.root.hidden = true;
    }

    /** Detach direct control listeners. @return {void} */
    destroy() {
        this.hide();
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
    }

    /** Update visible percentage labels for range controls. @return {void} */
    #renderRangeValues() {
        this.fillOpacityValue.textContent = `${this.fillOpacity.value}%`;
        this.strokeOpacityValue.textContent = `${this.strokeOpacity.value}%`;
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
                `${this.labelMinimumZoom.value} and closer.`;
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
