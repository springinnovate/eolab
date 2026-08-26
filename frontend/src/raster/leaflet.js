/**
 * Leaflet adapter for raster layers, bounds, and layer lifecycle.
 *
 * This module converts raster domain bounds to Leaflet coordinates, creates
 * WMS and sample-window layers, and manages keyed raster attachment, opacity,
 * and drawing order. It does not fetch publication or statistics data.
 */
import { validateRasterSelectedBounds } from "./geometry.js";

export const RASTER_SAMPLE_WINDOW_PANE = "rasterSampleWindowPane";
const RASTER_SAMPLE_WINDOW_PANE_Z_INDEX = "450";

/**
 * Ensure histogram preview/selection rectangles sit above raster imagery.
 *
 * @param {Object} leafletMap Leaflet-compatible map with pane factories.
 * @return {Object} Existing or created noninteractive sample-window pane.
 * @throws {Error} If Leaflet cannot provide the required styled pane.
 */
export function ensureRasterSampleWindowPane(leafletMap) {
    if (typeof leafletMap.getPane !== "function" ||
        typeof leafletMap.createPane !== "function") {
        throw new Error("Raster sample-window map pane factories are required.");
    }
    let pane = leafletMap.getPane(RASTER_SAMPLE_WINDOW_PANE);
    if (pane === undefined || pane === null) {
        pane = leafletMap.createPane(RASTER_SAMPLE_WINDOW_PANE);
    }
    if (pane === undefined || pane === null || pane.style === undefined) {
        throw new Error("Raster sample-window map pane is required.");
    }
    pane.style.zIndex = RASTER_SAMPLE_WINDOW_PANE_Z_INDEX;
    pane.style.pointerEvents = "none";
    return pane;
}
/**
 * Convert canonical bounds to Leaflet corners in the single visible world.
 *
 * @param {Object} bounds Canonical WGS 84 selected bounds.
 * @return {Array<Array<number>>} Southwest and northeast Leaflet corners.
 * @throws {Error} If bounds violate the selected-bounds contract.
 */
export function rasterSampleBoundsToLeaflet(bounds) {
    validateRasterSelectedBounds(bounds);
    return [
        [bounds.south, bounds.west],
        [bounds.north, bounds.east]
    ];
}
/**
 * Create the Leaflet WMS layer for one published Catalog raster.
 *
 * @param {Object} leaflet Leaflet namespace with a WMS tile-layer factory.
 * @param {string} wmsUrl Browser-facing GeoServer WMS endpoint.
 * @param {{bbox: number[], layerName: string}} publishedRaster Published
 * GeoServer layer identity and WGS 84 bounds.
 * @param {string} styleEnvironment Validated dynamic-style WMS environment.
 * @param {() => void} onTileError Reports the layer's first tile failure.
 * @return {Object} Leaflet-compatible WMS layer.
 */
export function createRasterWmsLayer(
    leaflet,
    wmsUrl,
    publishedRaster,
    styleEnvironment,
    onTileError
) {
    const [west, south, east, north] = publishedRaster.bbox;
    const rasterLayer = leaflet.tileLayer.wms(wmsUrl, {
        layers: publishedRaster.layerName,
        styles: "dynamic-raster",
        env: styleEnvironment,
        format: "image/png",
        transparent: true,
        version: "1.3.0",
        noWrap: true,
        bounds: [
            [south, west],
            [north, east]
        ]
    });
    rasterLayer.once("tileerror", onTileError);
    return rasterLayer;
}

/**
 * Create one Leaflet rectangle for sample preview or committed selection.
 *
 * @param {Object} leaflet Leaflet namespace with a rectangle factory.
 * @param {Array<Array<number>>} bounds Visible-world Leaflet corners.
 * @param {"preview"|"selection"} layerKind Rectangle presentation kind.
 * @return {Object} Leaflet-compatible rectangle layer.
 */
export function createRasterSampleWindowLayer(leaflet, bounds, layerKind) {
    return leaflet.rectangle(bounds, layerKind === "preview"
        ? {
            pane: RASTER_SAMPLE_WINDOW_PANE,
            color: "#f97316",
            weight: 2,
            fill: false,
            interactive: false
        }
        : {
            pane: RASTER_SAMPLE_WINDOW_PANE,
            color: "#2563eb",
            weight: 2,
            fillColor: "#3b82f6",
            fillOpacity: 0.12,
            interactive: false
        });
}
