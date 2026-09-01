/** Focused DOM owner for geometry-specific vector symbol controls. */

import { normalizeVectorStyle } from "./style.js";

/** Own vector style form state without knowing map or raster implementations. */
export class VectorStyleControls {
    /**
     * Bind the fixed vector symbol controls.
     *
     * @param {Document} [documentContext=globalThis.document] Owning document.
     */
    constructor(documentContext = globalThis.document) {
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
        this.applyButton = documentContext.querySelector("#apply-vector-style");
        this.status = documentContext.querySelector("#vector-style-status");
        this.inputs = [
            this.fillColor,
            this.fillOpacity,
            this.strokeColor,
            this.strokeOpacity,
            this.strokeWidth,
            this.pointSize,
        ];
        this.target = null;
        this.generation = 0;
        this.busy = false;
        this.onRangeInput = () => this.#renderRangeValues();
        this.onApply = () => void this.#apply();
        this.fillOpacity.addEventListener("input", this.onRangeInput);
        this.strokeOpacity.addEventListener("input", this.onRangeInput);
        this.applyButton.addEventListener("click", this.onApply);
    }

    /**
     * Show controls for one composition-provided vector style target.
     *
     * @param {{key:string,style:Object,apply:(style:Object)=>Promise<Object>}} target
     * Narrow vector target contract.
     * @return {void}
     */
    show(target) {
        const style = normalizeVectorStyle(target.style);
        const changedTarget = this.target?.key !== target.key;
        if (changedTarget) this.generation += 1;
        this.target = target;
        this.root.hidden = false;
        if (!changedTarget) return;
        this.heading.textContent = `${style.geometryKind[0].toUpperCase()}${style.geometryKind.slice(1)} symbol`;
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
        this.status.textContent = "";
        this.#renderRangeValues();
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
            });
        } catch (error) {
            this.status.textContent = error.message;
            return;
        }
        const target = this.target;
        const generation = this.generation;
        this.#setBusy(true);
        this.status.textContent = "Applying symbol…";
        try {
            const appliedStyle = normalizeVectorStyle(await target.apply(style));
            if (this.generation !== generation) return;
            this.target = { ...target, style: appliedStyle };
            this.status.textContent = "Symbol applied to the map.";
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
        for (const input of this.inputs) input.disabled = busy;
    }

    /** Update visible percentage labels for range controls. @return {void} */
    #renderRangeValues() {
        this.fillOpacityValue.textContent = `${this.fillOpacity.value}%`;
        this.strokeOpacityValue.textContent = `${this.strokeOpacity.value}%`;
    }
}
