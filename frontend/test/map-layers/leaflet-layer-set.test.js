import assert from "node:assert/strict";
import test from "node:test";

import { LeafletLayerSet } from "../../src/map-layers/leaflet-layer-set.js";
import { FakeRasterControlElement } from "../../test-support/raster/fake-controls-document.js";

/** Create a Leaflet-compatible grid that attaches its container to the test map's pane.
 * @return {Object} Grid with observable presentation state and load events.
 */
function createLayer() {
    const handlers = new Map();
    const container = new FakeRasterControlElement();
    return {
        redrawCount: 0,
        loading: false,
        isLoading() { return this.loading; },
        addTo(map) {
            this.loading = true;
            map.attached.add(this);
            (map.pane ??= new FakeRasterControlElement()).appendChild(container);
            return this;
        },
        setOpacity(opacity) {
            this.opacity = opacity;
        },
        setZIndex(zIndex) {
            this.zIndex = zIndex;
        },
        getContainer() {
            return container;
        },
        on(event, handler) {
            const eventHandlers = handlers.get(event) ?? new Set();
            eventHandlers.add(handler);
            handlers.set(event, eventHandlers);
        },
        off(event, handler) {
            handlers.get(event)?.delete(handler);
        },
        emit(event) {
            if (event === "load") this.loading = false;
            for (const handler of handlers.get(event) ?? []) handler();
        },
        redraw() {
            this.loading = true;
            this.redrawCount += 1;
            return this;
        },
        container,
    };
}

test("Leaflet layer set owns attachment, opacity, order, and cleanup", () => {
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    const layers = new LeafletLayerSet(map);
    const bottom = createLayer();
    const top = createLayer();

    layers.add("bottom", bottom, { visible: true, opacity: 0.8 });
    layers.add("top", top, { visible: false, opacity: 1 });
    layers.setOrder(["top", "bottom"]);
    layers.setVisible("top", true);
    layers.setVisible("bottom", false);
    layers.setOpacity("top", 0.4);

    assert.equal(layers.get("top"), top);
    assert.equal(layers.isAttached("top"), true);
    assert.equal(layers.isAttached("bottom"), false);
    assert.equal(top.opacity, 0.4);
    assert.ok(top.zIndex > bottom.zIndex);
    assert.throws(() => layers.setOrder(["top", "top"]), Error);

    const replacement = createLayer();
    layers.replace("top", replacement);
    assert.equal(map.attached.has(top), false);
    assert.equal(map.attached.has(replacement), true);
    assert.equal(replacement.opacity, 0.4);
    assert.ok(replacement.zIndex > bottom.zIndex);
    assert.deepEqual(layers.order, ["top", "bottom"]);

    layers.clear();

    assert.equal(map.attached.size, 0);
    assert.equal(layers.get("top"), null);
});

test("preparing a date preserves other visible views of the same source, their styles and stack order", async () => {
    const prepared = [], displayed = [];
    let capturedViews;
    const map = {attached: new Set(), removeLayer(layer) { this.attached.delete(layer); }};
    const layers = new LeafletLayerSet(map, {clear() {}, update(stack, {views}) { displayed.push(stack); capturedViews = views; },
        prepare: async (stack, signal) => prepared.push({stack, signal})});
    const source = {layerName: "dataset:january", styleName: "temperature"};
    const prior = {layerName: "dataset:january", styleName: "threshold"};
    const replacement = {...source, layerName: "dataset:february"};
    layers.add("active", createLayer(), {visible: true, opacity: 0.45});
    layers.add("reference", createLayer(), {visible: true, opacity: 0.7});
    layers.render([{key: "reference", visible: true, opacity: 0.7, descriptor: prior},
        {key: "active", visible: true, opacity: 0.45, descriptor: source}]);
    const signal = new AbortController().signal;
    await layers.prepareLayer("active", replacement, signal);
    assert.deepEqual(Array.from(capturedViews, ([key, frame]) => [key, frame.descriptor]),
        [["reference", prior], ["active", source]]);
    assert.deepEqual(prepared, [{stack: [{...prior, opacity: 0.7}, {...replacement, opacity: 0.45}], signal}]);
    assert.deepEqual(displayed.at(-1), [{...prior, opacity: 0.7}, {...source, opacity: 0.45}]);
    layers.clear();
});

test("Leaflet layer set atomically isolates selected individual grids", () => {
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    const updates = [];
    let clears = 0;
    const layers = new LeafletLayerSet(map, {
        update(rendering) {
            updates.push(rendering);
        },
        clear() {
            clears += 1;
        },
    });
    const top = createLayer();
    const bottom = createLayer();
    const unrelated = createLayer();
    layers.add("top", top, { visible: true, opacity: 0.8 });
    layers.add("bottom", bottom, { visible: true, opacity: 0.4 });
    layers.add("unrelated", unrelated, { visible: true, opacity: 1 });
    layers.render([
        {
            key: "top",
            visible: true,
            opacity: 0.8,
            descriptor: { layerName: "eolab:top" },
        },
        {
            key: "bottom",
            visible: true,
            opacity: 0.4,
            descriptor: { layerName: "eolab:bottom" },
        },
        {
            key: "unrelated",
            visible: true,
            opacity: 1,
            descriptor: { layerName: "eolab:unrelated" },
        },
    ]);

    assert.equal(map.attached.size, 0);
    assert.deepEqual(updates.at(-1), [
        { layerName: "eolab:top", opacity: 0.8 },
        { layerName: "eolab:bottom", opacity: 0.4 },
        { layerName: "eolab:unrelated", opacity: 1 },
    ]);
    assert.throws(
        () => layers.setIndividualRendering(["top", "top"]),
        /distinct retained layer keys/,
    );
    assert.throws(
        () => layers.setIndividualRendering(["missing"]),
        /Unknown retained map layer/,
    );
    layers.setIndividualRendering(["top", "bottom"]);
    assert.equal(clears, 0, "composite remains until both grids load");
    assert.deepEqual(map.attached, new Set([bottom, top]));
    assert.equal(top.container.hidden, true);
    assert.equal(bottom.container.hidden, true);
    assert.equal(unrelated.container.hidden, false);

    top.emit("load");
    assert.equal(clears, 0);
    assert.equal(top.container.hidden, true);
    bottom.emit("load");
    assert.equal(clears, 1);
    assert.equal(top.container.hidden, false);
    assert.equal(bottom.container.hidden, false);

    layers.setIndividualRendering(null);
    assert.equal(map.attached.size, 0);
    assert.equal(updates.length, 2);
});

test("Leaflet layer set ignores stale loads and retries only a failed grid", () => {
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    let clears = 0;
    const layers = new LeafletLayerSet(map, {
        update() {},
        clear() {
            clears += 1;
        },
    });
    const first = createLayer();
    const second = createLayer();
    const replacement = createLayer();
    layers.add("first", first, { visible: true, opacity: 1 });
    layers.add("second", second, { visible: true, opacity: 1 });
    layers.add("replacement", replacement, { visible: true, opacity: 1 });
    layers.render([
        { key: "first", visible: true, opacity: 1, descriptor: {} },
        { key: "second", visible: true, opacity: 1, descriptor: {} },
        { key: "replacement", visible: true, opacity: 1, descriptor: {} },
    ]);

    layers.setIndividualRendering(["first", "second"]);
    layers.setIndividualRendering(["second", "replacement"]);
    first.emit("load");
    second.emit("load");
    assert.equal(clears, 0);
    assert.equal(replacement.container.hidden, true);

    replacement.emit("tileerror");
    replacement.emit("load");
    assert.equal(clears, 0);
    assert.equal(replacement.redrawCount, 1);
    assert.deepEqual(map.attached, new Set([second, replacement]));
    assert.equal(second.container.hidden, true);
    assert.equal(replacement.container.hidden, true);

    replacement.emit("load");
    assert.equal(clears, 1);
    assert.deepEqual(map.attached, new Set([second, replacement]));
    assert.equal(second.container.hidden, false);
    assert.equal(replacement.container.hidden, false);
});

test("Leaflet layer set keeps the composite after the bounded retry fails", () => {
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    let clears = 0;
    const layers = new LeafletLayerSet(map, {
        update() {},
        clear() {
            clears += 1;
        },
    });
    const first = createLayer();
    const second = createLayer();
    layers.add("first", first, { visible: true, opacity: 1 });
    layers.add("second", second, { visible: true, opacity: 1 });
    layers.render([
        { key: "first", visible: true, opacity: 1, descriptor: {} },
        { key: "second", visible: true, opacity: 1, descriptor: {} },
    ]);

    layers.setIndividualRendering(["first", "second"]);
    first.emit("tileerror");
    first.emit("load");
    second.emit("load");
    assert.equal(first.redrawCount, 1);
    assert.equal(clears, 0);

    first.emit("tileerror");
    first.emit("load");
    assert.equal(clears, 0);
    assert.equal(map.attached.size, 0);
});

test("local layers interleave with source grids and never enter a server composite", () => {
    const map = {attached: new Set(), removeLayer(layer) { this.attached.delete(layer); }};
    const composites = [];
    const layers = new LeafletLayerSet(map, {clear() {}, update(rendering) { composites.push(rendering); }});
    const raster = createLayer(), local = createLayer();
    layers.add("raster", raster, {visible: true, opacity: 1});
    layers.add("local", local, {visible: true, opacity: 0.5});
    const descriptors = [
        {key: "local", visible: true, opacity: 0.5, descriptor: null},
        {key: "raster", visible: true, opacity: 1, descriptor: {layerName: "eolab:raster"}},
    ];
    layers.render(descriptors);
    assert.deepEqual(map.attached, new Set([raster, local]));
    assert.ok(local.zIndex > raster.zIndex);
    layers.render([...descriptors].reverse());
    assert.ok(raster.zIndex > local.zIndex);
    layers.setIndividualRendering(["raster"]);
    assert.equal(layers.isAttached("local"), true);
    layers.setIndividualRendering(null);
    layers.render(descriptors.map(entry => entry.key === "local" ? {...entry, visible: false} : entry));
    assert.equal(map.attached.size, 0);
    assert.deepEqual(composites.at(-1), [{layerName: "eolab:raster", opacity: 1}]);
});


test("replacing one paired frame reveals it without waiting for an unchanged loaded grid", () => {
    const map = {attached: new Set(), removeLayer(layer) { this.attached.delete(layer); layer.getContainer().remove(); }};
    const layers = new LeafletLayerSet(map, {update() {}, clear() {}});
    const first = createLayer(), unchanged = createLayer();
    layers.add("first", first, {visible: true, opacity: .4});
    layers.add("unchanged", unchanged, {visible: true, opacity: .6});
    const rendering = [
        {key: "first", visible: true, opacity: .4, descriptor: {layerName: "old"}},
        {key: "unchanged", visible: true, opacity: .6, descriptor: {layerName: "unchanged"}},
    ];
    layers.render(rendering);
    layers.setIndividualRendering(["first", "unchanged"]);
    first.emit("load"); unchanged.emit("load");
    assert.equal(unchanged.isLoading(), false);
    const pending = createLayer();
    layers.replace("first", pending, {keepPreviousFrame: true, awaitingPublication: true});
    layers.render([{...rendering[0], descriptor: null}, rendering[1]]);
    assert.ok(map.attached.has(first), "the previous date stays on the map during publication");
    assert.equal(unchanged.container.hidden, false);
    const current = createLayer();
    layers.replace("first", current, {keepPreviousFrame: true});
    layers.render([{...rendering[0], descriptor: {layerName: "new"}}, rendering[1]]);
    assert.equal(current.container.hidden, true, "the incoming grid stays out of the drawing order until its tiles load");
    assert.equal(first.container.hidden, false);
    assert.ok(map.attached.has(first), "the previous date stays on the map while the new tiles load");
    assert.equal(unchanged.container.hidden, false, "the other half of the comparison stays visible");
    current.emit("load");
    assert.equal(current.container.hidden, false);
    assert.equal(unchanged.container.hidden, false);
    assert.equal(current.opacity, .4);
    assert.equal(unchanged.opacity, .6);
    assert.equal(map.attached.has(first), false);
    assert.equal(map.attached.has(pending), false);
    assert.equal(map.pane.children[0], current.container,
        "a replacement keeps its drawing position relative to the stationary axis");
    const next = createLayer(), nextReference = createLayer();
    const bothChanged = rendering.map(row => ({...row, descriptor: {layerName: row.key + "-next"}}));
    layers.replace("first", next, {keepPreviousFrame: true});
    layers.render([bothChanged[0], rendering[1]]);
    layers.replace("unchanged", nextReference, {keepPreviousFrame: true});
    layers.render(bothChanged);
    next.emit("load");
    assert.ok(map.attached.has(current) && map.attached.has(unchanged), "keep both drawn axes until both new axes are ready");
    next.loading = true; // A pan requests another tile after this axis first finished.
    nextReference.emit("load");
    assert.ok(map.attached.has(current) && map.attached.has(unchanged), "keep the drawn pair while the panned axis reloads");
    assert.equal(next.container.hidden, true);
    next.emit("load");
    assert.deepEqual(map.attached, new Set([next, nextReference]));
    layers.clear();
});
