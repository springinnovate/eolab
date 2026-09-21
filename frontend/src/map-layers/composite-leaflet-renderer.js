/** Present server-composed map tiles and track recovery in the current view. */

const RETRY_DELAYS_MILLISECONDS = Object.freeze([250, 1000]);

/**
 * @typedef {Object} MapTileStatus
 * @property {"idle"|"preparing"|"loading"|"retrying"|"complete"|"incomplete"|"error"} phase Rendering state.
 * @property {number} total Requested tiles intersecting the current viewport.
 * @property {number} loaded Successfully loaded visible tiles, including transparent PNGs.
 * @property {number} failed Visible tiles whose automatic retries are exhausted.
 * @property {string} [message] Plan preparation error, when present.
 */

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
        this.statusScheduled = false;
        this.onMapMove = () => this.#refreshVisibleTiles();
        leafletMap.on("moveend zoomend", this.onMapMove);
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
        const grid = this.grid;
        if (!grid) return;
        for (const [tile, record] of grid.tiles) {
            if (record.phase !== "failed" || !this.#isVisible(record)) continue;
            record.attempts = 0;
            record.phase = "retrying";
            tile.src = record.source;
        }
        this.#scheduleStatus();
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
            for (const record of grid.tiles.values()) clearTimeout(record.timer);
            for (const [event, handler] of Object.entries(grid.handlers)) {
                grid.layer.off(event, handler);
            }
            this.leafletMap.removeLayer(grid.layer);
        }
        this.#emitStatus("idle");
    }

    /** Remove tiles and detach the map observer permanently. @return {void} */
    destroy() {
        if (this.destroyed) return;
        this.clear();
        this.destroyed = true;
        this.leafletMap.off("moveend zoomend", this.onMapMove);
    }

    /**
     * Attach the current plan and observe public Leaflet tile events.
     * @param {{wmsUrl:string}} plan Authorized WMS plan.
     * @return {void}
     */
    #present(plan) {
        const layer = this.leaflet.tileLayer.wms(plan.wmsUrl, {
            layers: "composite", styles: "", format: "image/png",
            transparent: true, version: "1.1.1", noWrap: true,
        });
        const grid = { layer, tiles: new Map(), loading: true, handlers: {} };
        this.grid = grid;
        grid.handlers = {
            loading: () => { grid.loading = true; this.#scheduleStatus(); },
            // Leaflet fires load even when tiles failed. Only tileload records success.
            load: () => { grid.loading = false; this.#scheduleStatus(); },
            tileloadstart: ({ tile, coords }) => {
                grid.tiles.set(tile, { coords, source: tile.src, phase: "loading", attempts: 0, timer: null });
                this.#scheduleStatus();
            },
            tileload: ({ tile }) => {
                const record = grid.tiles.get(tile);
                if (!record) return;
                clearTimeout(record.timer);
                record.timer = null;
                record.phase = "loaded";
                this.#scheduleStatus();
            },
            tileerror: ({ tile }) => this.#retryTile(grid, tile),
            tileunload: ({ tile }) => this.#forgetTile(grid, tile),
            tileabort: ({ tile }) => this.#forgetTile(grid, tile),
        };
        for (const [event, handler] of Object.entries(grid.handlers)) layer.on(event, handler);
        layer.addTo(this.leafletMap);
        this.#scheduleStatus();
    }

    /**
     * Schedule bounded recovery of one failed image in the current view.
     * @param {Object} grid Owning grid and tile records.
     * @param {HTMLImageElement} tile Failed image.
     * @return {void}
     */
    #retryTile(grid, tile) {
        const record = grid.tiles.get(tile);
        if (grid !== this.grid || !record || record.timer !== null) return;
        record.phase = "failed";
        if (this.#isVisible(record) && record.attempts < RETRY_DELAYS_MILLISECONDS.length) {
            record.phase = "retrying";
            record.timer = setTimeout(() => {
                record.timer = null;
                if (grid !== this.grid || !grid.tiles.has(tile)) return;
                if (this.#isVisible(record)) tile.src = record.source;
                else record.phase = "failed";
                this.#scheduleStatus();
            }, RETRY_DELAYS_MILLISECONDS[record.attempts++]);
        }
        this.#scheduleStatus();
    }

    /**
     * Release a tile that Leaflet discarded or aborted.
     * @param {Object} grid Owning grid.
     * @param {HTMLImageElement} tile Removed image.
     * @return {void}
     */
    #forgetTile(grid, tile) {
        clearTimeout(grid.tiles.get(tile)?.timer);
        grid.tiles.delete(tile);
        this.#scheduleStatus();
    }

    /**
     * Test tile intersection with the viewport, excluding Leaflet's retained buffer.
     * @param {{coords:{x:number,y:number,z:number}}} record Tile coordinates.
     * @return {boolean} Whether the tile belongs to the currently visible zoom and extent.
     */
    #isVisible(record) {
        const { x, y, z } = record.coords;
        if (z !== Math.round(this.leafletMap.getZoom())) return false;
        const bounds = this.leafletMap.getPixelBounds();
        const size = this.grid.layer.getTileSize();
        return x * size.x < bounds.max.x && (x + 1) * size.x > bounds.min.x &&
            y * size.y < bounds.max.y && (y + 1) * size.y > bounds.min.y;
    }

    /** Cancel queued retries outside the new viewport and refresh counts. @return {void} */
    #refreshVisibleTiles() {
        if (!this.grid) return;
        for (const record of this.grid.tiles.values()) {
            if (!this.#isVisible(record) && record.timer !== null) {
                clearTimeout(record.timer);
                record.timer = null;
                record.phase = "failed";
            }
        }
        this.#scheduleStatus();
    }

    /** Publish one snapshot after a synchronous burst of Leaflet events. @return {void} */
    #scheduleStatus() {
        if (this.statusScheduled) return;
        this.statusScheduled = true;
        queueMicrotask(() => {
            this.statusScheduled = false;
            if (!this.grid || this.destroyed) return;
            const tiles = [...this.grid.tiles.values()].filter(record => this.#isVisible(record));
            const loaded = tiles.filter(record => record.phase === "loaded").length;
            const failed = tiles.filter(record => record.phase === "failed").length;
            const retrying = tiles.some(record => record.phase === "retrying");
            const pending = tiles.length - loaded - failed;
            let phase = "complete";
            if (retrying) phase = "retrying";
            else if (pending || (!tiles.length && this.grid.loading)) phase = "loading";
            else if (failed) phase = "incomplete";
            this.onStatus({ phase, total: tiles.length, loaded, failed });
        });
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
