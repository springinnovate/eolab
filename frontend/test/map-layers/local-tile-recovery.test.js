import assert from "node:assert/strict";
import test from "node:test";
import { LeafletLayerSet } from "../../src/map-layers/leaflet-layer-set.js";

/** Flush tile-status microtasks. @return {Promise<void>} Settled callbacks. */
async function flush() { await new Promise(resolve => setImmediate(resolve)); }

/** Provide the public Leaflet event contract. @return {Object} Event source. */
function evented() {
    const handlers = new Map();
    return {
        on(events, handler) {
            for (const event of events.split(" ")) {
                if (!handlers.has(event)) handlers.set(event, new Set());
                handlers.get(event).add(handler);
            }
        },
        off(events, handler) {
            for (const event of events.split(" ")) handlers.get(event)?.delete(handler);
        },
        emit(event, payload) { for (const handler of handlers.get(event) ?? []) handler(payload); },
    };
}

/**
 * Interleave an annotation and two server tile grids in a two-tile viewport.
 * @return {Object} Layer set, events, image assignments, and published statuses.
 */
function fixture() {
    const statuses = [], layerStatuses = new Map();
    const map = Object.assign(evented(), {
        zoom: 1, attached: new Set(),
        getZoom() { return this.zoom; },
        getPixelBounds: () => ({ min: { x: 0, y: 0 }, max: { x: 512, y: 256 } }),
        removeLayer(layer) { this.attached.delete(layer); },
    });
    const set = new LeafletLayerSet(map, { clear() {}, update() {} }, {
        onStatus: status => statuses.push(status),
        onLayerStatus: (key, status) => layerStatuses.set(key, status),
    });
    const layers = new Map();
    for (const key of ["a", "annotation", "b"]) {
        const layer = Object.assign(evented(), {
            additions: 0,
            retryTile(tile) { tile.src = tile.src; },
            addTo() { this.additions++; map.attached.add(this); },
            setOpacity() {}, setZIndex() {},
            getTileSize: () => ({ x: 256, y: 256 }),
        });
        layers.set(key, layer);
        set.add(key, layer, { visible: true, opacity: 1 });
    }
    const rendering = [...layers.keys()].map(key => ({ key, visible: true, opacity: 1,
        descriptor: key === "annotation" ? null : { layerName: key } }));
    set.render(rendering);
    return { set, map, layers, rendering, layerStatuses, status: () => statuses.at(-1),
        tile(key, x = 0) {
            const assignments = [], source = `/tiles/${key}/${x}`;
            const tile = { assignments, get src() { return source; }, set src(value) { assignments.push(value); } };
            layers.get(key).emit("tileloadstart", { tile, coords: { x, y: 0, z: map.zoom } });
            return tile;
        },
    };
}

test("annotation interleaving tracks both catalog grids and recovers a failed image", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(), failed = f.tile("a"), good = f.tile("b");
    f.layers.get("b").emit("tileload", { tile: good });
    f.layers.get("a").emit("tileerror", { tile: failed });
    f.layers.get("a").emit("load"); await flush();
    assert.deepEqual(f.status(), { phase: "retrying", total: 2, loaded: 1, failed: 0 });
    assert.equal(f.set.hasTileRecovery("annotation"), false);
    context.mock.timers.tick(1000);
    assert.deepEqual(failed.assignments, ["/tiles/a/0"]);
    f.layers.get("a").emit("tileload", { tile: failed }); await flush();
    assert.deepEqual(f.status(), { phase: "complete", total: 2, loaded: 2, failed: 0 });
    assert.equal(good.assignments.length, 0);
    assert.equal(f.layerStatuses.get("a").failed, 0);
    f.set.clear();
});

test("a view outside catalog layer bounds has no missing tiles or endless loading", async () => {
    const f = fixture();
    await flush();
    assert.deepEqual(f.status(), { phase: "complete", total: 0, loaded: 0, failed: 0 });
    f.set.clear();
});

test("exhausted independent tiles offer targeted retry and clear their layer warning on success", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(), failed = f.tile("a"), good = f.tile("b");
    f.layers.get("b").emit("tileload", { tile: good });
    for (const delay of [1000, 4000, 10000, 15000, 30000, 5000]) {
        f.layers.get("a").emit("tileerror", { tile: failed });
        f.layers.get("a").emit("load"); context.mock.timers.tick(delay);
    }
    await flush();
    assert.deepEqual(f.status(), { phase: "incomplete", total: 2, loaded: 1, failed: 1 });
    assert.equal(f.layerStatuses.get("a").failed, 1);
    f.set.retryFailedTiles(); f.set.retryFailedTiles(); await flush();
    assert.equal(failed.assignments.length, 6);
    assert.equal(good.assignments.length, 0);
    f.layers.get("a").emit("tileload", { tile: failed }); await flush();
    assert.equal(f.layerStatuses.get("a").failed, 0);
    assert.equal(f.status().phase, "complete");
    f.set.clear();
});

test("zoom changes, hiding and composite transitions cancel obsolete independent retries", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(), old = f.tile("a");
    f.layers.get("a").emit("tileerror", { tile: old });
    f.map.zoom = 2; f.map.emit("zoomend");
    context.mock.timers.tick(60000); await flush();
    assert.equal(old.assignments.length, 0);
    const hidden = f.tile("a");
    f.layers.get("a").emit("tileerror", { tile: hidden });
    f.rendering[0].visible = false; f.set.render(f.rendering);
    context.mock.timers.tick(60000); await flush();
    assert.equal(hidden.assignments.length, 0);
    assert.equal(f.set.hasTileRecovery("a"), false);
    const removed = f.tile("b");
    f.layers.get("b").emit("tileerror", { tile: removed });
    f.rendering[1].visible = false; f.set.render(f.rendering);
    f.layers.get("b").emit("tileerror", { tile: removed });
    context.mock.timers.tick(60000); await flush();
    assert.equal(removed.assignments.length, 0);
    assert.equal(f.set.hasTileRecovery("b"), false);
    f.set.clear();
});

test("a busy tile can recover after a minute without reloading its successful neighbor", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(), busy = f.tile("a"), good = f.tile("b");
    f.layers.get("b").emit("tileload", { tile: good });
    for (const delay of [1000, 4000, 10000, 15000]) {
        f.layers.get("a").emit("tileerror", { tile: busy });
        context.mock.timers.tick(delay);
    }
    f.layers.get("a").emit("tileerror", { tile: busy });
    context.mock.timers.tick(29999); await flush();
    assert.deepEqual(f.status(), { phase: "retrying", total: 2, loaded: 1, failed: 0 });
    assert.equal(busy.assignments.length, 4);
    context.mock.timers.tick(1);
    assert.equal(busy.assignments.length, 5);
    f.layers.get("a").emit("tileload", { tile: busy }); await flush();
    assert.deepEqual(f.status(), { phase: "complete", total: 2, loaded: 2, failed: 0 });
    assert.equal(good.assignments.length, 0);
    f.set.clear();
});

test("zooming during a long retry wait preserves the new view and drops the old timer", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(), old = f.tile("a");
    for (const delay of [1000, 4000, 10000, 15000]) {
        f.layers.get("a").emit("tileerror", { tile: old });
        context.mock.timers.tick(delay);
    }
    f.layers.get("a").emit("tileerror", { tile: old });
    f.map.zoom = 2; f.map.emit("zoomend");
    f.layers.get("a").emit("tileunload", { tile: old });
    const current = f.tile("a");
    f.layers.get("a").emit("tileload", { tile: current });
    context.mock.timers.tick(60000); await flush();
    assert.equal(old.assignments.length, 4, "obsolete tile never retries again");
    assert.equal(current.assignments.length, 0);
    assert.deepEqual(f.status(), { phase: "complete", total: 1, loaded: 1, failed: 0 });
    f.set.clear();
});

test("style and opacity updates preserve observations rather than reloading good tiles", async () => {
    const f = fixture(), a = f.tile("a"), b = f.tile("b");
    f.layers.get("a").emit("tileload", { tile: a });
    f.layers.get("b").emit("tileload", { tile: b }); await flush();
    f.rendering[0].opacity = 0; f.set.render(f.rendering); await flush();
    f.rendering[0].opacity = 1; f.set.render(f.rendering); await flush();
    assert.equal(f.status().loaded, 2);
    assert.equal(f.layers.get("a").additions, 1);
    f.set.remove("a");
    f.set.render(f.rendering.filter(candidate => candidate.key !== "a")); await flush();
    assert.equal(f.status().loaded, 1);
    f.set.clear();
});

test("switching from paired grids starts tracking before their replacement tile cycle", async () => {
    const f = fixture();
    f.rendering[1].visible = false; f.set.render(f.rendering);
    f.set.setIndividualRendering(["a", "b"]);
    f.layers.get("a").emit("load"); f.layers.get("b").emit("load");
    const before = f.layers.get("a").additions;
    f.rendering[1].visible = true; f.set.render(f.rendering);
    assert.equal(f.layers.get("a").additions, before + 1);
    const a = f.tile("a"), b = f.tile("b");
    f.layers.get("a").emit("tileload", { tile: a });
    f.layers.get("b").emit("tileload", { tile: b }); await flush();
    assert.deepEqual(f.status(), { phase: "complete", total: 2, loaded: 2, failed: 0 });
    f.set.clear();
});
