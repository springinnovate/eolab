import assert from "node:assert/strict";
import test from "node:test";

import { getCatalogItemKey } from "../../src/catalog-item-identity.js";
import { SavedMapViewController } from "../../src/saved-map-view/controller.js";
import { createSavedMapView, serializeSavedMapView } from "../../src/saved-map-view/model.js";

const ZERO_REVISION = `sha256:${"0".repeat(64)}`;

/**
 * Create an inspectable view boundary for controller tests.
 *
 * @return {Object} Mutable saved-map presentation test double.
 */
function createView() {
  return {
    busy: [],
    confirmation: null,
    result: null,
    error: null,
    bind(handlers) { this.handlers = handlers; },
    unbind() { this.handlers = null; },
    setBusy(value) { this.busy.push(value); },
    download(content, filename) { this.downloaded = { content, filename }; },
    async confirmOpen(...arguments_) {
      this.confirmation = arguments_;
      return true;
    },
    showResults(result) { this.result = result; },
    showLoading(layerCount) { this.loading = layerCount; },
    showError(error) { this.error = error; },
  };
}

/**
 * Return a digest implementation with a stable non-secret fingerprint.
 *
 * @return {{digest:()=>Promise<ArrayBuffer>}} Test SubtleCrypto subset.
 */
function zeroDigest() {
  return { digest: async () => new Uint8Array(32).buffer };
}

test("saved map controller exports ordered Catalog layers and current viewport", async () => {
  const view = createView();
  const item = { collection: "vectors", id: "roads" };
  const record = {
    entry: { item, visible: true, opacity: 0.4, label: "Roads" },
    adapter: {
      exportSavedState: () => ({ kind: "vector", definition: { width: 2 } }),
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

  await controller.save();

  const downloaded = JSON.parse(view.downloaded.content);
  assert.equal(view.downloaded.filename,
    "eolab-map-view-2026-09-01T12-00-00Z.eolab-map.json");
  assert.deepEqual(downloaded.layers[0].catalogItem, item);
  assert.equal(downloaded.layers[0].sourceRevision, ZERO_REVISION);
  assert.deepEqual(view.busy, [true, false]);
});

test("saved map controller confirms, restores bottom-first, and reports each layer", async () => {
  const view = createView();
  const viewportCalls = [];
  const records = new Map();
  const calls = [];
  const mapLayers = {
    retainedRecords: [{ entry: { item: { collection: "old", id: "layer" } } }],
    getRecord: (key) => records.get(key) ?? null,
    setOpacity(key, opacity) { calls.push(["opacity", key, opacity]); },
    setVisible(key, visible) {
      records.get(key).entry.visible = visible;
      calls.push(["visible", key, visible]);
    },
    render() { calls.push(["render"]); },
  };
  const catalogVisualization = {
    clear() {
      calls.push(["clear"]);
      mapLayers.retainedRecords = [];
      records.clear();
    },
    assess: async (item) => ({ ...item, assessed: true }),
    sourceRevision: () => ["current"],
    async show(item) {
      calls.push(["show", item.id]);
      const record = {
        entry: { item, visible: true, opacity: 1, label: item.id.toUpperCase() },
        adapter: {
          async applySavedState(_record, style) {
            calls.push(["style", item.id, style.kind]);
          },
        },
      };
      records.set(getCatalogItemKey(item), record);
      mapLayers.retainedRecords.unshift(record);
      return { layerName: item.id };
    },
  };
  const saved = createSavedMapView({
    viewer: { version: "0.1.0", origin: "https://other.example" },
    createdAt: "2026-09-01T12:00:00Z",
    viewport: { center: { latitude: 3, longitude: 4 }, zoom: 5 },
    layers: [
      {
        catalogItem: { collection: "vectors", id: "top" },
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
      restore: (value) => viewportCalls.push(value),
    },
    mapLayers,
    catalogVisualization,
    catalogItems: { get: async (identity) => ({ ...identity }) },
    viewerVersion: "0.2.0",
    viewerOrigin: "https://viewer.example",
    subtleCrypto: zeroDigest(),
  });

  await controller.open({
    size: 100,
    text: async () => serializeSavedMapView(saved),
  });

  assert.deepEqual(calls.filter(([kind]) => kind === "show"), [
    ["show", "bottom"],
    ["show", "top"],
  ]);
  assert.equal(view.confirmation[1], 1);
  assert.equal(view.result.loaded, 2);
  assert.equal(view.loading, 2);
  assert.match(view.result.details[0], /TOP: loaded \(source changed/);
  assert.match(view.result.details[1], /BOTTOM: loaded\./);
  assert.deepEqual(viewportCalls, [saved.viewport]);
});

test("saved map controller leaves the current map unchanged after cancellation", async () => {
  const view = createView();
  view.confirmOpen = async () => false;
  let cleared = false;
  const saved = createSavedMapView({
    viewer: { version: "0.2.0", origin: "https://viewer.example" },
    createdAt: "2026-09-01T12:00:00Z",
    viewport: { center: { latitude: 0, longitude: 0 }, zoom: 2 },
    layers: [],
  });
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

  await controller.open({ size: 10, text: async () => serializeSavedMapView(saved) });

  assert.equal(cleared, false);
  assert.equal(view.result, null);
});
