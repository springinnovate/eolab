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
    assert.equal(controls.inspection.children[0].textContent, "<b>River</b>");
    assert.equal(controls.inspection.children[2].textContent, "First\nSecond");
    assert.equal(controls.inspection.children.some(child => child.tag === "div"), false, "peers get no edit/delete actions");
    const choices = controls.inspection.children.at(-1).children[0];
    choices.value = "1"; choices.dispatchEvent(new Event("change"));
    assert.deepEqual(actions, [["select", 1]]);
    controls.showPolygonInspection(own, [peer, own], () => {});
    const buttons = controls.inspection.children.find(child => child.tag === "div").children;
    buttons[0].dispatchEvent(new Event("click")); buttons[2].dispatchEvent(new Event("click"));
    assert.deepEqual(actions.slice(1), [["edit", "p"], ["delete", "p"]]);
    const retained = controls.inspection.children[0];
    controls.showPolygonInspection(own, [peer, own], () => {});
    assert.equal(controls.inspection.children[0], retained, "unchanged data preserves the focused controls");
    controls.clearPolygonInspection();
    assert.equal(controls.inspection.hidden, true);
});
