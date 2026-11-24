import assert from "node:assert/strict";
import test from "node:test";
import { CompositeLeafletRenderer } from "../../src/map-layers/composite-leaflet-renderer.js";
import { LeafletLayerSet } from "../../src/map-layers/leaflet-layer-set.js";
import { FakeRasterControlElement } from "../../test-support/raster/fake-controls-document.js";

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
    const statuses = [], displayed = [], grids = [], calls = [];
    const map = Object.assign(evented(), {
        attached: new Set(), pane: new FakeRasterControlElement(), zoom: 1,
        bounds: { min: { x: 0, y: 0 }, max: { x: 512, y: 256 } },
        getZoom() { return this.zoom; },
        getZoomScale(to, from) { return 2 ** (to - from); },
        getPixelBounds() { return this.bounds; },
        removeLayer(layer) { this.attached.delete(layer); layer.getContainer?.().remove(); },
    });
    const renderer = new CompositeLeafletRenderer({
        leaflet: { tileLayer: { wms(url, options) {
            const container = new FakeRasterControlElement();
            const layer = Object.assign(evented(), {
                url, options,
                getContainer() { return container; },
                getTileSize() { return { x: 256, y: 256 }; },
                addTo() { map.attached.add(this); map.pane.appendChild(container); map.onLayerAdd?.(); },
            });
            grids.push(layer);
            return layer;
        } } },
        leafletMap: map,
        client: { async create(layers, signal) {
            calls.push({ layers, signal });
            return create ? create(layers, signal) : { wmsUrl: "/authorized-plan/wms" };
        } },
        onStatus: (status, views) => {
            statuses.push(status);
            displayed.push([...views.values()].filter(frame => !frame.outsideViewport).map(frame => frame.descriptor.layerName));
            map.onDrawn?.(views);
        },
    });
    return {
        renderer, map, grids, calls, statuses, displayed,
        update(layers, options = {}) {
            const views = new Map(layers.map((descriptor, key) => [String(key), {descriptor, observation: null}]));
            renderer.update(layers, {...options, views});
        },
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
    f.update([{ layerName: "first", opacity: 0.5 }]);
    assert.equal(f.status().phase, "preparing");
    await flush();
    const layer = f.grids[0], first = f.tile(), transparent = f.tile(1);
    layer.emit("tileload", { tile: first }); await flush();
    assert.deepEqual(f.status(), { phase: "loading", total: 2, loaded: 1, failed: 0 });
    assert.deepEqual(f.displayed.at(-1), [], "wait for the first complete observation before offering playback");
    layer.emit("tileload", { tile: transparent }); layer.emit("load"); await flush();
    assert.deepEqual(f.status(), { phase: "complete", total: 2, loaded: 2, failed: 0 });
    assert.equal(layer.options.transparent, true);
    assert.equal(layer.options.maxZoom, 22, "composite tiles cover the full map zoom range");
    f.update([{ layerName: "first", opacity: 0.5 }]);
    assert.equal(f.calls.length, 1);
    f.renderer.destroy();
});

test("a prepared map is hidden until its exact styled stack is selected and pausing releases unused tiles", async () => {
    const f = fixture(), first = [{layerName: "January", opacity: 1}];
    const second = [{layerName: "May", opacity: 0.4}], controller = new AbortController();
    f.update(first);
    await flush();
    const t = f.tile();
    f.grids[0].emit("tileload", {tile: t});
    await flush();
    assert.deepEqual(f.displayed.at(-1), ["January"]);
    const lookahead = new AbortController();
    await f.renderer.prepare([{layerName: "September", opacity: 0.4}], lookahead.signal);
    const laterGrid = f.grids.at(-1);
    const preparing = f.renderer.prepare(second, controller.signal);
    await Promise.resolve();
    const staged = f.grids.at(-1), secondTile = new FakeRasterControlElement();
    staged.getContainer().appendChild(secondTile);
    staged.emit("tileloadstart", {tile: secondTile, coords: {x: 0, y: 0, z: 1}});
    assert.equal(staged.getContainer().hidden, true, "the buffered grid cannot paint through the translucent drawn raster");
    assert.equal(f.grids[0].getContainer().hidden, false);
    secondTile.setAttribute("class", "leaflet-tile-loaded");
    staged.emit("tileload", {tile: secondTile});
    await preparing;
    assert.deepEqual(f.displayed.at(-1), ["January"]);
    f.update(second, {keepPreviousFrame: true});
    controller.abort();
    await flush();
    assert.equal(f.calls.length, 3, "the selected grid needs no second map plan");
    assert.equal(f.map.pane.children[0], staged.getContainer(),
        "the ready grid takes the drawn grid's position even when another date was prepared first");
    assert.equal(f.map.pane.children[1], laterGrid.getContainer());
    lookahead.abort();
    assert.deepEqual([...f.map.attached], [staged]);
    assert.equal(staged.getContainer().hidden, false);
    assert.ok(secondTile.classList.contains("map-raster-frame-tile"), "a buffered tile must paint at the frame's opacity on handoff");
    assert.deepEqual(f.displayed.at(-1), ["May"]);

    const third = [{layerName: "June", opacity: 0.4}];
    f.tile(1); // A pan exposed one more tile of the current May grid.
    await flush();
    let left, right;
    f.map.onLayerAdd = () => { left = f.tile(); right = f.tile(1); };
    f.update(third, {keepPreviousFrame: true});
    await flush();
    const incoming = f.grids.at(-1);
    f.map.onLayerAdd = null;
    incoming.emit("tileload", {tile: left}); await flush();
    assert.ok(f.map.attached.has(staged), "keep the drawn observation until every visible replacement tile is ready");
    assert.equal(incoming.getContainer().hidden, true);
    assert.deepEqual(f.displayed.at(-1), ["May"]);
    f.map.zoom = 2;
    f.map.bounds = {min: {x: 256, y: 0}, max: {x: 512, y: 256}};
    f.tile(1, 2);
    f.map.emit("zoomend"); await flush();
    assert.equal(f.status().loaded, 0, "the replacement has no loaded tiles at the new zoom");
    assert.deepEqual(f.displayed.at(-1), ["May"], "May's enlarged tile is still on the map");
    f.map.zoom = 1;
    f.tile(2); // The new grid also has a pending tile in the destination of the pan.
    f.map.bounds = {min: {x: 512, y: 0}, max: {x: 768, y: 256}};
    f.map.emit("moveend"); await flush();
    assert.deepEqual(f.displayed.at(-1), [], "no May tiles remain in view");
    f.map.bounds = {min: {x: 0, y: 0}, max: {x: 512, y: 256}};
    f.map.emit("moveend"); await flush();
    assert.deepEqual(f.displayed.at(-1), ["May"], "the visible overlap still belongs to May");
    incoming.emit("tileload", {tile: right}); await flush();
    assert.deepEqual([...f.map.attached], [incoming]);
    assert.equal(incoming.getContainer().hidden, false);
    assert.deepEqual(f.displayed.at(-1), ["June"]);

    const unused = new AbortController();
    await f.renderer.prepare([{layerName: "June", opacity: 1}], unused.signal);
    const unusedGrid = f.grids.at(-1);
    f.update([{layerName: "June", opacity: 0.5}]);
    await flush();
    assert.notEqual(f.grids.at(-1), unusedGrid, "an old opacity cannot be drawn from the buffer");
    unused.abort();
    assert.equal(f.map.attached.has(unusedGrid), false);
    f.renderer.destroy();
});

test("adding an annotation after a superseded date attaches the grid belonging to the drawn observation", async () => {
    const f = fixture();
    const layers = new LeafletLayerSet(f.map, f.renderer);
    const source = () => ({setZIndex() {}, setOpacity() {}, addTo(map) { map.attached.add(this); }});
    const jan = source(), feb = source(), note = source();
    const row = name => ({key: "rain", visible: true, opacity: 1, descriptor: name ? {layerName: name} : null});
    layers.add("rain", jan, row("Jan"));
    layers.render([row("Jan")]);
    await flush();
    f.grids[0].emit("tileload", {tile: f.tile()}); await flush();
    f.map.onLayerAdd = () => f.tile();
    layers.replace("rain", feb, {keepPreviousFrame: true});
    layers.render([row("Feb")], {keepPreviousFrame: true});
    await flush();
    layers.replace("rain", source(), {keepPreviousFrame: true, awaitingPublication: true});
    layers.render([row(null)], {keepPreviousFrame: true});
    layers.add("note", note, {visible: true, opacity: 1});
    layers.render([row(null), {key: "note", visible: true, opacity: 1, descriptor: null}]);
    assert.deepEqual(f.map.attached, new Set([jan, note]), "the discarded February grid must not be shown as January");
    layers.clear();
});

test("reordering duplicate views during a date change keeps drawn publications with their original rows", async () => {
    const f = fixture();
    const layers = new LeafletLayerSet(f.map, f.renderer);
    let drawn;
    f.map.onDrawn = views => { drawn = new Map(Array.from(views, ([key, frame]) => [key, frame.descriptor.layerName])); };
    const row = (key, name) => ({key, visible: true, opacity: 1, descriptor: {layerName: name}});
    const source = () => ({setZIndex() {}, setOpacity() {}});
    const original = row("original", "Jan"), copy = row("copy", "Feb"), next = row("original", "Feb");
    for (const entry of [original, copy]) layers.add(entry.key, source(), entry);
    layers.render([original, copy]); await flush();
    f.grids[0].emit("tileload", {tile: f.tile()}); await flush();
    let incoming;
    f.map.onLayerAdd = () => { incoming = f.tile(); };
    layers.replace("original", source(), {keepPreviousFrame: true});
    layers.render([next, copy], {keepPreviousFrame: true}); await flush();
    layers.render([copy, next]);
    f.map.emit("moveend"); await flush();
    assert.deepEqual(drawn, new Map([["original", "Jan"], ["copy", "Feb"]]), "a reorder cannot relabel the old stack");
    f.grids.at(-1).emit("tileload", {tile: incoming}); await flush();
    assert.deepEqual(drawn, new Map([["copy", "Feb"], ["original", "Feb"]]));
    layers.clear();
});

test("Leaflet load following tileerror cannot claim completion; transient failure recovers", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(); f.update([{}]); await flush();
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
    const f = fixture(); f.update([{}]); await flush();
    const layer = f.grids[0];
    layer.emit("loading");
    const tile = f.tile(), offscreen = f.tile(3);
    layer.emit("tileload", { tile }); await flush();
    assert.deepEqual(f.status(), { phase: "complete", total: 1, loaded: 1, failed: 0 });
    let views;
    f.map.onDrawn = next => { views = next; };
    f.map.bounds = {min: {x: 512, y: 0}, max: {x: 768, y: 256}};
    f.map.emit("moveend"); await flush();
    assert.equal(views.get("0")?.outsideViewport, true, "the composite finished without any tiles in this viewport");
    layer.emit("tileunload", {tile: offscreen});
    f.map.emit("moveend"); await flush();
    assert.equal(f.status().phase, "complete", "Leaflet can discard its last pending tile without a grid load event");
    f.renderer.destroy();
});

test("exhausted retries stay incomplete; explicit retry preserves successful neighbors", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(); f.update([{}]); await flush();
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
    const f = fixture(); f.update([{}]); await flush();
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
    const f = fixture(); f.update([{ layerName: "first" }]); await flush();
    const previous = f.grids[0], tile = f.tile();
    previous.emit("tileerror", { tile });
    f.update([{ layerName: "second" }]);
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
        if (count === 2 || count === 4) throw new Error("Plan unavailable");
        return { wmsUrl: "/current" };
    });
    f.update([{ layerName: "old" }]);
    f.update([{ layerName: "new" }]); await flush();
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.status().phase, "error");
    assert.equal(f.status().message, "Plan unavailable");
    f.renderer.retryFailedTiles(); await flush();
    assert.deepEqual(f.calls[2].layers, [{ layerName: "new" }]);
    resolveFirst({ wmsUrl: "/obsolete" }); await flush();
    assert.equal(f.grids.length, 1); assert.equal(f.grids[0].url, "/current");

    const drawn = f.grids[0];
    const firstTile = f.tile();
    drawn.emit("tileload", {tile: firstTile}); await flush();
    f.update([{layerName: "next"}], {keepPreviousFrame: true});
    await flush();
    assert.equal(f.status().phase, "error");
    assert.deepEqual([...f.map.attached], [drawn], "a failed date change keeps the displayed frame");
    assert.deepEqual(f.displayed.at(-1), ["new"]);
    let nextTile;
    f.map.onLayerAdd = () => { nextTile = f.tile(); };
    f.renderer.retryFailedTiles(); await flush();
    const next = f.grids.at(-1);
    assert.equal(next.getContainer().hidden, true);
    assert.ok(f.map.attached.has(drawn), "retry keeps the old frame until the replacement has drawn");
    next.emit("tileload", {tile: nextTile}); await flush();
    assert.deepEqual([...f.map.attached], [next]);
    assert.deepEqual(f.displayed.at(-1), ["next"]);
    f.renderer.destroy(); f.map.emit("moveend"); await flush();
    assert.equal(f.status().phase, "idle");
});
