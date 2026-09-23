import assert from "node:assert/strict";
import test from "node:test";
import { AnnotationHoverCard } from "../../src/annotations/hover-card.js";

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
    const hover = new AnnotationHoverCard(map, () => { results.requests++; return results.hits; });
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
    assert.equal(h.card.style.left, "376px"); assert.equal(h.card.style.top, "356px");
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
