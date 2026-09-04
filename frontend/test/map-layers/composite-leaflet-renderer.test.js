import assert from "node:assert/strict";
import test from "node:test";

import {
    CompositeLeafletRenderer,
} from "../../src/map-layers/composite-leaflet-renderer.js";

/** Flush promise callbacks queued by a plan publication. */
async function flushPromises() {
    await new Promise((resolve) => setImmediate(resolve));
}

/** Create a Leaflet-compatible evented WMS layer. */
function createLayer(url, options) {
    const handlers = new Map();
    const addHandler = (event, handler, once) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event).add({ handler, once });
    };
    return {
        url,
        options,
        on(event, handler) {
            addHandler(event, handler, false);
            return this;
        },
        once(event, handler) {
            addHandler(event, handler, true);
            return this;
        },
        off(event, handler) {
            const eventHandlers = handlers.get(event);
            for (const registration of eventHandlers ?? []) {
                if (registration.handler === handler) {
                    eventHandlers.delete(registration);
                }
            }
            return this;
        },
        emit(event, detail) {
            const eventHandlers = handlers.get(event);
            for (const registration of [...(eventHandlers ?? [])]) {
                if (registration.once) eventHandlers.delete(registration);
                registration.handler(detail);
            }
        },
        addTo(map) {
            map.attached.add(this);
            return this;
        },
        setOpacity(opacity) {
            this.opacity = opacity;
        },
    };
}

/** Create an image-like tile that records retry source assignments. */
function createTile(source) {
    const assignments = [];
    let currentSource = source;
    return {
        assignments,
        currentSrc: "",
        get src() {
            return currentSource;
        },
        set src(value) {
            currentSource = value;
            assignments.push(value);
        },
    };
}

test("composite renderer swaps complete grids only after the replacement loads", async () => {
    const calls = [];
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    const leaflet = {
        tileLayer: {
            wms(url, options) {
                return createLayer(url, options);
            },
        },
    };
    const client = {
        async create(layers) {
            calls.push(layers);
            const planId = String(calls.length).repeat(64);
            return {
                planId,
                wmsUrl: `/api/map-rendering/plans/${planId}/wms`,
            };
        },
    };
    const renderer = new CompositeLeafletRenderer({
        leaflet,
        leafletMap: map,
        client,
    });

    renderer.update([{ layerName: "eolab:first", opacity: 1 }]);
    await flushPromises();
    const first = [...map.attached][0];
    assert.equal(first.options.layers, "composite");
    first.emit("load");

    renderer.update([{ layerName: "eolab:second", opacity: 0.5 }]);
    await flushPromises();
    assert.equal(map.attached.size, 2, "old grid remains during replacement load");
    const second = [...map.attached].find((layer) => layer !== first);
    assert.equal(second.opacity, 0);
    second.emit("load");
    assert.deepEqual([...map.attached], [second]);
    assert.equal(second.opacity, 1);

    renderer.update([{ layerName: "eolab:second", opacity: 0.5 }]);
    await flushPromises();
    assert.equal(calls.length, 2, "identical presentation is not republished");
    renderer.clear();
    assert.equal(map.attached.size, 0);
});

test("composite renderer keeps the current grid after plan preparation fails", async () => {
    const messages = [];
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    let publication = 0;
    const renderer = new CompositeLeafletRenderer({
        leaflet: {
            tileLayer: { wms: (url, options) => createLayer(url, options) },
        },
        leafletMap: map,
        client: {
            async create() {
                publication += 1;
                if (publication === 2) throw new Error("plan rejected");
                const planId = "a".repeat(64);
                return {
                    planId,
                    wmsUrl: `/api/map-rendering/plans/${planId}/wms`,
                };
            },
        },
        onError: (message) => messages.push(message),
    });
    renderer.update([{ layerName: "eolab:first" }]);
    await flushPromises();
    const current = [...map.attached][0];
    current.emit("load");
    renderer.update([{ layerName: "eolab:second" }]);
    await flushPromises();

    assert.deepEqual([...map.attached], [current]);
    assert.deepEqual(messages, ["plan rejected"]);
});

test("composite renderer retries failed tiles with bounded delays", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const messages = [];
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    const renderer = new CompositeLeafletRenderer({
        leaflet: {
            tileLayer: { wms: (url, options) => createLayer(url, options) },
        },
        leafletMap: map,
        client: {
            async create() {
                return { wmsUrl: "/api/map-rendering/plans/retry/wms" };
            },
        },
        onError: (message) => messages.push(message),
    });
    renderer.update([{ layerName: "eolab:raster" }]);
    await flushPromises();
    const layer = [...map.attached][0];
    const firstTile = createTile("/first-tile");
    const secondTile = createTile("/second-tile");

    layer.emit("tileerror", { tile: firstTile });
    layer.emit("tileerror", { tile: secondTile });
    context.mock.timers.tick(249);
    assert.deepEqual(firstTile.assignments, []);
    assert.deepEqual(secondTile.assignments, []);
    context.mock.timers.tick(1);
    assert.deepEqual(firstTile.assignments, ["/first-tile"]);
    assert.deepEqual(secondTile.assignments, ["/second-tile"]);
    assert.deepEqual(messages, []);

    layer.emit("tileload", { tile: secondTile });
    layer.emit("tileerror", { tile: firstTile });
    context.mock.timers.tick(999);
    assert.equal(firstTile.assignments.length, 1);
    context.mock.timers.tick(1);
    assert.deepEqual(firstTile.assignments, ["/first-tile", "/first-tile"]);
    layer.emit("tileerror", { tile: firstTile });
    layer.emit("tileerror", { tile: firstTile });

    assert.deepEqual(messages, ["The composite map could not be rendered."]);
});

test("composite renderer cancels stale tile retries", async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const map = {
        attached: new Set(),
        removeLayer(layer) {
            this.attached.delete(layer);
        },
    };
    const renderer = new CompositeLeafletRenderer({
        leaflet: {
            tileLayer: { wms: (url, options) => createLayer(url, options) },
        },
        leafletMap: map,
        client: {
            async create() {
                return { wmsUrl: "/api/map-rendering/plans/cancel/wms" };
            },
        },
    });
    renderer.update([{ layerName: "eolab:first" }]);
    await flushPromises();
    const replacedTile = createTile("/replaced-tile");
    [...map.attached][0].emit("tileerror", { tile: replacedTile });
    renderer.update([{ layerName: "eolab:second" }]);
    await flushPromises();
    context.mock.timers.tick(250);
    assert.deepEqual(replacedTile.assignments, []);

    const clearedTile = createTile("/cleared-tile");
    [...map.attached][0].emit("tileerror", { tile: clearedTile });
    renderer.clear();
    context.mock.timers.tick(250);
    assert.deepEqual(clearedTile.assignments, []);

    renderer.update([{ layerName: "eolab:third" }]);
    await flushPromises();
    const destroyedTile = createTile("/destroyed-tile");
    [...map.attached][0].emit("tileerror", { tile: destroyedTile });
    renderer.destroy();
    context.mock.timers.tick(250);
    assert.deepEqual(destroyedTile.assignments, []);
});
