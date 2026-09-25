import assert from "node:assert/strict";
import test from "node:test";
import { MapFeatureHover } from "../src/map-feature-hover.js";

/** @return {Object} Map events, pointer hit results and public hover presentation. */
function fixture() {
    const card = { hidden: true, textContent: "", style: {}, offsetWidth: 120, offsetHeight: 40, remove() { this.removed = true; } };
    const container = new EventTarget();
    Object.assign(container, { clientWidth: 500, clientHeight: 400, ownerDocument: { createElement: () => card }, append() {} });
    const handlers = new Map();
    const map = { getContainer: () => container,
        on(names, handler) { for (const name of names.split(" ")) handlers.set(name, handler); },
        off(names, handler) { for (const name of names.split(" ")) { assert.equal(handlers.get(name), handler); handlers.delete(name); } } };
    const results = { hits: [{ layerName: "Habitats", polygon: { name: "Wetland", contributor: "Lee" } }], requests: 0 };
    const hover = new MapFeatureHover(map, {
        findLocalText: () => {
            results.requests++;
            const hit = results.hits[0];
            return hit ? `${hit.layerName}\n${hit.polygon.name} — ${hit.polygon.contributor}` : null;
        },
        findRemoteText: async () => null,
    });
    const move = (x = 100, y = 200) => handlers.get("mousemove")({ latlng: { lng: 1, lat: 2 }, containerPoint: { x, y } });
    return { hover, card, container, handlers, results, move };
}

test("waits 80 ms once, then follows and switches polygons immediately as plain text", context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const h = fixture();
    h.move(); context.mock.timers.tick(79);
    assert.equal(h.card.hidden, true); assert.equal(h.results.requests, 0);
    context.mock.timers.tick(1);
    assert.equal(h.card.hidden, false);
    assert.equal(h.card.textContent, "Habitats\nWetland — Lee");
    h.results.hits[0].polygon.name = "<b>Plain text</b>";
    h.move(490, 390);
    assert.equal(h.card.textContent, "Habitats\n<b>Plain text</b> — Lee");
    assert.equal(h.card.style.left, "376px"); assert.equal(h.card.style.top, "334px");
    h.move(300, 20);
    assert.equal(h.card.style.left, "164px"); assert.equal(h.card.style.top, "4px");
    h.results.hits = []; h.move();
    assert.equal(h.card.hidden, true);
    h.hover.dispose();
});

test("leaving, dragging, editing and removal cancel pending hover work", context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const h = fixture();
    h.move(); h.container.dispatchEvent(new Event("pointerleave")); context.mock.timers.tick(80);
    assert.equal(h.results.requests, 0);
    h.move(); h.handlers.get("movestart")(); context.mock.timers.tick(80);
    assert.equal(h.card.hidden, true);
    h.move(); context.mock.timers.tick(80); assert.equal(h.results.requests, 0);
    h.handlers.get("moveend")(); h.move(); h.hover.setEnabled(false); context.mock.timers.tick(80);
    assert.equal(h.results.requests, 0);
    h.hover.setEnabled(true); h.move(); context.mock.timers.tick(80);
    assert.equal(h.card.hidden, false);
    h.handlers.get("zoomstart")(); assert.equal(h.card.hidden, true);
    h.handlers.get("zoomend")(); h.move(); h.handlers.get("remove")(); context.mock.timers.tick(80);
    assert.equal(h.results.requests, 1);
    assert.equal(h.handlers.size, 0); assert.equal(h.card.removed, true);
});

test("remote queries wait for a pause, cancel on movement and cannot display late replies", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const h = fixture();
    h.results.hits = [];
    const requests = [];
    h.hover.findRemoteText = (event, signal) => new Promise(resolve => requests.push({ event, signal, resolve }));
    for (let i = 0; i < 30; i++) { h.move(i); context.mock.timers.tick(10); }
    assert.equal(requests.length, 0);
    context.mock.timers.tick(80);
    assert.equal(requests.length, 1);
    h.move(200);
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve("Obsolete layer");
    await Promise.resolve();
    assert.equal(h.card.hidden, true);
    context.mock.timers.tick(80);
    requests[1].resolve("Current layer");
    await Promise.resolve();
    assert.equal(h.card.textContent, "Current layer");
    assert.equal(h.card.hidden, false);
    assert.equal(h.card.style.left, "216px");
    h.move(201);
    assert.equal(h.card.hidden, true, "do not identify a new position using old remote results");
    context.mock.timers.tick(80);
    h.container.dispatchEvent(new Event("pointerleave"));
    assert.equal(requests[2].signal.aborted, true);
    requests[2].resolve("No longer hovered");
    await Promise.resolve();
    assert.equal(h.card.hidden, true);
    h.hover.dispose();
});

test("editing, layer changes, clicks, dragging and disposal invalidate in-flight queries", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    for (const stop of [h => h.hover.setEnabled(false), h => h.hover.hide(),
        h => h.handlers.get("click")(), h => h.handlers.get("movestart")(), h => h.hover.dispose()]) {
        const h = fixture();
        h.results.hits = [];
        let finish, signal;
        h.hover.findRemoteText = (_, suppliedSignal) => {
            signal = suppliedSignal;
            return new Promise(resolve => { finish = resolve; });
        };
        h.move(); context.mock.timers.tick(80);
        stop(h);
        assert.equal(signal.aborted, true);
        finish("Late result"); await Promise.resolve();
        assert.equal(h.card.hidden, true);
    }
});

test("local polygons take priority; failed and empty remote results leave no stale card", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const h = fixture();
    let requests = 0;
    h.hover.findRemoteText = async () => { requests++; throw new Error("Unavailable"); };
    h.move(); context.mock.timers.tick(80);
    assert.equal(requests, 0);
    assert.equal(h.card.hidden, false);
    h.results.hits = [];
    h.move(); context.mock.timers.tick(80); await Promise.resolve();
    assert.equal(requests, 1);
    assert.equal(h.card.hidden, true);
    h.hover.findRemoteText = async () => null;
    h.move(); context.mock.timers.tick(80); await Promise.resolve();
    assert.equal(h.card.hidden, true);
    h.hover.dispose();
});
