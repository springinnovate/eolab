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

test("saved map controller copies ordered Catalog layers and current viewport", async () => {
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

  await controller.copyMapLink();

  const copied = JSON.parse(await decodeSavedMapViewFragment(view.fragment, {
    maximumOutputBytes: 512 * 1024,
  }));
  assert.deepEqual(copied.layers[0].catalogItem, item);
  assert.equal(copied.layers[0].sourceRevision, ZERO_REVISION);
  assert.equal(view.copied, true);
  assert.deepEqual(view.busy, [true, false]);
});

test("saved map controller restores bottom-first and reports exceptions", async () => {
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
    prepare: async (item) => ({ ...item, prepared: true }),
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

  await controller.openSharedFragment(await encodeSavedMapViewFragment(
    serializeSavedMapView(saved),
    { maximumInputBytes: 512 * 1024 },
  ));

  assert.deepEqual(calls.filter(([kind]) => kind === "show"), [
    ["show", "bottom"],
    ["show", "top"],
  ]);
  assert.equal(view.result.loaded, 2);
  assert.equal(view.loading, 2);
  assert.equal(view.result.details.length, 1);
  assert.match(view.result.details[0], /TOP: source changed/);
  assert.deepEqual(viewportCalls, [saved.viewport]);
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
