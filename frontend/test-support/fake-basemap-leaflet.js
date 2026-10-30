import { FakeRasterControlDocument } from "./raster/fake-controls-document.js";

/**
 * Track map backgrounds, controls, and attributions without loading network tiles.
 * @return {Object} Leaflet double, map, DOM, and captured calls.
 */
export function createLeafletDouble() {
    const document = new FakeRasterControlDocument();
    const calls = { map: null, setView: null, zoomControl: null, basemap: null,
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
    /** Record native zoom-button actions and placement. */
    class ZoomControl extends Handler {
        /** @param {Object} options Control placement. */
        constructor(options) { super(null); this.options = options; }
        /** @param {Object} map Owning map. @return {ZoomControl} Attached control. */
        addTo(map) { this._map = map; calls.zoomControl = {options: this.options, map}; map.zoomControl = this; return this; }
        /** @param {Object} event Click event. @return {void} */
        _zoomIn(event) { calls.nativeZoomIn = event; }
        /** @param {Object} event Click event. @return {void} */
        _zoomOut(event) { calls.nativeZoomOut = event; }
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
        /** @return {number} Initial fixture zoom. */
        getZoom() { return calls.setView.zoom; },
        /** Finish an active native zoom transition. @return {void} */
        _onZoomTransitionEnd() { this._animatingZoom = false; calls.zoomTransitionsFinished = (calls.zoomTransitionsFinished ?? 0) + 1; },
        /** @param {number} zoom Requested zoom. @param {Object} options Animation options. @return {void} */
        setZoom(zoom, options) { calls.setZoom = {zoom, options}; },
        /** @param {number} delta Zoom increment. @param {Object} options Animation options. @return {void} */
        zoomIn(delta, options) { calls.zoomIn = {delta, options}; },
        /** @param {number} delta Zoom decrement. @param {Object} options Animation options. @return {void} */
        zoomOut(delta, options) { calls.zoomOut = {delta, options}; },
        attached, attributions,
        setView(center, zoom) { calls.setView = { center, zoom }; return this; },
        getContainer() { return { ownerDocument: document }; },
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
        Map: {ScrollWheelZoom: WheelZoom, Keyboard: KeyboardZoom},
        Control: {Zoom: ZoomControl},
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
