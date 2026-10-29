/** DOM adapter for selecting a filtered polygon layer as the sampling area. */
export class VectorSamplingView {
    /**
     * Create a view over one placement of the shared vector controls.
     * @param {Document} [documentContext=document] Owning document.
     * @param {Object} [options] Mount selectors supplied by browser composition.
     * @param {string} [options.root="#vector-sampling"] Control container selector.
     */
    constructor(documentContext = document, { root = "#vector-sampling" } = {}) {
        this.document = documentContext;
        this.root = documentContext.querySelector(root);
        this.elements = Object.fromEntries(["layer", "filter", "retry", "remove", "status", "predicate"]
            .map(name => [name, documentContext.querySelector(`${root} [data-vector-sampling="${name}"]`)]));
        this.abort = new AbortController();
    }
    /** Connect source changes, retry, clearing and filter editing to their owner.
     * @param {{onLayer:(key:string)=>void,onRetry:()=>void,onRemove:()=>void,onFilter:()=>void}} handlers Selection actions.
     * @return {void}
     */
    bind(handlers) {
        const on = (element, event, callback) => element.addEventListener(event, callback, { signal: this.abort.signal });
        on(this.elements.layer, "change", () => handlers.onLayer(this.elements.layer.value));
        for (const [name, handler] of [["retry", "onRetry"], ["remove", "onRemove"], ["filter", "onFilter"]]) {
            on(this.elements[name], "click", () => handlers[handler]());
        }
    }
    /**
     * Show the chosen source, accepted filter, progress and actual read errors.
     * @param {{targets:Object[],key:string,phase:string,area:Object|null,message:string,filterSummary:string}} state Current selection.
     * @return {void}
     */
    render(state) {
        const signature = JSON.stringify(state.targets.map(target => [target.key, target.label]));
        if (signature !== this.signature) {
            this.signature = signature;
            this.elements.layer.replaceChildren(...[{key: "", label: "Choose a polygon layer"}, ...state.targets].map(target => {
                const option = this.document.createElement("option"); option.value = target.key; option.textContent = target.label; return option;
            }));
        }
        this.elements.layer.value = state.key;
        this.elements.layer.disabled = state.targets.length === 0;
        this.elements.predicate.textContent = state.filterSummary;
        this.elements.status.textContent = state.targets.length ? state.message : "Add a polygon layer to the map first.";
        this.elements.status.setAttribute("role", state.phase === "error" ? "alert" : "status");
        this.elements.status.classList.toggle("is-working", state.phase === "reading");
        this.elements.filter.disabled = !state.key;
        this.elements.retry.hidden = state.phase !== "error" || !state.key;
        this.elements.remove.hidden = !state.area && state.phase !== "reading";
        this.elements.remove.textContent = state.phase === "reading" ? "Cancel" : "Clear selection";
        this.root.setAttribute("aria-busy", String(state.phase === "reading"));
    }
    /** Remove listeners installed by this view. @return {void} */
    unbind() { this.abort.abort(); }
}
