/** Atomic Leaflet presentation of one server-composed visible layer stack. */

const COMPOSITE_TILE_RETRY_DELAYS_MILLISECONDS = Object.freeze([250, 1000]);

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
        this.layerRetryStates = new Map();
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
        this.#registerTileRetries(layer);
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
                this.#removeTileRetries(previous);
                this.leafletMap.removeLayer(previous);
            }
        });
        layer.addTo(this.leafletMap);
    }

    /**
     * Register bounded retry handling for every failed tile in one grid.
     *
     * @param {Object} layer Leaflet-compatible WMS layer.
     * @return {void}
     */
    #registerTileRetries(layer) {
        const state = {
            errorReported: false,
            retryTimeouts: new Set(),
            tiles: new WeakMap(),
            onTileError: null,
            onTileLoad: null,
            onTileUnload: null,
        };
        state.onTileError = (event) => this.#recordTileError(
            layer,
            state,
            event,
        );
        state.onTileLoad = (event) => this.#forgetTileRetry(
            state,
            event?.tile,
        );
        state.onTileUnload = state.onTileLoad;
        this.layerRetryStates.set(layer, state);
        layer.on("tileerror", state.onTileError);
        layer.on("tileload", state.onTileLoad);
        layer.on("tileunload", state.onTileUnload);
    }

    /**
     * Schedule the next retry for one failed tile or report exhausted recovery.
     *
     * @param {Object} layer Leaflet-compatible WMS layer.
     * @param {Object} layerState Retry state owned by the layer.
     * @param {{tile?:Object}|undefined} event Leaflet tile error event.
     * @return {void}
     */
    #recordTileError(layer, layerState, event) {
        if (!this.#isPresentedLayer(layer, layerState)) return;
        const tile = event?.tile;
        const source = tile?.currentSrc || tile?.src;
        if (typeof source !== "string" || source.length === 0) {
            this.#reportExhaustedRetry(layerState);
            return;
        }
        let tileState = layerState.tiles.get(tile);
        if (tileState === undefined) {
            tileState = {
                attempts: 0,
                source,
                timeoutId: null,
            };
            layerState.tiles.set(tile, tileState);
        }
        if (tileState.timeoutId !== null) return;
        if (
            tileState.attempts >=
            COMPOSITE_TILE_RETRY_DELAYS_MILLISECONDS.length
        ) {
            this.#reportExhaustedRetry(layerState);
            return;
        }
        const delay = COMPOSITE_TILE_RETRY_DELAYS_MILLISECONDS[
            tileState.attempts
        ];
        tileState.attempts += 1;
        const timeoutId = setTimeout(() => {
            layerState.retryTimeouts.delete(timeoutId);
            if (tileState.timeoutId !== timeoutId) return;
            tileState.timeoutId = null;
            if (!this.#isPresentedLayer(layer, layerState)) return;
            // Leaflet retains the failed image, so reloading its authorized URL
            // retries only this tile without redrawing successful neighbours.
            tile.src = tileState.source;
        }, delay);
        tileState.timeoutId = timeoutId;
        layerState.retryTimeouts.add(timeoutId);
    }

    /**
     * Forget retry state after one tile loads or leaves the visible grid.
     *
     * @param {Object} layerState Retry state owned by the layer.
     * @param {Object|undefined} tile Leaflet tile element.
     * @return {void}
     */
    #forgetTileRetry(layerState, tile) {
        if (tile === undefined) return;
        const tileState = layerState.tiles.get(tile);
        if (
            tileState?.timeoutId !== null &&
            tileState?.timeoutId !== undefined
        ) {
            clearTimeout(tileState.timeoutId);
            layerState.retryTimeouts.delete(tileState.timeoutId);
        }
        layerState.tiles.delete(tile);
    }

    /**
     * Report one rendering error after any tile exhausts its retry budget.
     *
     * @param {Object} layerState Retry state owned by the layer.
     * @return {void}
     */
    #reportExhaustedRetry(layerState) {
        if (layerState.errorReported) return;
        layerState.errorReported = true;
        this.onError("The composite map could not be rendered.");
    }

    /**
     * Return whether one retry state still belongs to a presented grid.
     *
     * @param {Object} layer Leaflet-compatible WMS layer.
     * @param {Object} layerState Retry state owned by the layer.
     * @return {boolean} Whether the grid is still pending or visible.
     */
    #isPresentedLayer(layer, layerState) {
        return !this.destroyed &&
            this.layerRetryStates.get(layer) === layerState &&
            (this.pendingLayer === layer || this.activeLayer === layer);
    }

    /**
     * Cancel retries and detach listeners for one removed grid.
     *
     * @param {Object} layer Leaflet-compatible WMS layer.
     * @return {void}
     */
    #removeTileRetries(layer) {
        const state = this.layerRetryStates.get(layer);
        if (state === undefined) return;
        for (const timeoutId of state.retryTimeouts) {
            clearTimeout(timeoutId);
        }
        state.retryTimeouts.clear();
        layer.off("tileerror", state.onTileError);
        layer.off("tileload", state.onTileLoad);
        layer.off("tileunload", state.onTileUnload);
        this.layerRetryStates.delete(layer);
    }

    /** Remove the grid still loading for a superseded plan. */
    #removePendingLayer() {
        if (this.pendingLayer === null) return;
        this.#removeTileRetries(this.pendingLayer);
        this.leafletMap.removeLayer(this.pendingLayer);
        this.pendingLayer = null;
    }

    /** Remove the fully loaded current composite grid. */
    #removeActiveLayer() {
        if (this.activeLayer === null) return;
        this.#removeTileRetries(this.activeLayer);
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
