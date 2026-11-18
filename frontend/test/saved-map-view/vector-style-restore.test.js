import assert from "node:assert/strict";
import test from "node:test";

import { SavedMapViewController } from "../../src/saved-map-view/controller.js";
import { decodeSavedMapViewFragment, encodeSavedMapViewFragment } from "../../src/saved-map-view/fragment-codec.js";
import { createSavedMapView, MAX_SAVED_MAP_VIEW_BYTES, parseSavedMapView, serializeSavedMapView } from "../../src/saved-map-view/model.js";
import { createVectorMapLayerAdapter } from "../../src/vector/map-layer-adapter.js";
import { SpatialFilterViews } from "../../src/vector/spatial-filter.js";

const ORIGIN = "https://viewer.example";
const VIEWPORT = { center: { latitude: 0, longitude: 0 }, zoom: 3 };
const BASE_STYLE = {
  geometryKind: "polygon", fillColor: "#2563eb", fillOpacity: 0.7,
  strokeColor: "#1e3a8a", strokeOpacity: 1, strokeWidth: 1, pointSize: null,
  categorical: null, graduated: null, label: null,
};
const CATALOG_ITEM = {
  collection: "vectors", id: "measurements", properties: {
    title: "Measurements", "table:primary_geometry": "geometry",
    "table:columns": [{ name: "geometry", type: "Polygon" }, { name: "score", type: "float64" }],
  },
};

/**
 * Build a two-color appearance with a user-chosen boundary.
 * @param {number} boundary Maximum of the lower color class.
 * @param {string} [field="score"] Numeric source or calculated field.
 * @return {Object} Complete vector appearance accepted by the style adapter.
 */
function graduatedStyle(boundary, field = "score") {
  return { ...BASE_STYLE, graduated: {
    field, method: "equal-interval", classCount: 2, palette: "viridis", missingColor: "#d1d5db",
    rules: [{ minimum: null, maximum: boundary, color: "#440154" },
      { minimum: boundary, maximum: null, color: "#fde725" }],
  } };
}

/**
 * Evaluate the WMS numeric-rule contract for one nonmissing feature value.
 * @param {Object} style Complete graduated vector style sent to WMS.
 * @param {number} value Original feature value.
 * @return {string|undefined} Color of the matching class.
 */
function featureColor(style, value) {
  return style.graduated.rules.find(rule =>
    (rule.minimum === null || value > rule.minimum) &&
    (rule.maximum === null || value <= rule.maximum))?.color;
}

/**
 * Connect real saved-map and vector owners to controlled Catalog, styling and WMS transports.
 * @param {number} automaticBoundary Classification returned for the original source.
 * @return {Object} Controllers, staged records and observable external-boundary calls.
 */
function createVectorRestoreFixture(automaticBoundary) {
  const records = [], classifications = [], styleCalls = [], filterCalls = [];
  const adapter = createVectorMapLayerAdapter({
    leaflet: { tileLayer: { wms: (_url, parameters) => ({
      wmsParams: { ...parameters }, on: () => {}, once: () => {}, remove: () => {},
      setParams(next) { Object.assign(this.wmsParams, next); },
    }) } },
    leafletMap: {}, wmsUrl: "/wms", onTileError: () => {}, fitToBounds: false,
    publish: async () => ({ layerName: "eolab:measurements", styleName: "uniform",
      bbox: [-1, -1, 1, 1], geometryKind: "polygon", style: BASE_STYLE }),
    style: async (source, style) => {
      styleCalls.push({ source: structuredClone(source), style: structuredClone(style) });
      return { styleName: `accepted-${styleCalls.length}`, style };
    },
    classify: async (source, field, method, classCount) => {
      classifications.push({ source, field, method, classCount });
      return { field, method, actualClassCount: 2, nullCount: 1, classes: [
        { minimum: null, maximum: automaticBoundary, count: 2 },
        { minimum: automaticBoundary, maximum: null, count: 2 },
      ] };
    },
    filter: async (source, filter) => {
      filterCalls.push({ source: structuredClone(source), filter: structuredClone(filter) });
      return { layerName: "eolab:filtered-measurements" };
    },
    countFilter: async () => ({ matched: 2, total: 4, complete: true }),
  });
  /**
   * Publish a detached vector record using its actual adapter lifecycle.
   * @param {Object} item Catalog metadata returned by source lookup.
   * @param {Object} presentation Retained-layer identity and display settings.
   * @return {Promise<Object>} Detached record and its WMS layer.
   */
  async function stage(item, presentation) {
    const publication = await adapter.publish(item);
    const record = { adapter, publication, entry: { item, label: item.id, ...presentation },
      state: adapter.createState({ item, publication }) };
    const layer = adapter.createLayer(record, () => {});
    return { record, layer };
  }
  const view = {
    result: null, fragment: null, bind: () => {}, setBusy: () => {}, showLoading: () => {},
    setUnavailableLayerCount: () => {}, hideUndoReset: () => {}, showCopied: () => {},
    showError: error => { throw error; },
    showResults: result => { view.result = result; },
    copyLink: async fragment => { view.fragment = fragment; return { copied: true }; },
  };
  const controller = new SavedMapViewController({
    view, viewerOrigin: ORIGIN, viewerVersion: "test",
    viewport: { snapshot: () => VIEWPORT, restore: () => {} },
    mapLayers: { retainedRecords: records,
      commitStaged: staged => { records.push(...staged.map(value => value.record)); },
      setLegendIncluded: (key, included) => { records.find(record => record.entry.key === key).entry.legendIncluded = included; },
    },
    catalogItems: { get: async identity => {
      assert.deepEqual(identity, { collection: CATALOG_ITEM.collection, id: CATALOG_ITEM.id });
      return structuredClone(CATALOG_ITEM);
    } },
    catalogVisualization: { prepare: async item => item, stage, clear: () => { records.length = 0; } },
    exportTemporal: () => null, restoreTemporal: async () => { assert.fail("Unexpected temporal source"); },
    exportUpload: () => null, restoreUpload: async () => { assert.fail("Unexpected private upload"); },
  });
  return { controller, adapter, stage, records, view, classifications, styleCalls, filterCalls };
}

/**
 * Round-trip exported vector views through the portable document and compressed map link.
 * @param {Object[]} layers Exported layer settings with Catalog identity.
 * @return {Promise<string>} Encoded share fragment consumed by the real controller.
 */
async function savedFragment(layers) {
  return encodeSavedMapViewFragment(serializeSavedMapView(createSavedMapView({
    viewer: { origin: ORIGIN, version: "test" }, createdAt: "2026-11-16T12:00:00Z",
    viewport: VIEWPORT, layers,
  })), { maximumInputBytes: MAX_SAVED_MAP_VIEW_BYTES });
}

for (const { boundary, automatic, value, color } of [
  { boundary: 80, automatic: 50, value: 60, color: "#440154" },
  { boundary: -5, automatic: 0, value: -2, color: "#fde725" },
]) {
  test(`saved Catalog maps retain edited boundary ${boundary} and feature ${value}'s color after reopen and resave`, async () => {
    const f = createVectorRestoreFixture(automatic);
    const { record } = await f.stage(CATALOG_ITEM, { key: "original", visible: false, opacity: 0.6, isCustom: true });
    await f.adapter.applyStyle(record, graduatedStyle(boundary));
    const saved = { catalogItem: { collection: CATALOG_ITEM.collection, id: CATALOG_ITEM.id },
      isCustom: true, visible: false, opacity: 0.6, customName: "Chosen threshold", legendIncluded: false,
      style: f.adapter.exportSavedState(record), calculatedFields: [],
      filter: { enabled: true, match: "all", rules: [{ field: "score", operator: "gt", value: boundary - 10 }] },
    };
    assert.equal(featureColor(saved.style.definition, value), color);
    await f.controller.openSharedFragment(await savedFragment([saved]));
    assert.deepEqual(f.view.result, { loaded: 1, total: 1, details: [] });
    const restored = f.records[0];
    const rendered = JSON.parse(restored.state.layer.wmsParams.vector_style);
    assert.deepEqual(rendered, saved.style.definition);
    assert.equal(featureColor(rendered, value), color);
    assert.deepEqual(f.adapter.exportFilterState(restored), saved.filter);
    assert.equal(restored.entry.visible, false);
    assert.equal(restored.entry.opacity, 0.6);
    assert.equal(restored.entry.customName, saved.customName);
    assert.deepEqual(f.classifications.map(call => call.classCount), [5, 5], "only initial publication classifies");
    await f.controller.copyMapLink();
    const resaved = parseSavedMapView(await decodeSavedMapViewFragment(f.view.fragment, { maximumOutputBytes: MAX_SAVED_MAP_VIEW_BYTES }));
    assert.deepEqual(resaved.layers, [saved]);

    const targetItem = { ...CATALOG_ITEM, id: "other-measurements" };
    const target = (await f.stage(targetItem, { key: "paste-target" })).record;
    const classificationCount = f.classifications.length;
    await f.adapter.applySavedState(target, saved.style);
    assert.equal(f.classifications.length, classificationCount + 1, "cross-source paste still reclassifies");
    assert.equal(f.classifications.at(-1).source.id, targetItem.id);
    assert.equal(target.state.style.graduated.rules[0].maximum, automatic);
    assert.notEqual(featureColor(target.state.style, value), color);
    assert.equal(featureColor(JSON.parse(restored.state.layer.wmsParams.vector_style), value), color);
  });
}

test("reopening an intersection selects the hidden duplicate and exports only its view ID", async t => {
  const f = createVectorRestoreFixture(50);
  const id = "00000000-0000-4000-8000-000000000042";
  const condition = {operator: "intersects", layerId: id};
  const predicate = {enabled: true, match: "all", rules: [condition]};
  const east = {enabled: true, match: "all", rules: [{field: "score", operator: "gt", value: 50}]};
  const item = {...CATALOG_ITEM, properties: {...CATALOG_ITEM.properties,
    "eolab:vector_source": {layer_name: "measurements", asset_key: "data"}}};
  const {record} = await f.stage(item, {key: "first", visible: true, opacity: 1});
  const base = {catalogItem: {collection: item.collection, id: item.id}, visible: true, opacity: 1,
    isCustom: true, calculatedFields: [], style: f.adapter.exportSavedState(record)};
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const selection = JSON.parse(options.body).selection;
    requests.push(selection.filter);
    return Response.json({layerName: "eolab:filtered-view", count: {matched: 0, total: 8, complete: true}});
  });
  await f.controller.openSharedFragment(await savedFragment([
    {...base, customName: "Parcels", filter: predicate},
    {...base, customName: "Zones copy", visible: false, filterViewId: id, filter: east},
    {...base, customName: "Zones", filter: {...east, rules: []}},
  ]));
  assert.deepEqual(f.view.result, {loaded: 3, total: 3, details: []});
  assert.deepEqual(requests[0].rules[0].source, {kind: "drawing", polygonArea: null});
  const target = f.records.find(view => view.entry.customName === "Parcels");
  const views = new SpatialFilterViews({layers: () => f.records.map(view => ({
    key: view.entry.key, id: view.filterViewId, selection: {collectionId: item.collection, itemId: item.id,
      assetKey: "data", layerName: "measurements"}, filter: f.adapter.exportFilterState(view),
  }))});
  const captured = await views.bind(target.entry.key, target.requestedSpatialFilter);
  assert.deepEqual(captured.rules[0].source.filter, east);
  await f.adapter.applyFilterState(target, captured);
  delete target.requestedSpatialFilter;
  await f.controller.copyMapLink();
  const resaved = parseSavedMapView(await decodeSavedMapViewFragment(f.view.fragment, {maximumOutputBytes: MAX_SAVED_MAP_VIEW_BYTES}));
  assert.deepEqual(resaved.layers.find(view => view.customName === "Parcels").filter, predicate);
  assert.equal(resaved.layers.find(view => view.filterViewId === id).visible, false);
});

test("independent custom views of the same Catalog source retain different saved breaks", async () => {
  const f = createVectorRestoreFixture(50);
  const layers = [80, 20].map((boundary, index) => ({
    catalogItem: { collection: CATALOG_ITEM.collection, id: CATALOG_ITEM.id },
    isCustom: true, visible: index === 0, opacity: index === 0 ? 0.6 : 1,
    customName: `Threshold ${boundary}`, style: { kind: "vector", definition: graduatedStyle(boundary) },
    filter: { enabled: false, match: "all", rules: [] }, calculatedFields: [],
  }));
  await f.controller.openSharedFragment(await savedFragment(layers));
  assert.deepEqual(f.view.result, { loaded: 2, total: 2, details: [] });
  assert.notEqual(f.records[0].entry.key, f.records[1].entry.key);
  assert.deepEqual(f.records.map(record => featureColor(JSON.parse(record.state.layer.wmsParams.vector_style), 60)),
    ["#440154", "#fde725"]);
  await f.controller.copyMapLink();
  assert.deepEqual(parseSavedMapView(await decodeSavedMapViewFragment(f.view.fragment, { maximumOutputBytes: MAX_SAVED_MAP_VIEW_BYTES })).layers, layers);
});

test("saved vector restoration still validates geometry, fields and unsupported style data", async () => {
  for (const definition of [
    { ...graduatedStyle(80), geometryKind: "point", pointSize: 8 },
    graduatedStyle(80, "missing"),
    { ...graduatedStyle(80), unsupported: true },
  ]) {
    const f = createVectorRestoreFixture(50);
    await f.controller.openSharedFragment(await savedFragment([{
      catalogItem: { collection: CATALOG_ITEM.collection, id: CATALOG_ITEM.id },
      visible: true, opacity: 1, style: { kind: "vector", definition },
    }]));
    assert.equal(f.view.result.loaded, 1);
    assert.match(f.view.result.details[0], /saved style was not applied/);
    assert.equal(f.records[0].state.style.graduated.rules[0].maximum, 50);
  }
});

test("saved uniform vector appearance replaces automatic numeric colors exactly", async () => {
  const f = createVectorRestoreFixture(50);
  const saved = { catalogItem: { collection: CATALOG_ITEM.collection, id: CATALOG_ITEM.id },
    visible: true, opacity: 1, isCustom: false,
    style: { kind: "vector", definition: { ...BASE_STYLE, fillColor: "#00aa33", strokeWidth: 3 } },
    filter: { enabled: false, match: "all", rules: [] }, calculatedFields: [],
  };
  await f.controller.openSharedFragment(await savedFragment([saved]));
  assert.deepEqual(f.view.result, { loaded: 1, total: 1, details: [] });
  assert.deepEqual(JSON.parse(f.records[0].state.layer.wmsParams.vector_style), saved.style.definition);
  await f.controller.copyMapLink();
  assert.deepEqual(parseSavedMapView(await decodeSavedMapViewFragment(f.view.fragment, { maximumOutputBytes: MAX_SAVED_MAP_VIEW_BYTES })).layers, [saved]);
});

test("saved calculated fields are installed before restoring their exact style and filter", async t => {
  const f = createVectorRestoreFixture(50);
  const calculatedFields = [{ version: 1, name: "Scaled", expression: "'score' * 2", numericText: false }];
  t.mock.method(globalThis, "fetch", async (url, request) => {
    assert.equal(url, "/api/vector-calculations");
    assert.deepEqual(JSON.parse(request.body), {
      source: { collectionId: CATALOG_ITEM.collection, itemId: CATALOG_ITEM.id }, calculatedFields,
    });
    return Response.json({ calculatedFields, fields: { score: "float64", Scaled: "float64" },
      featureCount: 4, missingCounts: { Scaled: 0 } });
  });
  const saved = { catalogItem: { collection: CATALOG_ITEM.collection, id: CATALOG_ITEM.id },
    visible: true, opacity: 1, isCustom: false, calculatedFields,
    style: { kind: "vector", definition: graduatedStyle(80, "Scaled") },
    filter: { enabled: true, match: "all", rules: [{ field: "Scaled", operator: "gt", value: 40 }] },
  };
  await f.controller.openSharedFragment(await savedFragment([saved]));
  assert.deepEqual(f.view.result, { loaded: 1, total: 1, details: [] });
  assert.deepEqual(f.styleCalls.at(-1).source.calculatedFields, calculatedFields);
  assert.deepEqual(f.filterCalls.at(-1).source.calculatedFields, calculatedFields);
  assert.deepEqual(JSON.parse(f.records[0].state.layer.wmsParams.vector_style), saved.style.definition);
  assert.deepEqual(JSON.parse(f.records[0].state.layer.wmsParams.vector_calculated_fields), calculatedFields);
  await f.controller.copyMapLink();
  assert.deepEqual(parseSavedMapView(await decodeSavedMapViewFragment(f.view.fragment, { maximumOutputBytes: MAX_SAVED_MAP_VIEW_BYTES })).layers, [saved]);
});
