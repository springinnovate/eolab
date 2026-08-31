/** One non-modal editor, keyed independently from histogram selection. */
export class MapLayerStyleEditor {
    constructor({ mapLayers, rasterViewer, documentContext = document }) {
        this.mapLayers = mapLayers;
        this.rasterViewer = rasterViewer;
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
            if (event.key !== "Escape" || this.key === null) return;
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

    open(key) {
        if (this.key !== null) this.rasterViewer.closeStyle();
        this.key = key;
        this.opener = this.document.activeElement;
        this.isRaster = this.rasterViewer.openStyle(key);
        this.refresh();
        if (this.key === null) return;
        this.root.showPopover();
        this.closeButton.focus();
    }

    refresh() {
        if (this.key === null) return;
        const layer = this.mapLayers.snapshots().find(({ key }) => key === this.key) ??
            this.rasterViewer.getSampledStyleTarget?.(this.key);
        if (!layer) {
            this.close();
            return;
        }
        this.title.textContent = layer.label;
        const locked = layer.opacityLocked === true;
        this.opacity.closest?.("label").toggleAttribute("hidden", layer.sampled === true);
        this.opacity.value = String(Math.round((layer.effectiveOpacity ?? layer.opacity ?? 1) * 100));
        this.opacity.disabled = locked;
        this.opacityValue.textContent = `${this.opacity.value}%`;
        this.opacity.setAttribute("aria-valuetext", `${this.opacity.value} percent`);
        this.note.textContent = locked
            ? "2D mode styles both visible rasters together. Opacity is fixed at 100%. Switch to 1D in Histograms for individual colors."
            : !this.isRaster
                ? "This vector layer uses fixed default colors. You can adjust its opacity."
                : layer.visible ? "Changes apply immediately." : "This layer is hidden. Styling it will not make it visible.";
        this.rasterControls.hidden = !this.isRaster || locked;
        this.pairedControls.hidden = !locked;
        this.rasterViewer.refreshStyle();
    }

    close() {
        if (this.key === null) return;
        const key = this.key;
        // Clear first: flushing a valid style can trigger a retained-layer render.
        this.key = null;
        this.rasterViewer.closeStyle();
        this.root.hidePopover();
        const replacement = [...this.document.querySelectorAll('[data-layer-action="style"]')]
            .find((element) => element.dataset.layerKey === key);
        const target = replacement ?? (this.opener?.isConnected ? this.opener : null);
        (target ?? this.document.querySelector("#toggle-map-layers"))?.focus();
    }

    destroy() {
        this.close();
        this.closeButton.removeEventListener("click", this.onClose);
        this.opacity.removeEventListener("input", this.onOpacity);
        this.document.removeEventListener("keydown", this.onKeydown, true);
    }
}
