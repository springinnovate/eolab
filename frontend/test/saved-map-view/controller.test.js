import assert from "node:assert/strict";
import test from "node:test";

import { MapLayerController } from "../../src/map-layers/controller.js";
import { SavedMapViewController } from "../../src/saved-map-view/controller.js";
import {
  decodeSavedMapViewFragment,
  encodeSavedMapViewFragment,
} from "../../src/saved-map-view/fragment-codec.js";
import { createSavedMapView, serializeSavedMapView } from "../../src/saved-map-view/model.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";

/**
 * Create a test controller without uploaded or temporal layers unless supplied.
 * @param {Object} configuration Test-owned view, layer and persistence adapters.
 * @return {SavedMapViewController} Controller connected to those test adapters.
 */
function createController(configuration) {
  return new SavedMapViewController({
    exportTemporal: () => null,
    restoreTemporal: async () => { throw new Error("This test did not provide a temporal layer to restore."); },
    exportUpload: () => null,
    restoreUpload: async () => { throw new Error("This test did not provide an upload to restore."); },
    ...configuration,
  });
}

/** Build an additive Catalog restore fixture with observable staging and cleanup.
 * @param {Object} [options={}] Failure and delay controls.
 * @return {Object} Controller, retained records and source-owner observations.
 */
function additiveCatalogFixture(options = {}) {
  const definition = {catalogItem: {collection: "local", id: "parcels"}, isCustom: true, visible: false, opacity: 0.6,
    customName: "Restoration parcels", legendIncluded: false, style: {kind: "vector", definition: {}},
    filter: {enabled: true, match: "all", rules: [{field: "region", operator: "eq", value: "north"}]},
    calculatedFields: [{version: 1, name: "Scaled", expression: "'score' * 2", numericText: false}]};
  const existing = {entry: {key: "existing", item: {collection: "local", id: "existing"}}};
  const records = [existing], staged = [], discarded = [], removed = [], order = [];
  const mapLayers = {retainedRecords: records,
    restoreStagedLayer(value, index) {
      if (value.record.entry.item?.id === options.failAttach && options.failAttach !== undefined) throw new Error("Attach failed");
      records.splice(index, 0, value.record);
    },
    setLegendIncluded(key, included) { records.find(record => record.entry.key === key).entry.legendIncluded = included; },
    removeKey(key) { removed.push(key); const index = records.findIndex(record => record.entry.key === key); if (index >= 0) records.splice(index, 1); },
    restoreOrder(keys) { records.splice(0, records.length, ...keys.map(key => records.find(record => record.entry.key === key))); },
  };
  const controller = createController({view: createView(), viewerVersion: "1", viewerOrigin: "https://viewer.example",
    viewport: {restore() { assert.fail("Additive layer restore must not move the map"); }}, mapLayers,
    catalogItems: {get: async identity => { await options.beforeRead?.(identity); return identity; }},
    catalogVisualization: {clear() { assert.fail("Additive layer restore must retain existing layers"); }, prepare: async item => item,
      stage: async (item, presentation) => {
        const record = {entry: {...presentation, item, label: item.id}, definitions: [], adapter: {
          restoreCalculatedFields(_record, fields) { order.push("fields"); record.definitions = fields; },
          applySavedState(_record, style) { order.push("style"); if (item.id === options.failStyle) throw new Error("Invalid saved style"); record.style = style; },
          applyFilterState(_record, filter) { order.push("filter"); record.filter = filter; },
          exportSavedState: () => record.style, exportFilterState: () => record.filter,
          exportCalculatedFields: () => record.definitions,
          discardStaged() { discarded.push(item.id); },
        }};
        const value = {key: presentation.key, record, layer: {remove() {}}}; staged.push(value); return value;
      }},
    ...options.configuration,
  });
  return {controller, definition, records, existing, staged, discarded, removed, order};
}

test("additive Catalog restore preserves existing map, strict settings and detached export values", async () => {
  const f = additiveCatalogFixture();
  const results = await f.controller.restoreLayers([f.definition], () => true);
  assert.equal(results.length, 1); assert.equal(results[0].error, null); assert.match(results[0].key, /^local:view:/);
  assert.deepEqual(f.order, ["fields", "style", "filter"]); assert.equal(f.records[1], f.existing);
  assert.deepEqual(f.controller.exportLayer(results[0].key), f.definition);
  const exported = f.controller.exportLayer(results[0].key); exported.filter.rules[0].value = "south";
  assert.equal(f.controller.exportLayer(results[0].key).filter.rules[0].value, "north");
  assert.throws(() => f.controller.exportLayer("removed"), /available layer/);
});

/** Build an ordinary linked drawing view with distinct local display settings.
 * @param {string} [customName] Local view name.
 * @return {Object} Portable source reference and appearance.
 */
function drawingDefinition(customName = "Priority parcels") {
  return {drawingLayerId: "11111111-1111-4111-8111-111111111111", isCustom: true, customName,
    visible: false, opacity: 0.6, legendIncluded: false,
    appearance: {color: "#1686b0", outline: "#202020", weight: 2, fillOpacity: 0.4, labels: true},
    filter: {enabled: true, match: "all", rules: [{field: "name", operator: "eq", value: "Priority"}]}};
}

/** Connect drawing callbacks to the same retained map used by additive Catalog restoration.
 * @param {Object} [options] Catalog failures and a drawing source read callback.
 * @return {Object} Fixture with drawing restoration observations.
 */
function additiveDrawingFixture(options = {}) {
  const restored = [], discardedDrawings = [];
  const f = additiveCatalogFixture({...options, configuration: {
    exportDrawing: record => record.definition ?? null,
    stageDrawing: async (definition, isCurrent) => {
      if (options.catalogExpected !== false) assert.equal(f.order.includes("filter"), true, "Catalog style and filter stage before attaching drawings");
      await options.readDrawing?.(definition);
      if (!isCurrent()) return null;
      const key = `local:annotation:${restored.length}`;
      const record = {entry: {key, item: null, isCustom: true}, definition: structuredClone(definition),
        adapter: {discardStaged() { discardedDrawings.push(key); }}};
      restored.push(record);
      return {key, record, layer: {remove() {}}};
    },
  }});
  return {...f, restored, discardedDrawings};
}

test("additive mixed views preserve original order and export drawings through the common layer path", async () => {
  const f = additiveDrawingFixture();
  const drawing = drawingDefinition(), second = {...drawingDefinition("Another view"), visible: true, legendIncluded: true};
  const definitions = [drawing, f.definition, second];
  const results = await f.controller.restoreLayers(definitions, () => true);
  assert.ok(results.every(result => result.key && result.error === null));
  assert.deepEqual(f.records.map(record => record.entry.key), [...results.map(result => result.key), "existing"]);
  assert.deepEqual(results.map(result => f.controller.exportLayer(result.key)), definitions);
  const exported = f.controller.exportLayer(results[0].key);
  exported.appearance.color = "#ffffff"; exported.filter.rules[0].value = "Changed";
  assert.deepEqual(f.controller.exportLayer(results[0].key), drawing);
  assert.equal(f.restored.length, 2, "Repeated source references receive independent views");
});

test("a drawing-only addition uses the shared restore path without needing Catalog preparation", async () => {
  const f = additiveDrawingFixture({catalogExpected: false});
  const definition = drawingDefinition();
  const [result] = await f.controller.restoreLayers([definition], () => true);
  assert.equal(result.error, null);
  assert.deepEqual(f.records.map(record => record.entry.key), [result.key, "existing"]);
  assert.deepEqual(f.controller.exportLayer(result.key), definition);
  assert.equal(f.staged.length, 0);
});

test("a drawing read failure discards detached drawings and Catalog views", async () => {
  const exposed = [];
  const f = additiveDrawingFixture({readDrawing: async layer => {
    if (layer.customName === "Missing") {
      exposed.push(...f.records);
      throw new Error("Drawing unavailable");
    }
  }});
  const results = await f.controller.restoreLayers([drawingDefinition(), f.definition, drawingDefinition("Missing")], () => true);
  assert.deepEqual(exposed, [f.existing], "an incomplete addition must not expose a drawing that rollback could delete after editing");
  assert.ok(results.every(result => result.key === null && /Drawing unavailable/.test(result.error)));
  assert.deepEqual(f.records, [f.existing]);
  assert.deepEqual(f.discarded, ["parcels"]);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.discardedDrawings, [f.restored[0].entry.key]);
});

test("Catalog attachment failure rolls back drawing additions without touching preexisting views", async () => {
  const f = additiveDrawingFixture({failAttach: "parcels"});
  const results = await f.controller.restoreLayers([drawingDefinition(), f.definition], () => true);
  assert.ok(results.every(result => result.key === null && /Attach failed/.test(result.error)));
  assert.deepEqual(f.records, [f.existing]); assert.deepEqual(f.discarded, ["parcels"]);
  assert.deepEqual(f.removed, [f.restored[0].entry.key]);
});

test("superseded mixed additions discard detached drawings and Catalog views", async () => {
  let current = true;
  const f = additiveDrawingFixture({readDrawing: async layer => { if (layer.customName === "Slow") current = false; }});
  const results = await f.controller.restoreLayers([f.definition, drawingDefinition(), drawingDefinition("Slow")], () => current);
  assert.ok(results.every(result => result.key === null && /cancelled/.test(result.error)));
  assert.deepEqual(f.records, [f.existing]); assert.deepEqual(f.discarded, ["parcels"]);
  assert.deepEqual(f.removed, []);
  assert.deepEqual(f.discardedDrawings, [f.restored[0].entry.key]);
});

test("additive Catalog restore rejects failed style and discards all detached preparations", async () => {
  const f = additiveCatalogFixture({failStyle: "broken"});
  const broken = {...f.definition, catalogItem: {collection: "local", id: "broken"}, calculatedFields: []};
  const results = await f.controller.restoreLayers([f.definition, broken], () => true);
  assert.equal(results.every(result => result.key === null && /Invalid saved style/.test(result.error)), true);
  assert.deepEqual(f.records, [f.existing]); assert.deepEqual(f.discarded.sort(), ["broken", "parcels"]);
});

test("additive Catalog attachment failure rolls back only layers from that operation", async () => {
  const f = additiveCatalogFixture({failAttach: "broken"});
  const broken = {...f.definition, catalogItem: {collection: "local", id: "broken"}};
  const results = await f.controller.restoreLayers([f.definition, broken], () => true);
  assert.equal(results.every(result => result.key === null && /Attach failed/.test(result.error)), true);
  assert.deepEqual(f.records, [f.existing]); assert.deepEqual(f.removed, [f.staged[0].key]);
  assert.deepEqual(f.discarded, ["broken"]);
});

test("superseded additive Catalog restore discards prepared layers without attaching them", async () => {
  let current = true;
  const f = additiveCatalogFixture({beforeRead: async () => { current = false; }});
  const results = await f.controller.restoreLayers([f.definition], () => current);
  assert.deepEqual(f.records, [f.existing]); assert.deepEqual(f.discarded, ["parcels"]);
  assert.equal(results[0].key, null); assert.match(results[0].error, /cancelled/);
});

test("calculated fields restore before dependent styles and filters and unavailable definitions survive the next save", async () => {
  const fields = [{version: 1, name: "Density", expression: "'Population' / 10", numericText: false}];
  const layer = {catalogItem: {collection: "vectors", id: "available"}, isCustom: true, visible: true, opacity: 1,
    calculatedFields: fields, style: {kind: "vector", definition: {field: "Density"}},
    filter: {enabled: true, match: "all", rules: [{field: "Density", operator: "gt", value: 2}]}};
  const missing = {...structuredClone(layer), catalogItem: {collection: "vectors", id: "missing"}};
  const artifact = {...structuredClone(layer), runArtifact: {jobId: "a".repeat(32), artifactId: "b".repeat(32), layerName: "results"}};
  delete artifact.catalogItem;
  const saved = {...emptySavedMap(0, 0, 2), layers: [missing, layer, artifact]};
  const view = createView(), records = [], order = [];
  const controller = createController({view, viewerVersion: "1", viewerOrigin: saved.viewer.origin,
    viewport: {restore() {}, snapshot: () => saved.viewport},
    mapLayers: {retainedRecords: records, commitStaged(staged) {records.push(...staged.map(value => value.record));},
      setLegendIncluded() {}},
    catalogVisualization: {clear() {records.length = 0;}, prepare: async item => item,
      stage: async (item, presentation) => {
        const record = {entry: {item, ...presentation}, definitions: [], adapter: {
          restoreCalculatedFields: async (_record, definitions) => {order.push("fields"); record.definitions = definitions;},
          applySavedState: async () => {assert.deepEqual(record.definitions, fields); order.push("style");},
          applyFilterState: async () => {assert.deepEqual(record.definitions, fields); order.push("filter");},
          exportCalculatedFields: () => record.definitions,
          exportSavedState: () => layer.style, exportFilterState: () => layer.filter,
        }};
        return {record};
      }},
    catalogItems: {get: async identity => {if (identity.id === "missing") throw new Error("Source unavailable"); return identity;}},
    restoreArtifact: async () => {throw new Error("Result expired");},
  });
  await controller.openSharedFragment(await encodeSavedMapViewFragment(serializeSavedMapView(saved), {maximumInputBytes: 512 * 1024}));
  assert.deepEqual(order, ["fields", "style", "filter"]);
  assert.equal(view.result.loaded, 1);
  assert.match(view.result.details.join(" "), /remain saved/);
  await controller.copyMapLink();
  const copied = JSON.parse(await decodeSavedMapViewFragment(view.fragment, {maximumOutputBytes: 512 * 1024}));
  assert.deepEqual(copied.layers, saved.layers);
});

test("live unavailable results retain only identities and definitions in the next saved view", async () => {
  const saved = emptySavedMap(0, 0, 2), view = createView();
  const fields = [{version: 1, name: "Scaled", expression: "'score' * 2", numericText: false}];
  const layers = ["a", "b"].map(id => ({runArtifact: {jobId: "c".repeat(32), artifactId: id.repeat(32), layerName: "results"},
    visible: true, opacity: 1, calculatedFields: fields, style: {kind: "vector", definition: {}}}));
  const records = layers.map((layer, index) => ({entry: {key: String(index), label: `Result ${index}`, item: null, isCustom: true}, layer}));
  const controller = createController({view, viewerVersion: "1", viewerOrigin: saved.viewer.origin,
    viewport: {snapshot: () => saved.viewport}, mapLayers: {retainedRecords: records}, exportArtifact: record => record.layer});
  for (const key of ["0", "1"]) {
    controller.retainUnavailableLayer(key);
    records.splice(records.findIndex(record => record.entry.key === key), 1);
  }
  assert.match(view.result.details[0], /Result 1.*remain saved/);
  await controller.copyMapLink();
  const copied = JSON.parse(await decodeSavedMapViewFragment(view.fragment, {maximumOutputBytes: 512 * 1024}));
  assert.deepEqual(copied.layers, layers.map(layer => ({...layer, isCustom: true})));
  assert.equal(records.length, 0);
});

test("unavailable private references keep their origin and can be explicitly removed to save this site's private layers", async () => {
  const saved = {...emptySavedMap(0, 0, 2), layers: [{runArtifact: {jobId: "a".repeat(32), artifactId: "b".repeat(32), layerName: "results"},
    visible: true, opacity: 1, calculatedFields: [{version: 1, name: "Scaled", expression: "'score' * 2", numericText: false}],
    style: {kind: "vector", definition: {}}}]};
  const view = createView(), records = [];
  const controller = createController({view, viewerVersion: "1", viewerOrigin: "https://other.example",
    viewport: {snapshot: () => saved.viewport, restore() {}}, mapLayers: {retainedRecords: records, commitStaged() {}},
    catalogVisualization: {clear() {}}, restoreArtifact: async () => assert.fail("foreign private source was requested"),
    exportArtifact: record => record.layer});
  await controller.openSharedFragment(await encodeSavedMapViewFragment(serializeSavedMapView(saved), {maximumInputBytes: 512 * 1024}));
  assert.match(view.result.details.join(" "), /original EOLab site/);
  await controller.copyMapLink();
  const copied = JSON.parse(await decodeSavedMapViewFragment(view.fragment, {maximumOutputBytes: 512 * 1024}));
  assert.equal(copied.viewer.origin, saved.viewer.origin);
  assert.deepEqual(copied.layers, saved.layers);
  records.push({entry: {key: "local-result", item: null, isCustom: true}, layer: saved.layers[0]});
  await controller.copyMapLink();
  assert.match(view.error.message, /layers linked to different EOLab sites/);
  assert.equal(view.unavailableCount, 1);
  view.handlers.onShowUnavailableLayers();
  assert.deepEqual(view.unavailableLayers, [{index: 0, label: "Private run result", sourceSite: saved.viewer.origin, fields: ["Scaled"]}]);
  view.handlers.onRemoveUnavailableLayer(view.unavailableLayers[0].index);
  assert.equal(view.unavailableCount, 0);
  assert.deepEqual(view.unavailableLayers, []);
  await controller.copyMapLink();
  const afterRemoval = JSON.parse(await decodeSavedMapViewFragment(view.fragment, {maximumOutputBytes: 512 * 1024}));
  assert.equal(afterRemoval.viewer.origin, "https://other.example");
  assert.deepEqual(afterRemoval.layers, [{...saved.layers[0], isCustom: true}]);
  assert.equal(records.length, 1);
});

test("removing an unavailable saved layer preserves the order of remaining live and unavailable layers", async () => {
  const fields = [{version: 1, name: "Scaled", expression: "'score' * 2", numericText: false}];
  const layers = ["A", "B", "C", "D"].map(name => ({catalogItem: {collection: "vectors", id: name},
    visible: true, opacity: 1, isCustom: true, calculatedFields: fields, style: {kind: "vector", definition: {}}}));
  const saved = {...emptySavedMap(0, 0, 2), layers}, view = createView(), records = [];
  const controller = createController({view, viewerVersion: "1", viewerOrigin: saved.viewer.origin,
    viewport: {restore() {}, snapshot: () => saved.viewport},
    mapLayers: {retainedRecords: records, commitStaged(staged) {records.push(...staged.map(value => value.record));}, setLegendIncluded() {}},
    catalogVisualization: {clear() {}, prepare: async item => item,
      stage: async (item, presentation) => ({record: {entry: {...presentation, item}, adapter: {
        restoreCalculatedFields() {}, applySavedState() {}, exportSavedState: () => layers[0].style, exportCalculatedFields: () => fields,
      }}})},
    catalogItems: {get: async identity => {
      if (["A", "C"].includes(identity.id)) throw new Error("Source unavailable");
      return identity;
    }},
  });
  await controller.openSharedFragment(await encodeSavedMapViewFragment(serializeSavedMapView(saved), {maximumInputBytes: 512 * 1024}));
  view.handlers.onShowUnavailableLayers();
  assert.deepEqual(view.unavailableLayers.map(layer => layer.label), ["A", "C"]);
  view.handlers.onRemoveUnavailableLayer(view.unavailableLayers[0].index);
  await controller.copyMapLink();
  const copied = JSON.parse(await decodeSavedMapViewFragment(view.fragment, {maximumOutputBytes: 512 * 1024}));
  assert.deepEqual(copied.layers.map(layer => layer.catalogItem.id), ["B", "C", "D"]);
  view.handlers.onRemoveUnavailableLayer(view.unavailableLayers[0].index);
  await controller.copyMapLink();
  const afterBothRemoved = JSON.parse(await decodeSavedMapViewFragment(view.fragment, {maximumOutputBytes: 512 * 1024}));
  assert.deepEqual(afterBothRemoved.layers.map(layer => layer.catalogItem.id), ["B", "D"]);
});

test("published drafts ignore personal autosave and only write on explicit save", async () => {
  const view = createView(), storage = createStorage("private"), submissions = [], headings = [];
  view.showPublishedMapEditor = (saved, complete) => { view.editor = { saved, complete }; };
  view.showPublishedMapEditStatus = message => { view.editStatus = message; };
  view.setPublishedMapSaving = saving => { view.saving = saving; };
  let position = emptySavedMap(10, 20, 6).viewport;
  const loaded = { slug: "amazon", title: "Original", subtitle: "", revision: 1, view: emptySavedMap(10, 20, 6) };
  const controller = createController({ view, storage, editPublishedMap: true, namedMapSlug: "amazon",
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
  const available = { catalogItem: { collection: "c", id: "available" },
    visible: false, opacity: 0.5, style: { kind: "vector", definition: {} } };
  const saved = { ...emptySavedMap(10, 20, 6), layers: [
    ...(keepAvailableLayer ? [available] : []), { ...available, catalogItem: { collection: "c", id: "gone" } },
  ] };
  const controller = createController({ view, editPublishedMap: true, namedMapSlug: "amazon",
    viewerVersion: "0.6.0", viewerOrigin: saved.viewer.origin,
    publicationApi: { getForEditing: async () => ({ title: "Map", subtitle: "", revision: 1, view: saved }),
      async update(slug, request) { submissions.push({ slug, request }); return { ...request, slug, revision: 2 }; } },
    viewport: { restore() {}, snapshot: () => saved.viewport },
    mapLayers: { retainedRecords: records, commitStaged(staged) { records.push(...staged.map(layer => layer.record)); },
      setLegendIncluded(key, value) { records.find(record => record.entry.key === key).entry.legendIncluded = value; } },
    catalogVisualization: { clear() {}, prepare: async item => item,
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
  assert.deepEqual(submissions[0].request.view.layers, keepAvailableLayer ? [{ ...available, isCustom: false }] : []);
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
  const controller = createController({ view, allowPublishing: true,
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
  const controller = createController({ view, storage, restoreSharedMap: true, namedMapSlug: "amazon",
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
  const controller = createController({ view, storage, restoreSharedMap: true, namedMapSlug: "missing",
    publicationApi: { async get() { throw new Error("Saved map not found."); } },
  });
  await controller.restoreStartupView("#view=other-map");
  assert.match(view.error.message, /not found/);
  assert.equal(storage.reads, 0);
  assert.equal(view.errorOperation, "open");
});

test("mixed shared maps export invitations, preserve layer order and restore presentation only", async () => {
  const annotation = { sharedAnnotation: { id: "11111111-1111-4111-8111-111111111111", joinCode: "ABCDEFGH" },
    visible: true, isCustom: true, legendIncluded: false, opacity: 0.7, appearance: { outline: "#202020", weight: 1, fillOpacity: 0.25, labels: false } };
  const catalog = { catalogItem: { collection: "vectors", id: "included" },
    visible: true, isCustom: false, legendIncluded: false, opacity: 1, style: { kind: "vector", definition: {} } };
  const saved = { ...emptySavedMap(10, 20, 6), mapLegend: { visible: false, collapsed: true }, layers: [catalog, annotation] };
  const fragment = await encodeSavedMapViewFragment(serializeSavedMapView(saved), { maximumInputBytes: 512 * 1024 });
  const view = createView(), records = [], restorations = [], ordered = [];
  const annotationRecord = { entry: { key: "local:annotation:mine", item: null, isCustom: true }, polygons: ["private polygon"] };
  let legendPreferences;
  const controller = createController({ view, restoreSharedMap: true,
    viewerVersion: "0.6.0", viewerOrigin: saved.viewer.origin,
    viewport: { snapshot: () => saved.viewport, restore() {} },
    mapLayers: { retainedRecords: records,
      setCustomLayer(key, value) { records.find(record => record.entry.key === key).entry.isCustom = value; },
      setLegendIncluded(key, value) { records.find(record => record.entry.key === key).entry.legendIncluded = value; },
      commitStaged(staged) { records.unshift(...staged.map(s => s.record)); }, restoreOrder(keys) { ordered.push(keys); } },
    mapLegend: { snapshot: () => legendPreferences, restore(value) { legendPreferences = value; } },
    catalogItems: { get: async identity => identity },
    catalogVisualization: { clear() { records.splice(0, records.length, ...records.filter(r => r.entry.item === null)); },
      prepare: async item => item,
      stage: async (item, presentation) => ({ record: { entry: { item, ...presentation }, adapter: {
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
  assert.deepEqual(ordered.at(-1), [records[0].entry.key, "local:annotation:mine"]);
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

test("ordinary map save and restore includes independent drawing views with Catalog layers", async () => {
  const catalog = {catalogItem: {collection: "vectors", id: "regions"}, isCustom: true,
    visible: true, opacity: 1, style: {kind: "vector", definition: {}}};
  const first = drawingDefinition(), second = {...drawingDefinition("Second drawing view"), visible: true};
  const saved = createSavedMapView({...emptySavedMap(12, 22, 7), layers: [first, catalog, second]});
  const records = [], view = createView(), storage = createStorage(serializeSavedMapView(saved)), timers = createTimers();
  const reads = [];
  const controller = createController({view, storage, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    viewerVersion: "1", viewerOrigin: saved.viewer.origin,
    initialViewport: saved.viewport,
    viewport: {snapshot: () => saved.viewport, restore() {}},
    beforeRestore: () => { records.length = 0; },
    mapLayers: {retainedRecords: records,
      setCustomLayer(key, value) { records.find(record => record.entry.key === key).entry.isCustom = value; },
      setLegendIncluded(key, value) { records.find(record => record.entry.key === key).entry.legendIncluded = value; },
      commitStaged(staged) { records.push(...staged.map(value => value.record)); },
      restoreOrder(keys) { records.splice(0, records.length, ...keys.map(key => records.find(record => record.entry.key === key))); },
    },
    catalogItems: {get: async identity => identity},
    catalogVisualization: {clear() {}, prepare: async item => item,
      stage: async (item, presentation) => ({record: {entry: {item, ...presentation},
        adapter: {applySavedState() {}, exportSavedState: () => catalog.style}}})},
    exportDrawing: record => record.definition ?? null,
    stageDrawing: async (definition, isCurrent) => {
      assert.equal(isCurrent(), true); reads.push(definition.drawingLayerId);
      const key = `drawing:${reads.length}`;
      return {key, record: {entry: {key, item: null, isCustom: true}, definition: structuredClone(definition), adapter: {}}, layer: {remove() {}}};
    },
  });
  await controller.restoreStartupView("");
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(record => record.entry.item?.id ?? record.definition.customName), [first.customName, "regions", second.customName]);
  assert.deepEqual(reads, [first.drawingLayerId, first.drawingLayerId]);
  records.push({entry: {key: "unsaved-local", item: null}, polygons: ["private local geometry"]});
  controller.scheduleRemember(); timers.runOnly();
  assert.deepEqual(JSON.parse(storage.serialized).layers, saved.layers);
  await controller.copyMapLink();
  const shared = JSON.parse(await decodeSavedMapViewFragment(view.fragment, {maximumOutputBytes: 512 * 1024}));
  assert.deepEqual(shared.layers, saved.layers);
  assert.equal(JSON.stringify(shared).includes("private local geometry"), false);
  await controller.resetView();
  assert.equal(records.length, 0);
  await controller.undoReset();
  assert.equal(records.length, 3);
  assert.deepEqual(records.map(record => record.entry.item?.id ?? record.definition.customName), [first.customName, "regions", second.customName]);
});

for (const foreign of [false, true]) {
  test(`unavailable drawing references remain saved with their source origin (${foreign ? "foreign site" : "source error"})`, async () => {
    const drawing = drawingDefinition(); delete drawing.customName;
    const saved = createSavedMapView({...emptySavedMap(0, 0, 2), layers: [drawing]});
    const view = createView(), records = []; let reads = 0;
    const controller = createController({view, viewerVersion: "1", viewerOrigin: foreign ? "https://other.example" : saved.viewer.origin,
      viewport: {snapshot: () => saved.viewport, restore() {}},
      mapLayers: {retainedRecords: records, commitStaged() {}}, catalogVisualization: {clear() {}},
      exportDrawing: record => record.definition ?? null,
      stageDrawing: async () => { reads++; throw new Error("Drawing unavailable"); },
    });
    await controller.openSharedFragment(await encodeSavedMapViewFragment(serializeSavedMapView(saved), {maximumInputBytes: 512 * 1024}));
    assert.equal(view.result.loaded, 0); assert.equal(reads, foreign ? 0 : 1);
    assert.match(view.result.details.join(" "), foreign ? /original EOLab site/ : /Drawing unavailable/);
    assert.equal(view.unavailableCount, 1);
    controller.showUnavailableLayers();
    assert.deepEqual(view.unavailableLayers, [{index: 0, label: "Saved drawing", sourceSite: foreign ? saved.viewer.origin : null, fields: []}]);
    await controller.copyMapLink();
    const copied = JSON.parse(await decodeSavedMapViewFragment(view.fragment, {maximumOutputBytes: 512 * 1024}));
    assert.deepEqual(copied.layers, saved.layers); assert.equal(copied.viewer.origin, saved.viewer.origin);
    if (foreign) {
      records.push({entry: {key: "this-site-drawing", item: null, isCustom: true}, definition: drawingDefinition("This site's drawing")});
      await controller.copyMapLink();
      assert.match(view.error.message, /layers linked to different EOLab sites/);
    }
    controller.removeUnavailableLayer(0);
    assert.equal(view.unavailableCount, 0);
  });
}

test("shared viewer restores its starting presentation and never reads or writes author autosave", async () => {
  const view = createView(), storage = createStorage("private map"), applied = [];
  const saved = emptySavedMap(10, 20, 6);
  const layer = { catalogItem: { collection: "vectors", id: "included" },
    visible: true, opacity: 0.6, style: { kind: "vector", definition: { color: "red" } },
    filter: { enabled: true, match: "all", rules: [] } };
  const fragment = await encodeSavedMapViewFragment(serializeSavedMapView({ ...saved, layers: [layer] }), { maximumInputBytes: 512 * 1024 });
  let position;
  const records = [];
  const controller = createController({ view, storage, restoreSharedMap: true,
    viewport: { snapshot: () => position, restore: value => { position = value; } },
    mapLayers: { retainedRecords: records, commitStaged: staged => records.push(...staged.map(item => item.record)),
      setLegendIncluded(key, value) { records.find(record => record.entry.key === key).entry.legendIncluded = value; } },
    catalogItems: { get: async identity => identity },
    catalogVisualization: {
      clear() { records.length = 0; }, prepare: async item => item,
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
    const controller = createController({ view, storage, restoreSharedMap: true });
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
      layers: [{ catalogItem: { collection: "vectors", id: "quakes" },
        visible: true, opacity: 1, style: { kind: "vector", definition: {} }, filter: state }],
    });
    const layers = { retainedRecords: [],
      commitStaged(staged) { calls.push("commit"); this.retainedRecords = staged.map(value => value.record); },
      setLegendIncluded(key, value) { this.retainedRecords.find(record => record.entry.key === key).entry.legendIncluded = value; } };
    const controller = createController({ view,
      viewport: { snapshot: () => saved.viewport, restore() {} }, mapLayers: layers,
      catalogItems: { get: async (identity) => identity },
      catalogVisualization: { clear() {}, prepare: async (item) => item,
        stage: async (item, presentation) => ({ record: { entry: { item, ...presentation, label: "Quakes" }, adapter: {
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
    setUnavailableLayerCount(count) { this.unavailableCount = count; },
    showUnavailableLayers(layers) { this.unavailableLayers = layers; },
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

test("saved map controller copies ordered Catalog layers and current viewport", async () => {
  const view = createView();
  const item = { collection: "vectors", id: "roads" };
  const record = {
    entry: { item, isCustom: false, visible: true, opacity: 0.4, label: "Workshop roads", customName: "Workshop roads" },
    adapter: {
      exportSavedState: () => ({ kind: "vector", definition: { width: 2 } }),
      exportFilterState: () => ({ enabled: false, match: "all", rules: [{ field: "year", operator: "gt", value: 2020 }] }),
    },
  };
  const controller = createController({
    view,
    viewport: { snapshot: () => ({
      center: { latitude: 10, longitude: 20 }, zoom: 4,
    }) },
    mapLayers: { retainedRecords: [record] },
    catalogVisualization: {},
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    clock: () => new Date("2026-09-01T12:00:00Z"),
  });

  await controller.copyMapLink();

  const copied = JSON.parse(await decodeSavedMapViewFragment(view.fragment, {
    maximumOutputBytes: 512 * 1024,
  }));
  assert.deepEqual(copied.layers[0].catalogItem, item);
  assert.equal(copied.layers[0].customName, "Workshop roads");
  assert.deepEqual(copied.layers[0].filter, record.adapter.exportFilterState());
  assert.equal(Object.hasOwn(copied.layers[0].style, "filter"), false);
  assert.equal(view.copied, true);
  assert.deepEqual(view.busy, [true, false]);
});

for (const kind of ["raster", "vector"]) test(`repeated ${kind} views survive export and reload and can be removed independently`, async () => {
  const style = kind === "vector" ? { kind, definition: { color: "#123456" } } : {
    kind, appearanceVersion: 1, mode: "continuous",
    continuous: { definition: { ...DEFAULT_RASTER_STYLE }, paletteName: "custom", styleWasEdited: true },
    categorical: null,
  };
  const first = { catalogItem: { collection: kind, id: "source" }, customName: "First view",
    visible: true, isCustom: false, opacity: 0.7, style,
    ...(kind === "vector" ? { filter: { enabled: true, match: "all",
      rules: [{ field: "ISO3", operator: "eq", value: "PER" }] } } : {}) };
  const second = { ...structuredClone(first), customName: "Second view", visible: false,
    opacity: 0.3, isCustom: true, legendIncluded: false };
  if (kind === "vector") {
    second.style.definition.color = "#ABCDEF";
    second.filter.rules[0].value = "BRA";
  } else {
    second.style.continuous.definition.minimumColor = "#ABCDEF";
  }
  const saved = { ...emptySavedMap(10, 20, 6), layers: [first, second] };
  const view = createView(), storage = createStorage(), timers = createTimers();
  const mapLayers = new MapLayerController({
    leafletMap: { removeLayer() {} },
    view: { bind() {}, unbind() {}, render() {}, setStatus() {} },
  });
  const adapter = {
    label: item => item.id,
    publish: async item => ({ id: item.id }),
    createState: () => ({}),
    createLayer: () => ({ addTo() {}, setOpacity() {}, setZIndex() {} }),
    renderDescriptor: record => ({ layerName: record.publication.id }),
    snapshot: () => ({ datasetKind: kind }),
    tileErrorMessage: "Test layer tiles unavailable",
    applySavedState(record, value) { record.state.style = structuredClone(value); },
    exportSavedState: record => record.state.style,
    ...(kind === "vector" ? {
      applyFilterState(record, value) { record.state.filter = structuredClone(value); },
      exportFilterState: record => record.state.filter,
    } : {}),
  };
  const controller = createController({ view, storage, mapLayers,
    viewport: { snapshot: () => saved.viewport, restore() {} },
    catalogItems: { get: async identity => identity },
    catalogVisualization: { clear: () => mapLayers.clear(), prepare: async item => item,
      stage: (item, presentation) => mapLayers.stage(item, adapter, presentation) },
    viewerVersion: "0.9.0", viewerOrigin: saved.viewer.origin,
    setTimer: timers.setTimer.bind(timers), clearTimer: timers.clearTimer.bind(timers),
  });
  await controller.openSharedFragment(await encodeSavedMapViewFragment(serializeSavedMapView(saved), {
    maximumInputBytes: 512 * 1024,
  }));
  assert.deepEqual(view.result.details, []);
  assert.equal(view.result.loaded, 2);
  assert.deepEqual(mapLayers.retainedRecords.map(record => record.entry.isCustom), [false, true]);
  const originalKeys = mapLayers.retainedRecords.map(record => record.entry.key);
  assert.equal(new Set(originalKeys).size, 2);
  await controller.copyMapLink();
  const exported = JSON.parse(await decodeSavedMapViewFragment(view.fragment, { maximumOutputBytes: 512 * 1024 }));
  assert.deepEqual(exported.layers, saved.layers);
  controller.scheduleRemember();
  timers.runOnly();
  assert.deepEqual(JSON.parse(storage.serialized).layers, saved.layers);
  await controller.restoreStartupView();
  const restored = mapLayers.retainedRecords;
  assert.equal(restored.length, 2);
  assert.ok(restored.every(record => !originalKeys.includes(record.entry.key)));
  assert.deepEqual(restored.map(record => record.entry.isCustom), [false, true]);
  mapLayers.removeKey(restored[0].entry.key);
  assert.equal(mapLayers.retainedRecords[0], restored[1]);
  await controller.copyMapLink();
  const remaining = JSON.parse(await decodeSavedMapViewFragment(view.fragment, { maximumOutputBytes: 512 * 1024 }));
  assert.deepEqual(remaining.layers, [second]);
  controller.destroy();
  mapLayers.destroy();
});

test("saved map controller stages concurrently and commits final saved order", async () => {
  const view = createView();
  const viewportCalls = [];
  const calls = [];
  const mapLayers = {
    retainedRecords: [{ entry: { item: { collection: "old", id: "layer" } } }],
    setLegendIncluded(key, value) { this.retainedRecords.find(record => record.entry.key === key).entry.legendIncluded = value; },
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
      return { key: presentation.key, record, layer: {} };
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
        visible: true,
        opacity: 0.5,
        style: { kind: "vector", definition: { width: 2 } },
      },
      {
        catalogItem: { collection: "rasters", id: "bottom" },
        visible: false,
        opacity: 0.8,
        style: {
          kind: "raster", appearanceVersion: 1, mode: "continuous",
          continuous: { definition: { ...DEFAULT_RASTER_STYLE }, paletteName: "custom", styleWasEdited: true },
          categorical: null,
        },
      },
    ],
  });
  const controller = createController({
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
  });

  await controller.openSharedFragment(await encodeSavedMapViewFragment(
    serializeSavedMapView(saved),
    { maximumInputBytes: 512 * 1024 },
  ));

  const restoredKeys = mapLayers.retainedRecords.map(record => record.entry.key);
  assert.equal(new Set(restoredKeys).size, 2);
  assert.deepEqual(calls.filter(([kind]) => kind === "stage"), [
    ["stage", "top", { key: restoredKeys[0], visible: true, isCustom: false, opacity: 0.5, customName: "Protected areas" }],
    ["stage", "bottom", { key: restoredKeys[1], visible: false, isCustom: false, opacity: 0.8 }],
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
  assert.deepEqual(view.result.details, []);
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
    setLegendIncluded(key, value) { this.retainedRecords.find(record => record.entry.key === key).entry.legendIncluded = value; },
    commitStaged(staged) {
      commitWhileActive = active;
      committed = staged;
      this.retainedRecords = staged.map(value => value.record);
    },
  };
  const catalogVisualization = {
    clear() {},
    prepare: async (item) => item,
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
      return { key: presentation.key, record, layer: {} };
    },
  };
  const controller = createController({
    view,
    viewport: { restore() {} },
    mapLayers,
    catalogVisualization,
    catalogItems: { get: async (identity) => ({ ...identity }) },
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
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
  const controller = createController({
    view,
    viewport: { restore: () => assert.fail("stale viewport restored") },
    mapLayers: {
      retainedRecords: [],
      commitStaged() { committed = true; },
    },
    catalogVisualization: {
      clear() {},
      prepare: async (item) => item,
      async stage(item, presentation) {
        reportStageStarted();
        await stageReleased;
        return {
          key: presentation.key,
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
  const controller = createController({
    view,
    viewport: {},
    mapLayers: { retainedRecords: [] },
    catalogVisualization: {},
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
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
  const controller = createController({
    view,
    viewport: { snapshot: () => ({
      center: { latitude: 0, longitude: 0 }, zoom: 2,
    }) },
    mapLayers: { retainedRecords: [] },
    catalogVisualization: {},
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
  });

  await controller.copyMapLink();

  assert.match(view.copyFallback, /^https:\/\/viewer\.example\/#view=/);
  assert.equal(view.copied, undefined);
});

test("saved map controller reports malformed owned fragments without clearing", async () => {
  const view = createView();
  let cleared = false;
  const controller = createController({
    view,
    viewport: {},
    mapLayers: { retainedRecords: [] },
    catalogVisualization: { clear: () => { cleared = true; } },
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
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
  const controller = createController({
    view: createView(),
    viewport: { restore: (viewport) => restored.push(viewport) },
    mapLayers: { retainedRecords: [], commitStaged() {} },
    catalogVisualization: { clear() {} },
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    storage,
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
  const controller = createController({
    view,
    viewport: { restore: () => { restored = true; } },
    mapLayers: { retainedRecords: [] },
    catalogVisualization: { clear() {} },
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    storage,
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
  const controller = createController({
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

for (const destroyDuringLoad of [false, true]) {
  test(`private startup applies appearance before loading and preserves later choices (${destroyDuringLoad ? "destroyed" : "completed"})`, async () => {
    const saved = {
      ...emptySavedMap(10, 20, 6),
      basemap: "outlines",
      mapLegend: { visible: false, collapsed: true },
      layers: ["slow", "missing", "fast"].map(id => ({
        catalogItem: { collection: "vectors", id },
        visible: true, opacity: 1, style: { kind: "vector", definition: {} },
      })),
    };
    const storage = createStorage(serializeSavedMapView(saved));
    const view = createView(), timers = createTimers(), records = [], requested = [];
    const appearanceCalls = [];
    let position = emptySavedMap(0, 0, 2).viewport;
    let background = "detailed", legend = { visible: true, collapsed: false };
    let finishReadiness, finishLayer, finishBasemap;
    const pendingReadiness = new Promise(resolve => { finishReadiness = resolve; });
    const pendingLayer = new Promise(resolve => { finishLayer = resolve; });
    const pendingBasemap = new Promise(resolve => { finishBasemap = resolve; });
    const controller = createController({
      view, storage, viewerVersion: "0.9.0", viewerOrigin: saved.viewer.origin,
      beforeRestore: () => pendingReadiness,
      setTimer: timers.setTimer.bind(timers), clearTimer: timers.clearTimer.bind(timers),
      viewport: {
        snapshot: () => position,
        restore(value) { position = value; appearanceCalls.push("viewport"); },
      },
      basemap: {
        snapshot: () => background,
        restore(value) { background = value; appearanceCalls.push("basemap"); return pendingBasemap; },
      },
      mapLegend: {
        snapshot: () => legend,
        restore(value) { legend = value; appearanceCalls.push("legend"); },
      },
      mapLayers: {
        retainedRecords: records,
        commitStaged(layers, options) {
          assert.deepEqual(options, { fitToBounds: false });
          records.push(...layers.map(layer => layer.record));
        },
        setLegendIncluded(key, included) {
          records.find(record => record.entry.key === key).entry.legendIncluded = included;
        },
      },
      catalogItems: { async get(identity) {
        requested.push(identity.id);
        if (identity.id === "slow") await pendingLayer;
        if (identity.id === "missing") throw new Error("Source unavailable");
        return identity;
      } },
      catalogVisualization: {
        clear() {}, prepare: async item => item,
        stage: async (item, presentation) => ({ record: {
          entry: { item, ...presentation, label: item.id },
          adapter: { applySavedState() {}, exportSavedState: () => ({ kind: "vector", definition: {} }) },
        } }),
      },
    });

    const restoring = controller.restoreStartupView("");
    assert.deepEqual(position, saved.viewport);
    assert.equal(background, saved.basemap);
    assert.deepEqual(legend, saved.mapLegend);
    assert.equal(storage.reads, 1, "capture the saved document before waiting for other startup work");
    assert.deepEqual(requested, [], "layer preparation waits for composition readiness");
    assert.equal(view.loading, null, "private startup does not open a blocking progress dialog");

    position = emptySavedMap(50, 60, 10).viewport;
    background = "none";
    legend = { visible: true, collapsed: false };
    controller.scheduleRemember();
    assert.equal(timers.scheduled.size, 0, "do not autosave an incomplete map while startup is waiting");
    assert.deepEqual(storage.writes, []);
    finishReadiness();
    await flushAsyncWork();
    assert.deepEqual(requested, ["slow", "missing", "fast"], "ready layers load while the basemap is still pending");
    if (destroyDuringLoad) controller.destroy();
    finishLayer();
    finishBasemap(null);
    await restoring;

    assert.deepEqual(position, emptySavedMap(50, 60, 10).viewport);
    assert.equal(background, "none");
    assert.deepEqual(legend, { visible: true, collapsed: false });
    assert.deepEqual(appearanceCalls, ["viewport", "basemap", "legend"]);
    if (destroyDuringLoad) {
      assert.equal(records.length, 0);
      assert.equal(view.result, null);
      assert.equal(timers.scheduled.size, 0);
      assert.deepEqual(storage.writes, []);
    } else {
      assert.deepEqual(records.map(record => record.entry.item.id), ["slow", "fast"]);
      assert.equal(view.result.loaded, 2);
      assert.equal(view.result.total, 3);
      assert.match(view.result.details[0], /vectors\/missing: Source unavailable/);
      timers.runOnly();
      const remembered = JSON.parse(storage.serialized);
      assert.deepEqual(remembered.viewport, position);
      assert.equal(remembered.basemap, background);
      assert.deepEqual(remembered.mapLegend, legend);
      assert.deepEqual(remembered.layers.map(layer => layer.catalogItem.id), ["slow", "fast"]);
    }
    assert.equal(storage.clears, 0);
    controller.destroy();
  });
}

test("destroyed startup cannot prepare or commit layers after composition becomes ready", async t => {
  for (const shared of [false, true]) {
    await t.test(shared ? "shared" : "private", async () => {
      const saved = { ...emptySavedMap(10, 20, 6), layers: [{
        catalogItem: { collection: "vectors", id: "waiting" },
        visible: true, opacity: 1, style: { kind: "vector", definition: {} },
      }] };
      const storage = createStorage(serializeSavedMapView(saved));
      let finishReadiness;
      const pendingReadiness = new Promise(resolve => { finishReadiness = resolve; });
      let markRestoreStarted;
      const restoreStarted = new Promise(resolve => { markRestoreStarted = resolve; });
      const positions = [];
      const requested = [];
      const readinessCurrent = [];
      let cleared = 0;
      const view = createView();
      const controller = createController({ view, storage,
        beforeRestore: async isCurrent => {
          readinessCurrent.push(isCurrent()); markRestoreStarted(); await pendingReadiness;
          readinessCurrent.push(isCurrent());
        },
        viewport: { restore: value => positions.push(value) },
        catalogItems: { get(identity) { requested.push(identity); return identity; } },
        catalogVisualization: { clear() { cleared++; } },
        mapLayers: { retainedRecords: [], commitStaged() { assert.fail("Stale startup must not commit layers"); } },
      });
      const fragment = shared ? await encodeSavedMapViewFragment(serializeSavedMapView(saved), { maximumInputBytes: 512 * 1024 }) : "";
      const restoring = controller.restoreStartupView(fragment);
      await restoreStarted;
      assert.deepEqual(positions, shared ? [] : [saved.viewport]);
      assert.equal(cleared, 1, "clear at the explicit restore request, before waiting");
      controller.destroy();
      finishReadiness();
      await restoring;
      assert.deepEqual(positions, shared ? [] : [saved.viewport]);
      assert.equal(cleared, 1, "never clear again after waiting");
      assert.deepEqual(requested, [], "stale startup must not prepare layers");
      assert.deepEqual(readinessCurrent, [true, false], "composition can stop stale cleanup after awaiting readiness");
      assert.deepEqual(storage.writes, []);
      assert.equal(storage.clears, 0);
      assert.equal(view.error, null);
    });
  }
});

test("startup without a remembered view leaves readiness and current appearance alone", async () => {
  const storage = createStorage();
  const view = createView();
  const controller = createController({ view, storage,
    beforeRestore() { assert.fail("No saved view needs a layer restoration"); },
    viewport: { restore() { assert.fail("Keep the current viewport"); } },
    catalogVisualization: { clear() { assert.fail("Keep the current map"); } },
    mapLayers: { retainedRecords: [] },
  });
  await controller.restoreStartupView("");
  assert.equal(storage.reads, 1);
  assert.deepEqual(view.busy, []);
  assert.deepEqual(storage.writes, []);
  controller.destroy();
});

test("startup discards corrupt remembered content without blocking the map", async () => {
  const storage = createStorage("not valid saved-map JSON");
  let clearedMap = false;
  const view = createView();
  const controller = createController({
    view,
    viewport: {},
    mapLayers: { retainedRecords: [] },
    catalogVisualization: { clear: () => { clearedMap = true; } },
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    storage,
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
    entry: { item, isCustom: false, visible: false, opacity: 0.35, label: "Workshop roads", customName: "Workshop roads" },
    adapter: {
      exportSavedState: () => ({ kind: "vector", definition: { width: 4 } }),
    },
  };
  const storage = createStorage();
  const timers = createTimers();
  const controller = createController({
    view: createView(),
    viewport: { snapshot: () => ({
      center: { latitude: 8, longitude: 9 }, zoom: 5,
    }) },
    mapLayers: { retainedRecords: [record] },
    catalogVisualization: {},
    catalogItems: {},
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    storage,
    clock: () => new Date("2026-09-01T12:00:00Z"),
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
    isCustom: false,
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
    entry: { item, isCustom: true, visible: true, opacity: 0.6, label: "Roads" },
    adapter: { exportSavedState: () => style },
  };
  let currentViewport = workingViewport;
  const calls = [];
  const mapLayers = {
    retainedRecords: [originalRecord],
    setLegendIncluded(key, value) { this.retainedRecords.find(record => record.entry.key === key).entry.legendIncluded = value; },
    commitStaged(staged) {
      this.retainedRecords = staged.map(({ record }) => record);
      calls.push(["commit", this.retainedRecords.map(({ entry }) => entry.item.id)]);
    },
  };
  const catalogVisualization = {
    clear() { mapLayers.retainedRecords = []; },
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
        key: presentation.key,
        record: restoredRecord,
        layer: {},
      };
    },
  };
  const view = createView();
  const storage = createStorage();
  const timers = createTimers();
  const controller = createController({
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
    isCustom: true,
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
  const controller = createController({ view,
    viewport: {snapshot: () => ({center: {latitude: 0, longitude: 0}, zoom: 4})},
    mapLayers: {retainedRecords: [{entry: {item: null, label: "Private workshop"},
      adapter: {exportSavedState() {throw new Error("Local data must never be exported here");}}}]},
    catalogVisualization: {}, catalogItems: {}, viewerVersion: "0.5.0", viewerOrigin: "https://viewer.example",
  });
  await controller.copyMapLink();
  const copied = JSON.parse(await decodeSavedMapViewFragment(view.fragment, {maximumOutputBytes: 512 * 1024}));
  assert.deepEqual(copied.layers, []);
});

test("upload references survive autosave and links with their appearance and map order", async () => {
  const upload = { uploadId: "11111111-1111-4111-8111-111111111111", customName: "Wetlands",
    visible: false, isCustom: true, opacity: 0.4, legendIncluded: false,
    style: { kind: "vector", definition: { fillColor: "#123456" } },
    filter: { enabled: true, match: "all", rules: [{ field: "label", operator: "eq", value: "Café wetlands" }] } };
  const record = { entry: { item: null, isCustom: true, key: `local:upload:${upload.uploadId}`, legendIncluded: false } };
  const storage = createStorage(), view = createView(), timers = createTimers();
  const saved = emptySavedMap(10, 20, 6);
  const controller = createController({ view, storage,
    viewport: { snapshot: () => saved.viewport }, mapLayers: { retainedRecords: [record] },
    viewerVersion: "0.9.0", viewerOrigin: saved.viewer.origin,
    exportUpload: candidate => candidate === record ? upload : null,
    setTimer: timers.setTimer.bind(timers), clearTimer: timers.clearTimer.bind(timers),
  });
  controller.scheduleRemember();
  timers.runOnly();
  assert.deepEqual(JSON.parse(storage.serialized).layers, [upload]);
  await controller.copyMapLink();
  const linked = JSON.parse(await decodeSavedMapViewFragment(view.fragment, { maximumOutputBytes: 512 * 1024 }));
  assert.deepEqual(linked.layers, [upload]);
  controller.destroy();

  const restoredView = createView(), records = [], restored = [], order = [];
  const restarted = createController({ view: restoredView, storage,
    viewerVersion: "0.9.0", viewerOrigin: saved.viewer.origin,
    viewport: { restore() {} }, catalogVisualization: { clear() {} },
    mapLayers: { retainedRecords: records, commitStaged() {},
      setCustomLayer(key, value) { assert.equal(key, record.entry.key); record.entry.isCustom = value; },
      setLegendIncluded(key, included) { assert.equal(key, record.entry.key); assert.equal(included, false); },
      restoreOrder(keys) { order.push(keys); } },
    restoreUpload: async (layer, isCurrent) => {
      assert.equal(isCurrent(), true); restored.push(layer); records.push(record); return record.entry.key;
    },
    setTimer: timers.setTimer.bind(timers), clearTimer: timers.clearTimer.bind(timers),
  });
  await restarted.restoreStartupView("");
  assert.deepEqual(restored, [upload]);
  assert.deepEqual(order, [[record.entry.key]]);
  assert.equal(restoredView.result, null, "successful private restoration stays quiet");
  restarted.destroy();
});

test("unavailable private uploads are explained after refresh and when opening links", async () => {
  const upload = { uploadId: "11111111-1111-4111-8111-111111111111", customName: "Wetlands",
    visible: true, opacity: 1, style: { kind: "vector", definition: {} } };
  const saved = { ...emptySavedMap(10, 20, 6), layers: [upload] };
  const serialized = serializeSavedMapView(saved);
  const fragment = await encodeSavedMapViewFragment(serialized, { maximumInputBytes: 512 * 1024 });
  for (const useLink of [false, true]) {
    const view = createView(), timers = createTimers();
    let attempts = 0;
    const controller = createController({ view, storage: createStorage(serialized),
      viewerVersion: "0.9.0", viewerOrigin: saved.viewer.origin,
      viewport: { restore() {} }, catalogVisualization: { clear() {} },
      mapLayers: { retainedRecords: [], commitStaged() {} },
      restoreUpload: async () => { attempts += 1; throw new Error("This upload is unavailable. Open it in the browser that uploaded it; it may have been deleted."); },
      setTimer: timers.setTimer.bind(timers), clearTimer: timers.clearTimer.bind(timers),
    });
    await controller.restoreStartupView(useLink ? fragment : "");
    assert.equal(attempts, 1);
    assert.equal(view.result.loaded, 0);
    assert.equal(view.result.total, 1);
    assert.match(view.result.details[0], /Wetlands:.*browser that uploaded it/);
    controller.viewerOrigin = "https://different-site.example";
    await controller.openSharedFragment(fragment);
    assert.equal(attempts, 1, "foreign upload identifiers never reach local source access");
    assert.match(view.result.details[0], /original EOLab site/);
    controller.destroy();
  }
});

test("removing a restored upload while another layer loads does not discard the saved map", async () => {
  const upload = { uploadId: "11111111-1111-4111-8111-111111111111", customName: "Wetlands",
    visible: true, opacity: 1, style: { kind: "vector", definition: {} } };
  const later = { ...upload, uploadId: "22222222-2222-4222-8222-222222222222", customName: "Forest" };
  const saved = { ...emptySavedMap(10, 20, 6), layers: [upload, later] };
  const records = [], ordered = [], view = createView(), timers = createTimers();
  const storage = createStorage(serializeSavedMapView(saved));
  let finishLater;
  const waiting = new Promise(resolve => { finishLater = resolve; });
  const controller = createController({ view, storage,
    viewerVersion: "0.9.0", viewerOrigin: saved.viewer.origin,
    viewport: { restore() {} }, catalogVisualization: { clear() {} },
    mapLayers: { retainedRecords: records, commitStaged() {},
      setLegendIncluded(key) { assert.ok(records.some(record => record.entry.key === key), "only retained layers receive legend changes"); },
      restoreOrder(keys) { ordered.push(keys); } },
    restoreUpload: async layer => {
      if (layer.uploadId === later.uploadId) await waiting;
      const key = `local:upload:${layer.uploadId}`;
      records.push({ entry: { key, item: null } });
      return key;
    },
    setTimer: timers.setTimer.bind(timers), clearTimer: timers.clearTimer.bind(timers),
  });
  const restoring = controller.restoreStartupView("");
  await flushAsyncWork();
  assert.equal(records.length, 1);
  records.length = 0;
  finishLater();
  await restoring;
  assert.equal(storage.clears, 0);
  assert.equal(view.result.loaded, 1);
  assert.equal(view.result.total, 2);
  assert.match(view.result.details[0], /Wetlands was removed from the map/);
  assert.deepEqual(ordered, [[`local:upload:${later.uploadId}`]]);
  controller.destroy();
});

test("undoing Reset explains an upload deleted after the reset", async () => {
  const upload = { uploadId: "11111111-1111-4111-8111-111111111111", customName: "Wetlands",
    visible: true, opacity: 1, style: { kind: "vector", definition: {} } };
  const saved = emptySavedMap(10, 20, 6), view = createView(), timers = createTimers();
  const records = [{ entry: { key: `local:upload:${upload.uploadId}`, item: null, isCustom: true } }];
  const controller = createController({ view, storage: createStorage(), initialViewport: saved.viewport,
    viewerVersion: "0.9.0", viewerOrigin: saved.viewer.origin,
    viewport: { snapshot: () => saved.viewport, restore() {} },
    catalogVisualization: { clear() {} }, beforeRestore() { records.length = 0; },
    mapLayers: { retainedRecords: records, commitStaged() {} }, exportUpload: () => upload,
    restoreUpload: async () => { throw new Error("This private upload was deleted."); },
    setTimer: timers.setTimer.bind(timers), clearTimer: timers.clearTimer.bind(timers),
  });
  await controller.resetView();
  assert.equal(view.undoVisible, true);
  await controller.undoReset();
  assert.equal(view.undoVisible, false);
  assert.equal(view.result.loaded, 0);
  assert.equal(view.result.total, 1);
  assert.match(view.result.details[0], /Wetlands:.*deleted/);
  controller.destroy();
});


test("temporal views restore independently in mixed map order and retain unavailable selections", async () => {
  const style = { kind: "raster", appearanceVersion: 1, mode: "continuous",
    continuous: { definition: { ...DEFAULT_RASTER_STYLE }, paletteName: "custom", styleWasEdited: true },
    categorical: null };
  const temporal = { temporalSource: { collectionId: "eolab-temporal-datasets", itemId: "era5",
    variable: "air_temperature", time: "2020-01-15T12:00:00.000Z" },
    customName: "First", visible: true, isCustom: false, opacity: 0.6, legendIncluded: false, style };
  const catalog = { catalogItem: { collection: "vectors", id: "roads" }, visible: false,
    opacity: 0.8, isCustom: false, style: { kind: "vector", definition: {} } };
  const saved = { ...emptySavedMap(10, 20, 6), layers: [temporal, catalog,
    { ...structuredClone(temporal), customName: "Second", isCustom: true, opacity: 0.3 }] };
  const records = [], view = createView(), order = [];
  const controller = createController({ view,
    viewerVersion: "0.9.0", viewerOrigin: saved.viewer.origin,
    viewport: { snapshot: () => saved.viewport, restore() {} },
    mapLayers: { retainedRecords: records,
      setCustomLayer(key, value) { records.find(record => record.entry.key === key).entry.isCustom = value; },
      commitStaged(staged) { records.push(...staged.map(value => value.record)); },
      setLegendIncluded(key, value) { records.find(record => record.entry.key === key).entry.legendIncluded = value; },
      restoreOrder(keys) { order.push(keys); records.sort((a, b) => keys.indexOf(a.entry.key) - keys.indexOf(b.entry.key)); } },
    catalogItems: { get: async identity => identity },
    catalogVisualization: { clear() { records.length = 0; }, prepare: async item => item,
      stage: async (item, presentation) => ({ record: { entry: { item, ...presentation },
        adapter: { applySavedState() {}, exportSavedState: () => catalog.style } } }) },
    exportTemporal: record => record.savedTemporal ?? null,
    restoreTemporal: async (layer, isCurrent) => {
      assert.equal(isCurrent(), true);
      const key = `local:temporal:${layer.customName}`;
      records.push({ entry: { key, item: null, isCustom: false }, savedTemporal: layer,
        error: layer.customName === "Second" ? "This observation is unavailable." : null });
      return key;
    },
  });
  await controller.openSharedFragment(await encodeSavedMapViewFragment(serializeSavedMapView(saved), {
    maximumInputBytes: 512 * 1024,
  }));
  assert.equal(view.result.loaded, 3);
  assert.deepEqual(order, [["local:temporal:First", records[1].entry.key, "local:temporal:Second"]]);
  assert.match(records[2].error, /unavailable/);
  assert.deepEqual(records.map(record => record.entry.isCustom), [false, false, true]);
  await controller.copyMapLink();
  const copied = JSON.parse(await decodeSavedMapViewFragment(view.fragment, { maximumOutputBytes: 512 * 1024 }));
  assert.deepEqual(copied.layers, saved.layers);
  controller.destroy();
});

test("superseded temporal restoration cannot add a late row or commit its saved view", async () => {
  const view = createView();
  let begin, release;
  const started = new Promise(resolve => { begin = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const saved = { ...emptySavedMap(0, 0, 3), layers: [{
    temporalSource: { collectionId: "eolab-temporal-datasets", itemId: "era5",
      variable: "air_temperature", time: "2020-01-15T12:00:00.000Z" },
    visible: true, opacity: 1,
    style: { kind: "raster", appearanceVersion: 1, mode: "continuous",
      continuous: { definition: { ...DEFAULT_RASTER_STYLE }, paletteName: "custom", styleWasEdited: true },
      categorical: null },
  }] };
  const controller = createController({ view,
    viewerVersion: "0.9.0", viewerOrigin: saved.viewer.origin,
    viewport: { restore: () => assert.fail("superseded viewport restored") },
    catalogVisualization: { clear() {} },
    mapLayers: { retainedRecords: [], commitStaged() { assert.fail("superseded view committed"); } },
    restoreTemporal: async (_layer, isCurrent) => {
      begin(); await waiting;
      assert.equal(isCurrent(), false);
      return null;
    },
  });
  const opening = controller.openSharedFragment(await encodeSavedMapViewFragment(serializeSavedMapView(saved), {
    maximumInputBytes: 512 * 1024,
  }));
  await started;
  controller.destroy(); release(); await opening;
  assert.equal(view.result, null);
});
