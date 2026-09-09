/** DOM adapter for selecting a filtered polygon layer as the sampling area. */
export class VectorSamplingView {
    /** @param {Document} documentContext Document containing the shared sampling controls. */
    constructor(documentContext = document) {
        this.document = documentContext;
        this.root = documentContext.querySelector("#vector-sampling");
        this.elements = Object.fromEntries(["layer", "filter", "use", "confirm", "remove", "status", "predicate"]
            .map(name => [name, this.root.querySelector(`[data-vector-sampling="${name}"]`)]));
        this.choice = documentContext.querySelector("#use-vector-for-raster");
        this.disclosure = documentContext.querySelector("#vector-sampling-disclosure");
        this.abort = new AbortController();
    }
    /** @param {Object} handlers Semantic layer, selection and review handlers. */
    bind(handlers) {
        const on = (element, event, callback) => element.addEventListener(event, callback, { signal: this.abort.signal });
        on(this.elements.layer, "change", () => handlers.onLayer(this.elements.layer.value));
        for (const [name, handler] of [["use", "onUse"], ["confirm", "onConfirm"], ["remove", "onRemove"], ["filter", "onFilter"]]) {
            on(this.elements[name], "click", () => handlers[handler]());
        }
        on(this.choice, "change", () => { this.disclosure.open = true; this.elements.layer.focus(); });
    }
    /** @param {Object} state Current selection and review state. */
    render(state) {
        const signature = JSON.stringify(state.targets.map(target => [target.key, target.label]));
        if (signature !== this.signature) {
            this.signature = signature;
            this.elements.layer.replaceChildren(...state.targets.map(target => {
                const option = this.document.createElement("option"); option.value = target.key; option.textContent = target.label; return option;
            }));
        }
        this.elements.layer.value = state.key;
        this.elements.predicate.textContent = state.filterSummary;
        this.elements.status.textContent = state.targets.length ? state.message : "Add a Shapefile or GeoPackage polygon layer to the map first.";
        this.elements.status.setAttribute("role", "status");
        this.elements.use.disabled = !state.key || state.phase === "reading";
        this.elements.filter.disabled = !state.key;
        this.elements.use.hidden = ["review", "confirm"].includes(state.phase);
        this.elements.confirm.hidden = !["review", "confirm"].includes(state.phase);
        this.elements.confirm.textContent = state.phase === "confirm" ? "Yes, use this near-global selection" : "Continue with these features";
        this.elements.remove.hidden = !state.area && state.phase !== "reading";
        this.elements.remove.textContent = state.phase === "reading" ? "Cancel" : "Clear selection";
        this.root.setAttribute("aria-busy", String(state.phase === "reading"));
    }
    /** Remove listeners installed by this view. */
    unbind() { this.abort.abort(); }
}
