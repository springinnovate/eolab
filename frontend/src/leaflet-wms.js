/** WMS image requests whose lifetime follows their Leaflet tiles. */

/**
 * @typedef {Object} WmsTileRequest
 * @property {string} url Leaflet-generated WMS URL, retained for retries.
 * @property {(error:Error|null,tile:HTMLImageElement)=>void} done Leaflet completion callback.
 * @property {AbortController|null} controller Current fetch attempt.
 * @property {string|null} objectUrl Decoded response retained until tile removal.
 * @property {boolean} loaded Whether an image has successfully loaded.
 */

/**
 * Create a WMS layer that aborts discarded requests, including pending zoom tiles.
 *
 * Leaflet still owns WMS URLs, tile placement, and reuse of loaded images. Fetch
 * owns network cancellation: clearing an image's src alone does not reliably
 * disconnect queued requests through the deployed proxy. Errors remain normal
 * Leaflet tile errors; aborting an obsolete tile does not report an error.
 *
 * @param {Object} leaflet Leaflet namespace with a WMS tile-layer factory.
 * @param {string} url Application WMS endpoint.
 * @param {Object} options Existing Leaflet WMS options.
 * @return {Object} WMS layer with retryTile(image) for retrying a failed request.
 */
export function createCancelableWmsLayer(leaflet, url, options) {
    const layer = leaflet.tileLayer.wms(url, options);
    /** @type {Map<HTMLImageElement,WmsTileRequest>} */
    const requests = new Map();

    /**
     * Release one attempt's network and image resources before removal or retry.
     * @param {HTMLImageElement} tile Tile image.
     * @param {WmsTileRequest} request Resources owned by this tile.
     * @return {void}
     */
    function release(tile, request) {
        request.controller?.abort();
        request.controller = null;
        tile.onload = null;
        tile.onerror = null;
        if (request.objectUrl) URL.revokeObjectURL(request.objectUrl);
        request.objectUrl = null;
    }

    /**
     * Fetch and decode a tile, ignoring completion from a removed/replaced attempt.
     * @param {HTMLImageElement} tile Retained tile image.
     * @param {WmsTileRequest} request URL and Leaflet completion callback.
     * @return {Promise<void>} Settles after assigning the image or reporting failure.
     */
    async function load(tile, request) {
        release(tile, request);
        const controller = new AbortController();
        request.controller = controller;
        /** @return {boolean} Whether this attempt can still update the tile. */
        const isCurrent = () => requests.get(tile) === request &&
            request.controller === controller && !controller.signal.aborted;
        try {
            const response = await fetch(request.url, { signal: controller.signal });
            if (!response.ok) throw new Error(`WMS tile request failed (${response.status}).`);
            const blob = await response.blob();
            if (!isCurrent()) return;
            request.objectUrl = URL.createObjectURL(blob);
            tile.onload = () => {
                if (!isCurrent()) return;
                request.loaded = true;
                request.done(null, tile);
            };
            tile.onerror = () => {
                if (isCurrent()) request.done(new Error("WMS tile image could not be decoded."), tile);
            };
            tile.src = request.objectUrl;
        } catch (error) {
            if (isCurrent()) request.done(error, tile);
        }
    }

    /**
     * Build a decorative tile image and start its cancellable request.
     * @param {{x:number,y:number,z:number}} coords Leaflet tile coordinates.
     * @param {(error:Error|null,tile:HTMLImageElement)=>void} done Leaflet callback.
     * @return {HTMLImageElement} Image populated when the request completes.
     */
    layer.createTile = function (coords, done) {
        const tile = document.createElement("img");
        tile.alt = "";
        const request = { url: this.getTileUrl(coords), done, controller: null,
            objectUrl: null, loaded: false };
        requests.set(tile, request);
        void load(tile, request);
        return tile;
    };

    /**
     * Retry a retained failed tile without replacing neighboring images.
     * @param {HTMLImageElement} tile Image previously returned by createTile.
     * @return {void}
     */
    layer.retryTile = function (tile) {
        const request = requests.get(tile);
        if (request && !request.loaded) void load(tile, request);
    };

    layer.on("tileunload tileabort", ({ tile }) => {
        const request = requests.get(tile);
        if (!request) return;
        requests.delete(tile);
        release(tile, request);
    });

    const abortLoading = layer._abortLoading;
    /**
     * Discard unfinished tiles from previous zoom levels before Leaflet updates.
     *
     * Leaflet 1.9 checks img.complete here, but an image waiting for fetch has no
     * src yet and appears complete. Keep this private lifecycle adaptation here;
     * loaded images continue through Leaflet's ordinary retention/pruning logic.
     * @return {void}
     */
    layer._abortLoading = function () {
        for (const [key, tile] of Object.entries(this._tiles)) {
            const request = requests.get(tile.el);
            if (request && !request.loaded && tile.coords.z !== this._tileZoom) {
                this._removeTile(key);
            }
        }
        abortLoading.call(this);
    };
    return layer;
}
