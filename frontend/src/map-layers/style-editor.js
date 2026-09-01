/** One non-modal editor, keyed independently from histogram selection. */
export class MapLayerStyleEditor {
    /**
     * Bind layer editing within the shared non-modal map inspector.
     * @param {Object} dependencies Layer, raster, and presentation adapters.
     * @param {Object} dependencies.mapLayers Retained layer controller.
     * @param {Object} dependencies.rasterViewer Raster styling boundary.
     * @param {Object} dependencies.inspection Shared map-side presentation.
     * @param {Object} [dependencies.vectorStyleControls] Vector-owned controls.
     * @param {(key:string)=>Object|null} [dependencies.getVectorStyleTarget]
     * Composition callback returning one narrow vector style target.
     * @param {Document} [dependencies.documentContext=document] Owning document.
     */
    constructor({
        mapLayers,
        rasterViewer,
        inspection,
        vectorStyleControls = { show() {}, hide() {} },
        getVectorStyleTarget = () => null,
        documentContext = document,
    }) {
        this.mapLayers = mapLayers;
        this.rasterViewer = rasterViewer;
        this.inspection = inspection;
        this.vectorStyleControls = vectorStyleControls;
        this.getVectorStyleTarget = getVectorStyleTarget;
        this.document = documentContext;
        this.root = documentContext.querySelector("#layer-style-editor");
        this.title = documentContext.querySelector("#layer-style-title");
        this.opacity = documentContext.querySelector("#layer-style-opacity");
        this.opacityValue = documentContext.querySelector("#layer-style-opacity-value");
        this.note = documentContext.querySelector("#layer-style-note");
        this.rasterControls = documentContext.querySelector("#layer-raster-style");
        this.pairedControls = documentContext.querySelector("#layer-paired-style");
        this.closeButton = documentContext.querySelector("#close-layer-style");
        this.key = null;
        this.onClose = () => this.close();
        this.onKeydown = (event) => {
            if (event.key !== "Escape" || this.key === null ||
                !this.root.contains(this.document.activeElement)) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.close();
        };
        this.onOpacity = () => {
            if (this.key === null || this.opacity.disabled) return;
            this.mapLayers.setOpacity(this.key, Number(this.opacity.value) / 100);
            this.refresh();
        };
        this.closeButton.addEventListener("click", this.onClose);
        this.opacity.addEventListener("input", this.onOpacity);
        documentContext.addEventListener("keydown", this.onKeydown, true);
    }

    /**
     * Open one layer's controls without changing the histogram target.
     * @param {string} key Retained layer identity.
     * @return {void}
     */
    open(key) {
        if (this.key !== null) this.rasterViewer.closeStyle();
        this.key = key;
        this.opener = this.document.activeElement;
        this.isRaster = this.rasterViewer.openStyle(key);
        this.refresh();
        if (this.key === null) return;
        this.inspection.showStyle();
        this.closeButton.focus();
    }

    /** Synchronize controls with the independently keyed editing target. @return {void} */
    refresh() {
        if (this.key === null) return;
        const layer = this.mapLayers.snapshots().find(
            ({ key }) => key === this.key
        );
        if (!layer) {
            this.close();
            return;
        }
        this.title.textContent = layer.label;
        const locked = layer.opacityLocked === true;
        this.opacity.closest?.("label").removeAttribute("hidden");
        this.opacity.value = String(Math.round((layer.effectiveOpacity ?? layer.opacity ?? 1) * 100));
        this.opacity.disabled = locked;
        this.opacityValue.textContent = `${this.opacity.value}%`;
        this.opacity.setAttribute("aria-valuetext", `${this.opacity.value} percent`);
        this.note.textContent = locked
            ? "2D mode styles both visible rasters together. Opacity is fixed at 100%. Switch to 1D in Histogram for individual colors."
            : !this.isRaster
                ? "Layer opacity scales the complete symbol. Customize its geometry-specific colors and size below."
                : layer.visible ? "Changes apply immediately." : "This layer is hidden. Styling it will not make it visible.";
        const vectorTarget = this.isRaster
            ? null : this.getVectorStyleTarget(this.key);
        if (vectorTarget === null) this.vectorStyleControls.hide();
        else this.vectorStyleControls.show(vectorTarget);
        this.rasterControls.hidden = !this.isRaster || locked;
        this.pairedControls.hidden = !locked;
        this.rasterViewer.refreshStyle();
    }

    /** Commit pending style edits and restore focus without closing histograms. @return {void} */
    close() {
        if (this.key === null) return;
        const key = this.key;
        // Clear first: flushing a valid style can trigger a retained-layer render.
        this.key = null;
        this.rasterViewer.closeStyle();
        this.vectorStyleControls.hide();
        this.inspection.hideStyle();
        const replacement = [...this.document.querySelectorAll('[data-layer-action="style"]')]
            .find((element) => element.dataset.layerKey === key);
        // Prefer the originating shortcut; removed or hidden controls cannot
        // receive focus, so try the retained-layer action and disclosure next.
        for (const target of [this.opener, replacement, this.document.querySelector("#toggle-map-layers")]) {
            if (!target || target.isConnected === false || target.hidden || target.disabled) continue;
            target.focus();
            if (this.document.activeElement === target) break;
        }
    }

    /** Close this editor and detach its input/keyboard listeners. @return {void} */
    destroy() {
        this.close();
        this.closeButton.removeEventListener("click", this.onClose);
        this.opacity.removeEventListener("input", this.onOpacity);
        this.document.removeEventListener("keydown", this.onKeydown, true);
    }
}
