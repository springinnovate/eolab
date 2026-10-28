/** Present annotation tools in one map-side panel instead of inside layer rows. */
export class AnnotationPanelView {
    /**
     * Connect the layer editor's selector and close action.
     * Layer owners supply their retained controls; this view never edits polygon data.
     * @param {Object} options Presentation dependencies.
     * @param {Document} options.document Browser document.
     * @param {()=>void} options.onOpen Reveal the panel in the existing map-tool container.
     * @param {()=>void} options.onClose Hide the panel without discarding controls.
     */
    constructor({ document, onOpen, onClose }) {
        this.document = document;
        this.onOpen = onOpen;
        this.onClose = onClose;
        this.layers = new Map();
        this.selectedKey = null;
        this.title = document.querySelector("#annotation-panel-title");
        this.entry = document.querySelector("#toggle-map-layers");
        this.selector = document.querySelector("#annotation-panel-layer");
        this.layerField = document.querySelector("#annotation-panel-layer-field");
        this.content = document.querySelector("#annotation-panel-content");
        this.empty = document.querySelector("#annotation-panel-empty");
        this.selector.addEventListener("change", () => this.showLayer(this.selector.value));
        document.querySelector("#close-annotations").addEventListener("click", () => {
            onClose();
            const target = this.entry.getClientRects().length ? this.entry : document.querySelector("#map");
            target.focus({ preventScroll: true });
        });
    }

    /**
     * Register a layer's existing controls and add its name to the panel selector.
     * Display the first registered layer's controls without opening the panel.
     * @param {string} key Map-layer identity.
     * @param {string} label Layer name, including contributor attribution when shared.
     * @param {HTMLElement} controls Controls provided by the annotation layer owner.
     * @return {void}
     */
    registerLayerControls(key, label, controls) {
        const option = this.document.createElement("option");
        option.value = key;
        option.textContent = label;
        this.layers.set(key, { controls, option });
        this.selector.append(option);
        this.layerField.hidden = this.layers.size < 2;
        if (this.selectedKey === null) this.displayLayerControls(key);
    }

    /**
     * Refresh a label without rebuilding the editor or interrupting text entry.
     * @param {string} key Map-layer identity.
     * @param {string} label Current layer name.
     * @return {void}
     */
    renameLayer(key, label) {
        const layer = this.layers.get(key);
        if (layer) layer.option.textContent = label;
        if (layer && this.selectedKey === key) this.title.textContent = label;
    }

    /**
     * Remove a deleted layer's controls, selecting another layer or closing the empty editor.
     * @param {string} key Map-layer identity.
     * @return {void}
     */
    removeLayer(key) {
        this.layers.get(key)?.option.remove();
        this.layers.delete(key);
        this.layerField.hidden = this.layers.size < 2;
        if (this.selectedKey === key) this.displayLayerControls(this.layers.keys().next().value ?? null);
        if (this.layers.size === 0) this.onClose();
    }

    /**
     * Display a layer's existing controls without opening the panel or moving focus.
     * @param {string|null} key Registered layer identity, or null for the empty state.
     * @return {void}
     */
    displayLayerControls(key) {
        const layer = this.layers.get(key);
        this.selectedKey = layer ? key : null;
        this.selector.value = this.selectedKey ?? "";
        this.content.replaceChildren(...(layer ? [layer.controls] : []));
        this.empty.hidden = !!layer;
        this.title.textContent = layer?.option.textContent ?? "Polygons";
    }

    /**
     * Reveal a particular annotation layer, retaining its fields and open disclosures.
     * @param {string} key Registered map-layer identity.
     * @return {void}
     */
    showLayer(key) {
        if (!this.layers.has(key)) return;
        if (this.selectedKey !== key) this.displayLayerControls(key);
        this.show();
    }

    /** Reveal polygon controls or an action error, focusing the visible selector or heading.
     * Keep the selected layer and any unfinished text.
     * @return {void}
     */
    show() {
        this.onOpen();
        (this.layerField.hidden ? this.title : this.selector).focus({ preventScroll: true });
    }
}
