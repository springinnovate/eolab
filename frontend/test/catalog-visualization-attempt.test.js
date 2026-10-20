import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  catalogItemsMatch, CatalogMapActions,
} from "../src/catalog-map-actions.js";
import { renderCatalogMapAction } from "../src/catalog-map-action-view.js";
import { createCatalogResultView } from "../src/catalog-result-view.js";
import { getCatalogItemKey } from "../src/catalog-item-identity.js";
import { getCatalogItemMapBounds } from "../src/map.js";

const MARKUP = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/** Build a prepared catalog raster. @param {string} id Item ID. @return {Object} Catalog Item. */
function raster(id) {
  return {
    collection: "eolab-mounted-geotiffs", id,
    properties: { title: `Mounted/Model_outputs/${id}.tif` },
    assets: { data: {} },
  };
}

/**
 * Build a catalog vector with scanner-owned eligibility metadata.
 * @param {string} id Item ID.
 * @param {boolean} [eligible=true] Whether visualization is supported.
 * @param {string|null} [reason=null] Explanation of a rendering restriction.
 * @return {Object} Catalog Item.
 */
function vector(id, eligible = true, reason = null) {
  return {
    collection: "eolab-mounted-vectors", id, assets: { data: {} },
    properties: {
      title: `${id}.gpkg`,
      "eolab:vector_rendering": {
        policy: "vector-v1", eligible, reason,
      },
    },
  };
}

/**
 * Control completion at an asynchronous publication boundary.
 * @return {{promise:Promise<Object|null>,resolve:(value:Object|null)=>void,reject:(reason:Error)=>void}}
 * Promise and settlement callbacks.
 */
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** DOM node supporting the native events and properties used by Catalog actions. */
class ActionElement extends EventTarget {
  /** Create an event-capable control. @param {string} tagName Element name. */
  constructor(tagName) {
    super();
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.textContent = "";
    this.classList = {
      contains: (name) => this.className.split(" ").includes(name),
      toggle: (name, enabled) => {
        const classes = new Set(this.className.split(" "));
        if (enabled) classes.add(name); else classes.delete(name);
        this.className = [...classes].join(" ");
      },
    };
  }

  /** Store a rendered attribute. @param {string} name Attribute name. @param {string} value Attribute value. @return {void} */
  setAttribute(name, value) { this.attributes.set(name, value); }
  /** Read a rendered attribute. @param {string} name Attribute name. @return {string|null} Current attribute value. */
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  /** Attach child controls. @param {...ActionElement} children Nodes to append. @return {void} */
  append(...children) { this.children.push(...children); }
  /** Check control ancestry. @param {ActionElement|null} node Candidate descendant. @return {boolean} Whether it belongs to this node. */
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
}

/**
 * Connect the actual action owner and views through application-style callbacks.
 * @param {Object} [options] Controllable publication boundaries and initial selection.
 * @param {Object|null} [options.selectedItem=null] Item displayed in details.
 * @param {(item:Object)=>Promise<Object>} [options.prepare] Preparation boundary.
 * @param {(item:Object)=>Promise<Object|null>} [options.show] Publication boundary.
 * @param {Object[]} [options.retained=[]] Initially retained Items.
 * @return {Object} Actions, rendered controls, callback records and external lifecycle helpers.
 */
function harness({ selectedItem = null, prepare = async (item) => item,
  show = async () => ({ layerName: "eolab:test" }), retained = [] } = {}) {
  const calls = [], transitions = [];
  const state = { selectedItem, resultViews: new Map() };
  const retainedItems = new Set(retained.map(getCatalogItemKey));
  const documentContext = { createElement: (tag) => new ActionElement(tag) };
  const layerButton = new ActionElement("button"), styleButton = new ActionElement("button");
  const zoomButton = new ActionElement("button"), onMap = new ActionElement("span");
  const actionContainer = new ActionElement("div"), actionStatus = new ActionElement("p");
  const status = new ActionElement("p");
  const elements = { container: actionContainer, toggle: layerButton, style: styleButton,
    zoom: zoomButton, onMap, actionStatus, layerStatus: status };
  const visualization = {
    contains: (item) => retainedItems.has(getCatalogItemKey(item)),
    /** Record removal and its Undo policy. @param {Object} item Removed source. @param {boolean} allowUndo User-removal flag. @return {void} */
    remove(item, allowUndo) {
      calls.push(["remove", item.id, allowUndo]);
      retainedItems.delete(getCatalogItemKey(item));
    },
    /** Record preparation and defer to the test boundary. @param {Object} item Requested Item. @return {Promise<Object>} Prepared Item. */
    async prepare(item) { calls.push(["prepare", item.id]); return prepare(item); },
    /** Retain the Item after successful publication. @param {Object} item Prepared Item. @return {Promise<Object|null>} Publication or cancellation. */
    async show(item) {
      calls.push(["show", item.id]);
      const publication = await show(item);
      if (publication !== null) retainedItems.add(getCatalogItemKey(item));
      return publication;
    },
  };
  /** Refresh actual row and inspector views from the action owner's current state. @return {void} */
  const refresh = () => {
    for (const row of state.resultViews.values()) row.update(actions.state(row.item));
    renderCatalogMapAction(elements, state.selectedItem, actions.state(state.selectedItem));
  };
  const actions = new CatalogMapActions({
    contains: visualization.contains,
    prepare: visualization.prepare,
    show: visualization.show,
    remove: item => visualization.remove(item, true),
    getBounds: getCatalogItemMapBounds,
    openStyle: key => calls.push(["style", key]),
    zoomToBounds: bounds => calls.push(["zoom", bounds, { padding: [24, 24], maxZoom: 9 }]),
    onPrepared: (item, currentVisualization) => {
      transitions.push(["prepared", item, currentVisualization]);
      if (!catalogItemsMatch(state.selectedItem, item)) return;
      actions.applyAssessment(state.selectedItem);
      if (currentVisualization?.kind === "raster") calls.push(["activate-analysis", state.selectedItem.id]);
      calls.push(["render-inspector", state.selectedItem.id]);
    },
    onRemoved: (item, kind) => {
      transitions.push(["removed", item, kind]);
      if (kind === "raster" && catalogItemsMatch(state.selectedItem, item)) calls.push(["activate-analysis", item.id]);
    },
    onAdded: () => calls.push(["open-rendering"]),
    onChange: refresh,
  });
  let lastAction = null;
  layerButton.addEventListener("click", () => { lastAction = actions.toggle(state.selectedItem); });
  styleButton.addEventListener("click", () => actions.style(state.selectedItem));
  zoomButton.addEventListener("click", () => actions.zoom(state.selectedItem));
  /** Add a real result row to the current search presentation. @param {Object} item Catalog Item. @return {Object} Row and native action controls. */
  const addRow = (item) => {
    const view = createCatalogResultView({
      item, id: getCatalogItemKey(item), documentContext,
      presentation: { filename: item.id, fullTitle: item.id, accessibleLabel: `More details: ${item.id}` },
      onMapAction: requested => { lastAction = actions.toggle(requested); },
      onStyle: requested => actions.style(requested),
      onZoom: requested => actions.zoom(requested),
      onDetails: () => {}, onPreview: () => {}, onClearPreview: () => {},
    });
    const controls = view.element.children.find(child => child.className === "catalog-result-actions");
    const [, mapButton, rowZoomButton, rowStyleButton] = controls.children;
    const row = { ...view, mapButton, zoomButton: rowZoomButton, styleButton: rowStyleButton,
      /** Record and render row state. @param {Object} value Current action state. @return {void} */
      update(value) { this.state = value; view.update(value); } };
    state.resultViews.set(getCatalogItemKey(item), row);
    refresh();
    return row;
  };
  const row = selectedItem === null ? null : addRow(selectedItem);
  refresh();
  return {
    run: (item = state.selectedItem) => actions.toggle(item), actions,
    refresh, style: item => actions.style(item), zoom: item => actions.zoom(item),
    addRow, row, state, calls, transitions, layerButton, styleButton, zoomButton,
    onMap, actionContainer, actionStatus, status,
    /** Read the latest control-triggered action. @return {Promise<void>|null} Latest action dispatched by a native control. */
    get lastAction() { return lastAction; },
    /** Simulate retention before publication settles. @param {Object} item Source retained by another owner while publication is pending. @return {void} */
    retainExternally(item) { retainedItems.add(getCatalogItemKey(item)); refresh(); },
    /** Simulate removal outside Catalog actions. @param {Object} item Source removed outside Catalog. @return {void} */
    removeExternally(item) { visualization.remove(item, false); refresh(); },
  };
}

test("catalog publication and map feedback retain live regions", () => {
  assert.match(MARKUP, /id="toggle-catalog-layer"[\s\S]*?>\s*Add to map\s*</);
  assert.match(MARKUP, /id="catalog-on-map" hidden[\s\S]*?On map/);
  assert.match(MARKUP, /id="catalog-map-action-status"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/);
  assert.match(MARKUP, /id="map-layer-rendering-announcement"[\s\S]*?role="status"/);
  assert.doesNotMatch(MARKUP, /Assess for visualization|Reassess visualization|Check for full visualization/);
});

test("empty startup state does not access map membership or uninitialized feature commands", () => {
  const commands = Object.fromEntries([
    "contains", "prepare", "show", "remove", "openStyle", "zoomToBounds",
    "onPrepared", "onRemoved", "onAdded", "onChange",
  ].map(name => [name, () => { throw new Error(`Startup must not call ${name}`); }]));
  const actions = new CatalogMapActions({ ...commands, getBounds: getCatalogItemMapBounds });
  assert.deepEqual(actions.state(null), {
    visualization: null, supported: false, retained: false, canZoom: false,
    pendingAction: null, feedback: null,
  });
});

test("row and details Style reuse the editor with composite identity and no map or selection changes", () => {
  const first = raster("same-id"), second = vector("same-id");
  const h = harness({ selectedItem: second, retained: [first, second] });
  assert.match(MARKUP, /id="style-catalog-layer"[\s\S]*?aria-controls="layer-style-editor"[\s\S]*?hidden[\s\S]*?>\s*Style\s*</);
  assert.equal(h.styleButton.hidden, false);
  assert.equal(h.styleButton.disabled, false);
  h.addRow(first).styleButton.dispatchEvent(new Event("click"));
  h.styleButton.dispatchEvent(new Event("click"));
  assert.deepEqual(h.calls, [["style", getCatalogItemKey(first)], ["style", getCatalogItemKey(second)]]);
  assert.equal(h.state.selectedItem, second);
  assert.equal(h.row.state.retained, true);
});

test("Zoom to targets the requested raster or vector bbox without selection or layer mutations", () => {
  const first = { ...raster("same-id"), bbox: [-123, 48, -122, 49] };
  const second = { ...vector("same-id"), bbox: [10, 20, 100, 11, 21, 200] };
  const h = harness({ selectedItem: second, retained: [first, second] });
  assert.match(MARKUP, /id="toggle-catalog-layer"[\s\S]*?id="zoom-catalog-layer"[\s\S]*?aria-controls="map"[\s\S]*?>\s*Zoom to\s*<[\s\S]*?id="style-catalog-layer"/);
  assert.equal(h.zoomButton.hidden, false);
  assert.equal(h.zoomButton.disabled, false);
  assert.equal(h.row.state.canZoom, true);
  h.addRow(first).zoomButton.dispatchEvent(new Event("click"));
  h.zoomButton.dispatchEvent(new Event("click"));
  assert.deepEqual(h.calls, [
    ["zoom", [[48, -123], [49, -122]], { padding: [24, 24], maxZoom: 9 }],
    ["zoom", [[20, 10], [21, 11]], { padding: [24, 24], maxZoom: 9 }],
  ]);
  assert.equal(h.state.selectedItem, second);
  assert.equal(h.row.state.retained, true);
});

test("Zoom to rejects missing bounds, pending actions, and removed or unretained Items", async () => {
  const item = raster("zoom-lifecycle"), completion = deferred();
  const h = harness({ selectedItem: item, retained: [item], prepare: () => completion.promise });
  assert.equal(h.zoomButton.disabled, true);
  assert.match(h.zoomButton.title, /no usable bounding box/);
  assert.equal(h.row.state.canZoom, false);
  h.zoom(item);
  h.zoom(null);
  item.bbox = [10, 20, 10, 20];
  h.refresh();
  assert.equal(h.zoomButton.disabled, false);
  h.removeExternally(item);
  const pending = h.run(item);
  h.retainExternally(item);
  h.calls.length = 0;
  assert.equal(h.zoomButton.disabled, true);
  h.zoom(item);
  h.zoom({ ...vector("not-retained"), bbox: item.bbox });
  assert.deepEqual(h.calls, []);
  completion.resolve(item);
  await pending;
  h.removeExternally(item);
  assert.equal(h.zoomButton.hidden, true);
  h.calls.length = 0;
  h.zoom(item);
  assert.deepEqual(h.calls, []);
});

test("Style is absent before adding and after removal, and stale or busy requests do nothing", async () => {
  const item = raster("style-lifecycle"), completion = deferred();
  const h = harness({ selectedItem: item, prepare: () => completion.promise });
  assert.equal(h.styleButton.hidden, true);
  h.style(item);
  h.style(null);
  assert.deepEqual(h.calls, []);
  const attempt = h.run();
  h.retainExternally(item);
  assert.equal(h.styleButton.disabled, true);
  h.style(item);
  assert.deepEqual(h.calls, [["prepare", item.id]]);
  completion.resolve(item);
  await attempt;
  assert.equal(h.styleButton.hidden, false);
  assert.equal(h.styleButton.disabled, false);
  h.removeExternally(item);
  assert.equal(h.styleButton.hidden, true);
  h.calls.length = 0;
  h.style(item);
  assert.deepEqual(h.calls, []);
});

test("pending row Add needs no selection, disables only its Item, and prevents duplicates", async () => {
  const item = raster("pending"), completion = deferred();
  const h = harness({ prepare: () => completion.promise });
  const row = h.addRow(item), other = h.addRow(vector("other"));
  const attempt = h.run(item);
  await h.run(item);
  assert.equal(row.state.pendingAction.buttonText, "Adding to map...");
  assert.equal(other.state.pendingAction, null);
  assert.deepEqual(h.calls, [["prepare", "pending"]]);
  completion.resolve(item);
  await attempt;
  assert.equal(row.state.pendingAction, null);
  assert.equal(row.state.retained, true);
  assert.equal(h.state.selectedItem, null);
  assert.equal(h.actionContainer.hidden, true);
  assert.deepEqual(h.calls.filter(([call]) => call === "open-rendering"), [["open-rendering"]]);
  assert.equal(h.calls.some(([call]) => call === "render-inspector"), false);
});

test("selected Item mirrors pending and success states", async () => {
  const item = raster("eligible"), completion = deferred();
  const h = harness({ selectedItem: item, prepare: () => completion.promise });
  const attempt = h.run();
  assert.equal(h.layerButton.disabled, true);
  assert.equal(h.layerButton.textContent, "Adding to map...");
  assert.equal(h.actionStatus.textContent, "Publishing this prepared raster.");
  completion.resolve(item);
  await attempt;
  assert.deepEqual(h.calls, [
    ["prepare", item.id], ["activate-analysis", item.id],
    ["render-inspector", item.id], ["show", item.id], ["open-rendering"],
  ]);
  assert.equal(h.layerButton.textContent, "Remove from map");
  assert.equal(h.layerButton.classList.contains("catalog-add-action"), false);
  assert.equal(h.onMap.hidden, false);
  assert.equal(h.row.state.retained, true);
  assert.equal(h.actionStatus.textContent, "Raster added to the map.");
  assert.equal(h.status.textContent, "This raster is on the map.");
  assert.equal(h.actionContainer.getAttribute("aria-busy"), "false");
  assert.equal(h.row.state.pendingAction, null);
});

test("inspector and row Add use the same panel-opening path", async () => {
  const h = harness({ selectedItem: raster("inspector") });
  h.layerButton.dispatchEvent(new Event("click"));
  await h.lastAction;
  assert.deepEqual(h.calls.filter(([call]) => call === "open-rendering"), [["open-rendering"]]);
  const row = h.addRow(raster("row"));
  row.mapButton.dispatchEvent(new Event("click"));
  await h.lastAction;
  assert.equal(row.state.retained, true);
  assert.equal(h.state.selectedItem.id, "inspector");
  assert.equal(h.calls.filter(([call]) => call === "open-rendering").length, 2);
});

test("row removal skips assessment and updates row and matching inspector", async () => {
  const item = raster("retained");
  const h = harness({ selectedItem: item, retained: [item] });
  await h.run();
  assert.equal(h.calls.some(([call]) => call === "prepare" || call === "show"), false);
  assert.equal(h.layerButton.textContent, "Add to map");
  assert.equal(h.layerButton.classList.contains("catalog-add-action"), true);
  assert.equal(h.onMap.hidden, true);
  assert.equal(h.row.state.retained, false);
  assert.equal(h.actionStatus.textContent, "Raster removed from the map.");
  assert.equal(h.calls.some(([call]) => call === "open-rendering"), false);
  assert.deepEqual(h.calls, [["remove", item.id, true], ["activate-analysis", item.id]]);
  assert.deepEqual(h.transitions, [["removed", item, "raster"]]);
});

test("removing an unselected raster or a vector preserves analysis selection and requests Undo", async () => {
  for (const item of [raster("unselected"), vector("vector")]) {
    const selected = raster("selected");
    const h = harness({ selectedItem: selected, retained: [item] });
    await h.run(item);
    assert.deepEqual(h.calls, [["remove", item.id, true]]);
    assert.equal(h.state.selectedItem, selected);
    assert.equal(h.transitions[0][0], "removed");
    assert.equal(h.actions.state(item).feedback.message,
      item.collection === "eolab-mounted-geotiffs" ? "Raster removed from the map." : "Vector layer removed from the map.");
  }
});

test("ineligible vector assessment keeps its contextual reason and never publishes", async () => {
  const reason = "Visualization unavailable: this vector cannot be opened.";
  const h = harness({
    selectedItem: vector("ineligible"),
    prepare: async () => vector("ineligible", false, reason),
  });
  await h.run();
  assert.equal(h.calls.some(([call]) => call === "show"), false);
  assert.equal(h.row.state.feedback.isError, true);
  assert.equal(
    h.row.state.feedback.message,
    "Visualization for ineligible.gpkg unavailable: this vector cannot be opened.",
  );
  assert.equal(h.actionStatus.textContent, h.row.state.feedback.message);
  assert.equal(h.layerButton.disabled, false);
  assert.equal(h.layerButton.textContent, "Add to map");
  assert.equal(h.row.state.pendingAction, null);
});

test("preparation and publication errors are local and retryable", async () => {
  for (const boundary of ["prepare", "show"]) {
    const h = harness({ [boundary]: async () => { throw new Error("Service unavailable"); } });
    const item = raster(boundary), row = h.addRow(item), other = h.addRow(vector("unrelated"));
    await h.run(item);
    assert.equal(row.state.feedback.message, "Service unavailable");
    assert.equal(row.state.feedback.isError, true);
    assert.equal(row.state.retained, false);
    assert.equal(row.state.pendingAction, null);
    assert.equal(other.state.feedback, null);
    assert.equal(h.actionStatus.textContent, "");
    assert.equal(h.calls.some(([call]) => call === "open-rendering"), false);
    await h.run(item);
    assert.equal(h.calls.filter(([call]) => call === boundary).length, 2);
  }
});

test("selection changes during preparation do not cancel Add or overwrite another inspector", async () => {
  const first = raster("first"), second = raster("second"), completion = deferred();
  const h = harness({ selectedItem: first, prepare: () => completion.promise });
  const attempt = h.run();
  h.state.selectedItem = second;
  h.refresh();
  completion.resolve(first);
  await attempt;
  assert.equal(h.row.state.retained, true);
  assert.equal(h.state.selectedItem, second);
  assert.equal(h.onMap.hidden, true);
  assert.equal(h.actionStatus.textContent, "");
  assert.equal(h.calls.some(([call]) => call === "render-inspector"), false);
});

test("a replaced selected vector receives its completed assessment before publication", async () => {
  const item = vector("refreshed-vector"), completion = deferred();
  const h = harness({ selectedItem: item, prepare: () => completion.promise });
  const attempt = h.run();
  const replacement = { ...vector(item.id), properties: { title: "New search title" } };
  h.state.selectedItem = replacement;
  const row = h.addRow(replacement);
  const assessed = vector(item.id);
  completion.resolve(assessed);
  await attempt;
  assert.equal(h.state.selectedItem, replacement);
  assert.equal(replacement.properties.title, "New search title");
  assert.deepEqual(replacement.properties["eolab:vector_rendering"], assessed.properties["eolab:vector_rendering"]);
  assert.equal(row.state.retained, true);
  assert.deepEqual(h.calls, [
    ["prepare", item.id], ["render-inspector", item.id], ["show", item.id], ["open-rendering"],
  ]);
  assert.equal(h.transitions[0][0], "prepared");
  assert.equal(h.transitions[0][2].kind, "vector");
  assert.equal(h.actions.applyAssessment({ ...replacement, properties: {} }), false);
});

test("concurrent raster and vector Adds use collection plus Item ID", async () => {
  const first = raster("same-id"), second = vector("same-id");
  const a = deferred(), b = deferred();
  const h = harness({ prepare: (item) => item.collection === first.collection ? a.promise : b.promise });
  const rowA = h.addRow(first), rowB = h.addRow(second);
  const addA = h.run(first), addB = h.run(second);
  b.resolve(second);
  await addB;
  assert.equal(rowB.state.retained, true);
  assert.notEqual(rowA.state.pendingAction, null);
  a.resolve(first);
  await addA;
  assert.equal(rowA.state.retained, true);
  assert.equal(rowB.state.pendingAction, null);
  assert.equal(rowB.state.feedback.message, "Vector layer added to the map.");
  assert.equal(h.calls.filter(([call]) => call === "open-rendering").length, 2);
});

test("a successful addition opens Map layers even after browsing to another item", async () => {
  const item = raster("first"), completion = deferred();
  const h = harness({ selectedItem: item, show: () => completion.promise });
  const attempt = h.run(item);
  await Promise.resolve();
  h.state.selectedItem = raster("second");
  completion.resolve({ layerName: "eolab:first" });
  await attempt;
  assert.equal(h.row.state.retained, true);
  assert.deepEqual(h.calls.filter(([call]) => call === "open-rendering"), [["open-rendering"]]);
});

test("replacement search rows inherit in-flight actions and completion by Item identity", async () => {
  const item = raster("refreshed"), completion = deferred();
  const h = harness({ prepare: () => completion.promise });
  h.addRow(item);
  const attempt = h.run(item);
  h.state.resultViews.clear();
  h.actions.clearTransientState();
  const replacement = h.addRow(raster("refreshed"));
  assert.notEqual(replacement.state.pendingAction, null);
  completion.resolve(item);
  await attempt;
  assert.equal(replacement.state.pendingAction, null);
  assert.equal(replacement.state.retained, true);
  assert.equal(replacement.state.feedback.message, "Raster added to the map.");
});

test("search reset clears completed feedback and assessments without cancelling pending additions", async () => {
  const completed = vector("completed"), pendingItem = raster("pending-reset"), completion = deferred();
  const h = harness({ prepare: item => item === pendingItem ? completion.promise : Promise.resolve(item) });
  const completedRow = h.addRow(completed);
  await h.run(completed);
  assert.equal(completedRow.state.feedback.message, "Vector layer added to the map.");
  const pendingRow = h.addRow(pendingItem);
  const attempt = h.run(pendingItem);
  assert.notEqual(pendingRow.state.pendingAction, null);
  h.actions.clearTransientState();
  h.state.resultViews.clear();
  assert.equal(h.actions.state(completed).feedback, null);
  assert.equal(h.actions.applyAssessment({ ...completed, properties: {} }), false);
  const replacement = h.addRow(raster(pendingItem.id));
  assert.notEqual(replacement.state.pendingAction, null);
  completion.resolve(pendingItem);
  await attempt;
  assert.equal(replacement.state.pendingAction, null);
  assert.equal(replacement.state.retained, true);
  assert.equal(replacement.state.feedback.message, "Raster added to the map.");
  assert.equal(h.calls.filter(([call]) => call === "prepare").length, 2);
});

test("external removal clears stale success and membership from both presentations", async () => {
  const item = raster("removed");
  const h = harness({ selectedItem: item });
  await h.run();
  h.removeExternally(item);
  assert.equal(h.row.state.retained, false);
  assert.equal(h.row.state.feedback, null);
  assert.equal(h.onMap.hidden, true);
  assert.equal(h.layerButton.textContent, "Add to map");
  assert.equal(h.actionStatus.textContent, "");
});

test("unsupported Items and canceled publication never claim to be on map", async () => {
  const h = harness({ show: async () => null });
  const unsupported = { collection: "remote", id: "metadata", assets: {}, properties: {} };
  const row = h.addRow(unsupported);
  await h.run(unsupported);
  assert.equal(row.state.supported, false);
  assert.equal(h.calls.length, 0);
  const canceled = h.addRow(raster("canceled"));
  await h.run(canceled.item);
  assert.equal(canceled.state.retained, false);
  assert.equal(canceled.state.feedback, null);
  assert.equal(canceled.state.pendingAction, null);
  assert.equal(h.calls.some(([call]) => call === "open-rendering"), false);
});
