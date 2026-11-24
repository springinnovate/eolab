import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { initializeCatalogPaneControls } from "../src/catalog-pane-controller.js";
import { CatalogFootprintController } from "../src/catalog.js";

class FakeClassList {
  constructor() {
    this.tokens = new Set();
  }

  toggle(token, force) {
    if (force) {
      this.tokens.add(token);
    } else {
      this.tokens.delete(token);
    }
  }

  contains(token) {
    return this.tokens.has(token);
  }
}

class FakeElement extends EventTarget {
  constructor(attributes = {}, ownerDocument = null) {
    super();
    this.attributes = new Map(Object.entries(attributes));
    this.classList = new FakeClassList();
    this.hidden = false;
    this.ownerDocument = ownerDocument;
    this.textContent = "";
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

function createCatalogPaneFixture() {
  const document = { activeElement: null, querySelector: null };
  const layout = new FakeElement({}, document);
  const resultsPane = new FakeElement({}, document);
  const resultsBody = new FakeElement({}, document);
  const resultsHeading = new FakeElement({}, document);
  const inspectorPane = new FakeElement(
    { "aria-hidden": "true" },
    document,
  );
  inspectorPane.hidden = true;
  const inspectorBody = new FakeElement({}, document);
  const inspectorHeading = new FakeElement({}, document);
  const closeItemDetails = new FakeElement({}, document);
  const elements = new Map([
    ["#catalog-layout", layout],
    ["#catalog-results-pane", resultsPane],
    ["#catalog-results-body", resultsBody],
    ["#catalog-results-heading", resultsHeading],
    ["#catalog-item-inspector", inspectorPane],
    ["#catalog-inspector-body", inspectorBody],
    ["#catalog-inspector-heading", inspectorHeading],
    ["#close-catalog-item-details", closeItemDetails],
  ]);
  document.querySelector = (selector) => elements.get(selector) ?? null;
  return {
    closeItemDetails,
    document,
    inspectorBody,
    inspectorHeading,
    inspectorPane,
    layout,
    resultsBody,
    resultsHeading,
    resultsPane,
  };
}

test("included-layer details open and close a dialog without revealing catalog results", () => {
  const fixture = createCatalogPaneFixture();
  const dialog = new EventTarget();
  dialog.open = false;
  dialog.append = element => { dialog.content = element; };
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  const controls = initializeCatalogPaneControls(fixture.document, () => {}, { detailsDialog: dialog });
  const opener = new FakeElement({}, fixture.document);
  opener.isConnected = true;
  controls.showInspector({ moveFocus: true, returnFocusTarget: opener });
  assert.equal(dialog.open, true);
  assert.equal(dialog.content, fixture.inspectorPane);
  assert.equal(fixture.document.activeElement, fixture.inspectorHeading);
  assert.equal(fixture.closeItemDetails.textContent, "×");
  assert.equal(fixture.closeItemDetails.title, "Close layer details");
  fixture.closeItemDetails.dispatchEvent(new Event("click"));
  assert.equal(dialog.open, false);
  assert.equal(fixture.document.activeElement, opener);
  controls.showInspector({ returnFocusTarget: opener });
  dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  assert.equal(dialog.open, false);
  assert.equal(fixture.inspectorPane.hidden, true);
});

test("Catalog keeps results visible and reveals selection progressively", () => {
  const fixture = createCatalogPaneFixture();
  let layoutChanges = 0;
  const controls = initializeCatalogPaneControls(
    fixture.document,
    () => layoutChanges += 1,
  );

  assert.equal(fixture.resultsBody.hidden, false);
  assert.equal(fixture.inspectorPane.hidden, true);
  assert.equal(fixture.inspectorBody.hidden, true);
  assert.equal(controls.isInspectorVisible(), false);
  assert.equal(layoutChanges, 0);

  controls.showInspector({ moveFocus: true });

  assert.equal(fixture.inspectorPane.hidden, false);
  assert.equal(fixture.inspectorPane.getAttribute("aria-hidden"), "false");
  assert.equal(fixture.inspectorBody.hidden, false);
  assert.equal(
    fixture.layout.classList.contains("is-catalog-inspector-visible"),
    true,
  );
  assert.equal(fixture.document.activeElement, fixture.inspectorHeading);
  assert.equal(controls.isInspectorVisible(), true);
  assert.equal(layoutChanges, 1);

  controls.showInspector();
  assert.equal(layoutChanges, 1);

  controls.showResults();
  assert.equal(fixture.resultsBody.hidden, false);
  assert.equal(layoutChanges, 2);
});

test("Catalog validates its feature-neutral layout-change boundary", () => {
  const fixture = createCatalogPaneFixture();
  assert.throws(
    () => initializeCatalogPaneControls(fixture.document, null),
    /layout-change notifier must be callable/,
  );
});

test("Closing details focuses Catalog results when no originating row exists", () => {
  const fixture = createCatalogPaneFixture();
  const controls = initializeCatalogPaneControls(fixture.document);
  controls.showInspector();

  fixture.closeItemDetails.dispatchEvent(new Event("click"));

  assert.equal(fixture.inspectorPane.hidden, true);
  assert.equal(fixture.inspectorPane.getAttribute("aria-hidden"), "true");
  assert.equal(
    fixture.layout.classList.contains("is-catalog-inspector-visible"),
    false,
  );
  assert.equal(fixture.document.activeElement, fixture.resultsHeading);
});

test("More details reveals metadata immediately with scroll reset", () => {
  const fixture = createCatalogPaneFixture();
  const controls = initializeCatalogPaneControls(fixture.document);
  controls.showInspector();
  fixture.inspectorBody.scrollTop = 250;

  controls.showInspector({ moveFocus: true });

  assert.equal(fixture.inspectorBody.scrollTop, 0);
  assert.equal(controls.isInspectorVisible(), true);
  assert.equal(fixture.document.activeElement, fixture.inspectorHeading);
});

test("Closing details restores its origin, with a stale-row fallback", () => {
  const fixture = createCatalogPaneFixture();
  const controls = initializeCatalogPaneControls(fixture.document);
  const detailsButton = new FakeElement({}, fixture.document);
  detailsButton.isConnected = true;
  controls.showInspector({ moveFocus: true, returnFocusTarget: detailsButton });
  fixture.closeItemDetails.dispatchEvent(new Event("click"));
  assert.equal(fixture.document.activeElement, detailsButton);

  controls.showInspector({ returnFocusTarget: detailsButton });
  detailsButton.isConnected = false;
  fixture.closeItemDetails.dispatchEvent(new Event("click"));
  assert.equal(fixture.document.activeElement, fixture.resultsHeading);
});

test("Escape closes only the progressive inspector and restores results focus", () => {
  const fixture = createCatalogPaneFixture();
  const controls = initializeCatalogPaneControls(fixture.document);
  controls.showInspector();
  const escapeEvent = new Event("keydown", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(escapeEvent, "key", { value: "Escape" });

  fixture.inspectorPane.dispatchEvent(escapeEvent);

  assert.equal(escapeEvent.defaultPrevented, true);
  assert.equal(fixture.inspectorPane.hidden, true);
  assert.equal(fixture.resultsBody.hidden, false);
  assert.equal(fixture.document.activeElement, fixture.resultsHeading);
});

test("Dismissing item details clears the solid outline without leaving a focus preview", () => {
  const fixture = createCatalogPaneFixture();
  const controls = initializeCatalogPaneControls(fixture.document);
  const visible = new Set();
  const map = { removeLayer: layer => visible.delete(layer) };
  const footprints = new CatalogFootprintController(map, (_item, state) => ({
    state,
    addTo() { visible.add(this); return this; },
    getBounds: () => ({ isValid: () => false }),
  }));
  const item = { collection: "catalog", id: "workshop" };
  const opener = new FakeElement({}, fixture.document);
  opener.isConnected = true;
  opener.focus = () => {
    fixture.document.activeElement = opener;
    footprints.preview(item);
  };
  const escape = new Event("keydown", { cancelable: true });
  Object.defineProperty(escape, "key", { value: "Escape" });

  const dismissals = [
    [fixture.closeItemDetails, new Event("click")],
    [fixture.inspectorPane, escape],
  ];
  for (const [target, event] of dismissals) {
    footprints.select(item);
    controls.showInspector({
      moveFocus: true, returnFocusTarget: opener,
      onDismiss: () => footprints.clearSelectedFootprint(),
    });
    assert.deepEqual([...visible].map(layer => layer.state), ["selected"]);

    target.dispatchEvent(event);

    assert.equal(fixture.document.activeElement, opener);
    assert.equal(visible.size, 0);
    footprints.preview(item);
    assert.deepEqual([...visible].map(layer => layer.state), ["preview"]);
  }
});

test("Catalog inspector shows requested metadata without a second disclosure", () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  assert.doesNotMatch(markup, /id="toggle-catalog-results"/);
  assert.doesNotMatch(markup, />Data discovery</);
  assert.doesNotMatch(markup, />Catalog results</);
  assert.doesNotMatch(markup, /Selected record|toggle-catalog-inspector/);
  assert.doesNotMatch(markup, /id="catalog-item-details"/);
  assert.ok(markup.indexOf('id="catalog-map-actions"') < markup.indexOf('id="catalog-inspector-content"'));
  assert.match(
    markup,
    /<button\s+class="secondary-button catalog-inspector-close"\s+id="close-catalog-item-details"[\s\S]*aria-label="Close item details"[\s\S]*title="Close item details"/,
  );
  assert.doesNotMatch(markup, /Back to results/);
  assert.match(markup, /id="catalog-item-inspector"[\s\S]*aria-hidden="true"[\s\S]*hidden/);
  assert.match(
    markup,
    /class="visually-hidden" id="catalog-results-heading" tabindex="-1"/,
  );
  assert.match(markup, /id="catalog-inspector-heading" tabindex="-1"/);
  assert.match(markup, /placeholder="Search filenames, hazards, or data types\.\.\."/);
  assert.match(markup, /<details class="catalog-actions">/);
  assert.ok(
    markup.indexOf('id="catalog-search"') <
      markup.indexOf('id="catalog-results-scroll"'),
  );
});

test("Catalog selection delegates progressive presentation without feature coupling", () => {
  const mainSource = readFileSync(
    new URL("../src/main.js", import.meta.url),
    "utf8",
  );
  const controllerSource = readFileSync(
    new URL("../src/catalog-pane-controller.js", import.meta.url),
    "utf8",
  );
  const clearSelection = mainSource.slice(
    mainSource.indexOf("function clearCatalogSelection"),
    mainSource.indexOf("function selectCatalogItem"),
  );
  const selectItem = mainSource.slice(
    mainSource.indexOf("function selectCatalogItem"),
    mainSource.indexOf("function appendCatalogPage"),
  );
  const appendPage = mainSource.slice(
    mainSource.indexOf("function appendCatalogPage"),
    mainSource.indexOf("async function prefetchNextCatalogPage"),
  );

  assert.match(clearSelection, /catalogPaneControls\.showResults\(\)/);
  assert.match(
    selectItem,
    /catalogPaneControls\.showInspector\(\{\s*moveFocus: true, returnFocusTarget: returnFocusTarget \?\? itemButton,/,
  );
  assert.match(
    mainSource,
    /initializeCatalogPaneControls\(\s*document,\s*\(\) => layoutController\?\.notifyLayoutChange\(\)/s,
  );
  assert.doesNotMatch(
    controllerSource,
    /Leaflet|leaflet|raster|renderer|statistics|fetch\(/,
  );
  assert.doesNotMatch(appendPage, /leafletMap\.|L\.geoJSON/);
  assert.match(appendPage, /onZoom: item => catalogMapActions\.zoom\(item\)/);
});

for (const catalogAvailable of [true, false]) {
  test(`retained-layer details and actions share the displayed item (Catalog=${catalogAvailable})`, () => {
    const fixture = createCatalogPaneFixture();
    const dialog = new EventTarget();
    dialog.open = false;
    dialog.append = () => {};
    dialog.showModal = () => { dialog.open = true; };
    dialog.close = () => { dialog.open = false; };
    const pane = initializeCatalogPaneControls(fixture.document, () => {}, {detailsDialog: dialog});
    const opener = new FakeElement({}, fixture.document);
    opener.isConnected = true;
    const canopy = {collection: "rasters", id: "canopy"};
    const parcels = {collection: "vectors", id: "parcels"};
    const retained = new Set([canopy, parcels]);
    const actions = [];
    const state = {collectionsDocument: catalogAvailable ? {collections: []} : null,
      resultViews: new Map(), selectedItem: null, selectedButton: null};
    const zoom = new EventTarget(), style = new EventTarget(), toggle = new EventTarget();
    let displayedItem, actionItem;
    const dependencies = {
      document: fixture.document, isSharedViewer: true, catalogState: state,
      appGlobalConfiguration: {scanDisplayPathPrefix: ""}, catalogPaneControls: pane,
      catalogMapActionStatus: {textContent: ""},
      catalogLayerZoom: zoom, catalogLayerStyle: style, catalogLayerToggle: toggle,
      catalogMapActions: {
        applyAssessment() {},
        zoom: item => actions.push(["zoom", item]),
        style: item => actions.push(["style", item]),
        toggle: item => { actions.push(["remove", item]); retained.delete(item); },
      },
      getCatalogItemKey: item => JSON.stringify([item.collection, item.id]),
      getCatalogVisualization: () => null,
      renderCatalogItemInspector: item => { displayedItem = item; },
      updateCatalogMapAction: item => { actionItem = item; },
      footprintController: {select() {}, clearSelectedFootprint() {}},
      rasterVisualization: {deactivateAnalysis() {}, activateAnalysis() {}},
      onCatalogWorkspaceRequested: () => assert.fail("Layer details must not open Catalog"),
    };
    const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
    const selectionStart = source.indexOf("    function selectCatalogItem(");
    const selectionEnd = source.indexOf("\n    /**", selectionStart);
    const retainedStart = source.indexOf("    function inspectRetainedMapLayer(");
    const retainedEnd = source.indexOf("    if (!isSharedViewer || visitorAvailability.catalog) await loadCatalog", retainedStart);
    const {select, inspect} = new Function(...Object.keys(dependencies),
      `${source.slice(selectionStart, selectionEnd)}\n${source.slice(retainedStart, retainedEnd)}\n` +
      "return {select: selectCatalogItem, inspect: inspectRetainedMapLayer};"
    )(...Object.values(dependencies));
    if (catalogAvailable) {
      select(canopy);
      pane.showResults();
    }
    opener.focus();
    inspect(parcels);
    assert.equal(displayedItem, parcels);
    for (const button of [zoom, style, toggle]) button.dispatchEvent(new Event("click"));
    assert.deepEqual(actions, [["zoom", parcels], ["style", parcels], ["remove", parcels]]);
    assert.deepEqual([...retained], [canopy]);
    assert.equal(actionItem, parcels);
    fixture.closeItemDetails.dispatchEvent(new Event("click"));
    assert.equal(fixture.document.activeElement, opener);
  });
}
