import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationPanelView } from "../../src/annotations/panel-view.js";

/** DOM fixture that retains field values while controls move between containers. */
class Element extends EventTarget {
    /** @param {Object} document Focus owner. */
    constructor(document) { super(); this.document = document; this.children = []; this.value = ""; }
    /** @param {...Element} nodes Children to move here. @return {void} */
    append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
    /** Detach this element. @return {void} */
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
    /** @param {...Element} nodes Replacement children. @return {void} */
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    /** @return {Object[]} Visible client rectangles, or none for a hidden launcher. */
    getClientRects() { return this.hidden ? [] : [{}]; }
    /** Focus this element. @return {void} */
    focus() { this.document.activeElement = this; }
}

/** @return {Object} Panel with DOM and open/close observations. */
function setup() {
    const elements = new Map();
    const document = { createElement: () => new Element(document), querySelector: selector => {
        if (!elements.has(selector)) elements.set(selector, new Element(document));
        return elements.get(selector);
    } };
    document.querySelector("#annotation-panel-layer-field").hidden = true;
    document.querySelector("#annotation-panel-title").textContent = "Polygons";
    const events = [];
    const view = new AnnotationPanelView({ document, onOpen: () => events.push("open"), onClose: () => events.push("close") });
    return { document, events, view };
}

test("loading and renaming layers never open the panel or replace the editor's fields", () => {
    const { document, events, view } = setup();
    const local = document.createElement(); local.value = "Unfinished note";
    const shared = document.createElement();
    view.registerLayerControls("local", "My annotations", local);
    assert.equal(view.title.textContent, "My annotations");
    assert.equal(view.layerField.hidden, true);
    view.showLayer("local");
    assert.equal(document.activeElement, view.title);
    events.length = 0;
    view.registerLayerControls("shared", "Maria · Wetlands", shared);
    assert.deepEqual(events, []);
    assert.equal(view.layerField.hidden, false);
    view.showLayer("local");
    view.renameLayer("local", "New name");
    assert.equal(view.title.textContent, "New name");
    assert.equal(view.content.children[0], local);
    view.showLayer("shared");
    assert.equal(view.title.textContent, "Maria · Wetlands");
    assert.equal(document.activeElement, view.selector);
    view.renameLayer("local", "New local name");
    assert.equal(view.title.textContent, "Maria · Wetlands");
    view.selector.value = "local";
    view.selector.dispatchEvent(new Event("change"));
    assert.equal(view.content.children[0], local);
    assert.equal(local.value, "Unfinished note");
    assert.equal(view.selector.children[0].textContent, "New local name");
    document.querySelector("#close-annotations").dispatchEvent(new Event("click"));
    assert.equal(events.at(-1), "close");
    assert.equal(document.activeElement, view.entry);
    view.showLayer("local");
    assert.equal(view.content.children[0], local);
});

test("removal selects another editor or closes the empty panel without retaining controls", () => {
    const { document, view, events } = setup();
    view.registerLayerControls("a", "A", document.createElement());
    view.registerLayerControls("b", "B", document.createElement());
    view.removeLayer("a");
    assert.equal(view.selectedKey, "b");
    assert.equal(view.selector.children.length, 1);
    assert.equal(view.layerField.hidden, true);
    assert.equal(view.title.textContent, "B");
    view.removeLayer("b");
    assert.equal(view.empty.hidden, false);
    assert.equal(view.layerField.hidden, true);
    assert.equal(view.content.children.length, 0);
    view.showLayer("a");
    assert.deepEqual(events, ["close"]);
    assert.equal(view.title.textContent, "Polygons");
    view.show();
    assert.equal(document.activeElement, view.title);
});

test("empty startup stays closed but a failed polygon action can open its neutral panel", () => {
    const { document, view, events } = setup();
    assert.deepEqual(events, []);
    document.querySelector("#annotation-file-status").textContent = "Cannot import GeoJSON: invalid polygon";
    view.show();
    assert.deepEqual(events, ["open"]);
    assert.equal(view.title.textContent, "Polygons");
    assert.equal(document.activeElement, view.title);
});

test("closing the layer editor focuses the map when Map layers is collapsed", () => {
    const { document, view } = setup();
    view.entry.hidden = true;
    view.show();
    document.querySelector("#close-annotations").dispatchEvent(new Event("click"));
    assert.equal(document.activeElement, document.querySelector("#map"));
});
