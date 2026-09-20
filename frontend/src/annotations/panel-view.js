/** Present annotation tools in one map-side panel instead of inside layer rows. */
export class AnnotationPanelView {
    /**
     * Connect the panel's layer selector, entry button and close action.
     * Layer owners supply their retained controls; this view never edits polygon data.
     * @param {Object} options Presentation dependencies.
     * @param {Document} options.document Browser document.
     * @param {()=>void} options.onOpen Reveal the panel in the existing map-tool container.
     * @param {()=>void} options.onClose Hide the panel without discarding controls.
     */
    constructor({ document, onOpen, onClose }) {
        this.document = document;
        this.onOpen = onOpen;
        this.layers = new Map();
        this.selectedKey = null;
        this.entry = document.querySelector("#open-annotations");
        this.selector = document.querySelector("#annotation-panel-layer");
        this.layerField = document.querySelector("#annotation-panel-layer-field");
        this.content = document.querySelector("#annotation-panel-content");
        this.empty = document.querySelector("#annotation-panel-empty");
        this.entry.addEventListener("click", () => this.show());
        this.selector.addEventListener("change", () => this.showLayer(this.selector.value));
        document.querySelector("#close-annotations").addEventListener("click", () => {
            onClose();
            const target = this.entry.getClientRects().length ? this.entry : document.querySelector("#map");
            target.focus({ preventScroll: true });
        });
    }

    /**
     * Retain one editable layer or read-only contribution without opening the panel.
     * @param {string} key Map-layer identity.
     * @param {string} label Layer name, including contributor attribution when shared.
     * @param {HTMLElement} controls Controls provided by the annotation layer owner.
     * @return {void}
     */
    addLayer(key, label, controls) {
        const option = this.document.createElement("option");
        option.value = key;
        option.textContent = label;
        this.layers.set(key, { controls, option });
        this.selector.append(option);
        if (this.selectedKey === null) this.selectLayer(key);
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
    }

    /**
     * Remove a deleted layer's controls and select another layer, if available.
     * @param {string} key Map-layer identity.
     * @return {void}
     */
    removeLayer(key) {
        this.layers.get(key)?.option.remove();
        this.layers.delete(key);
        if (this.selectedKey === key) this.selectLayer(this.layers.keys().next().value ?? null);
    }

    /**
     * Display retained controls without changing panel visibility or keyboard focus.
     * @param {string|null} key Registered layer identity, or null for the empty state.
     * @return {void}
     */
    selectLayer(key) {
        const layer = this.layers.get(key);
        this.selectedKey = layer ? key : null;
        this.selector.value = this.selectedKey ?? "";
        this.content.replaceChildren(...(layer ? [layer.controls] : []));
        this.layerField.hidden = !layer;
        this.empty.hidden = !!layer;
    }

    /**
     * Reveal a particular annotation layer, retaining its fields and open disclosures.
     * @param {string} key Registered map-layer identity.
     * @return {void}
     */
    showLayer(key) {
        if (!this.layers.has(key)) return;
        if (this.selectedKey !== key) this.selectLayer(key);
        this.onOpen();
        this.selector.focus({ preventScroll: true });
    }

    /** Reveal annotation tools, keeping the selected layer and any unfinished text. @return {void} */
    show() {
        this.onOpen();
        (this.selectedKey ? this.selector : this.document.querySelector("#create-annotation-layer")).focus({ preventScroll: true });
    }
}
