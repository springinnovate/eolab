import assert from "node:assert/strict";
import test from "node:test";
import { CompositeLeafletRenderer } from "../../src/map-layers/composite-leaflet-renderer.js";

/** Flush publication promises and tile status. @return {Promise<void>} Settled microtasks. */
async function flush() { await new Promise(resolve => setImmediate(resolve)); }

/** Provide public Leaflet events. @return {Object} Event source. */
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
        emit(event, detail) { for (const handler of handlers.get(event) ?? []) handler(detail); },
    };
}

/**
 * Create a two-tile viewport and observable image source assignments.
 * @param {Function|null} create Optional plan publication override.
 * @return {Object} Renderer, map, statuses, and tile factory.
 */
function fixture(create = null) {
    const statuses = [], grids = [], calls = [];
    const map = Object.assign(evented(), {
        attached: new Set(), zoom: 1,
        bounds: { min: { x: 0, y: 0 }, max: { x: 512, y: 256 } },
        getZoom() { return this.zoom; },
        getPixelBounds() { return this.bounds; },
        removeLayer(layer) { this.attached.delete(layer); },
    });
    const renderer = new CompositeLeafletRenderer({
        leaflet: { tileLayer: { wms(url, options) {
            const layer = Object.assign(evented(), {
                url, options,
                getTileSize() { return { x: 256, y: 256 }; },
                addTo() { map.attached.add(this); },
            });
            grids.push(layer);
            return layer;
        } } },
        leafletMap: map,
        client: { async create(layers, signal) {
            calls.push({ layers, signal });
            return create ? create(layers, signal) : { wmsUrl: "/authorized-plan/wms" };
        } },
        onStatus: status => statuses.push(status),
    });
    return {
        renderer, map, grids, calls, statuses,
        status: () => statuses.at(-1),
        tile(x = 0, z = 1) {
            const assignments = [];
            const tile = { assignments, get src() { return `/tile/${x}/${z}`; },
                set src(source) { assignments.push(source); } };
            grids.at(-1).emit("tileloadstart", { tile, coords: { x, y: 0, z } });
            return tile;
        },
    };
}

test("delayed tiles remain loading; transparent PNG counts as successfully loaded", async () => {
    const f = fixture();
    f.renderer.update([{ layerName: "first", opacity: 0.5 }]);
    assert.equal(f.status().phase, "preparing");
    await flush();
    const layer = f.grids[0], first = f.tile(), transparent = f.tile(1);
    layer.emit("tileload", { tile: first }); await flush();
    assert.deepEqual(f.status(), { phase: "loading", total: 2, loaded: 1, failed: 0 });
    layer.emit("tileload", { tile: transparent }); layer.emit("load"); await flush();
    assert.deepEqual(f.status(), { phase: "complete", total: 2, loaded: 2, failed: 0 });
    assert.equal(layer.options.transparent, true);
    assert.equal(layer.options.maxZoom, 22, "composite tiles cover the full map zoom range");
    f.renderer.update([{ layerName: "first", opacity: 0.5 }]);
    assert.equal(f.calls.length, 1);
    f.renderer.destroy();
});

test("Leaflet load following tileerror cannot claim completion; transient failure recovers", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(); f.renderer.update([{}]); await flush();
    const layer = f.grids[0], tile = f.tile();
    layer.emit("tileerror", { tile }); layer.emit("load"); await flush();
    assert.equal(f.status().phase, "retrying");
    context.mock.timers.tick(1000);
    assert.equal(tile.assignments.length, 1);
    layer.emit("tileload", { tile }); layer.emit("load"); await flush();
    assert.equal(f.status().phase, "complete");
    f.renderer.destroy();
});

test("offscreen buffered requests do not prevent visible completion", async () => {
    const f = fixture(); f.renderer.update([{}]); await flush();
    const layer = f.grids[0], tile = f.tile();
    f.tile(3); // Still loading outside the viewport; the grid has not fired load.
    layer.emit("tileload", { tile }); await flush();
    assert.deepEqual(f.status(), { phase: "complete", total: 1, loaded: 1, failed: 0 });
    f.renderer.destroy();
});

test("exhausted retries stay incomplete; explicit retry preserves successful neighbors", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(); f.renderer.update([{}]); await flush();
    const layer = f.grids[0], failed = f.tile(), good = f.tile(1);
    layer.emit("tileload", { tile: good });
    for (const delay of [1000, 4000, 10000, 15000, 30000, 5000]) {
        layer.emit("tileerror", { tile: failed }); layer.emit("load");
        context.mock.timers.tick(delay);
    }
    await flush();
    assert.deepEqual(f.status(), { phase: "incomplete", total: 2, loaded: 1, failed: 1 });
    assert.equal(failed.assignments.length, 5);
    f.renderer.retryFailedTiles(); f.renderer.retryFailedTiles();
    assert.equal(failed.assignments.length, 6, "double click does not restart in-flight retry");
    assert.equal(good.assignments.length, 0);
    layer.emit("tileload", { tile: failed }); layer.emit("load"); await flush();
    assert.equal(f.status().phase, "complete");
    f.renderer.destroy();
});

test("pan/zoom excludes buffered tiles and cancels obsolete retries, including tileabort", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(); f.renderer.update([{}]); await flush();
    const layer = f.grids[0], old = f.tile(), next = f.tile(2), aborted = f.tile(1);
    layer.emit("tileerror", { tile: old }); layer.emit("tileerror", { tile: aborted });
    layer.emit("tileabort", { tile: aborted });
    layer.emit("tileload", { tile: next }); layer.emit("load");
    f.map.bounds = { min: { x: 512, y: 0 }, max: { x: 768, y: 256 } };
    f.map.emit("moveend"); context.mock.timers.tick(60000); await flush();
    assert.equal(old.assignments.length, 0); assert.equal(aborted.assignments.length, 0);
    assert.deepEqual(f.status(), { phase: "complete", total: 1, loaded: 1, failed: 0 });
    f.map.zoom = 2; f.map.emit("zoomend");
    const zoomed = f.tile(2, 2);
    layer.emit("tileerror", { tile: zoomed }); layer.emit("tileunload", { tile: zoomed });
    context.mock.timers.tick(60000); await flush();
    assert.equal(zoomed.assignments.length, 0); assert.equal(f.status().total, 0);
    f.renderer.destroy();
});

test("replacement removes old pixels immediately and ignores their events/retries", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(); f.renderer.update([{ layerName: "first" }]); await flush();
    const previous = f.grids[0], tile = f.tile();
    previous.emit("tileerror", { tile });
    f.renderer.update([{ layerName: "second" }]);
    assert.equal(f.map.attached.size, 0); await flush();
    previous.emit("tileload", { tile }); previous.emit("load");
    context.mock.timers.tick(60000); await flush();
    assert.equal(tile.assignments.length, 0); assert.equal(f.status().loaded, 0);
    assert.deepEqual([...f.map.attached], [f.grids[1]]);
    f.renderer.clear(); await flush();
    assert.equal(f.status().phase, "idle"); f.renderer.destroy();
});

test("failed plan is recoverable and late responses cannot replace current layers", async () => {
    let resolveFirst, count = 0;
    const f = fixture(() => {
        count++;
        if (count === 1) return new Promise(resolve => { resolveFirst = resolve; });
        if (count === 2) throw new Error("Plan unavailable");
        return { wmsUrl: "/current" };
    });
    f.renderer.update([{ layerName: "old" }]);
    f.renderer.update([{ layerName: "new" }]); await flush();
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.status().phase, "error");
    assert.equal(f.status().message, "Plan unavailable");
    f.renderer.retryFailedTiles(); await flush();
    assert.deepEqual(f.calls[2].layers, [{ layerName: "new" }]);
    resolveFirst({ wmsUrl: "/obsolete" }); await flush();
    assert.equal(f.grids.length, 1); assert.equal(f.grids[0].url, "/current");
    f.renderer.destroy(); f.map.emit("moveend"); await flush();
    assert.equal(f.status().phase, "idle");
});
