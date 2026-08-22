/**
 * Leaflet adapter for EOLab's single canonical WGS 84 world.
 *
 * This module owns map and basemap options so horizontal bounds and tile
 * wrapping cannot drift apart as the application composition changes.
 */

export const SINGLE_WORLD_BOUNDS = [
    [-90, -180],
    [90, 180]
];

/**
 * Format a pointer position only when it belongs to the canonical world.
 *
 * At low zoom, a viewport can be wider than Leaflet's zoom-zero world. The
 * unused area is intentionally blank and must not display noncanonical
 * longitude values.
 *
 * @param {{lat: number, lng: number}} position Leaflet geographic position.
 * @return {string} Canonical coordinate text or an outside-bounds label.
 */
export function formatSingleWorldPosition(position) {
    if (
        !Number.isFinite(position?.lat) ||
        !Number.isFinite(position?.lng) ||
        position.lat < -90 ||
        position.lat > 90 ||
        position.lng < -180 ||
        position.lng > 180
    ) {
        return "Outside map bounds";
    }
    return `${position.lat.toFixed(3)}, ${position.lng.toFixed(3)}`;
}

/**
 * Create the application map and basemap without repeated world copies.
 *
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} appGlobalConfiguration Browser-safe application settings.
 * @return {Object} Initialized Leaflet-compatible map.
 */
export function createSingleWorldMap(leaflet, appGlobalConfiguration) {
    const leafletMap = leaflet.map("map", {
        zoomControl: false,
        minZoom: 0,
        maxZoom: 22,
        maxBounds: SINGLE_WORLD_BOUNDS,
        maxBoundsViscosity: 1,
        worldCopyJump: false
    }).setView(
        [
            appGlobalConfiguration.initialView.latitude,
            appGlobalConfiguration.initialView.longitude
        ],
        appGlobalConfiguration.initialView.zoom
    );

    leaflet.control.zoom({ position: "bottomleft" }).addTo(leafletMap);
    leaflet.tileLayer(appGlobalConfiguration.basemap.url, {
        attribution: appGlobalConfiguration.basemap.attribution,
        maxZoom: 22,
        noWrap: true,
        bounds: SINGLE_WORLD_BOUNDS
    }).addTo(leafletMap);

    return leafletMap;
}
