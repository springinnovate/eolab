/**
 * Leaflet adapter for EOLab's single canonical WGS 84 world.
 *
 * This module owns map and basemap options so horizontal bounds and tile
 * wrapping cannot drift apart as the application composition changes.
 */

import { addBasemapControl } from "./basemap-control.js";

export const SINGLE_WORLD_BOUNDS = [
    [-90, -180],
    [90, 180]
];

/**
 * Convert WGS 84 bounding coordinates to Leaflet's latitude/longitude corners.
 *
 * RFC 7946 section 5 orders all lower axes before all upper axes. A crossing
 * bbox (west > east) needs the full longitude span to show both sides within
 * this application's single, non-wrapping world.
 *
 * @param {unknown} bbox A possible 2D or 3D bounding box in GeoJSON axis order.
 * @return {number[][]|null} Map corners, or null for missing/invalid bounds.
 */
export function getSingleWorldMapBounds(bbox) {
    if (!Array.isArray(bbox) || ![4, 6].includes(bbox.length) ||
        !bbox.every(Number.isFinite)) return null;
    const dimensions = bbox.length / 2;
    const [west, south] = bbox;
    const [east, north] = bbox.slice(dimensions);
    if (south < -90 || north > 90 || south > north ||
        Math.abs(west) > 180 || Math.abs(east) > 180 ||
        (dimensions === 3 && bbox[2] > bbox[5])) return null;
    return [[south, west > east ? -180 : west], [north, west > east ? 180 : east]];
}

/**
 * Convert a STAC Item's WGS 84 bounding box to corners for the single-world map.
 * @param {{bbox?:number[]}|null} item Catalog Item with an optional bounding box.
 * @return {number[][]|null} Map corners, or null for missing or invalid bounds.
 */
export function getCatalogItemMapBounds(item) {
    return getSingleWorldMapBounds(item?.bbox);
}

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
 * Add fine zoom with Shift and the wheel or +/- keys while preserving ordinary map navigation.
 * These map-local subclasses delegate to the pinned Leaflet 1.9.4 hooks; they
 * do not modify Leaflet's prototypes or any other map instance.
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} map Initialized Leaflet map.
 * @return {void}
 */
function addFineMapZoom(leaflet, map) {
    map.options.zoomSnap = 0.1;
    /** Finish Leaflet's active transition so it cannot discard the next zoom.
     * @return {void}
     */
    function finishZoomAnimation() {
        if (map._animatingZoom) map._onZoomTransitionEnd();
    }
    const wheel = leaflet.Map.ScrollWheelZoom.prototype;
    const FineWheelZoom = leaflet.Map.ScrollWheelZoom.extend({
        /** Keep normal and Shift wheel input in separate native debounce batches.
         * @param {WheelEvent} event Map wheel event. @return {void}
         */
        _onWheelScroll(event) {
            if (this._startTime && this.fineZoom !== event.shiftKey) {
                clearTimeout(this._timer);
                this._performZoom();
            }
            this.fineZoom = event.shiftKey;
            wheel._onWheelScroll.call(this, event);
        },
        /** Run Leaflet's wheel calculation with fine or ordinary sensitivity.
         * @return {void}
         */
        _performZoom() {
            finishZoomAnimation();
            const {zoomSnap, wheelPxPerZoomLevel} = map.options;
            map.options.zoomSnap = this.fineZoom ? 0.1 : 1;
            map.options.wheelPxPerZoomLevel *= this.fineZoom ? 10 : 1;
            try {
                wheel._performZoom.call(this);
            } finally {
                Object.assign(map.options, {zoomSnap, wheelPxPerZoomLevel});
            }
        },
        /** Detach native wheel input and discard its pending zoom batch.
         * @return {void}
         */
        removeHooks() {
            clearTimeout(this._timer);
            this._delta = 0;
            this._startTime = null;
            wheel.removeHooks.call(this);
        },
    });
    map.scrollWheelZoom.disable();
    map.addHandler("scrollWheelZoom", FineWheelZoom);

    const keyboard = leaflet.Map.Keyboard.prototype;
    const FineKeyboardZoom = leaflet.Map.Keyboard.extend({
        /** Use fine Shift +/- keys while preserving navigation and form shortcuts.
         * @param {KeyboardEvent} event Focused-map key event. @return {void}
         */
        _onKeyDown(event) {
            const delta = this._zoomKeys[event.keyCode];
            if (!event.shiftKey || !delta || event.altKey || event.ctrlKey || event.metaKey) {
                return keyboard._onKeyDown.call(this, event);
            }
            finishZoomAnimation();
            map.setZoom(map.getZoom() + Math.sign(delta) * 0.1, {animate: false});
            leaflet.DomEvent.stop(event);
        },
    });
    map.keyboard.disable();
    map.addHandler("keyboard", FineKeyboardZoom);

    const getBoundsZoom = map.getBoundsZoom;
    /** Keep fit-to-layer and Shift-drag box zoom on their original whole levels.
     * @param {Object|number[][]} bounds Leaflet geographic bounds.
     * @param {boolean} [inside] Fit the view inside the bounds.
     * @param {Object|number[]} [padding] Pixel padding.
     * @return {number} Fitting zoom level within the map limits.
     */
    map.getBoundsZoom = function (bounds, inside, padding) {
        const snap = this.options.zoomSnap;
        this.options.zoomSnap = 1;
        try {
            return getBoundsZoom.call(this, bounds, inside, padding);
        } finally {
            this.options.zoomSnap = snap;
        }
    };
}

/**
 * Create the application map and basemap without repeated world copies.
 * Hold Shift while zooming for smaller steps. Fit layers between the workspace
 * panels and retain active layers' attribution credits.
 *
 * @param {Object} leaflet Leaflet namespace.
 * @param {Object} appGlobalConfiguration Browser-safe application settings.
 * @param {(control:Object)=>void} [onBasemapReady] Receive the basemap's public selection interface.
 * @return {Object} Initialized Leaflet-compatible map.
 */
export function createSingleWorldMap(leaflet, appGlobalConfiguration, onBasemapReady = () => {}) {
    const leafletMap = leaflet.map("map", {
        zoomControl: false,
        minZoom: 0,
        maxZoom: 22,
        maxBounds: SINGLE_WORLD_BOUNDS,
        maxBoundsViscosity: 1,
        worldCopyJump: false,
        updateWhenIdle: true,
        updateWhenZooming: false,
        wheelDebounceTime: 120,
    }).setView(
        [
            appGlobalConfiguration.initialView.latitude,
            appGlobalConfiguration.initialView.longitude
        ],
        appGlobalConfiguration.initialView.zoom
    );

    leafletMap.attributionControl.setPrefix(false);
    const fitBounds = leafletMap.fitBounds;
    /** Fit a layer in the unobstructed map area while retaining the caller's extra padding.
     * @param {import("leaflet").LatLngBoundsExpression} bounds Geographic bounds to show.
     * @param {import("leaflet").FitBoundsOptions} [options] Leaflet zoom, animation and padding options.
     * @return {import("leaflet").Map} The map after requesting the fitted view.
     */
    leafletMap.fitBounds = function (bounds, options = {}) {
        const container = this.getContainer();
        const canvas = container.getBoundingClientRect();
        const controls = container.querySelector(".leaflet-control-container").getBoundingClientRect();
        return fitBounds.call(this, bounds, {
            ...options,
            paddingTopLeft: leaflet.point(options.paddingTopLeft ?? options.padding ?? [0, 0])
                .add([controls.left - canvas.left, controls.top - canvas.top]),
            paddingBottomRight: leaflet.point(options.paddingBottomRight ?? options.padding ?? [0, 0])
                .add([canvas.right - controls.right, canvas.bottom - controls.bottom]),
        });
    };
    addFineMapZoom(leaflet, leafletMap);
    onBasemapReady(addBasemapControl(leaflet, leafletMap, appGlobalConfiguration.basemap, SINGLE_WORLD_BOUNDS));

    return leafletMap;
}

/**
 * Keep Leaflet's pixel coordinates aligned when a sidebar resizes the map.
 * ResizeObserver covers CSS transitions and panel changes without knowing which
 * tool caused them. Removing the map releases the observer and pending frame.
 * @param {Object} map Initialized Leaflet map.
 * @return {void}
 */
export function observeMapViewportSize(map) {
    const container = map.getContainer();
    const view = container.ownerDocument.defaultView;
    let frame = null;
    const observer = new view.ResizeObserver(() => {
        if (frame !== null) return;
        frame = view.requestAnimationFrame(() => {
            frame = null;
            map.invalidateSize({animate: false, debounceMoveend: true});
        });
    });
    observer.observe(container);
    map.once("unload", () => {
        observer.disconnect();
        if (frame !== null) view.cancelAnimationFrame(frame);
    });
}
