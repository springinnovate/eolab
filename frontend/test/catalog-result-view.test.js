import assert from "node:assert/strict";
import test from "node:test";
import { createCatalogResultView } from "../src/catalog-result-view.js";

/** Minimal DOM boundary: stable nodes, attributes, focus, and native events. */
function fixture(presentation = {}) {
  const document = { activeElement: null, createElement: (tag) => new Element(tag) };
  class Element extends EventTarget {
    constructor(tag) {
      super();
      this.tagName = tag;
      this.children = [];
      this.attributes = new Map();
      this.className = "";
      this.textContent = "";
      this.classList = {
        contains: (name) => this.className.split(" ").includes(name),
        toggle: (name, force) => {
          const names = new Set(this.className.split(" "));
          if (force) names.add(name); else names.delete(name);
          this.className = [...names].join(" ");
        },
      };
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    append(...children) { this.children.push(...children); }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    focus() { document.activeElement = this; }
  }
  const item = { collection: "rasters", id: "wind" }, calls = [];
  const view = createCatalogResultView({
    item, id: "row-1", documentContext: document,
    presentation: {
      filename: "wind.tif", fullTitle: "future/wind.tif", context: "future",
      datasetType: "Raster", accessibleLabel: "More details: future/wind.tif",
      ...presentation,
    },
    onMapAction: (requested) => calls.push(["map", requested]),
    onDetails: (requested, button) => calls.push(["details", requested, button]),
    onPreview: (requested) => calls.push(["preview", requested]),
    onClearPreview: () => calls.push(["clear"]),
  });
  const actions = view.element.children.find((child) => child.className === "catalog-result-actions");
  const [onMap, mapButton] = actions.children;
  const status = view.element.children.at(-1);
  const update = (state = {}) => view.update({ supported: true, retained: false, pendingAction: null, feedback: null, ...state });
  update();
  return { view, item, document, calls, actions, onMap, mapButton, status, update };
}

test("result row has separate native map/details buttons without nested buttons", () => {
  const f = fixture();
  assert.equal(f.view.element.tagName, "div");
  assert.equal(f.view.element.getAttribute("role"), "group");
  assert.equal(f.mapButton.tagName, "button");
  assert.equal(f.view.detailsButton.tagName, "button");
  assert.equal(f.mapButton.type, "button");
  assert.equal(f.view.detailsButton.getAttribute("aria-controls"), "catalog-item-inspector");
  f.mapButton.dispatchEvent(new Event("click"));
  assert.deepEqual(f.calls, [["map", f.item]]);
  f.view.detailsButton.dispatchEvent(new Event("click"));
  assert.deepEqual(f.calls.at(-1), ["details", f.item, f.view.detailsButton]);
});

test("state changes preserve controls/focus and keep On map distinct from Remove", () => {
  const f = fixture(), originalChildren = [...f.actions.children];
  f.mapButton.focus();
  assert.equal(f.mapButton.textContent, "Add to map");
  assert.equal(f.mapButton.getAttribute("aria-label"), "Add to map: future/wind.tif");
  f.update({ pendingAction: { buttonText: "Adding to map...", statusText: "Checking raster" } });
  assert.equal(f.mapButton.disabled, true);
  assert.equal(f.mapButton.textContent, "Adding...");
  assert.equal(f.status.textContent, "Checking raster");
  assert.equal(f.status.getAttribute("aria-live"), "polite");
  assert.equal(f.mapButton.getAttribute("aria-describedby"), f.status.id);
  f.update({ retained: true, feedback: { message: "Raster added to the map." } });
  assert.equal(f.onMap.hidden, false);
  assert.equal(f.mapButton.textContent, "Remove");
  assert.equal(f.mapButton.getAttribute("aria-label"), "Remove from map: future/wind.tif");
  assert.equal(f.mapButton.disabled, false);
  assert.equal(f.document.activeElement, f.mapButton);
  assert.deepEqual(f.actions.children, originalChildren);
  f.update();
  assert.equal(f.onMap.hidden, true);
  assert.equal(f.mapButton.textContent, "Add to map");
});

test("errors are visible beside the affected action; retries hide stale errors", () => {
  const f = fixture();
  const feedback = { message: "Unable to read raster metadata", isError: true };
  f.update({ feedback });
  assert.equal(f.status.textContent, feedback.message);
  assert.equal(f.status.classList.contains("visually-hidden"), false);
  f.update({ feedback, pendingAction: { buttonText: "Adding to map...", statusText: "Retrying" } });
  assert.equal(f.status.textContent, "Retrying");
  assert.equal(f.status.classList.contains("visually-hidden"), true);
});

test("unsupported Items keep details, and source strings are rendered as text", () => {
  const f = fixture({ filename: "<img onerror=alert(1)>", context: null, datasetType: null });
  f.update({ supported: false });
  assert.equal(f.mapButton.hidden, true);
  assert.equal(f.view.element.children[0].textContent, "<img onerror=alert(1)>");
  assert.equal(f.view.element.children[0].children.length, 0);
  assert.equal(f.view.element.children.length, 3);
  f.view.detailsButton.dispatchEvent(new Event("click"));
  assert.equal(f.calls[0][0], "details");
});

test("footprint preview survives focus moving between controls within the row", () => {
  const f = fixture();
  f.view.element.dispatchEvent(new Event("focusin"));
  const internal = new Event("focusout");
  Object.defineProperty(internal, "relatedTarget", { value: f.view.detailsButton });
  f.view.element.dispatchEvent(internal);
  assert.deepEqual(f.calls, [["preview", f.item]]);
  const external = new Event("focusout");
  Object.defineProperty(external, "relatedTarget", { value: null });
  f.view.element.dispatchEvent(external);
  assert.deepEqual(f.calls.at(-1), ["clear"]);
});
