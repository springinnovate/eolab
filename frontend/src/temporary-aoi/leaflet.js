/**
 * Leaflet adapter and map-layer lifecycle for one temporary AOI overlay.
 */

export const TEMPORARY_AOI_PANE = "temporaryAoiPane";
const TEMPORARY_AOI_PANE_Z_INDEX = "460";

/**
 * Ensure the isolated temporary-AOI pane exists above ordinary overlays.
 *
 * @param {Object} leafletMap Leaflet-compatible map with pane factories.
 * @return {HTMLElement|Object} Existing or newly created AOI pane.
 * @throws {Error} If the map cannot provide the required pane.
 */
export function ensureTemporaryAoiPane(leafletMap) {
    let pane = leafletMap.getPane(TEMPORARY_AOI_PANE);
    if (pane === undefined || pane === null) {
        pane = leafletMap.createPane(TEMPORARY_AOI_PANE);
    }
    if (pane === undefined || pane === null || pane.style === undefined) {
        throw new Error("Temporary AOI map pane is required.");
    }
    pane.style.zIndex = TEMPORARY_AOI_PANE_Z_INDEX;
    pane.style.pointerEvents = "none";
    return pane;
}

/**
 * Create a noninteractive high-contrast GeoJSON overlay in its isolated pane.
 *
 * @param {Object} leaflet Leaflet namespace with a GeoJSON layer factory.
 * @param {Object} geometry Validated GeoJSON FeatureCollection.
 * @return {Object} Leaflet-compatible temporary-AOI layer.
 */
export function createTemporaryAoiLayer(leaflet, geometry) {
    return leaflet.geoJSON(geometry, {
        pane: TEMPORARY_AOI_PANE,
        interactive: false,
        style: {
            className: "temporary-aoi-overlay",
            color: "#6d1b7b",
            fillColor: "#ffdf57",
            fillOpacity: 0.24,
            lineCap: "round",
            lineJoin: "round",
            opacity: 1,
            weight: 4,
        },
    });
}

/** Manage the retained geometry and visibility of one temporary AOI layer. */
export class TemporaryAoiLayerController {
    /**
     * Create the one-overlay Leaflet lifecycle boundary.
     *
     * @param {Object} leafletMap Leaflet-compatible application map.
     * @param {Object} leaflet Leaflet namespace with GeoJSON and bounds factories.
     */
    constructor(leafletMap, leaflet) {
        this.leafletMap = leafletMap;
        this.leaflet = leaflet;
        this.activeLayer = null;
        this.activeBounds = null;
        this.isVisible = false;
        ensureTemporaryAoiPane(leafletMap);
    }

    /**
     * Replace retained browser geometry, display it, and zoom to its bounds.
     *
     * @param {{geometry: Object, bbox: number[]}} temporaryAoi Ready AOI response.
     * @return {void}
     */
    load(temporaryAoi) {
        this.clear();
        const [west, south, east, north] = temporaryAoi.bbox;
        this.activeLayer = createTemporaryAoiLayer(
            this.leaflet,
            temporaryAoi.geometry
        );
        this.activeBounds = this.leaflet.latLngBounds(
            [[south, west], [north, east]]
        );
        this.show();
        this.zoom();
    }

    /**
     * Display retained geometry when it is currently hidden.
     *
     * @return {boolean} Whether geometry is displayed after the operation.
     */
    show() {
        if (this.activeLayer === null) {
            return false;
        }
        if (!this.isVisible) {
            this.activeLayer.addTo(this.leafletMap);
            this.isVisible = true;
        }
        return true;
    }

    /**
     * Hide retained geometry without removing the temporary server resource.
     *
     * @return {boolean} Whether retained geometry was available to hide.
     */
    hide() {
        if (this.activeLayer === null) {
            return false;
        }
        if (this.isVisible) {
            this.leafletMap.removeLayer(this.activeLayer);
            this.isVisible = false;
        }
        return true;
    }

    /**
     * Fit the map to retained valid bounds without zooming beyond AOI context.
     *
     * @return {boolean} Whether the map was fit to valid retained bounds.
     */
    zoom() {
        if (this.activeBounds === null || !this.activeBounds.isValid()) {
            return false;
        }
        this.leafletMap.fitBounds(this.activeBounds.pad(0.15), { maxZoom: 13 });
        return true;
    }

    /**
     * Remove browser geometry and all retained map presentation state.
     *
     * @return {void}
     */
    clear() {
        if (this.activeLayer !== null && this.isVisible) {
            this.leafletMap.removeLayer(this.activeLayer);
        }
        this.activeLayer = null;
        this.activeBounds = null;
        this.isVisible = false;
    }
}
