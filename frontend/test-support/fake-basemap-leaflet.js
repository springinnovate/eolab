import { FakeRasterControlDocument } from "./raster/fake-controls-document.js";

/**
 * Create a pixel point for recording calls across the Leaflet boundary.
 * @param {number|number[]} x X coordinate or coordinate pair.
 * @param {number} [y] Y coordinate.
 * @return {Object} Point supporting the fixture's viewport operations.
 */
function point(x, y) {
    if (Array.isArray(x)) [x, y] = x;
    return {
        x, y,
        add(other) {
            const [otherX, otherY] = Array.isArray(other) ? other : [other.x, other.y];
            return point(x + otherX, y + otherY);
        },
        subtract(other) { return point(x - other.x, y - other.y); },
        divideBy(divisor) { return point(x / divisor, y / divisor); },
        equals(other) { return x === other.x && y === other.y; },
    };
}

/**
 * Create a rectangle for recording viewport size and position.
 * @param {number[]|Object} start Top left.
 * @param {number[]|Object} end Bottom right.
 * @return {Object} Fixture pixel bounds.
 */
function bounds(start, end) {
    const min = Array.isArray(start) ? point(start) : start;
    const max = Array.isArray(end) ? point(end) : end;
    return {min, max, getCenter: () => min.add(max).divideBy(2), getSize: () => max.subtract(min)};
}

/**
 * Track map backgrounds, controls, and attributions without loading network tiles.
 * @return {Object} Leaflet double, map, DOM, and captured calls.
 */
export function createLeafletDouble() {
    const document = new FakeRasterControlDocument();
    document.defaultView.ResizeObserver = class { observe() {} };
    const canvas = {left: 0, top: 0, right: 1000, bottom: 600};
    const container = {
        ownerDocument: document,
        getBoundingClientRect: () => canvas,
        querySelector: () => ({getBoundingClientRect: () => canvas}),
    };
    const calls = { map: null, setView: null, basemap: null,
        layers: [], controls: [], stoppedClicks: [], stoppedScrolls: [] };
    /** Construct a Leaflet-style handler whose subclass can delegate native hooks. */
    class Handler {
        /** @param {Object} map Owning map. */
        constructor(map) { this._map = map; }
        /** @return {Handler} Enabled handler. */
        enable() { this._enabled = true; return this; }
        /** @return {Handler} Disabled handler. */
        disable() { this._enabled = false; this.removeHooks?.(); return this; }
        /** @param {Object} methods Subclass hooks. @return {typeof Handler} Subclass. */
        static extend(methods) {
            class Subclass extends this {}
            Object.assign(Subclass.prototype, methods);
            return Subclass;
        }
    }
    /** Record wheel-handler delegation without duplicating Leaflet zoom math. */
    class WheelZoom extends Handler {
        /** Record a wheel batch without simulating Leaflet's easing algorithm.
         * @param {Object} event Wheel event. @return {void}
         */
        _onWheelScroll(event) { this._startTime = 1; calls.wheelEvent = event; }
        /** Record the native calculation's inputs. @return {void} */
        _performZoom() {
            (calls.wheelBatches ??= []).push({...this._map.options});
            this._startTime = null;
        }
        /** Record native wheel detachment. @return {void} */
        removeHooks() { calls.wheelDetached = true; }
    }
    /** Record keyboard events delegated to Leaflet. */
    class KeyboardZoom extends Handler {
        /** @param {Object} map Owning map. */
        constructor(map) { super(map); this._zoomKeys = {187: 1, 189: -1}; }
        /** Record an ordinary native key event.
         * @param {Object} event Key event. @return {void}
         */
        _onKeyDown(event) { calls.nativeKey = event; }
    }
    const panes = new Map(), attached = new Set(), attributions = new Map();
    const leafletMap = {
        attributionControl: { setPrefix(prefix) { calls.attributionPrefix = prefix; } },
        fire(type) { calls.event = type; },
        /** Register a map-local input handler.
         * @param {string} name Map handler property. @param {typeof Handler} Constructor Handler subclass.
         * @return {Object} Owning map.
         */
        addHandler(name, Constructor) { this[name] = new Constructor(this).enable(); return this; },
        /** Record fit inputs at the Leaflet boundary.
         * @param {Object} bounds Requested bounds. @param {boolean} inside Fit direction.
         * @param {Object} padding Pixel padding. @return {number} Fixture fit zoom.
         */
        getBoundsZoom(bounds, inside, padding) { calls.fit = {bounds, inside, padding, snap: this.options.zoomSnap}; return 3; },
        /** Record the map fit request and provide a geographic fixture target.
         * @param {Object} extent Bounds being fitted. @param {Object} options Fit padding and zoom limits.
         * @return {{center:number[],zoom:number}} Fixture center and zoom.
         */
        _getBoundsCenterZoom(extent, options) {
            calls.fitView = options;
            return {center: [0, 0], zoom: 2};
        },
        fitBounds(extent, options) {
            this._getBoundsCenterZoom(extent, options);
            return this;
        },
        _getBoundsOffset(pixels) { calls.viewPixels = pixels; return point(0, 0); },
        // The test records camera pixel geometry independently of the map projection.
        project(center) { return Array.isArray(center) ? point(center[1], center[0]) : point(center.lng, center.lat); },
        unproject(pixels) { return {lat: pixels.y, lng: pixels.x}; },
        _limitZoom(zoom) { return zoom; },
        getSize() { return point(canvas.right, canvas.bottom); },
        once() {},
        /** @return {number} Initial fixture zoom. */
        getZoom() { return calls.setView.zoom; },
        /** Finish an active native zoom transition. @return {void} */
        _onZoomTransitionEnd() { this._animatingZoom = false; calls.zoomTransitionsFinished = (calls.zoomTransitionsFinished ?? 0) + 1; },
        /** @param {number} zoom Requested zoom. @param {Object} options Animation options. @return {void} */
        setZoom(zoom, options) { calls.setZoom = {zoom, options}; },
        attached, attributions,
        setView(center, zoom) { calls.setView = { center, zoom }; return this; },
        getContainer() { return container; },
        getPane(name) { return panes.get(name); },
        createPane(name) { const pane = { style: {} }; panes.set(name, pane); return pane; },
        removeLayer(layer) {
            if (attached.delete(layer) && layer.options.attribution) {
                const text = layer.options.attribution;
                const count = attributions.get(text) - 1;
                if (count) attributions.set(text, count); else attributions.delete(text);
            }
            return this;
        },
    };
    leafletMap.scrollWheelZoom = new WheelZoom(leafletMap);
    leafletMap.keyboard = new KeyboardZoom(leafletMap);
    leafletMap.dragging = new Handler(leafletMap);
    /**
     * Create a background whose attachment updates only its own attribution.
     * @param {string} kind Background type.
     * @param {Object|string} data Geometry or tile URL.
     * @param {Object} options Leaflet layer options.
     * @return {Object} Layer double with tracked attachment.
     */
    function layer(kind, data, options) {
        const events = new EventTarget();
        const result = { kind, data, options,
            on: (type, handler) => events.addEventListener(type, handler),
            off: (type, handler) => events.removeEventListener(type, handler),
            fire: type => events.dispatchEvent(new Event(type)),
            addTo(map) {
            if (!map.attached.has(this) && options.attribution) {
                map.attributions.set(options.attribution, (map.attributions.get(options.attribution) ?? 0) + 1);
            }
            map.attached.add(this);
            if (kind === "tiles") calls.basemap = { url: data, options, map };
            return this;
        } };
        calls.layers.push(result);
        return result;
    }
    const leaflet = {
        /** @param {string} container Map element ID. @param {Object} options Map options. @return {Object} Map double. */
        map(container, options) {
            calls.map = {container, options};
            leafletMap.options = {zoomSnap: 1, wheelPxPerZoomLevel: 60, ...options};
            return leafletMap;
        },
        Map: {ScrollWheelZoom: WheelZoom, Keyboard: KeyboardZoom, Drag: Handler},
        point,
        bounds,
        latLngBounds() { return {isValid: () => true}; },
        tileLayer(url, options) { return layer("tiles", url, options); },
        geoJSON(geometry, options) { return layer("outlines", geometry, options); },
        control(options) {
            const control = { options,
                addTo(map) { this.map = map; this.root = this.onAdd(map); calls.controls.push(this); return this; },
                getContainer() { return this.root; },
                remove() { this.onRemove(this.map); },
            };
            return control;
        },
        DomEvent: {
            /** @param {Object} event Consumed input event. @return {void} */
            stop(event) { calls.stoppedEvent = event; },
            disableClickPropagation(element) { calls.stoppedClicks.push(element); },
            disableScrollPropagation(element) { calls.stoppedScrolls.push(element); },
        },
    };
    return { calls, leaflet, leafletMap, document };
}
