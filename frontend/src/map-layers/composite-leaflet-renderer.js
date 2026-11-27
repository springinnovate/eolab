/** Present server-composed map tiles and track recovery in the current view. */

import { TileRecovery } from "./tile-recovery.js";
import { revealLoadedRasterFrame } from "./raster-frame.js";

/** @typedef {import("./tile-recovery.js").MapTileStatus} MapTileStatus */

/** @typedef {import("./raster-frame.js").MapFrame} MapFrame */
/** @typedef {import("./raster-frame.js").ViewportFrame} ViewportFrame */
/** @typedef {{layer:Object,recovery:TileRecovery,status:MapTileStatus}} CompositeGrid */
/** @typedef {{signature:string,views:Map<string,MapFrame>,layers:Object[],grid:CompositeGrid|null,request:AbortController,status:MapTileStatus}} CompositeFrame */

/** Draw the current composite stack and hand off between observations of the same raster. */
export class CompositeLeafletRenderer {
    /**
     * Connect tile presentation to its map and status observer.
     * @param {Object} configuration Collaborators.
     * @param {Object} configuration.leaflet Leaflet namespace.
     * @param {Object} configuration.leafletMap Leaflet map.
     * @param {{create:(layers:Object[],signal:AbortSignal)=>Promise<Object>}} configuration.client Plan client.
     * @param {(status:MapTileStatus,displayed:Map<string,ViewportFrame>)=>void} [configuration.onStatus] Tile progress and the frames drawn or outside the viewport.
     */
    constructor({ leaflet, leafletMap, client, onStatus = () => {} }) {
        this.leaflet = leaflet;
        this.leafletMap = leafletMap;
        this.client = client;
        this.onStatus = onStatus;
        this.selected = null;
        this.drawn = null;
        this.prepared = new Map();
        this.destroyed = false;
    }

    /**
     * Draw an authorized stack, retaining the displayed grid during a date change.
     * @param {Object[]} layers Top-first server rendering descriptors, including opacity.
     * @param {{keepPreviousFrame?:boolean,views?:Map<string,MapFrame>}} [options] Source grids and observations in this exact stack.
     * @return {void}
     */
    update(layers, {keepPreviousFrame = false, views = new Map()} = {}) {
        if (this.destroyed) return;
        const signature = JSON.stringify(layers);
        if (this.selected?.signature === signature) {
            this.selected.views = views;
            this.#report();
            return;
        }
        if (keepPreviousFrame && !this.drawn && this.selected?.grid?.recovery.hasLoadedTilesInView) this.drawn = this.selected;
        if (this.selected !== this.drawn) this.#release(this.selected);
        if (!keepPreviousFrame || !layers.length) {
            this.#release(this.drawn);
            this.drawn = null;
        }
        if (!layers.length) {
            this.selected = null;
            this.#report();
            return;
        }
        if (this.drawn?.signature === signature) {
            this.selected = this.drawn;
            this.selected.views = views;
            this.#report();
            return;
        }
        const frame = {layers, signature, views, grid: null, request: new AbortController(),
            status: {phase: "preparing", total: 0, loaded: 0, failed: 0}};
        this.selected = frame;
        const staged = this.prepared.get(signature);
        if (staged) {
            staged.detach();
            frame.grid = staged.grid;
            if (!this.drawn) revealLoadedRasterFrame(frame.grid.layer);
            frame.grid.recovery.refresh();
            return;
        }
        this.#report();
        void this.client.create(layers, frame.request.signal).then(
            plan => {
                if (frame !== this.selected) return;
                frame.grid = this.#createGrid(plan);
                frame.grid.layer.addTo(this.leafletMap);
                if (this.drawn) frame.grid.layer.getContainer().hidden = true;
                frame.grid.recovery.refresh();
            },
            error => {
                if (frame !== this.selected) return;
                frame.status = {...frame.status, phase: "error",
                    message: error instanceof Error ? error.message : "Map contents could not be prepared."};
                this.#report();
            },
        );
    }

    /** Return the source grid and observation used to draw a row of the displayed composite.
     * @param {string} key Retained map-layer key.
     * @return {MapFrame|undefined} Row snapshot from the displayed grid.
     */
    drawnView(key) {
        return this.drawn?.views.get(key);
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
            grid.layer.getContainer().hidden = true;
            grid.recovery.refresh();
        });
    }

    /**
     * Retry exhausted visible tiles, or retry a failed plan publication.
     * Successful neighbors and requests already in flight are preserved.
     * @return {void}
     */
    retryFailedTiles() {
        const frame = this.selected;
        if (!frame) return;
        if (frame.status.phase === "error") {
            this.selected = null;
            this.update(frame.layers, {views: frame.views, keepPreviousFrame: Boolean(this.drawn)});
        } else frame.grid?.recovery.retryFailedTiles();
    }

    /** Release both frames and invalidate outstanding plan responses. @return {void} */
    clear() {
        if (this.selected !== this.drawn) this.#release(this.selected);
        this.#release(this.drawn);
        this.selected = null;
        this.drawn = null;
        this.#report();
    }

    /** Cancel a plan and detach its tile grid when replaced or removed.
     * @param {CompositeFrame|null} frame Composite to retire.
     * @return {void}
     */
    #release(frame) {
        if (!frame) return;
        frame.request.abort();
        if (frame.grid) {
            frame.grid.recovery.destroy();
            this.leafletMap.removeLayer(frame.grid.layer);
        }
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
     * @param {(status:MapTileStatus)=>void} [onPrepared] Tile progress before this grid is selected for display.
     * @return {CompositeGrid} Grid and its current visible-tile counts.
     */
    #createGrid(plan, onPrepared) {
        const layer = this.leaflet.tileLayer.wms(plan.wmsUrl, {
            layers: "composite", styles: "", format: "image/png",
            transparent: true, version: "1.1.1", noWrap: true,
            maxZoom: 22,
        });
        const grid = {layer, status: {phase: "loading", total: 0, loaded: 0, failed: 0}};
        grid.recovery = new TileRecovery(this.leafletMap, layer, status => {
            grid.status = status;
            if (this.selected?.grid === grid) {
                if (this.drawn !== this.selected && status.phase === "complete") {
                    if (this.drawn) {
                        revealLoadedRasterFrame(layer, this.drawn.grid.layer);
                        this.#release(this.drawn);
                    }
                    this.drawn = grid.recovery.hasLoadedTilesInView ? this.selected : null;
                }
                this.#report();
            } else if (this.drawn?.grid === grid) this.#report();
            else onPrepared?.(status);
        });
        return grid;
    }

    /** Report incoming progress with the rows of the grid that has pixels in this viewport. @return {void} */
    #report() {
        const status = this.selected?.grid?.status ?? this.selected?.status ??
            {phase: "idle", total: 0, loaded: 0, failed: 0};
        if (this.drawn?.grid.recovery.hasLoadedTilesInView) {
            this.onStatus(status, this.drawn.views);
        } else {
            const views = new Map();
            if (status.phase === "complete" && status.total === 0) {
                for (const [key, frame] of this.selected.views) views.set(key, {...frame, outsideViewport: true});
            }
            this.onStatus(status, views);
        }
    }
}
