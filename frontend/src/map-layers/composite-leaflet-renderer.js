/** Atomic Leaflet presentation of one server-composed visible layer stack. */

/** Own the single WMS grid used for ordinary multi-layer map rendering. */
export class CompositeLeafletRenderer {
    /**
     * Create an empty composite renderer.
     *
     * @param {Object} configuration Collaborators.
     * @param {Object} configuration.leaflet Leaflet namespace.
     * @param {Object} configuration.leafletMap Leaflet map.
     * @param {{create:(layers:Object[],signal:AbortSignal)=>Promise<Object>}}
     * configuration.client Composite plan client.
     * @param {(message:string)=>void} [configuration.onError] Error observer.
     */
    constructor({ leaflet, leafletMap, client, onError = () => {} }) {
        this.leaflet = leaflet;
        this.leafletMap = leafletMap;
        this.client = client;
        this.onError = onError;
        this.signature = null;
        this.generation = 0;
        this.abortController = null;
        this.activeLayer = null;
        this.pendingLayer = null;
        this.destroyed = false;
    }

    /**
     * Publish and atomically present a complete top-first visible stack.
     *
     * @param {Object[]} layers Authorized feature render descriptors.
     * @return {void}
     */
    update(layers) {
        if (this.destroyed) return;
        const signature = JSON.stringify(layers);
        if (signature === this.signature) return;
        this.signature = signature;
        this.generation += 1;
        const generation = this.generation;
        this.abortController?.abort();
        this.abortController = null;
        this.#removePendingLayer();
        if (layers.length === 0) {
            this.#removeActiveLayer();
            return;
        }
        const abortController = new AbortController();
        this.abortController = abortController;
        void this.client.create(layers, abortController.signal).then(
            (plan) => this.#present(plan, generation),
            (error) => {
                if (
                    error?.name !== "AbortError" &&
                    generation === this.generation &&
                    !this.destroyed
                ) {
                    this.onError(asErrorMessage(error));
                }
            },
        );
    }

    /** Remove every composite layer and invalidate pending publication. */
    clear() {
        this.signature = null;
        this.generation += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.#removePendingLayer();
        this.#removeActiveLayer();
    }

    /** Permanently detach this renderer. */
    destroy() {
        if (this.destroyed) return;
        this.clear();
        this.destroyed = true;
    }

    /**
     * Attach a prepared grid, retaining the previous grid until load completes.
     *
     * @param {{wmsUrl:string}} plan Published composite plan.
     * @param {number} generation Matching presentation generation.
     * @return {void}
     */
    #present(plan, generation) {
        if (generation !== this.generation || this.destroyed) return;
        this.abortController = null;
        const layer = this.leaflet.tileLayer.wms(plan.wmsUrl, {
            layers: "composite",
            styles: "",
            format: "image/png",
            transparent: true,
            version: "1.1.1",
            noWrap: true,
        });
        const replacesActiveLayer = this.activeLayer !== null;
        layer.setOpacity(replacesActiveLayer ? 0 : 1);
        this.pendingLayer = layer;
        layer.once("tileerror", () => {
            if (generation === this.generation && !this.destroyed) {
                this.onError("The composite map could not be rendered.");
            }
        });
        layer.once("load", () => {
            if (
                generation !== this.generation ||
                this.destroyed ||
                this.pendingLayer !== layer
            ) {
                return;
            }
            const previous = this.activeLayer;
            layer.setOpacity(1);
            this.activeLayer = layer;
            this.pendingLayer = null;
            if (previous !== null && previous !== layer) {
                this.leafletMap.removeLayer(previous);
            }
        });
        layer.addTo(this.leafletMap);
    }

    /** Remove the grid still loading for a superseded plan. */
    #removePendingLayer() {
        if (this.pendingLayer === null) return;
        this.leafletMap.removeLayer(this.pendingLayer);
        this.pendingLayer = null;
    }

    /** Remove the fully loaded current composite grid. */
    #removeActiveLayer() {
        if (this.activeLayer === null) return;
        this.leafletMap.removeLayer(this.activeLayer);
        this.activeLayer = null;
    }
}

/**
 * Return a browser-safe message for one rejected promise value.
 *
 * @param {unknown} candidate Rejection value.
 * @return {string} Error message or bounded fallback.
 */
function asErrorMessage(candidate) {
    return candidate instanceof Error && candidate.message.length > 0
        ? candidate.message
        : "The composite map could not be prepared.";
}
