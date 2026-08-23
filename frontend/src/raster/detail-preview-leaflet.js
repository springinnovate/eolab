/** Leaflet construction for bounded, sampled raster preview images. */

import {
    buildRasterDetailPreviewStyle,
    encodeRasterDetailPreviewPng
} from "./detail-preview-image.js";

export const RASTER_DETAIL_PREVIEW_IMAGE_PANE =
    "rasterDetailPreviewImagePane";
export const RASTER_DETAIL_PREVIEW_BOUNDARY_PANE =
    "rasterDetailPreviewBoundaryPane";
const RASTER_DETAIL_PREVIEW_IMAGE_Z_INDEX = "420";
const RASTER_DETAIL_PREVIEW_BOUNDARY_Z_INDEX = "440";

/**
 * Ensure sampled images and their outlines use ordered noninteractive panes.
 *
 * The boundary pane sits above the opaque numeric images but below the
 * temporary-AOI pane, preserving both raster labels and AOI visibility.
 *
 * @param {Object} leafletMap Leaflet-compatible map with pane factories.
 * @return {{imagePane:Object,boundaryPane:Object}} Existing or created panes.
 * @throws {Error} If Leaflet cannot provide either required styled pane.
 */
export function ensureRasterDetailPreviewPanes(leafletMap) {
    if (typeof leafletMap.getPane !== "function" ||
        typeof leafletMap.createPane !== "function") {
        throw new Error("Sampled raster map pane factories are required.");
    }
    /**
     * Resolve one styled pane owned by sampled-raster presentation.
     *
     * @param {string} name Stable Leaflet pane name.
     * @param {string} zIndex Ordered CSS stacking index.
     * @return {Object} Existing or newly created styled pane.
     * @throws {Error} If Leaflet cannot provide the requested pane.
     */
    const ensurePane = (name, zIndex) => {
        let pane = leafletMap.getPane(name);
        if (pane === undefined || pane === null) {
            pane = leafletMap.createPane(name);
        }
        if (pane === undefined || pane === null || pane.style === undefined) {
            throw new Error("Sampled raster map panes are required.");
        }
        pane.style.zIndex = zIndex;
        pane.style.pointerEvents = "none";
        return pane;
    };
    return {
        imagePane: ensurePane(
            RASTER_DETAIL_PREVIEW_IMAGE_PANE,
            RASTER_DETAIL_PREVIEW_IMAGE_Z_INDEX
        ),
        boundaryPane: ensurePane(
            RASTER_DETAIL_PREVIEW_BOUNDARY_PANE,
            RASTER_DETAIL_PREVIEW_BOUNDARY_Z_INDEX
        )
    };
}

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
 * @param {{encodeImage?:(preview:Object,style:Object)=>string,style?:Object}}
 * [dependencies={}] Injectable PNG encoder and optional session color style.
 * @return {{layer:Object,focusBounds:number[][],style:Object,dispose:Function}}
 * Grouped layer, fit bounds, exact shared color style, and cleanup callback.
 * @throws {Error} If style validation, PNG encoding, or Leaflet construction
 * fails.
 */
export function createRasterDetailPreviewLayer(
    leaflet,
    preview,
    {
        encodeImage = encodeRasterDetailPreviewPng,
        style: sessionStyle = null
    } = {}
) {
    const extentBounds = toLeafletBounds(preview.rasterExtent);
    const imageBounds = toLeafletBounds(preview.imageBounds);
    const style = sessionStyle ?? buildRasterDetailPreviewStyle(preview);
    const imageDataUrl = encodeImage(preview, style);
    const layers = [];
    if (preview.scope !== "currentView") {
        layers.push(leaflet.rectangle(extentBounds, {
            pane: RASTER_DETAIL_PREVIEW_BOUNDARY_PANE,
            color: "#f97316",
            weight: 2,
            dashArray: "7 5",
            fill: false,
            interactive: false,
            className: "raster-detail-extent"
        }));
    }
    layers.push(leaflet.imageOverlay(imageDataUrl, imageBounds, {
            pane: RASTER_DETAIL_PREVIEW_IMAGE_PANE,
            opacity: 1,
            interactive: false,
            className: "raster-sampled-proxy"
        }));
    if (preview.scope === "currentView") {
        layers.push(leaflet.rectangle(imageBounds, {
            pane: RASTER_DETAIL_PREVIEW_BOUNDARY_PANE,
            color: "#0f766e",
            weight: 2,
            fill: false,
            interactive: false,
            className: "raster-current-view-detail-boundary"
        }));
    }
    if (preview.mode === "representativePatch") {
        layers.push(leaflet.rectangle(imageBounds, {
            pane: RASTER_DETAIL_PREVIEW_BOUNDARY_PANE,
            color: "#0f766e",
            weight: 2,
            fill: false,
            interactive: false,
            className: "raster-detail-patch-boundary"
        }));
    }
    return {
        layer: leaflet.layerGroup(layers),
        focusBounds: preview.scope === "representativePatch"
            ? imageBounds
            : extentBounds,
        style,
        dispose() {}
    };
}
