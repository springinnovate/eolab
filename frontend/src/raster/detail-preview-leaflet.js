/** Leaflet construction for bounded, sampled raster preview images. */

import {
    buildRasterDetailPreviewStyle,
    encodeRasterDetailPreviewPng
} from "./detail-preview-image.js";

/**
 * Convert canonical WGS 84 bounds to Leaflet southwest/northeast corners.
 *
 * @param {number[]} bounds West, south, east, north bounds.
 * @return {number[][]} Leaflet latitude/longitude corner pairs.
 */
function toLeafletBounds(bounds) {
    return [
        [bounds[1], bounds[0]],
        [bounds[3], bounds[2]]
    ];
}

/**
 * Create one grouped map layer and appropriate focus for a sampled preview.
 *
 * The dashed outline is the cataloged raster extent, not a valid-data
 * footprint. The backend has already warped the bounded numeric image into a
 * Web-Mercator-aligned rectangle; the browser applies EOLab's shared raster
 * color ramp locally and keeps nodata transparent.
 *
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} preview Validated detail-preview response.
 * @param {{encodeImage?:(preview:Object,style:Object)=>string}}
 * [dependencies={}] Injectable PNG encoder.
 * @return {{layer:Object,focusBounds:number[][],style:Object}} Grouped layer,
 * fit bounds, and the exact shared raster style used for coloring.
 * @throws {Error} If style validation, PNG encoding, or Leaflet construction
 * fails.
 */
export function createRasterDetailPreviewLayer(
    leaflet,
    preview,
    { encodeImage = encodeRasterDetailPreviewPng } = {}
) {
    const extentBounds = toLeafletBounds(preview.rasterExtent);
    const imageBounds = toLeafletBounds(preview.imageBounds);
    const style = buildRasterDetailPreviewStyle(preview);
    const imageDataUrl = encodeImage(preview, style);
    const layers = [
        leaflet.rectangle(extentBounds, {
            color: "#f97316",
            weight: 2,
            dashArray: "7 5",
            fill: false,
            interactive: false,
            className: "raster-detail-extent"
        }),
        leaflet.imageOverlay(imageDataUrl, imageBounds, {
            opacity: 1,
            interactive: false,
            className: "raster-sampled-proxy"
        })
    ];
    if (preview.mode === "representativePatch") {
        layers.push(leaflet.rectangle(imageBounds, {
            color: "#0f766e",
            weight: 2,
            fill: false,
            interactive: false,
            className: "raster-detail-patch-boundary"
        }));
    }
    return {
        layer: leaflet.layerGroup(layers),
        focusBounds: preview.mode === "representativePatch"
            ? imageBounds
            : extentBounds,
        style
    };
}
