/** Present server-composed map tiles and track recovery in the current view. */

import { TileRecovery } from "./tile-recovery.js";

/** @typedef {import("./tile-recovery.js").MapTileStatus} MapTileStatus */

/** Own one composite grid; never retain an old layer stack behind missing tiles. */
export class CompositeLeafletRenderer {
    /**
     * Connect tile presentation to its map and status observer.
     * @param {Object} configuration Collaborators.
     * @param {Object} configuration.leaflet Leaflet namespace.
     * @param {Object} configuration.leafletMap Leaflet map.
     * @param {{create:(layers:Object[],signal:AbortSignal)=>Promise<Object>}} configuration.client Plan client.
     * @param {(status:MapTileStatus,displayed:string[])=>void} [configuration.onStatus] Current viewport status and layer names whose tiles are fully displayed.
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
        this.prepared = new Map();
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
        const staged = this.prepared.get(signature);
        if (staged) {
            staged.detach();
            this.grid = staged.grid;
            this.grid.layer.getContainer().style.visibility = "";
            this.grid.recovery.refresh();
            return;
        }
        const generation = this.generation;
        const abortController = new AbortController();
        this.abortController = abortController;
        this.#emitStatus("preparing");
        void this.client.create(layers, abortController.signal).then(
            (plan) => {
                if (generation !== this.generation || this.destroyed) return;
                this.abortController = null;
                this.grid = this.#createGrid(plan);
                this.grid.layer.addTo(this.leafletMap);
                this.grid.recovery.refresh();
            },
            (error) => {
                if (generation !== this.generation || this.destroyed) return;
                this.abortController = null;
                this.planFailed = true;
                this.#emitStatus("error", error instanceof Error
                    ? error.message : "Map contents could not be prepared.");
            },
        );
    }

    /**
     * Load an upcoming stack in a hidden ordinary tile grid. An exact matching update adopts it.
     * The caller owns its lifetime, including release of unused grids on pause or a new selection.
     * @param {Object[]} layers Complete ordered, styled render descriptors including opacity.
     * @param {AbortSignal} signal Lifetime of this speculative view.
     * @return {Promise<void>} Settles when visible tiles load, fail, or the caller drops the view.
     * @throws {Error} If the ordinary map plan cannot be created.
     */
    async prepare(layers, signal) {
        const signature = JSON.stringify(layers);
        const plan = await this.client.create(layers, signal);
        if (signal.aborted || this.destroyed) return;
        this.prepared.get(signature)?.release();
        await new Promise(resolve => {
            const grid = this.#createGrid(plan, status => {
                if (status.phase === "complete") resolve();
                if (status.phase === "incomplete") release();
            });
            /** Stop tracking this prepared stack once shown or released. @return {void} */
            const detach = () => {
                signal.removeEventListener("abort", release);
                this.prepared.delete(signature);
                resolve();
            };
            /** Remove unused tiles and cancel their retries. @return {void} */
            const release = () => {
                detach();
                grid.recovery.destroy();
                this.leafletMap.removeLayer(grid.layer);
            };
            this.prepared.set(signature, {grid, detach, release});
            signal.addEventListener("abort", release, {once: true});
            grid.layer.addTo(this.leafletMap);
            grid.layer.getContainer().style.visibility = "hidden";
            grid.recovery.refresh();
        });
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
        for (const staged of this.prepared.values()) staged.release();
        this.clear();
        this.destroyed = true;
    }

    /**
     * Create the ordinary WMS tile grid for either a visible or an upcoming map.
     * @param {{wmsUrl:string}} plan Authorized WMS plan.
     * @param {(status:MapTileStatus)=>void} [onPrepared] Tile progress before attachment as the displayed stack.
     * @return {{layer:Object,recovery:TileRecovery}} Grid and its visible-tile observer.
     */
    #createGrid(plan, onPrepared) {
        const layer = this.leaflet.tileLayer.wms(plan.wmsUrl, {
            layers: "composite", styles: "", format: "image/png",
            transparent: true, version: "1.1.1", noWrap: true,
            maxZoom: 22,
        });
        const recovery = new TileRecovery(this.leafletMap, layer, status => {
            if (this.grid?.layer === layer) {
                this.onStatus(status, status.phase === "complete" ? this.layers.map(item => item.layerName) : []);
            } else onPrepared?.(status);
        });
        return {layer, recovery};
    }

    /**
     * Report a state that has no grid counts yet.
     * @param {MapTileStatus["phase"]} phase Preparation or lifecycle state.
     * @param {string} [message] Optional plan error.
     * @return {void}
     */
    #emitStatus(phase, message) {
        this.onStatus({ phase, total: 0, loaded: 0, failed: 0, message }, []);
    }
}
