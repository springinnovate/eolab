/** Leaflet construction and presentation metadata for bounded vector WMS. */

/** Fixed browser legend colors matching initializer-owned GeoServer SLDs. */
export const VECTOR_DEFAULT_SYMBOLOGY = Object.freeze({
    point: Object.freeze({
        label: "Point",
        fill: "#fd8d3c",
        stroke: "#800026",
    }),
    line: Object.freeze({
        label: "Line",
        fill: "transparent",
        stroke: "#e31a1c",
    }),
    polygon: Object.freeze({
        label: "Polygon",
        fill: "#fd8d3c",
        stroke: "#800026",
    }),
});

/**
 * Create one bounded WMS tile layer for a published catalog vector.
 *
 * @param {Object} leaflet Leaflet namespace with a WMS factory.
 * @param {string} wmsUrl Browser-facing restricted WMS endpoint.
 * @param {{bbox:number[],layerName:string,geometryKind:string,styleName:string}}
 * publishedVector Validated publication contract.
 * @param {() => void} onTileError Reports the layer's first tile failure.
 * @return {Object} Leaflet-compatible bounded WMS tile layer.
 */
export function createVectorWmsLayer(
    leaflet,
    wmsUrl,
    publishedVector,
    onTileError
) {
    const [west, south, east, north] = publishedVector.bbox;
    const layer = leaflet.tileLayer.wms(wmsUrl, {
        layers: publishedVector.layerName,
        styles: publishedVector.styleName,
        format: "image/png",
        transparent: true,
        tiled: true,
        tilesorigin: "-20037508.342789244,-20037508.342789244",
        version: "1.3.0",
        noWrap: true,
        bounds: [
            [south, west],
            [north, east],
        ],
    });
    layer.once("tileerror", onTileError);
    return layer;
}
