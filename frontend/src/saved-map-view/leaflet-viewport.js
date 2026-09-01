/** Leaflet adapter for the neutral saved-map viewport contract. */

/**
 * Create a snapshot-and-restore boundary over one initialized Leaflet map.
 *
 * @param {Object} leafletMap Leaflet-compatible map.
 * @return {Readonly<{snapshot:Function,restore:Function}>} Viewport adapter.
 */
export function createSavedMapLeafletViewport(leafletMap) {
    return Object.freeze({
        /** Return the current canonical map center and zoom. */
        snapshot() {
            const center = leafletMap.getCenter();
            return {
                center: {
                    latitude: center.lat,
                    longitude: center.lng,
                },
                zoom: leafletMap.getZoom(),
            };
        },
        /**
         * Restore a previously validated canonical map viewport.
         *
         * @param {Object} viewport Saved viewport.
         * @return {void}
         */
        restore(viewport) {
            leafletMap.setView(
                [viewport.center.latitude, viewport.center.longitude],
                viewport.zoom
            );
        },
    });
}
