/** Leaflet construction and presentation metadata for bounded vector WMS. */

/** Fixed browser legend colors matching initializer-owned GeoServer SLDs. */
export const VECTOR_DEFAULT_SYMBOLOGY = Object.freeze({
    point: Object.freeze({
        label: "Point",
        fill: "#2b83ba",
        stroke: "#000000",
    }),
    line: Object.freeze({
        label: "Line",
        fill: "transparent",
        stroke: "#2b83ba",
    }),
    polygon: Object.freeze({
        label: "Polygon",
        fill: "#2b83ba",
        stroke: "#000000",
    }),
});

/**
 * Fit validated vector bounds into the application's single Leaflet world.
 *
 * Crossing extents use the full longitude span so both date-line edges can
 * render. This conservative display envelope does not replace catalog bounds.
 *
 * @param {number[]} bbox Validated WGS 84 west, south, east, north bounds.
 * @return {number[][]} Southwest and northeast Leaflet corners.
 */
export function vectorMapBounds(bbox) {
    const [west, south, east, north] = bbox;
    return [[south, west > east ? -180 : west], [north, west > east ? 180 : east]];
}

/**
 * Create one WMS tile layer that posts its appearance with each tile request.
 * The returned layer provides reloadTile(image) for retrying its POST request.
 * Retain both sides of crossing extents.
 * Render through the map's maximum zoom of 22 instead of Leaflet's default 18.
 *
 * @param {Object} leaflet Leaflet namespace with a WMS factory.
 * @param {string} wmsUrl Browser-facing restricted WMS endpoint.
 * @param {{bbox:number[],layerName:string,geometryKind:string,styleName:string,style:Object}}
 * publishedVector Validated publication and complete vector appearance.
 * @param {() => void} onTileError Reports the layer's first tile failure.
 * @return {Object} Leaflet-compatible bounded WMS tile layer.
 */
export function createVectorWmsLayer(
    leaflet,
    wmsUrl,
    publishedVector,
    onTileError
) {
    const layer = leaflet.tileLayer.wms(wmsUrl, {
        layers: publishedVector.layerName,
        styles: publishedVector.styleName,
        vector_style: JSON.stringify(publishedVector.style),
        format: "image/png",
        transparent: true,
        tiled: true,
        tilesorigin: "-20037508.342789244,-20037508.342789244",
        version: "1.3.0",
        noWrap: true,
        maxZoom: 22,
        bounds: vectorMapBounds(publishedVector.bbox),
    });
    const requests = new WeakMap();

    /**
     * Cancel a tile's HTTP request and release its temporary image URL.
     * @param {HTMLImageElement} tile Tile being retried or discarded.
     * @return {void}
     */
    function cancelTileRequest(tile) {
        const request = requests.get(tile);
        request.controller?.abort();
        tile.onload = null;
        tile.onerror = null;
        if (request.objectUrl !== null) {
            URL.revokeObjectURL(request.objectUrl);
            request.objectUrl = null;
        }
    }

    /**
     * Repeat a tile's WMS POST with the layer's current rendering parameters.
     * Aborted or replaced requests cannot install an image or report completion.
     * @param {HTMLImageElement} tile Tile returned by this layer's createTile.
     * @return {Promise<void>} Settles after installing an image or reporting failure.
     */
    layer.reloadTile = async function (tile) {
        cancelTileRequest(tile);
        const request = requests.get(tile);
        const controller = new AbortController();
        request.controller = controller;
        tile.removeAttribute("src");
        const url = layer.getTileUrl(request.coords);
        const separator = url.indexOf("?");
        let blob;
        try {
            const response = await fetch(url.slice(0, separator), {
                method: "POST",
                headers: { "X-EOLab-Uploads": "1" },
                body: new URLSearchParams(url.slice(separator + 1)),
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(`Vector tile returned ${response.status}.`);
            blob = await response.blob();
        } catch (error) {
            if (!controller.signal.aborted) request.done(error, tile);
            return;
        }
        if (controller.signal.aborted) return;
        request.objectUrl = URL.createObjectURL(blob);
        tile.onload = () => {
            cancelTileRequest(tile);
            request.done(null, tile);
        };
        tile.onerror = () => {
            cancelTileRequest(tile);
            request.done(new Error("The vector tile image could not be read."), tile);
        };
        tile.src = request.objectUrl;
    };

    /**
     * Create a decorative image and load its WMS tile through the POST transport.
     * @param {{x:number,y:number,z:number}} coords Leaflet tile coordinates.
     * @param {(error:Error|null,tile:HTMLImageElement)=>void} done Leaflet completion callback.
     * @return {HTMLImageElement} Image owned by Leaflet's normal tile lifecycle.
     */
    layer.createTile = function (coords, done) {
        const tile = document.createElement("img");
        tile.alt = "";
        requests.set(tile, { coords, done, controller: null, objectUrl: null });
        void layer.reloadTile(tile);
        return tile;
    };
    layer.on("tileunload tileabort", ({ tile }) => {
        cancelTileRequest(tile);
        requests.delete(tile);
    });
    layer.once("tileerror", onTileError);
    return layer;
}
