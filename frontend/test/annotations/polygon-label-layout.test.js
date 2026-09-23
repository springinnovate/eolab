import assert from "node:assert/strict";
import test from "node:test";
import { PolygonLabelLayout } from "../../src/annotations/polygon-label-layout.js";

/** @return {Object} Map with controllable screen scale, layers, and animation frames. */
function setup() {
    let nextFrame = 0;
    const frames = new Map(), listeners = new Map(), layers = new Set();
    const window = {
        requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame(id) { frames.delete(id); },
    };
    const map = {
        scale: 1,
        getContainer: () => ({ ownerDocument: { defaultView: window },
            getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }) }),
        on(events, callback) { for (const event of events.split(" ")) listeners.set(event, callback); },
        off(events) { for (const event of events.split(" ")) listeners.delete(event); },
        hasLayer: shape => layers.has(shape),
        latLngToContainerPoint(point) { return { x: point.x * this.scale, y: point.y * this.scale }; },
    };
    return { map, layers, frames, listeners, layout: new PolygonLabelLayout(map),
        flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); } };
}

/**
 * Create a polygon with independently measurable label and screen envelope.
 * @param {number} left Label's horizontal screen position.
 * @param {number} [width=100] Polygon envelope width.
 * @param {number} [height=60] Polygon envelope height.
 * @return {Object} Polygon double and retained tooltip element.
 */
function polygon(left, width = 100, height = 60) {
    const element = { style: {}, getBoundingClientRect: () => ({ left, right: left + 80, top: 100, bottom: 120, width: 80, height: 20 }) };
    return { element, getTooltip: () => ({ getElement: () => element }),
        getBounds: () => ({ getNorthWest: () => ({ x: 0, y: 0 }), getSouthEast: () => ({ x: width, y: height }) }) };
}

test("tiny polygons retain geometry but hide labels until screen space is sufficient", () => {
    const { map, layout, layers, flush, listeners } = setup();
    const shape = polygon(20, 20, 10);
    layers.add(shape);
    layout.register("saved", () => [shape]); flush();
    assert.equal(shape.element.style.visibility, "hidden");
    map.scale = 4; listeners.get("zoomend")(); flush();
    assert.equal(shape.element.style.visibility, "visible");
    map.scale = 1; listeners.get("resize")(); flush();
    assert.equal(shape.element.style.visibility, "hidden");
    assert.equal(layers.has(shape), true);
});

test("overlapping labels across layers choose a stable winner and reveal it when the other layer is hidden", () => {
    const { layout, layers, flush, listeners } = setup();
    const first = polygon(20), second = polygon(30), separate = polygon(200);
    [first, second, separate].forEach(shape => layers.add(shape));
    layout.register("first", () => [first]);
    layout.register("second", () => [second, separate]); flush();
    assert.equal(first.element.style.visibility, "visible");
    assert.equal(second.element.style.visibility, "hidden");
    assert.equal(separate.element.style.visibility, "visible");
    listeners.get("moveend")(); flush();
    assert.equal(first.element.style.visibility, "visible");
    layers.delete(first); listeners.get("layerremove")(); flush();
    assert.equal(second.element.style.visibility, "visible");
    layers.add(first); listeners.get("layeradd")(); flush();
    assert.equal(second.element.style.visibility, "hidden");
});

test("editing labels take priority regardless of polygon size and return space when editing ends", () => {
    const { layout, layers, flush } = setup();
    const saved = polygon(20), draft = polygon(30, 1, 1);
    layers.add(saved); layers.add(draft);
    layout.register("saved", () => [saved]);
    layout.register("draft", () => [draft], true); flush();
    assert.equal(draft.element.style.visibility, "visible");
    assert.equal(saved.element.style.visibility, "hidden");
    layout.unregister("draft"); flush();
    assert.equal(saved.element.style.visibility, "visible");
});

test("labels disabled by style, detached polygons and offscreen labels do not take space", () => {
    const { layout, layers, flush } = setup();
    const offscreen = polygon(-200), detached = polygon(20), disabled = polygon(20), visible = polygon(20);
    disabled.getTooltip = () => undefined;
    [offscreen, disabled, visible].forEach(shape => layers.add(shape));
    layout.register("saved", () => [offscreen, detached, disabled, visible]); flush();
    assert.equal(offscreen.element.style.visibility, "hidden");
    assert.equal(visible.element.style.visibility, "visible");
});

test("larger wrapped names and notes need more screen space without shrinking or truncating text", () => {
    const { layout, layers, flush } = setup();
    const shape = polygon(20);
    layers.add(shape); layout.register("saved", () => [shape]); flush();
    assert.equal(shape.element.style.visibility, "visible");
    const measure = shape.element.getBoundingClientRect;
    shape.element.getBoundingClientRect = () => ({ ...measure(), height: 100, bottom: 200 });
    layout.schedule(); flush();
    assert.equal(shape.element.style.visibility, "hidden");
    shape.element.getBoundingClientRect = measure;
    layout.schedule(); flush();
    assert.equal(shape.element.style.visibility, "visible");
});

test("refresh bursts use one frame; final removal cancels it and removes all listeners", () => {
    const { layout, frames, listeners, flush } = setup();
    layout.register("saved", () => []);
    for (let i = 0; i < 100; i++) layout.schedule();
    assert.equal(frames.size, 1);
    flush(); assert.equal(frames.size, 0);
    layout.schedule(); layout.unregister("saved");
    assert.equal(frames.size, 0); assert.equal(listeners.size, 0);
    layout.register("again", () => []);
    assert.equal(listeners.size, 5);
});
