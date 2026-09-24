import assert from "node:assert/strict";
import test from "node:test";
import {coordinateTickInterval, coordinateTicks, formatCoordinate, addMapCoordinateGuide} from "../src/map-coordinate-guide.js";
import {observeMapViewportSize} from "../src/map.js";
import {FakeRasterControlDocument} from "../test-support/raster/fake-controls-document.js";

test("degree ticks adapt from world to street scale without wrapping or rounding away precision", () => {
    assert.equal(coordinateTickInterval(360, 800), 50);
    const streetInterval = coordinateTickInterval(0.001, 800);
    // Exponentiation can round the last binary digit differently across runtimes.
    assert.ok(Math.abs(streetInterval - 0.0002) <= 4 * Number.EPSILON * 0.0002,
        `street-scale interval should be approximately 0.0002, got ${streetInterval}`);
    assert.deepEqual(coordinateTicks(-210, 230, 50, 180), [-150, -100, -50, 0, 50, 100, 150]);
    assert.deepEqual(coordinateTicks(90, 95, 1, 85.0511287798066), []);
    assert.equal(formatCoordinate(-73.567, "longitude", 0.01), "73.57°W");
    assert.equal(formatCoordinate(40.2, "latitude", 1), "40°N");
    assert.equal(formatCoordinate(-0.00001, "latitude", 0.01), "0.00°");
    assert.equal(formatCoordinate(0.0001234, "longitude", 0.000001), "0.000123°E");
});

test("guide follows projected coordinates, clears stale pointers, toggles and releases listeners", () => {
    const doc = new FakeRasterControlDocument();
    let pending = null, removed = false, off = false;
    doc.defaultView = {
        requestAnimationFrame(callback) { pending = callback; return 1; },
        cancelAnimationFrame() { pending = null; },
    };
    const container = doc.createElement();
    container.closest = () => null;
    const createSVG = doc.createElementNS.bind(doc);
    doc.createElementNS = (...args) => {
        const element = createSVG(...args);
        element.remove = () => { removed = true; };
        return element;
    };
    let lng = 5, lat = 15, size = {x: 800, y: 600}, changed;
    const map = {
        getContainer: () => container,
        getSize: () => size,
        getBounds: () => ({getEast: () => 40, getWest: () => -40, getNorth: () => 40, getSouth: () => -40}),
        latLngToContainerPoint: ([lat, lng]) => ({x: 400 + lng * 10, y: 300 - lat * 5}),
        mouseEventToContainerPoint: () => ({x: 450, y: 225}),
        containerPointToLatLng: () => ({lat, lng}),
        on: (events, callback) => { changed = callback; },
        off: (events, callback) => { off = callback === changed; },
    };
    const leaflet = {control: () => ({addTo() { this.button = this.onAdd(); return this; }}),
        DomEvent: {disableClickPropagation() {}, disableScrollPropagation() {}}};
    const control = addMapCoordinateGuide(leaflet, map);
    const svg = container.children[0], [ticks, pointer] = svg.children;
    const north = ticks.children.find(node => node.textContent === "20°N");
    assert.equal(north.getAttribute("y"), "203", "uses projected latitude position, not linear screen interpolation");
    container.dispatchEvent(new Event("mousemove"));
    assert.equal(pointer.children[0].getAttribute("x1"), "450");
    assert.ok(pointer.children.some(node => node.textContent === "5.0000°E"));
    lng = 181;
    container.dispatchEvent(new Event("mousemove"));
    assert.equal(pointer.children.length, 0, "no repeated world coordinates");
    lng = 5;
    container.dispatchEvent(new Event("mousemove"));
    changed(); changed();
    assert.equal(pointer.children.length, 0);
    size = {x: 600, y: 400}; pending(); pending = null;
    assert.equal(svg.getAttribute("viewBox"), "0 0 600 400");
    control.button.dispatchEvent(new Event("click"));
    assert.equal(svg.style.display, "none");
    assert.equal(control.button.getAttribute("aria-pressed"), "false");
    container.dispatchEvent(new Event("mousemove"));
    assert.equal(pointer.children.length, 0);
    control.button.dispatchEvent(new Event("click"));
    container.dispatchEvent(new Event("mousemove"));
    container.dispatchEvent(new Event("mouseleave"));
    assert.equal(pointer.children.length, 0);
    control.onRemove();
    assert.equal(pending, null);
    assert.ok(removed && off);
    assert.equal(container.classList.contains("has-coordinate-guide"), false);
    container.dispatchEvent(new Event("mousemove"));
    assert.equal(pointer.children.length, 0);
});

test("map resize observation coalesces layout changes and stops on map removal", () => {
    let resized, frame, unload, disconnected = false, calls = 0;
    const view = {
        ResizeObserver: class {
            constructor(callback) { resized = callback; }
            observe() {}
            disconnect() { disconnected = true; }
        },
        requestAnimationFrame(callback) { frame = callback; return 1; },
        cancelAnimationFrame() { frame = null; },
    };
    observeMapViewportSize({
        getContainer: () => ({ownerDocument: {defaultView: view}}),
        invalidateSize(options) { assert.equal(options.animate, false); calls++; },
        once(event, callback) { assert.equal(event, "unload"); unload = callback; },
    });
    resized(); resized(); frame();
    assert.equal(calls, 1);
    resized(); unload();
    assert.ok(disconnected);
    assert.equal(frame, null);
});
