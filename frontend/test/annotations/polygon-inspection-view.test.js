import assert from "node:assert/strict";
import test from "node:test";
import { AnnotationLayerControls } from "../../src/annotations/layer-controls.js";

/** Minimal text-only DOM for the polygon-details public view contract. */
class Element extends EventTarget {
    /** @param {string} tag Element tag. */
    constructor(tag) { super(); this.tag = tag; this.children = []; this.textContent = ""; this.hidden = false; }
    /** @param {...Element} children Child nodes. @return {void} */
    append(...children) { this.children.push(...children); }
    /** @param {...Element} children Replacement child nodes. @return {void} */
    replaceChildren(...children) { this.children = [...children]; }
}

test("details preserve plain text, provide only owner actions and allow choosing an overlap", () => {
    const actions = [];
    const controls = Object.create(AnnotationLayerControls.prototype);
    controls.document = { createElement: tag => new Element(tag) };
    controls.inspection = new Element("section");
    controls.actions = { edit: id => actions.push(["edit", id]), removePolygon: id => actions.push(["delete", id]) };
    const own = { layerId: "l", layerName: "Habitats", canEdit: true, polygon: { id: "p", name: "<b>River</b>", note: "First\nSecond", contributor: "Lee" } };
    const peer = { ...own, canEdit: false, polygon: { ...own.polygon, id: "other", contributor: "Maria" } };
    controls.showPolygonInspection(peer, [peer, own], index => actions.push(["select", index]));
    assert.equal(controls.inspection.children[0].textContent, "Selected polygon");
    assert.equal(controls.inspection.children[1].textContent, "<b>River</b>");
    assert.equal(controls.inspection.children[3].textContent, "First\nSecond");
    assert.equal(controls.inspection.children.some(child => child.tag === "div"), false, "peers get no edit/delete actions");
    const choices = controls.inspection.children.at(-1).children[0];
    choices.value = "1"; choices.dispatchEvent(new Event("change"));
    assert.deepEqual(actions, [["select", 1]]);
    controls.showPolygonInspection(own, [peer, own], () => {});
    const buttons = controls.inspection.children.find(child => child.tag === "div").children;
    buttons[0].dispatchEvent(new Event("click")); buttons[1].dispatchEvent(new Event("click"));
    assert.deepEqual(actions.slice(1), [["edit", "p"], ["delete", "p"]]);
    const retained = controls.inspection.children[0];
    controls.showPolygonInspection(own, [peer, own], () => {});
    assert.equal(controls.inspection.children[0], retained, "unchanged data preserves the focused controls");
    controls.clearPolygonInspection();
    assert.equal(controls.inspection.hidden, true);
});

test("polygon rows open the unified editor from name and note without directly changing saved data", () => {
    const actions = [];
    const controls = Object.create(AnnotationLayerControls.prototype);
    controls.document = { createElement: tag => Object.assign(new Element(tag), { dataset: {}, classList: { add() {} } }) };
    controls.actions = { edit: (id, field) => actions.push([id, field]) };
    const polygon = { id: "p", name: "River", note: "First\nSecond" };
    const before = structuredClone(polygon);
    const row = controls.polygonRow(polygon);
    row.children[0].dispatchEvent(new Event("click"));
    row.children[2].dispatchEvent(new Event("click"));
    assert.deepEqual(actions, [["p", "name"], ["p", "note"]]);
    assert.deepEqual(polygon, before);
    assert.equal(row.children.some(child => child.tag === "input" || child.tag === "textarea"), false);
});

test("selection emphasis runs only on explicit selection and respects reduced motion", () => {
    const controls = Object.create(AnnotationLayerControls.prototype);
    let reducedMotion = false, animations = 0, cancellations = 0;
    controls.document = { createElement: tag => new Element(tag), defaultView: {
        matchMedia: query => { assert.equal(query, "(prefers-reduced-motion: reduce)"); return { matches: reducedMotion }; },
    } };
    controls.inspection = new Element("section");
    controls.inspection.animate = () => { animations++; return { cancel() { cancellations++; } }; };
    const hit = { layerId: "layer", layerName: "Habitats", canEdit: false, polygon: { id: "polygon", name: "River", note: "" } };
    controls.showPolygonInspection(hit, [hit], () => {}, true);
    assert.equal(animations, 1);
    hit.polygon.note = "Shared update";
    controls.showPolygonInspection(hit, [hit], () => {});
    assert.equal(animations, 1, "background updates do not highlight again");
    controls.clearPolygonInspection();
    assert.equal(cancellations, 1);
    reducedMotion = true;
    controls.showPolygonInspection(hit, [hit], () => {}, true);
    assert.equal(animations, 1, "reduced-motion users retain the static caption and distinct card");
    assert.equal(controls.inspection.children[0].textContent, "Selected polygon");
});
