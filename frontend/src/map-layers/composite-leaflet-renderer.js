/** Present server-composed map tiles and track recovery in the current view. */

import { TileRecovery } from "./tile-recovery.js";
import { createCancelableWmsLayer } from "../leaflet-wms.js";

/** @typedef {import("./tile-recovery.js").MapTileStatus} MapTileStatus */

/** Own one composite grid; never retain an old layer stack behind missing tiles. */
export class CompositeLeafletRenderer {
    /**
     * Connect tile presentation to its map and status observer.
     * @param {Object} configuration Collaborators.
     * @param {Object} configuration.leaflet Leaflet namespace.
     * @param {Object} configuration.leafletMap Leaflet map.
     * @param {{create:(layers:Object[],signal:AbortSignal)=>Promise<Object>}} configuration.client Plan client.
     * @param {(status:MapTileStatus)=>void} [configuration.onStatus] Current-view status observer.
     */
    constructor({ leaflet, leafletMap, client, onStatus = () => {} }) {
        this.leaflet = leaflet;
        this.leafletMap = leafletMap;
        this.client = client;
        this.onStatus = onStatus;
        this.signature = null;
        this.layers = [];
        this.generation = 0;
        this.abortController = null;
        this.grid = null;
        this.planFailed = false;
        this.destroyed = false;
    }

    /**
     * Replace the displayed stack and prepare its new tiles.
     * Old pixels are removed immediately so a failed replacement cannot imply
     * that the old layer selection or style is still current.
     * @param {Object[]} layers Authorized top-first rendering descriptors.
     * @return {void}
     */
    update(layers) {
        if (this.destroyed) return;
        const signature = JSON.stringify(layers);
        if (signature === this.signature) return;
        this.clear();
        this.signature = signature;
        this.layers = layers;
        if (layers.length === 0) return;
        const generation = this.generation;
        const abortController = new AbortController();
        this.abortController = abortController;
        this.#emitStatus("preparing");
        void this.client.create(layers, abortController.signal).then(
            (plan) => {
                if (generation !== this.generation || this.destroyed) return;
                this.abortController = null;
                this.#present(plan);
            },
            (error) => {
                if (generation !== this.generation || this.destroyed) return;
                this.abortController = null;
                this.planFailed = true;
                this.#emitStatus("error", error instanceof Error
                    ? error.message : "Map layers could not be prepared.");
            },
        );
    }

    /**
     * Retry exhausted visible tiles, or retry a failed plan publication.
     * Successful neighbors and requests already in flight are preserved.
     * @return {void}
     */
    retryFailedTiles() {
        if (this.destroyed) return;
        if (this.planFailed) {
            this.signature = null;
            this.update(this.layers);
            return;
        }
        this.grid?.recovery.retryFailedTiles();
    }

    /** Remove the grid, cancel retries, and invalidate plan responses. @return {void} */
    clear() {
        this.signature = null;
        this.layers = [];
        this.generation += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.planFailed = false;
        const grid = this.grid;
        this.grid = null;
        if (grid) {
            grid.recovery.destroy();
            this.leafletMap.removeLayer(grid.layer);
        }
        this.#emitStatus("idle");
    }

    /** Remove tiles and detach the map observer permanently. @return {void} */
    destroy() {
        if (this.destroyed) return;
        this.clear();
        this.destroyed = true;
    }

    /**
     * Attach the current plan and observe public Leaflet tile events.
     * @param {{wmsUrl:string}} plan Authorized WMS plan.
     * @return {void}
     */
    #present(plan) {
        const layer = createCancelableWmsLayer(this.leaflet, plan.wmsUrl, {
            layers: "composite", styles: "", format: "image/png",
            transparent: true, version: "1.1.1", noWrap: true,
        });
        const recovery = new TileRecovery(this.leafletMap, layer, this.onStatus);
        this.grid = { layer, recovery };
        layer.addTo(this.leafletMap);
        recovery.refresh();
    }

    /**
     * Report a state that has no grid counts yet.
     * @param {MapTileStatus["phase"]} phase Preparation or lifecycle state.
     * @param {string} [message] Optional plan error.
     * @return {void}
     */
    #emitStatus(phase, message) {
        this.onStatus({ phase, total: 0, loaded: 0, failed: 0, message });
    }
}
