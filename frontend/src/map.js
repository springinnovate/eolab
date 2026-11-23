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
 * Find the largest rectangle outside the open panels in canvas-relative pixels.
 * Panel layout boxes count as covered at every opacity. Closed panels have
 * empty layout boxes. For a fully covered canvas, return a point at its center.
 *
 * @param {typeof import("leaflet")} leaflet Leaflet namespace.
 * @param {HTMLElement} container Map canvas.
 * @param {readonly HTMLElement[]} panels Floating panels above the canvas.
 * @return {import("leaflet").Bounds} Space available for map interaction.
 */
function measureUncoveredMapArea(leaflet, container, panels) {
    const {left, top, right, bottom} = container.getBoundingClientRect();
    let areas = [{left, top, right, bottom}];
    for (const panel of panels) {
        const footprint = panel.getBoundingClientRect();
        areas = areas.flatMap(area => {
            const coveredLeft = Math.max(area.left, footprint.left);
            const coveredTop = Math.max(area.top, footprint.top);
            const coveredRight = Math.min(area.right, footprint.right);
            const coveredBottom = Math.min(area.bottom, footprint.bottom);
            if (coveredLeft >= coveredRight || coveredTop >= coveredBottom) return [area];
            return [
                {...area, right: coveredLeft},
                {...area, left: coveredRight},
                {...area, bottom: coveredTop},
                {...area, top: coveredBottom},
            ].filter(rectangle => rectangle.left < rectangle.right && rectangle.top < rectangle.bottom);
        });
    }
    /** @param {DOMRectReadOnly|{left:number,top:number,right:number,bottom:number}} rectangle
     * @return {number} Area in square CSS pixels.
     */
    const rectangleArea = ({left, top, right, bottom}) => (right - left) * (bottom - top);
    const centerX = (left + right) / 2;
    const centerY = (top + bottom) / 2;
    const uncovered = areas.reduce(
        (largest, candidate) => rectangleArea(candidate) > rectangleArea(largest) ? candidate : largest,
        {left: centerX, top: centerY, right: centerX, bottom: centerY},
    );
    const x = Math.ceil(uncovered.left - left);
    const y = Math.ceil(uncovered.top - top);
    return leaflet.bounds([x, y], [
        Math.max(x, Math.floor(uncovered.right - left)),
        Math.max(y, Math.floor(uncovered.bottom - top)),
    ]);
}

/**
 * Keep fitting, navigation and map-centered actions in the uncovered area.
 * The Leaflet canvas still covers the whole map, including under the panels.
 *
 * @param {typeof import("leaflet")} leaflet Leaflet namespace.
 * @param {import("leaflet").Map} map Application map, before its first view.
 * @param {readonly HTMLElement[]} panels Floating panels above the canvas.
 * @return {MapVisibleView} Geographic view centered in the uncovered area.
 */
function bindMapNavigation(leaflet, map, panels) {
    const container = map.getContainer();
    let area = measureUncoveredMapArea(leaflet, container, panels);
    const zero = leaflet.point(0, 0);
    const getBoundsOffset = map._getBoundsOffset;
    /** Apply Leaflet 1.9.4's boundary rules to the uncovered rectangle.
     * @param {import("leaflet").Bounds} pixels Projected canvas bounds.
     * @param {import("leaflet").LatLngBounds} bounds Geographic limits.
     * @param {number} [zoom] Zoom of the projected canvas.
     * @return {import("leaflet").Point} Offset that brings the view inside the limits.
     */
    map._getBoundsOffset = function (pixels, bounds, zoom) {
        return getBoundsOffset.call(this, leaflet.bounds(
            pixels.min.add(area.min),
            pixels.min.add(area.max),
        ), bounds, zoom);
    };

    /** Keep the actual projected pixels inside bounds after navigation or layout changes.
     * @param {import("leaflet").LatLngBoundsExpression} bounds Geographic limits.
     * @param {import("leaflet").PanOptions} [options] Pan options.
     * @return {import("leaflet").Map} This map.
     */
    map.panInsideBounds = function (bounds, options) {
        const offset = this._limitOffset(zero, leaflet.latLngBounds(bounds)).round();
        if (offset.equals(zero)) return this;
        this._enforcingBounds = true;
        try {
            return this.panBy(offset, {animate: false, ...options});
        } finally {
            this._enforcingBounds = false;
        }
    };

    const BoundedDrag = leaflet.Map.Drag.extend({
        /** Limit the pending drag with the same rule used for inertial and keyboard panning.
         * @return {void}
         */
        _onPreDragLimit() {
            const pane = map._getMapPanePos();
            const proposed = pane.subtract(this._draggable._newPos);
            this._draggable._newPos = pane.subtract(map._limitOffset(proposed, map.options.maxBounds));
        },
    });
    map.dragging.disable();
    map.addHandler("dragging", BoundedDrag);

    /** Read the clear area's canonical geographic center.
     * @return {import("leaflet").LatLng} Center point of the uncovered map.
     */
    const getCenter = () => map.containerPointToLatLng(area.getCenter());

    /** Put a geographic location at the uncovered map's center, subject to the world bounds.
     * @param {import("leaflet").LatLngExpression} center Geographic focus.
     * @param {number} zoom Requested zoom.
     * @param {import("leaflet").ZoomPanOptions} [options] View transition options.
     * @return {import("leaflet").Map} This map.
     */
    function setView(center, zoom, options) {
        area = measureUncoveredMapArea(leaflet, container, panels);
        const halfCanvas = map.getSize().divideBy(2);
        const shift = halfCanvas.subtract(area.getCenter());
        if (shift.equals(zero)) return map.setView(center, zoom, options);

        zoom = map._limitZoom(zoom);
        const target = map.project(center, zoom).add(shift);
        const limit = map._getBoundsOffset(leaflet.bounds(
            target.subtract(halfCanvas), target.add(halfCanvas),
        ), map.options.maxBounds, zoom);
        const bounded = target.add(limit);
        const canvasCenter = map.unproject(bounded, zoom);
        if (Math.abs(map.project(canvasCenter, zoom).y - bounded.y) <= 1) {
            return map.setView(canvasCenter, zoom, options);
        }
        // On short, exposed strips the canvas center can be beyond Mercator's
        // latitude limit. Move the remaining distance in pixels.
        map.setView(canvasCenter, zoom, {...options, animate: false, reset: true});
        return map.panBy(bounded.subtract(map.getPixelBounds().getCenter()), {animate: false});
    }

    const setZoom = map.setZoom;
    /** Zoom buttons and centered shortcuts keep the clear area's focus in place.
     * @param {number} zoom Requested zoom.
     * @param {import("leaflet").ZoomOptions} [options] Zoom transition options.
     * @return {import("leaflet").Map} This map.
     */
    map.setZoom = function (zoom, options) {
        if (!this._loaded) return setZoom.call(this, zoom, options);
        return setView(getCenter(), zoom, {zoom: options});
    };

    /** Fit geographic bounds into the clear space, including the caller's margins.
     * @param {import("leaflet").LatLngBoundsExpression} bounds Geographic extent to fit.
     * @param {import("leaflet").FitBoundsOptions} [options] Margins, zoom limit and transition options.
     * @return {import("leaflet").Map} This map.
     * @throws {Error} If the supplied bounds are invalid.
     */
    map.fitBounds = function (bounds, options = {}) {
        const extent = leaflet.latLngBounds(bounds);
        if (!extent.isValid()) throw new Error("Bounds are not valid.");
        area = measureUncoveredMapArea(leaflet, container, panels);
        const size = area.getSize();
        const inset = this.getSize().subtract(size).divideBy(2);
        const start = leaflet.point(options.paddingTopLeft ?? options.padding ?? [0, 0]);
        const end = leaflet.point(options.paddingBottomRight ?? options.padding ?? [0, 0]);
        const total = start.add(end);
        // Leave some map for the target when the requested margins would fill a narrow strip.
        const scaleX = total.x >= size.x && total.x > 0 ? size.x / (2 * total.x) : 1;
        const scaleY = total.y >= size.y && total.y > 0 ? size.y / (2 * total.y) : 1;
        const target = this._getBoundsCenterZoom(extent, {
            ...options,
            paddingTopLeft: inset.add([start.x * scaleX, start.y * scaleY]),
            paddingBottomRight: inset.add([end.x * scaleX, end.y * scaleY]),
        });
        return setView(target.center, target.zoom, options);
    };

    observeMapViewportSize(map, panels, () => {
        area = measureUncoveredMapArea(leaflet, container, panels);
        map.panInsideBounds(map.options.maxBounds);
    });
    return {getCenter, getZoom: () => map.getZoom(), setView};
}

/**
 * @typedef {Object} MapVisibleView
 * @property {() => import("leaflet").LatLng} getCenter Geographic focus in the unobstructed area.
 * @property {() => number} getZoom Current map zoom.
 * @property {(center: import("leaflet").LatLngExpression, zoom: number, options?: import("leaflet").ZoomPanOptions) => import("leaflet").Map} setView
 * Restore the geographic focus and zoom with the current panels.
 */

/**
 * Create the application map and basemap without repeated world copies.
 * Hold Shift while zooming for smaller steps. Fit layers between the workspace
 * panels and retain active layers' attribution credits.
 *
 * @param {typeof import("leaflet")} leaflet Leaflet namespace.
 * @param {Object} appGlobalConfiguration Browser-safe application settings.
 * @param {(control:Object)=>void} [onBasemapReady] Receive the basemap's public selection interface.
 * @param {readonly HTMLElement[]} [panels=[]] Workspace panels whose layout boxes cover the map.
 * @return {import("leaflet").Map & {visibleView: MapVisibleView}} Initialized application map.
 */
export function createSingleWorldMap(leaflet, appGlobalConfiguration, onBasemapReady = () => {}, panels = []) {
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
    });
    leafletMap.visibleView = bindMapNavigation(leaflet, leafletMap, panels);
    leafletMap.visibleView.setView(
        [
            appGlobalConfiguration.initialView.latitude,
            appGlobalConfiguration.initialView.longitude
        ],
        appGlobalConfiguration.initialView.zoom
    );

    leafletMap.attributionControl.setPrefix(false);
    addFineMapZoom(leaflet, leafletMap);
    onBasemapReady(addBasemapControl(leaflet, leafletMap, appGlobalConfiguration.basemap, SINGLE_WORLD_BOUNDS));

    return leafletMap;
}

/**
 * Update the map after its canvas or the floating panels change size.
 * Removing the map releases the observer and pending frame.
 * @param {import("leaflet").Map} map Leaflet map.
 * @param {readonly HTMLElement[]} [panels=[]] Panels whose layout changes affect the clear area.
 * @param {() => void} [onResize] Update navigation after Leaflet reads the new canvas size.
 * @return {void}
 */
export function observeMapViewportSize(map, panels = [], onResize = () => {}) {
    const container = map.getContainer();
    const view = container.ownerDocument.defaultView;
    let frame = null;
    const observer = new view.ResizeObserver(() => {
        if (frame !== null) return;
        frame = view.requestAnimationFrame(() => {
            frame = null;
            map.invalidateSize({animate: false, debounceMoveend: true});
            onResize();
        });
    });
    observer.observe(container);
    for (const panel of panels) observer.observe(panel, {box: "border-box"});
    map.once("unload", () => {
        observer.disconnect();
        if (frame !== null) view.cancelAnimationFrame(frame);
    });
}
