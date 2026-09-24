/** Track and retry visible images in one Leaflet tile grid. */

// One browser retry schedule for both individual and composite WMS layers.
// Server queue wait limits are configured separately through environment variables.
// Immediate busy responses retry at 1, 5, 15, 30, and 60 seconds.
// Time spent awaiting each HTTP response is additional to these delays.
const RETRY_DELAYS_MILLISECONDS = Object.freeze([1000, 4000, 10000, 15000, 30000]);

/**
 * @typedef {Object} MapTileStatus
 * @property {"idle"|"preparing"|"loading"|"retrying"|"complete"|"incomplete"|"error"} phase Rendering state.
 * @property {number} total Tiles intersecting the current viewport.
 * @property {number} loaded Successfully loaded visible tiles, including transparent images.
 * @property {number} failed Visible tiles whose automatic retries are exhausted.
 * @property {string} [message] Optional preparation error.
 */

/** Own tile observations and retry timers without attaching or removing layers. */
export class TileRecovery {
    /**
     * Observe a grid before its first attachment to the map.
     * @param {Object} map Leaflet map with zoom, pixel bounds and public events.
     * @param {Object} layer Leaflet WMS layer with public tile events.
     * @param {(status:MapTileStatus)=>void} onStatus Current-view status observer.
     */
    constructor(map, layer, onStatus) {
        this.map = map;
        this.layer = layer;
        this.onStatus = onStatus;
        this.tiles = new Map();
        this.loading = false;
        this.destroyed = false;
        this.scheduled = false;
        this.onMove = () => this.refresh();
        this.handlers = {
            loading: () => { this.loading = true; this.refresh(); },
            load: () => { this.loading = false; this.refresh(); },
            tileloadstart: ({ tile, coords }) => {
                this.forget(tile);
                this.tiles.set(tile, { coords, source: tile.src, phase: "loading", attempts: 0, timer: null });
                this.refresh();
            },
            tileload: ({ tile }) => {
                const record = this.tiles.get(tile);
                if (!record) return;
                clearTimeout(record.timer);
                record.timer = null;
                record.phase = "loaded";
                this.refresh();
            },
            tileerror: ({ tile }) => this.retryTile(tile),
            tileunload: ({ tile }) => this.forget(tile),
            tileabort: ({ tile }) => this.forget(tile),
        };
        for (const [event, handler] of Object.entries(this.handlers)) layer.on(event, handler);
        map.on("moveend zoomend", this.onMove);
    }

    /** Retry exhausted visible tiles without replacing successful neighbors. @return {void} */
    retryFailedTiles() {
        if (this.destroyed) return;
        for (const [tile, record] of this.tiles) {
            if (record.phase !== "failed" || !this.isVisible(record)) continue;
            record.attempts = 0;
            record.phase = "retrying";
            tile.src = record.source;
        }
        this.refresh();
    }

    /** Cancel timers and detach all observers, leaving the layer to its owner. @return {void} */
    destroy() {
        this.destroyed = true;
        for (const record of this.tiles.values()) clearTimeout(record.timer);
        this.tiles.clear();
        for (const [event, handler] of Object.entries(this.handlers)) this.layer.off(event, handler);
        this.map.off("moveend zoomend", this.onMove);
    }

    /**
     * Retry a failed visible image up to five times with increasing delays.
     * Exhausted tiles remain available for manual retry; leaving the view cancels
     * pending retry timers.
     * @param {HTMLImageElement} tile Failed image.
     * @return {void}
     */
    retryTile(tile) {
        const record = this.tiles.get(tile);
        if (this.destroyed || !record || record.timer !== null) return;
        record.phase = "failed";
        if (this.isVisible(record) && record.attempts < RETRY_DELAYS_MILLISECONDS.length) {
            record.phase = "retrying";
            record.timer = setTimeout(() => {
                record.timer = null;
                if (this.destroyed || !this.tiles.has(tile)) return;
                if (this.isVisible(record)) tile.src = record.source;
                else record.phase = "failed";
                this.refresh();
            }, RETRY_DELAYS_MILLISECONDS[record.attempts++]);
        }
        this.refresh();
    }

    /**
     * Forget an unloaded or aborted tile and cancel its retry.
     * @param {HTMLImageElement} tile Image discarded by Leaflet.
     * @return {void}
     */
    forget(tile) {
        clearTimeout(this.tiles.get(tile)?.timer);
        this.tiles.delete(tile);
        this.refresh();
    }

    /**
     * Test current-zoom viewport intersection, excluding the retained tile buffer.
     * @param {{coords:{x:number,y:number,z:number}}} record Tile coordinates.
     * @return {boolean} Whether the tile is currently visible.
     */
    isVisible(record) {
        const { x, y, z } = record.coords;
        if (z !== Math.round(this.map.getZoom())) return false;
        const bounds = this.map.getPixelBounds();
        const size = this.layer.getTileSize();
        return x * size.x < bounds.max.x && (x + 1) * size.x > bounds.min.x &&
            y * size.y < bounds.max.y && (y + 1) * size.y > bounds.min.y;
    }

    /** Cancel offscreen retries and publish counts after the current event burst. @return {void} */
    refresh() {
        if (this.destroyed) return;
        for (const record of this.tiles.values()) {
            if (!this.isVisible(record) && record.timer !== null) {
                clearTimeout(record.timer);
                record.timer = null;
                record.phase = "failed";
            }
        }
        if (this.scheduled) return;
        this.scheduled = true;
        queueMicrotask(() => {
            this.scheduled = false;
            if (this.destroyed) return;
            const tiles = [...this.tiles.values()].filter(record => this.isVisible(record));
            const loaded = tiles.filter(record => record.phase === "loaded").length;
            const failed = tiles.filter(record => record.phase === "failed").length;
            const retrying = tiles.some(record => record.phase === "retrying");
            const pending = tiles.length - loaded - failed;
            const phase = retrying ? "retrying" : pending || (!tiles.length && this.loading)
                ? "loading" : failed ? "incomplete" : "complete";
            this.onStatus({ phase, total: tiles.length, loaded, failed });
        });
    }
}
