import assert from "node:assert/strict";
import test from "node:test";

import { getCatalogItemKey } from "../../src/catalog-item-identity.js";
import { SavedMapViewController } from "../../src/saved-map-view/controller.js";
import {
  decodeSavedMapViewFragment,
  encodeSavedMapViewFragment,
} from "../../src/saved-map-view/fragment-codec.js";
import { createSavedMapView, serializeSavedMapView } from "../../src/saved-map-view/model.js";

const ZERO_REVISION = `sha256:${"0".repeat(64)}`;

test("published drafts ignore personal autosave and only write on explicit save", async () => {
  const view = createView(), storage = createStorage("private"), submissions = [], headings = [];
  view.showPublishedMapEditor = (saved, complete) => { view.editor = { saved, complete }; };
  view.showPublishedMapEditStatus = message => { view.editStatus = message; };
  view.setPublishedMapSaving = saving => { view.saving = saving; };
  let position = emptySavedMap(10, 20, 6).viewport;
  const loaded = { slug: "amazon", title: "Original", subtitle: "", revision: 1, view: emptySavedMap(10, 20, 6) };
  const controller = new SavedMapViewController({ view, storage, editPublishedMap: true, namedMapSlug: "amazon",
    viewerVersion: "0.6.0", viewerOrigin: loaded.view.viewer.origin,
    publicationApi: {
      async getForEditing(slug) { assert.equal(slug, "amazon"); return loaded; },
      async update(slug, request) {
        submissions.push({ slug, request });
        if (submissions.length === 1) throw new Error("Storage unavailable");
        return { ...request, slug, revision: request.revision + 1 };
      },
    },
    applyMapHeading: (...values) => headings.push(values),
    viewport: { snapshot: () => position, restore(value) { position = value; } },
    catalogVisualization: { clear() {} }, mapLayers: { retainedRecords: [], commitStaged() {} },
  });
  await controller.restoreStartupView("#view=ignored");
  assert.equal(view.editor.complete, true);
  position = emptySavedMap(30, 40, 8).viewport;
  controller.scheduleRemember();
  assert.equal(storage.reads, 0);
  assert.deepEqual(storage.writes, []);
  assert.equal(submissions.length, 0);
  await controller.savePublishedMapChanges({ title: "Changed", subtitle: "Edited" });
  assert.match(view.editStatus, /Storage unavailable/);
  assert.equal(view.saving, false);
  await controller.savePublishedMapChanges({ title: "Changed", subtitle: "Edited" });
  assert.equal(submissions[1].request.revision, 1);
  assert.deepEqual(submissions[1].request.view.viewport, position);
  await controller.savePublishedMapChanges({ title: "Changed again", subtitle: "" });
  assert.equal(submissions[2].request.revision, 2);
  assert.deepEqual(headings.at(-1), ["Changed again", ""]);
  assert.match(view.editStatus, /Saved/);
  controller.destroy();
  assert.deepEqual(storage.writes, []);
});

for (const keepAvailableLayer of [true, false]) test(`published map saves current layers after restoration failures (available layer: ${keepAvailableLayer})`, async () => {
  const view = createView(), submissions = [], records = [];
  view.showPublishedMapEditor = (saved, complete) => { view.complete = complete; };
  view.showPublishedMapEditStatus = message => { view.editStatus = message; };
  view.setPublishedMapSaving = () => {};
  const available = { catalogItem: { collection: "c", id: "available" }, sourceRevision: null,
    visible: false, opacity: 0.5, style: { kind: "vector", definition: {} } };
  const saved = { ...emptySavedMap(10, 20, 6), layers: [
    ...(keepAvailableLayer ? [available] : []), { ...available, catalogItem: { collection: "c", id: "gone" } },
  ] };
  const controller = new SavedMapViewController({ view, editPublishedMap: true, namedMapSlug: "amazon",
    viewerVersion: "0.6.0", viewerOrigin: saved.viewer.origin,
    publicationApi: { getForEditing: async () => ({ title: "Map", subtitle: "", revision: 1, view: saved }),
      async update(slug, request) { submissions.push({ slug, request }); return { ...request, slug, revision: 2 }; } },
    viewport: { restore() {}, snapshot: () => saved.viewport },
    mapLayers: { retainedRecords: records, commitStaged(staged) { records.push(...staged.map(layer => layer.record)); } },
    catalogVisualization: { clear() {}, prepare: async item => item, sourceRevision: () => null,
      async stage(item, presentation) { return { record: { entry: { item, ...presentation },
        adapter: { applySavedState() {}, exportSavedState: () => available.style } } }; } },
    catalogItems: { async get(item) { if (item.id === "gone") throw new Error("unavailable"); return item; } },
  });
  await controller.openNamedMap();
  assert.equal(view.complete, false);
  assert.equal(submissions.length, 0, "partial restoration must not save automatically");
  await controller.savePublishedMapChanges({ title: "Map", subtitle: "" });
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].slug, "amazon");
  assert.equal(submissions[0].request.revision, 1);
  assert.deepEqual(submissions[0].request.view.layers, keepAvailableLayer ? [available] : []);
  assert.match(view.editStatus, /Saved/);
});

test("publication captures once and preserves that view while correcting a duplicate name", async () => {
  const view = createView(), submissions = [];
  let current = emptySavedMap(10, 20, 6).viewport;
  Object.assign(view, {
    showPublicationForm(defaults) { this.defaults = defaults; },
    setPublicationBusy(value) { this.publishing = value; },
    showPublicationError(message) { this.publicationError = message; },
    showPublishedMap(slug) { this.published = slug; },
  });
  const controller = new SavedMapViewController({ view, allowPublishing: true,
    viewport: { snapshot: () => current }, mapLayers: { retainedRecords: [] },
    viewerVersion: "0.6.0", viewerOrigin: "https://viewer.example",
    publicationDefaults: { title: "Site", subtitle: "Explore" },
    basemap: { snapshot: () => "none" },
    publicationApi: { async create(candidate) {
      submissions.push(candidate);
      if (submissions.length === 1) throw new Error("Name already in use");
      return candidate;
    } },
  });
  await controller.openPublicationDialog();
  current = emptySavedMap(0, 0, 2).viewport;
  await controller.publishMap({ title: "New title", subtitle: "", slug: "taken" });
  assert.match(view.publicationError, /already in use/);
  await controller.publishMap({ title: "New title", subtitle: "", slug: "new-name" });
  assert.equal(view.published, "new-name");
  assert.equal(view.publishing, false);
  assert.equal(submissions[0].view, submissions[1].view);
  assert.deepEqual(submissions[1].view.viewport, emptySavedMap(10, 20, 6).viewport);
  assert.equal(submissions[1].view.basemap, "none");
  assert.equal(submissions[1].subtitle, "");
});

test("named URLs override fragments and private state, restore basemap and copy the original link", async () => {
  const view = createView(), storage = createStorage("private"), loaded = [], headings = [], basemaps = [];
  let position;
  view.copyNamedMapLink = async slug => { view.namedCopy = slug; return { copied: true }; };
  const saved = { ...emptySavedMap(10, 20, 6), basemap: "none" };
  const controller = new SavedMapViewController({ view, storage, restoreSharedMap: true, namedMapSlug: "amazon",
    publicationApi: { async get(slug) { loaded.push(slug); return { title: "Amazon", subtitle: "", view: saved }; } },
    applyMapHeading: (...values) => headings.push(values),
    viewport: { snapshot: () => position, restore(value) { position = value; } },
    basemap: { restore: async id => { basemaps.push(id); return null; } },
    catalogVisualization: { clear() {} }, mapLayers: { retainedRecords: [], commitStaged() {} },
  });
  await controller.restoreStartupView("#view=invalid-fragment");
  position = emptySavedMap(0, 0, 2).viewport;
  await controller.copyMapLink();
  assert.equal(view.namedCopy, "amazon");
  await controller.resetView();
  assert.deepEqual(position, saved.viewport);
  assert.deepEqual(loaded, ["amazon", "amazon"]);
  assert.deepEqual(headings, [["Amazon", ""], ["Amazon", ""]]);
  assert.deepEqual(basemaps, ["none", "none"]);
  assert.equal(storage.reads, 0);
  assert.equal(storage.writes.length, 0);
});

test("missing named maps never fall back to fragments or private maps", async () => {
  const view = createView(), storage = createStorage("private");
  const controller = new SavedMapViewController({ view, storage, restoreSharedMap: true, namedMapSlug: "missing",
    publicationApi: { async get() { throw new Error("Saved map not found."); } },
  });
  await controller.restoreStartupView("#view=other-map");
  assert.match(view.error.message, /not found/);
  assert.equal(storage.reads, 0);
  assert.equal(view.errorOperation, "open");
});

test("mixed shared maps export invitations, preserve layer order and restore presentation only", async () => {
  const annotation = { sharedAnnotation: { id: "11111111-1111-4111-8111-111111111111", joinCode: "ABCDEFGH" },
    visible: true, legendIncluded: false, opacity: 0.7, appearance: { outline: "#202020", weight: 1, fillOpacity: 0.25, labels: true, notes: false } };
  const catalog = { catalogItem: { collection: "vectors", id: "included" }, sourceRevision: null,
    visible: true, legendIncluded: false, opacity: 1, style: { kind: "vector", definition: {} } };
  const saved = { ...emptySavedMap(10, 20, 6), mapLegend: { visible: false, collapsed: true }, layers: [catalog, annotation] };
  const fragment = await encodeSavedMapViewFragment(serializeSavedMapView(saved), { maximumInputBytes: 512 * 1024 });
  const view = createView(), records = [], restorations = [], ordered = [];
  const annotationRecord = { entry: { key: "local:annotation:mine", item: null }, polygons: ["private polygon"] };
  let legendPreferences;
  const controller = new SavedMapViewController({ view, restoreSharedMap: true,
    viewerVersion: "0.6.0", viewerOrigin: saved.viewer.origin,
    viewport: { snapshot: () => saved.viewport, restore() {} },
    mapLayers: { retainedRecords: records,
      setLegendIncluded(key, value) { records.find(record => record.entry.key === key).entry.legendIncluded = value; },
      commitStaged(staged) { records.unshift(...staged.map(s => s.record)); }, restoreOrder(keys) { ordered.push(keys); } },
    mapLegend: { snapshot: () => legendPreferences, restore(value) { legendPreferences = value; } },
    catalogItems: { get: async identity => identity },
    catalogVisualization: { clear() { records.splice(0, records.length, ...records.filter(r => r.entry.item === null)); },
      prepare: async item => item, sourceRevision: () => null,
      stage: async item => ({ record: { entry: { key: "catalog", item, visible: true, opacity: 1 }, adapter: {
        applySavedState() {}, exportSavedState: () => catalog.style,
      } } }) },
    exportAnnotation: record => record === annotationRecord ? annotation : null,
    restoreAnnotation: async (layer, isCurrent) => {
      assert.equal(isCurrent(), true); restorations.push(layer);
      if (!records.includes(annotationRecord)) records.push(annotationRecord);
      return annotationRecord.entry.key;
    },
  });
  await controller.restoreStartupView(fragment);
  assert.equal(view.result.loaded, 2);
  assert.deepEqual(legendPreferences, saved.mapLegend);
  assert.ok(records.every(record => record.entry.legendIncluded === false));
  assert.deepEqual(ordered.at(-1), ["catalog", "local:annotation:mine"]);
  records.push({ entry: { key: "local:private", item: null }, polygons: ["do not share"] });
  await controller.copyMapLink();
  const exported = JSON.parse(await decodeSavedMapViewFragment(view.fragment, { maximumOutputBytes: 512 * 1024 }));
  assert.deepEqual(exported.layers, saved.layers);
  assert.deepEqual(exported.mapLegend, saved.mapLegend);
  assert.equal(JSON.stringify(exported).includes("private polygon"), false);
  await controller.resetView();
  assert.deepEqual(restorations, [annotation, annotation]);
  assert.deepEqual(annotationRecord.polygons, ["private polygon"]);
  const foreign = { ...saved, viewer: { ...saved.viewer, origin: "https://another-site.example" } };
  await controller.openSharedFragment(await encodeSavedMapViewFragment(serializeSavedMapView(foreign), { maximumInputBytes: 512 * 1024 }));
  assert.match(view.result.details[0], /original EOLab site/);
  assert.equal(restorations.length, 2, "foreign invitations never reach the annotation API");
});

test("shared viewer restores its starting presentation and never reads or writes author autosave", async () => {
  const view = createView(), storage = createStorage("private map"), applied = [];
  const saved = emptySavedMap(10, 20, 6);
  const layer = { catalogItem: { collection: "vectors", id: "included" }, sourceRevision: null,
    visible: true, opacity: 0.6, style: { kind: "vector", definition: { color: "red" } },
    filter: { enabled: true, match: "all", rules: [] } };
  const fragment = await encodeSavedMapViewFragment(serializeSavedMapView({ ...saved, layers: [layer] }), { maximumInputBytes: 512 * 1024 });
  let position;
  const records = [];
  const controller = new SavedMapViewController({ view, storage, restoreSharedMap: true,
    viewport: { snapshot: () => position, restore: value => { position = value; } },
    mapLayers: { retainedRecords: records, commitStaged: staged => records.push(...staged.map(item => item.record)) },
    catalogItems: { get: async identity => identity },
    catalogVisualization: {
      clear() { records.length = 0; }, prepare: async item => item, sourceRevision: () => null,
      stage: async (item, presentation) => ({ record: { entry: { item, ...presentation }, adapter: {
        applySavedState: (_record, style) => applied.push(style),
        applyFilterState: (_record, filter) => applied.push(filter),
      } } }),
    }, viewerVersion: "0.6.0", viewerOrigin: "https://viewer.example",
  });
  await controller.restoreStartupView(fragment);
  assert.equal(records.length, 1);
  records[0].entry.visible = false;
  position = emptySavedMap(0, 0, 2).viewport;
  controller.scheduleRemember();
  await controller.resetView();
  assert.deepEqual(position, saved.viewport);
  assert.equal(records[0].entry.visible, true);
  assert.equal(records[0].entry.opacity, 0.6);
  assert.deepEqual(applied, [layer.style, layer.filter, layer.style, layer.filter]);
  assert.equal(view.undoVisible, false);
  assert.deepEqual([storage.reads, storage.writes.length, storage.clears], [0, 0, 0]);
  assert.equal(storage.serialized, "private map");
});

test("missing and invalid shared links report errors without falling back to private maps", async () => {
  for (const fragment of ["", "#view=bad"]) {
    const view = createView(), storage = createStorage("private map");
    const controller = new SavedMapViewController({ view, storage, restoreSharedMap: true });
    await controller.restoreStartupView(fragment);
    assert.equal(view.errorOperation, "open");
    await controller.resetView();
    assert.equal(view.errorOperation, "open");
    assert.equal(storage.reads, 0);
    assert.equal(storage.clears, 0);
  }
});

test("saved filters restore before commit and invalid filters never expose an unfiltered layer", async () => {
  for (const valid of [true, false]) {
    const state = { enabled: false, match: "all", rules: [{ field: "year", operator: "gt", value: 2020 }] };
    const view = createView(), calls = [];
    const saved = createSavedMapView({
      viewer: { version: "0.5.0", origin: "https://viewer.example" }, createdAt: "2026-09-01T12:00:00Z",
      viewport: { center: { latitude: 0, longitude: 0 }, zoom: 4 },
      layers: [{ catalogItem: { collection: "vectors", id: "quakes" }, sourceRevision: null,
        visible: true, opacity: 1, style: { kind: "vector", definition: {} }, filter: state }],
    });
    const layers = { retainedRecords: [], commitStaged(staged) { calls.push("commit"); this.retainedRecords = staged; } };
    const controller = new SavedMapViewController({ view,
      viewport: { snapshot: () => saved.viewport, restore() {} }, mapLayers: layers,
      catalogItems: { get: async (identity) => identity },
      catalogVisualization: { clear() {}, prepare: async (item) => item, sourceRevision: () => null,
        stage: async (item) => ({ record: { entry: { item, label: "Quakes" }, adapter: {
          applySavedState() { calls.push("style"); },
          applyFilterState(_record, restored) {
            calls.push("filter"); assert.deepEqual(restored, state);
            if (!valid) throw new Error("Filter field is no longer present");
          },
        } } }),
      }, viewerVersion: "0.5.0", viewerOrigin: "https://viewer.example",
    });
    await controller.openSharedFragment(await encodeSavedMapViewFragment(serializeSavedMapView(saved), { maximumInputBytes: 512 * 1024 }));
    assert.deepEqual(calls, ["style", "filter", "commit"]);
    assert.equal(layers.retainedRecords.length, valid ? 1 : 0);
    if (!valid) assert.match(view.result.details[0], /Filter field is no longer present/);
  }
});

/**
 * Create an inspectable view boundary for controller tests.
 *
 * @return {Object} Mutable saved-map presentation test double.
 */
function createView() {
  return {
    busy: [],
    result: null,
    loading: null,
    error: null,
    undoVisible: false,
    bind(handlers) { this.handlers = handlers; },
    unbind() { this.handlers = null; },
    setBusy(value) { this.busy.push(value); },
    async copyLink(fragment) {
      this.fragment = fragment;
      return { copied: true, url: `https://viewer.example/${fragment}` };
    },
    showCopied() { this.copied = true; },
    showCopyFallback(url) { this.copyFallback = url; },
    showResults(result) { this.result = result; },
    showLoading(layerCount) { this.loading = layerCount; },
    showError(error, operation) {
      this.error = error;
      this.errorOperation = operation;
    },
    showUndoReset() { this.undoVisible = true; },
    hideUndoReset() { this.undoVisible = false; },
  };
}

/**
 * Create an inspectable opaque storage adapter for controller tests.
 *
 * @param {string|null} [serialized] Initially remembered content.
 * @return {Object} Mutable storage boundary test double.
 */
function createStorage(serialized = null) {
  return {
    serialized,
    reads: 0,
    writes: [],
    clears: 0,
    read() {
      this.reads += 1;
      return this.serialized;
    },
    write(value) {
      this.serialized = value;
      this.writes.push(value);
      return true;
    },
    clear() {
      this.serialized = null;
      this.clears += 1;
      return true;
    },
  };
}

/**
 * Create deterministic debounce timer boundaries.
 *
 * @return {Object} Timer functions and inspectable scheduled handlers.
 */
function createTimers() {
  let nextIdentifier = 1;
  const scheduled = new Map();
  return {
    scheduled,
    setTimer(handler, delay) {
      const identifier = nextIdentifier;
      nextIdentifier += 1;
      scheduled.set(identifier, { handler, delay });
      return identifier;
    },
    clearTimer(identifier) { scheduled.delete(identifier); },
    runOnly() {
      assert.equal(scheduled.size, 1);
      const [[identifier, { handler }]] = scheduled;
      scheduled.delete(identifier);
      handler();
    },
  };
}

/**
 * Build one empty validated saved-map document with a chosen viewport.
 *
 * @param {number} latitude Canonical center latitude.
 * @param {number} longitude Canonical center longitude.
 * @param {number} zoom Leaflet zoom level.
 * @return {Readonly<Object>} Validated saved-map document.
 */
function emptySavedMap(latitude, longitude, zoom) {
  return createSavedMapView({
    viewer: { version: "0.2.0", origin: "https://viewer.example" },
    createdAt: "2026-09-01T12:00:00Z",
    viewport: { center: { latitude, longitude }, zoom },
    layers: [],
  });
}

/** Allow detached async persistence to finish after a timer handler. */
async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Return a digest implementation with a stable non-secret fingerprint.
 *
 * @return {{digest:()=>Promise<ArrayBuffer>}} Test SubtleCrypto subset.
 */
function zeroDigest() {
  return { digest: async () => new Uint8Array(32).buffer };
}

test("saved map controller copies ordered Catalog layers and current viewport", async () => {
  const view = createView();
  const item = { collection: "vectors", id: "roads" };
  const record = {
    entry: { item, visible: true, opacity: 0.4, label: "Workshop roads", customName: "Workshop roads" },
    adapter: {
      exportSavedState: () => ({ kind: "vector", definition: { width: 2 } }),
      exportFilterState: () => ({ enabled: false, match: "all", rules: [{ field: "year", operator: "gt", value: 2020 }] }),
    },
  };
  const controller = new SavedMapViewController({
    view,
    viewport: { snapshot: () => ({
      center: { latitude: 10, longitude: 20 }, zoom: 4,
    }) },
    mapLayers: { retainedRecords: [record] },
    catalogVisualization: { sourceRevision: () => [1, 2, 3] },
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    clock: () => new Date("2026-09-01T12:00:00Z"),
    subtleCrypto: zeroDigest(),
  });

  await controller.copyMapLink();

  const copied = JSON.parse(await decodeSavedMapViewFragment(view.fragment, {
    maximumOutputBytes: 512 * 1024,
  }));
  assert.deepEqual(copied.layers[0].catalogItem, item);
  assert.equal(copied.layers[0].customName, "Workshop roads");
  assert.equal(copied.layers[0].sourceRevision, ZERO_REVISION);
  assert.deepEqual(copied.layers[0].filter, record.adapter.exportFilterState());
  assert.equal(Object.hasOwn(copied.layers[0].style, "filter"), false);
  assert.equal(view.copied, true);
  assert.deepEqual(view.busy, [true, false]);
});

test("saved map controller stages concurrently and commits final saved order", async () => {
  const view = createView();
  const viewportCalls = [];
  const calls = [];
  const mapLayers = {
    retainedRecords: [{ entry: { item: { collection: "old", id: "layer" } } }],
    commitStaged(staged, options) {
      calls.push([
        "commit",
        staged.map(({ record }) => record.entry.item.id),
        options,
      ]);
      this.retainedRecords = staged.map(({ record }) => record);
    },
  };
  const catalogVisualization = {
    clear() {
      calls.push(["clear"]);
      mapLayers.retainedRecords = [];
    },
    prepare: async (item) => ({ ...item, prepared: true }),
    sourceRevision: () => ["current"],
    async stage(item, presentation) {
      calls.push(["stage", item.id, presentation]);
      const record = {
        entry: { item, ...presentation, label: item.id.toUpperCase() },
        adapter: {
          async applySavedState(_record, style) {
            calls.push(["style", item.id, style.kind]);
          },
        },
      };
      return { key: getCatalogItemKey(item), record, layer: {} };
    },
  };
  const saved = createSavedMapView({
    viewer: { version: "0.1.0", origin: "https://other.example" },
    createdAt: "2026-09-01T12:00:00Z",
    viewport: { center: { latitude: 3, longitude: 4 }, zoom: 5 },
    layers: [
      {
        catalogItem: { collection: "vectors", id: "top" },
        customName: "Protected areas",
        sourceRevision: `sha256:${"1".repeat(64)}`,
        visible: true,
        opacity: 0.5,
        style: { kind: "vector", definition: { width: 2 } },
      },
      {
        catalogItem: { collection: "rasters", id: "bottom" },
        sourceRevision: ZERO_REVISION,
        visible: false,
        opacity: 0.8,
        style: {
          kind: "raster",
          definition: { minimum: 0 },
          paletteName: "custom",
        },
      },
    ],
  });
  const controller = new SavedMapViewController({
    view,
    viewport: {
      snapshot: () => saved.viewport,
      restore: (value) => {
        viewportCalls.push(value);
        calls.push(["viewport"]);
      },
    },
    mapLayers,
    catalogVisualization,
    catalogItems: { get: async (identity) => ({ ...identity }) },
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    subtleCrypto: zeroDigest(),
  });

  await controller.openSharedFragment(await encodeSavedMapViewFragment(
    serializeSavedMapView(saved),
    { maximumInputBytes: 512 * 1024 },
  ));

  assert.deepEqual(calls.filter(([kind]) => kind === "stage"), [
    ["stage", "top", { visible: true, opacity: 0.5, customName: "Protected areas" }],
    ["stage", "bottom", { visible: false, opacity: 0.8 }],
  ]);
  assert.deepEqual(calls.filter(([kind]) => kind === "commit"), [
    ["commit", ["top", "bottom"], { fitToBounds: false }],
  ]);
  assert.ok(
    calls.findIndex(([kind]) => kind === "viewport") <
    calls.findIndex(([kind]) => kind === "commit")
  );
  assert.equal(view.result.loaded, 2);
  assert.equal(view.loading, 2);
  assert.equal(view.result.details.length, 1);
  assert.match(view.result.details[0], /TOP: source changed/);
  assert.deepEqual(viewportCalls, [saved.viewport]);
});

test("saved map restoration bounds work and isolates layer failures", async () => {
  const view = createView();
  const activeCounts = [];
  let active = 0;
  let commitWhileActive = null;
  let committed = null;
  const layers = Array.from({ length: 9 }, (_, index) => ({
    catalogItem: { collection: "vectors", id: `layer-${index}` },
    sourceRevision: null,
    visible: index % 2 === 0,
    opacity: 0.5,
    style: { kind: "vector", definition: {} },
  }));
  const saved = createSavedMapView({
    viewer: { version: "0.2.0", origin: "https://viewer.example" },
    createdAt: "2026-09-01T12:00:00Z",
    viewport: { center: { latitude: 0, longitude: 0 }, zoom: 3 },
    layers,
  });
  const mapLayers = {
    retainedRecords: [],
    commitStaged(staged) {
      commitWhileActive = active;
      committed = staged;
    },
  };
  const catalogVisualization = {
    clear() {},
    prepare: async (item) => item,
    sourceRevision: () => null,
    async stage(item, presentation) {
      active += 1;
      activeCounts.push(active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (item.id === "layer-4") {
        throw new Error("publication failed");
      }
      const record = {
        entry: { item, ...presentation, label: item.id.toUpperCase() },
        adapter: {
          async applySavedState() {
            if (item.id === "layer-6") {
              throw new Error("style changed");
            }
          },
        },
      };
      return { key: getCatalogItemKey(item), record, layer: {} };
    },
  };
  const controller = new SavedMapViewController({
    view,
    viewport: { restore() {} },
    mapLayers,
    catalogVisualization,
    catalogItems: { get: async (identity) => ({ ...identity }) },
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    subtleCrypto: zeroDigest(),
  });

  await controller.openSharedFragment(await encodeSavedMapViewFragment(
    serializeSavedMapView(saved),
    { maximumInputBytes: 512 * 1024 },
  ));

  assert.equal(Math.max(...activeCounts), 4);
  assert.equal(commitWhileActive, 0);
  assert.deepEqual(
    committed.map(({ record }) => record.entry.item.id),
    layers.map(({ catalogItem }) => catalogItem.id)
      .filter((id) => id !== "layer-4"),
  );
  assert.equal(view.result.loaded, 8);
  assert.equal(view.result.total, 9);
  assert.equal(view.result.details.length, 2);
  assert.match(view.result.details[0], /publication failed/);
  assert.match(view.result.details[1], /saved style was not applied: style changed/);
});

test("destroyed saved map restoration never commits its detached batch", async () => {
  const view = createView();
  let releaseStage;
  let reportStageStarted;
  const stageStarted = new Promise((resolve) => {
    reportStageStarted = resolve;
  });
  const stageReleased = new Promise((resolve) => {
    releaseStage = resolve;
  });
  let committed = false;
  const layer = {
    catalogItem: { collection: "vectors", id: "roads" },
    sourceRevision: null,
    visible: true,
    opacity: 1,
    style: { kind: "vector", definition: {} },
  };
  const saved = createSavedMapView({
    viewer: { version: "0.2.0", origin: "https://viewer.example" },
    createdAt: "2026-09-01T12:00:00Z",
    viewport: { center: { latitude: 0, longitude: 0 }, zoom: 3 },
    layers: [layer],
  });
  const controller = new SavedMapViewController({
    view,
    viewport: { restore: () => assert.fail("stale viewport restored") },
    mapLayers: {
      retainedRecords: [],
      commitStaged() { committed = true; },
    },
    catalogVisualization: {
      clear() {},
      prepare: async (item) => item,
      sourceRevision: () => null,
      async stage(item, presentation) {
        reportStageStarted();
        await stageReleased;
        return {
          key: getCatalogItemKey(item),
          record: {
            entry: { item, ...presentation, label: "Roads" },
            adapter: { applySavedState() {} },
          },
          layer: {},
        };
      },
    },
    catalogItems: { get: async (identity) => ({ ...identity }) },
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    subtleCrypto: zeroDigest(),
  });
  const opening = controller.openSharedFragment(
    await encodeSavedMapViewFragment(serializeSavedMapView(saved), {
      maximumInputBytes: 512 * 1024,
    })
  );

  await stageStarted;
  controller.destroy();
  releaseStage();
  await opening;

  assert.equal(committed, false);
  assert.equal(view.result, null);
});

test("saved map controller ignores fragments owned by other components", async () => {
  const view = createView();
  const controller = new SavedMapViewController({
    view,
    viewport: {},
    mapLayers: { retainedRecords: [] },
    catalogVisualization: {},
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    subtleCrypto: zeroDigest(),
  });

  await controller.openSharedFragment("#catalog=roads");

  assert.deepEqual(view.busy, []);
  assert.equal(view.loading, null);
});

test("saved map controller exposes the URL when clipboard access is denied", async () => {
  const view = createView();
  view.copyLink = async (fragment) => ({
    copied: false,
    url: `https://viewer.example/${fragment}`,
  });
  const controller = new SavedMapViewController({
    view,
    viewport: { snapshot: () => ({
      center: { latitude: 0, longitude: 0 }, zoom: 2,
    }) },
    mapLayers: { retainedRecords: [] },
    catalogVisualization: {},
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    subtleCrypto: zeroDigest(),
  });

  await controller.copyMapLink();

  assert.match(view.copyFallback, /^https:\/\/viewer\.example\/#view=/);
  assert.equal(view.copied, undefined);
});

test("saved map controller reports malformed owned fragments without clearing", async () => {
  const view = createView();
  let cleared = false;
  const controller = new SavedMapViewController({
    view,
    viewport: {},
    mapLayers: { retainedRecords: [] },
    catalogVisualization: { clear: () => { cleared = true; } },
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    subtleCrypto: zeroDigest(),
  });

  await controller.openSharedFragment("#view=not+base64");

  assert.equal(cleared, false);
  assert.match(view.error.message, /invalid encoded view/);
  assert.deepEqual(view.busy, [true, false]);
});

test("startup shared fragments take precedence over remembered local views", async () => {
  const localView = emptySavedMap(1, 2, 3);
  const sharedView = emptySavedMap(40, -120, 7);
  const storage = createStorage(serializeSavedMapView(localView));
  const timers = createTimers();
  const restored = [];
  const controller = new SavedMapViewController({
    view: createView(),
    viewport: { restore: (viewport) => restored.push(viewport) },
    mapLayers: { retainedRecords: [], commitStaged() {} },
    catalogVisualization: { clear() {} },
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    storage,
    subtleCrypto: zeroDigest(),
    setTimer: timers.setTimer.bind(timers),
    clearTimer: timers.clearTimer.bind(timers),
  });

  await controller.restoreStartupView(await encodeSavedMapViewFragment(
    serializeSavedMapView(sharedView),
    { maximumInputBytes: 512 * 1024 },
  ));

  assert.equal(storage.reads, 0);
  assert.deepEqual(restored, [sharedView.viewport]);
});

test("malformed owned startup fragments never fall back to private state", async () => {
  const storage = createStorage(serializeSavedMapView(emptySavedMap(1, 2, 3)));
  const view = createView();
  let restored = false;
  const controller = new SavedMapViewController({
    view,
    viewport: { restore: () => { restored = true; } },
    mapLayers: { retainedRecords: [] },
    catalogVisualization: { clear() {} },
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    storage,
    subtleCrypto: zeroDigest(),
  });

  await controller.restoreStartupView("#view=not+base64");

  assert.equal(storage.reads, 0);
  assert.equal(restored, false);
  assert.match(view.error.message, /invalid encoded view/);
});

test("startup silently restores a valid remembered map through the transaction", async () => {
  const remembered = emptySavedMap(-15, 35, 6);
  const storage = createStorage(serializeSavedMapView(remembered));
  const timers = createTimers();
  const calls = [];
  const view = createView();
  const controller = new SavedMapViewController({
    view,
    viewport: { restore: (viewport) => calls.push(["viewport", viewport]) },
    mapLayers: {
      retainedRecords: [],
      commitStaged: (layers, options) => calls.push(["commit", layers, options]),
    },
    catalogVisualization: { clear: () => calls.push(["clear"]) },
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    storage,
    subtleCrypto: zeroDigest(),
    setTimer: timers.setTimer.bind(timers),
    clearTimer: timers.clearTimer.bind(timers),
  });

  await controller.restoreStartupView("#catalog=roads");

  assert.equal(storage.reads, 1);
  assert.deepEqual(calls, [
    ["clear"],
    ["viewport", remembered.viewport],
    ["commit", [], { fitToBounds: false }],
  ]);
  assert.equal(view.loading, null);
  assert.equal(view.result, null);
  assert.equal(view.error, null);
});

test("startup discards corrupt remembered content without blocking the map", async () => {
  const storage = createStorage("not valid saved-map JSON");
  let clearedMap = false;
  const view = createView();
  const controller = new SavedMapViewController({
    view,
    viewport: {},
    mapLayers: { retainedRecords: [] },
    catalogVisualization: { clear: () => { clearedMap = true; } },
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    storage,
    subtleCrypto: zeroDigest(),
  });

  await controller.restoreStartupView("");

  assert.equal(storage.clears, 1);
  assert.equal(clearedMap, false);
  assert.equal(view.error, null);
  assert.deepEqual(view.busy, []);
});

test("remembered map persistence coalesces complete validated snapshots", async () => {
  const item = { collection: "vectors", id: "roads" };
  const record = {
    entry: { item, visible: false, opacity: 0.35, label: "Workshop roads", customName: "Workshop roads" },
    adapter: {
      exportSavedState: () => ({ kind: "vector", definition: { width: 4 } }),
    },
  };
  const storage = createStorage();
  const timers = createTimers();
  const controller = new SavedMapViewController({
    view: createView(),
    viewport: { snapshot: () => ({
      center: { latitude: 8, longitude: 9 }, zoom: 5,
    }) },
    mapLayers: { retainedRecords: [record] },
    catalogVisualization: { sourceRevision: () => null },
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    storage,
    clock: () => new Date("2026-09-01T12:00:00Z"),
    subtleCrypto: zeroDigest(),
    setTimer: timers.setTimer.bind(timers),
    clearTimer: timers.clearTimer.bind(timers),
  });

  controller.scheduleRemember();
  controller.scheduleRemember();

  assert.equal(timers.scheduled.size, 1);
  assert.equal([...timers.scheduled.values()][0].delay, 350);
  timers.runOnly();
  await flushAsyncWork();

  assert.equal(storage.writes.length, 1);
  const remembered = JSON.parse(storage.writes[0]);
  assert.deepEqual(remembered.viewport, {
    center: { latitude: 8, longitude: 9 }, zoom: 5,
  });
  assert.deepEqual(remembered.layers, [{
    catalogItem: item,
    sourceRevision: null,
    visible: false,
    opacity: 0.35,
    customName: "Workshop roads",
    style: { kind: "vector", definition: { width: 4 } },
  }]);
  assert.deepEqual(Object.keys(remembered).sort(), [
    "basemap", "createdAt", "format", "layers", "schemaVersion", "viewer", "viewport",
  ]);
});

test("reset and one-step undo reuse complete validated restore documents", async () => {
  const initialViewport = {
    center: { latitude: 0, longitude: 0 }, zoom: 2,
  };
  const workingViewport = {
    center: { latitude: 12, longitude: 13 }, zoom: 7,
  };
  const item = { collection: "vectors", id: "roads" };
  const style = { kind: "vector", definition: { width: 3 } };
  const originalRecord = {
    entry: { item, visible: true, opacity: 0.6, label: "Roads" },
    adapter: { exportSavedState: () => style },
  };
  let currentViewport = workingViewport;
  const calls = [];
  const mapLayers = {
    retainedRecords: [originalRecord],
    commitStaged(staged) {
      this.retainedRecords = staged.map(({ record }) => record);
      calls.push(["commit", this.retainedRecords.map(({ entry }) => entry.item.id)]);
    },
  };
  const catalogVisualization = {
    clear() { mapLayers.retainedRecords = []; },
    sourceRevision: () => null,
    prepare: async (catalogItem) => catalogItem,
    async stage(catalogItem, presentation) {
      const restoredRecord = {
        entry: {
          item: catalogItem,
          label: "Roads",
          ...presentation,
        },
        adapter: {
          exportSavedState: () => style,
          applySavedState(_record, restoredStyle) {
            calls.push(["style", restoredStyle]);
          },
        },
      };
      return {
        key: getCatalogItemKey(catalogItem),
        record: restoredRecord,
        layer: {},
      };
    },
  };
  const view = createView();
  const storage = createStorage();
  const timers = createTimers();
  const controller = new SavedMapViewController({
    view,
    viewport: {
      snapshot: () => currentViewport,
      restore(viewport) {
        currentViewport = viewport;
        calls.push(["viewport", viewport]);
      },
    },
    mapLayers,
    catalogVisualization,
    catalogItems: { get: async (identity) => ({ ...identity }) },
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    storage,
    initialViewport,
    clock: () => new Date("2026-09-01T12:00:00Z"),
    subtleCrypto: zeroDigest(),
    setTimer: timers.setTimer.bind(timers),
    clearTimer: timers.clearTimer.bind(timers),
  });

  await controller.resetView();

  assert.deepEqual(currentViewport, initialViewport);
  assert.deepEqual(mapLayers.retainedRecords, []);
  assert.equal(view.undoVisible, true);
  assert.deepEqual(JSON.parse(storage.serialized).layers, []);

  controller.scheduleRemember();
  timers.runOnly();
  await flushAsyncWork();

  assert.equal(
    view.undoVisible,
    true,
    "programmatic restore events must not consume reset undo",
  );

  await controller.undoReset();

  assert.deepEqual(currentViewport, workingViewport);
  assert.deepEqual(
    mapLayers.retainedRecords.map(({ entry }) => entry.item),
    [item],
  );
  assert.deepEqual(calls.filter(([kind]) => kind === "style"), [
    ["style", style],
  ]);
  assert.equal(view.undoVisible, false);
  assert.deepEqual(JSON.parse(storage.serialized).layers[0], {
    catalogItem: item,
    sourceRevision: null,
    visible: true,
    opacity: 0.6,
    style,
  });

  await controller.resetView();
  currentViewport = {
    center: { latitude: 1, longitude: 1 }, zoom: 3,
  };
  controller.scheduleRemember();
  timers.runOnly();
  await flushAsyncWork();

  assert.equal(
    view.undoVisible,
    true,
    "reset undo remains available until it is used or replaced",
  );
});

test("shared map links exclude private local annotation contents", async () => {
  const view = createView();
  const controller = new SavedMapViewController({ view,
    viewport: {snapshot: () => ({center: {latitude: 0, longitude: 0}, zoom: 4})},
    mapLayers: {retainedRecords: [{entry: {item: null, label: "Private workshop"},
      adapter: {exportSavedState() {throw new Error("Local data must never be exported here");}}}]},
    catalogVisualization: {}, catalogItems: {}, viewerVersion: "0.5.0", viewerOrigin: "https://viewer.example",
  });
  await controller.copyMapLink();
  const copied = JSON.parse(await decodeSavedMapViewFragment(view.fragment, {maximumOutputBytes: 512 * 1024}));
  assert.deepEqual(copied.layers, []);
});
