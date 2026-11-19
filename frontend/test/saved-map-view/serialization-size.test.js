import assert from "node:assert/strict";
import test from "node:test";

import { createNamedMapFixture } from "../../test-support/named-map.js";
import { SavedMapViewController } from "../../src/saved-map-view/controller.js";
import {
  createSavedMapView,
  MAX_SAVED_MAP_VIEW_BYTES,
  parseSavedMapView,
  serializeSavedMapView,
} from "../../src/saved-map-view/model.js";
import { normalizeVectorStyle } from "../../src/vector/style.js";

/**
 * Build a valid map using category styles admitted by the vector owner.
 * @param {number} layerCount Number of independent vector layers.
 * @param {string} label Category label, including multibyte text when required.
 * @return {Readonly<Object>} Canonical saved-map document.
 */
function categoricalMap(layerCount, label) {
  const definition = normalizeVectorStyle({
    geometryKind: "polygon",
    fillColor: "#ffffff", fillOpacity: 0.4,
    strokeColor: "#123456", strokeOpacity: 0.8, strokeWidth: 2,
    categorical: {
      field: "habitat", limit: 50,
      rules: Array.from({ length: 50 }, (_, index) => ({
        value: { kind: "string", value: String(index).padEnd(256, "x") },
        label, color: "#008844", opacity: 1,
      })),
    },
  });
  return createSavedMapView({
    viewer: { version: "0.9.0", origin: "https://viewer.example" },
    createdAt: "2026-11-15T12:00:00Z",
    viewport: { center: { latitude: 0, longitude: 0 }, zoom: 2 },
    layers: Array.from({ length: layerCount }, (_, index) => ({
      catalogItem: { collection: "vectors", id: `habitat-${index}` },
      isCustom: false, visible: true, opacity: 1,
      style: { kind: "vector", definition },
    })),
  });
}

test("serialization bounds its final indented UTF-8 output and preserves accepted maps", () => {
  const accepted = categoricalMap(1, "湿地".repeat(100));
  const serialized = serializeSavedMapView(accepted);
  assert.ok(new TextEncoder().encode(serialized).byteLength <= MAX_SAVED_MAP_VIEW_BYTES);
  assert.deepEqual(parseSavedMapView(serialized), accepted);

  const oversized = categoricalMap(20, "x".repeat(256));
  assert.throws(() => serializeSavedMapView(oversized), /512 KiB.*Remove some layers/);

  // Character counts and compact JSON are both too small to detect this output.
  const multibyte = categoricalMap(11, "湿地".repeat(100));
  const compact = JSON.stringify(multibyte);
  const indented = `${JSON.stringify(multibyte, null, 2)}\n`;
  assert.ok(indented.length < MAX_SAVED_MAP_VIEW_BYTES);
  assert.ok(new TextEncoder().encode(compact).byteLength < MAX_SAVED_MAP_VIEW_BYTES);
  assert.ok(new TextEncoder().encode(indented).byteLength > MAX_SAVED_MAP_VIEW_BYTES);
  assert.throws(() => serializeSavedMapView(multibyte), /512 KiB/);
});

test("oversized remembering preserves the last valid map and later saves recover", async () => {
  const initial = categoricalMap(1, "Wetlands");
  const previous = serializeSavedMapView(initial);
  let remembered = previous;
  let writes = 0;
  let scheduled, publicationError;
  const publication = createNamedMapFixture();
  const mapLayers = { retainedRecords: [] };
  const controller = new SavedMapViewController({
    ...publication.author,
    view: {
      bind() {}, setBusy() {}, showPublicationForm() {}, setPublicationBusy() {},
      showPublicationError(message) { publicationError = message; },
    },
    viewport: { snapshot: () => initial.viewport },
    mapLayers, catalogVisualization: {}, catalogItems: {},
    viewerVersion: initial.viewer.version, viewerOrigin: initial.viewer.origin,
    exportTemporal: () => null,
    exportUpload: () => null,
    restoreTemporal: async () => null,
    restoreUpload: async () => null,
    storage: {
      read: () => remembered,
      write(value) { remembered = value; writes += 1; return true; },
      clear() { assert.fail("A failed save must not clear the previous map"); },
    },
    setTimer(handler) { scheduled = handler; return 1; },
    clearTimer() { scheduled = undefined; },
    clock: () => new Date(initial.createdAt),
  });

  /**
   * Present saved layer data through the actual controller's retained-layer contract.
   * @param {Object} document Valid map to present as current live layers.
   * @return {void}
   */
  function showMap(document) {
    mapLayers.retainedRecords = document.layers.map(layer => ({
      entry: { item: layer.catalogItem, isCustom: false, visible: true, opacity: 1 },
      adapter: { exportSavedState: () => layer.style },
    }));
  }

  showMap(categoricalMap(20, "x".repeat(256)));
  controller.scheduleRemember();
  assert.doesNotThrow(() => scheduled());
  assert.equal(writes, 0);
  assert.equal(remembered, previous);
  assert.deepEqual(parseSavedMapView(remembered), initial);
  await controller.openPublicationDialog();
  await controller.publishMap({ title: "Wetlands", slug: "wetlands", subtitle: "" });
  assert.match(publicationError, /512 KiB/);
  assert.equal(publication.record.view, null);

  showMap(initial);
  controller.scheduleRemember();
  scheduled();
  assert.equal(writes, 1);
  assert.deepEqual(parseSavedMapView(remembered), initial);
});

test("undo restores an oversized live map and completes its controls without replacing valid storage", async () => {
  const oversized = categoricalMap(20, "x".repeat(256));
  let remembered;
  let scheduled;
  let undoVisible = false;
  const mapLayers = {
    retainedRecords: oversized.layers.map(layer => ({
      entry: { item: layer.catalogItem, isCustom: false, visible: true, opacity: 1 },
      adapter: { exportSavedState: () => layer.style },
    })),
    commitStaged(staged) { this.retainedRecords = staged.map(({ record }) => record); },
    setLegendIncluded() {},
  };
  const controller = new SavedMapViewController({
    view: {
      bind() {}, setBusy() {}, setUnavailableLayerCount() {},
      showUndoReset() { undoVisible = true; },
      hideUndoReset() { undoVisible = false; },
      showError(error) { assert.fail(error.message); },
    },
    viewport: { snapshot: () => oversized.viewport, restore() {} },
    initialViewport: oversized.viewport,
    mapLayers,
    catalogVisualization: {
      clear() { mapLayers.retainedRecords = []; },
      prepare: async item => item,
      stage: async (item, presentation) => ({ record: {
        entry: { item, ...presentation },
        adapter: {
          applySavedState() {},
          exportSavedState: () => oversized.layers[0].style,
        },
      } }),
    },
    catalogItems: { get: async identity => identity },
    viewerVersion: oversized.viewer.version, viewerOrigin: oversized.viewer.origin,
    exportTemporal: () => null, exportUpload: () => null,
    restoreTemporal: async () => null, restoreUpload: async () => null,
    storage: {
      read: () => remembered,
      write(value) { remembered = value; return true; },
      clear() { assert.fail("Undo must not clear valid storage"); },
    },
    setTimer(handler) { scheduled = handler; return 1; },
    clearTimer() { scheduled = undefined; },
    clock: () => new Date(oversized.createdAt),
  });

  await controller.resetView();
  assert.equal(mapLayers.retainedRecords.length, 0);
  assert.equal(undoVisible, true);
  const resetSnapshot = remembered;
  assert.deepEqual(parseSavedMapView(resetSnapshot).layers, []);

  await controller.undoReset();
  assert.equal(mapLayers.retainedRecords.length, 20);
  assert.equal(undoVisible, false);
  assert.equal(remembered, resetSnapshot);
  assert.doesNotThrow(() => scheduled());
  assert.equal(remembered, resetSnapshot);
  await controller.resetView();
  assert.equal(mapLayers.retainedRecords.length, 0);
  assert.equal(undoVisible, true);
});
