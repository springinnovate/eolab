import assert from "node:assert/strict";
import test from "node:test";

import { initializeRasterDetailPreview } from "../../src/raster/detail-preview-controller.js";
import {
  CENTER_SAMPLE_DETAIL_PREVIEW,
  CURRENT_VIEW_DETAIL_PREVIEW,
  EXACT_CURRENT_VIEW_DETAIL_PREVIEW,
  MOUNTED_GEOTIFF_ITEM,
  NODATA_DETAIL_PREVIEW,
  PATCH_DETAIL_PREVIEW,
  REPRESENTATIVE_SAMPLE_DETAIL_PREVIEW,
} from "../../test-support/raster/fixtures.js";

/**
 * Return a promise with externally controlled settlement.
 *
 * @return {{promise:Promise,resolve:Function,reject:Function}} Deferred work.
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/**
 * Create an event-capable inspectable Leaflet map boundary.
 *
 * @param {Object} [overrides={}] Per-test map behavior.
 * @return {Object} Fake map with controllable zoom, bounds, and move events.
 */
function fakeMap(overrides = {}) {
  const listeners = new Map();
  const panes = new Map();
  let zoom = 4;
  let bounds = {
    getWest: () => -123,
    getSouth: () => 48,
    getEast: () => -121,
    getNorth: () => 50,
  };
  return {
    removeLayer() {},
    fitBounds() {},
    getBoundsZoom() { return 4; },
    getMinZoom() { return 0; },
    getPane(name) { return panes.get(name); },
    createPane(name) {
      const pane = { style: {} };
      panes.set(name, pane);
      return pane;
    },
    getZoom() { return zoom; },
    getBounds() { return bounds; },
    on(event, listener) { listeners.set(event, listener); },
    off(event, listener) {
      if (listeners.get(event) === listener) listeners.delete(event);
    },
    emit(event) { listeners.get(event)?.(); },
    setZoom(value) { zoom = value; },
    setBounds(value) { bounds = value; },
    listenerCount() { return listeners.size; },
    ...overrides,
  };
}

test("detail preview ignores stale mode responses even when abort loses", async () => {
  const requests = [];
  const added = [];
  const removed = [];
  const fits = [];
  const map = fakeMap({
    removeLayer(layer) { removed.push(layer); },
    fitBounds(bounds, options) { fits.push({ bounds, options }); },
  });
  const createPreviewLayer = (_leaflet, preview) => {
    const layer = {
      mode: preview.mode,
      addTo(target) {
        assert.equal(target, map);
        added.push(this);
      },
    };
    return { layer, focusBounds: [[48, -123], [50, -121]] };
  };
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      loadPreview(_item, { mode }, signal) {
        const work = deferred();
        requests.push({ mode, signal, work });
        return work.promise;
      },
      createPreviewLayer,
    },
  );

  const oldShow = controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample", "coarse");
  const currentShow = controller.show(
    MOUNTED_GEOTIFF_ITEM,
    "representativeSample",
    "coarse",
  );
  assert.equal(requests[0].signal.aborted, true);
  requests[1].work.resolve(REPRESENTATIVE_SAMPLE_DETAIL_PREVIEW);
  assert.equal((await currentShow).mode, "representativeSample");
  requests[0].work.resolve(CENTER_SAMPLE_DETAIL_PREVIEW);
  assert.equal(await oldShow, null);

  assert.deepEqual(added.map((layer) => layer.mode), ["representativeSample"]);
  assert.deepEqual(removed, []);
  assert.equal(fits.length, 1);
  assert.deepEqual(fits[0].options, { maxZoom: 8, animate: false });
  assert.equal(controller.contains(MOUNTED_GEOTIFF_ITEM), true);
});

test("a failed replacement preserves the current map preview", async () => {
  const removed = [];
  let fail = false;
  const layer = { addTo() {} };
  const controller = initializeRasterDetailPreview(
    {
      leafletMap: fakeMap({
        removeLayer(value) { removed.push(value); },
        fitBounds() {},
      }),
      leaflet: {},
    },
    {
      async loadPreview() {
        if (fail) {
          throw new Error("bounded read failed");
        }
        return CENTER_SAMPLE_DETAIL_PREVIEW;
      },
      createPreviewLayer() {
        return { layer, focusBounds: [[48, -123], [50, -121]] };
      },
    },
  );

  await controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample", "coarse");
  fail = true;
  await assert.rejects(
    controller.show(MOUNTED_GEOTIFF_ITEM, "representativeSample", "coarse"),
    /bounded read failed/,
  );
  assert.equal(controller.contains(MOUNTED_GEOTIFF_ITEM), true);
  assert.deepEqual(removed, []);
});

test("successful replacement is atomic and preserves full-extent map focus", async () => {
  const events = [];
  const fits = [];
  const map = fakeMap({
    removeLayer(layer) { events.push(`remove:${layer.mode}`); },
    fitBounds(bounds, options) { fits.push({ bounds, options }); },
  });
  const previews = new Map([
    ["centerSample", CENTER_SAMPLE_DETAIL_PREVIEW],
    ["representativeSample", REPRESENTATIVE_SAMPLE_DETAIL_PREVIEW],
    ["representativePatch", PATCH_DETAIL_PREVIEW],
  ]);
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      async loadPreview(_item, { mode }) { return previews.get(mode); },
      createPreviewLayer(_leaflet, preview) {
        const layer = {
          mode: preview.mode,
          addTo(target) {
            assert.equal(target, map);
            events.push(`add:${this.mode}`);
          },
        };
        return {
          layer,
          focusBounds: preview.mode === "representativePatch"
            ? [[48.9, -122.1], [49.1, -121.9]]
            : [[48, -123], [50, -121]],
          style: {},
        };
      },
    },
  );

  await controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample", "coarse");
  await controller.show(
    MOUNTED_GEOTIFF_ITEM,
    "representativeSample",
    "coarse",
  );

  assert.deepEqual(events, [
    "add:centerSample",
    "add:representativeSample",
    "remove:centerSample",
  ]);
  assert.equal(fits.length, 1);
  assert.deepEqual(fits[0].options, { maxZoom: 8, animate: false });

  await controller.show(MOUNTED_GEOTIFF_ITEM, "representativePatch", null);
  assert.deepEqual(events.slice(-2), [
    "add:representativePatch",
    "remove:representativeSample",
  ]);
  assert.equal(fits.length, 2);
  assert.deepEqual(fits[1].bounds, [[48.9, -122.1], [49.1, -121.9]]);
  assert.deepEqual(fits[1].options, { maxZoom: 16, animate: false });
});

test("style changes atomically recolor base and current-view sampled images", async () => {
  const events = [];
  const timers = [];
  const map = fakeMap({
    removeLayer(layer) { events.push(`remove:${layer.name}`); },
  });
  const defaultStyle = {
    minimum: 0,
    midpoint: 50,
    maximum: 100,
    minimumColor: "#0000ff",
    midpointColor: "#ffff00",
    maximumColor: "#ff0000",
  };
  const nextStyle = {
    ...defaultStyle,
    minimum: 10,
    midpoint: 20,
    maximum: 30,
  };
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      async loadPreview(_item, options) {
        return options.viewBounds === null
          ? CENTER_SAMPLE_DETAIL_PREVIEW
          : CURRENT_VIEW_DETAIL_PREVIEW;
      },
      createPreviewLayer(_leaflet, preview, options = {}) {
        const name = preview.scope === "currentView" ? "detail" : "base";
        return {
          layer: {
            name,
            addTo() { events.push(`add:${name}`); },
          },
          focusBounds: [[48, -123], [50, -121]],
          style: options.style ?? defaultStyle,
          dispose() {},
        };
      },
      setTimer(callback) {
        timers.push(callback);
        return callback;
      },
      clearTimer(timer) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    },
  );

  await controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample", "coarse");
  map.setZoom(5);
  map.emit("moveend");
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  controller.setStyle(MOUNTED_GEOTIFF_ITEM, nextStyle);

  assert.deepEqual(events, [
    "add:base",
    "add:detail",
    "add:base",
    "add:detail",
    "remove:detail",
    "remove:base",
  ]);
  assert.deepEqual(controller.getState().style, nextStyle);
  assert.equal(Object.isFrozen(controller.getState().style), false);
  assert.throws(
    () => controller.setStyle(
      { ...MOUNTED_GEOTIFF_ITEM, id: "geotiff-ffffffffffffffffffffffff" },
      nextStyle,
    ),
    /style target is not current/,
  );
});

test("same-item reassessment refits when its raster focus changes", async () => {
  const fits = [];
  let currentPreview = CENTER_SAMPLE_DETAIL_PREVIEW;
  const map = fakeMap({
    fitBounds(bounds) { fits.push(bounds); },
  });
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      async loadPreview() { return currentPreview; },
      createPreviewLayer(_leaflet, preview) {
        return {
          layer: { addTo() {} },
          focusBounds: [
            [preview.rasterExtent[1], preview.rasterExtent[0]],
            [preview.rasterExtent[3], preview.rasterExtent[2]],
          ],
          style: {},
        };
      },
    },
  );

  await controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample", "coarse");
  currentPreview = {
    ...CENTER_SAMPLE_DETAIL_PREVIEW,
    rasterExtent: [-124, 47, -120, 51],
    imageBounds: [-123.9, 47.1, -120.1, 50.9],
  };
  await controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample", "coarse");

  assert.deepEqual(fits, [
    [[48, -123], [50, -121]],
    [[47, -124], [51, -120]],
  ]);
});

test("detail refinement starts above the map-minimum-clamped fit zoom", async () => {
  const timers = [];
  let zoom = 2;
  const map = fakeMap({
    fitBounds() {},
    getBoundsZoom() { return 0; },
    getMinZoom() { return 2; },
    getZoom() { return zoom; },
  });
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      async loadPreview(_item, options) {
        return options.viewBounds === null
          ? CENTER_SAMPLE_DETAIL_PREVIEW
          : CURRENT_VIEW_DETAIL_PREVIEW;
      },
      createPreviewLayer() {
        return {
          layer: { addTo() {} },
          focusBounds: [[48, -123], [50, -121]],
          style: {},
        };
      },
      setTimer(callback) {
        timers.push(callback);
        return callback;
      },
      clearTimer(timer) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    },
  );

  await controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample", "coarse");
  assert.equal(timers.length, 0);
  zoom = 3;
  map.emit("moveend");
  assert.equal(timers.length, 1);
});

test("failed construction or map attachment cannot remove the current layer", async () => {
  const removed = [];
  let nextFailure = null;
  const map = fakeMap({
    removeLayer(layer) { removed.push(layer.mode); },
    fitBounds() {},
  });
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      async loadPreview(_item, { mode }) {
        return mode === "centerSample"
          ? CENTER_SAMPLE_DETAIL_PREVIEW
          : REPRESENTATIVE_SAMPLE_DETAIL_PREVIEW;
      },
      createPreviewLayer(_leaflet, preview) {
        if (nextFailure === "construct") {
          throw new Error("image construction failed");
        }
        return {
          layer: {
            mode: preview.mode,
            addTo() {
              if (nextFailure === "attach") {
                throw new Error("image attachment failed");
              }
            },
          },
          focusBounds: [[48, -123], [50, -121]],
          style: {},
        };
      },
    },
  );

  await controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample", "coarse");
  nextFailure = "construct";
  await assert.rejects(
    controller.show(MOUNTED_GEOTIFF_ITEM, "representativeSample", "coarse"),
    /construction failed/,
  );
  assert.deepEqual(removed, []);
  assert.equal(controller.contains(MOUNTED_GEOTIFF_ITEM), true);

  nextFailure = "attach";
  await assert.rejects(
    controller.show(MOUNTED_GEOTIFF_ITEM, "representativeSample", "coarse"),
    /attachment failed/,
  );
  assert.deepEqual(removed, ["representativeSample"]);
  assert.equal(controller.contains(MOUNTED_GEOTIFF_ITEM), true);
});

test("detail preview ignores a stale Item using the same proxy mode", async () => {
  const requests = [];
  const added = [];
  const secondItem = {
    ...MOUNTED_GEOTIFF_ITEM,
    id: "geotiff-fedcba9876543210fedcba98",
  };
  const map = fakeMap();
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      loadPreview(item, { mode }, signal) {
        const work = deferred();
        requests.push({ item, mode, signal, work });
        return work.promise;
      },
      createPreviewLayer(_leaflet, preview) {
        return {
          layer: { addTo() { added.push(preview); } },
          focusBounds: [[48, -123], [50, -121]],
          style: {},
        };
      },
    },
  );

  const staleShow = controller.show(
    MOUNTED_GEOTIFF_ITEM,
    "centerSample",
    "coarse",
  );
  const currentShow = controller.show(secondItem, "centerSample", "coarse");
  assert.equal(requests[0].signal.aborted, true);
  requests[1].work.resolve(CENTER_SAMPLE_DETAIL_PREVIEW);
  assert.equal(await currentShow, CENTER_SAMPLE_DETAIL_PREVIEW);
  requests[0].work.resolve(CENTER_SAMPLE_DETAIL_PREVIEW);
  assert.equal(await staleShow, null);

  assert.deepEqual(added, [CENTER_SAMPLE_DETAIL_PREVIEW]);
  assert.equal(controller.contains(secondItem), true);
  assert.equal(controller.contains(MOUNTED_GEOTIFF_ITEM), false);
});

test("removing a sampled raster prevents a late request from restoring it", async () => {
  const added = [];
  const work = deferred();
  const map = fakeMap();
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      loadPreview(_item, _options, signal) {
        assert.equal(signal.aborted, false);
        return work.promise;
      },
      createPreviewLayer() {
        return {
          layer: { addTo() { added.push(this); } },
          focusBounds: [[48, -123], [50, -121]],
        };
      },
    },
  );

  const pending = controller.show(
    MOUNTED_GEOTIFF_ITEM,
    "centerSample",
    "coarse",
  );
  controller.remove();
  work.resolve(CENTER_SAMPLE_DETAIL_PREVIEW);

  assert.equal(await pending, null);
  assert.deepEqual(added, []);
  assert.equal(controller.contains(MOUNTED_GEOTIFF_ITEM), false);
});

test("zoom and pan replace sampled or exact current detail without stale flashes", async () => {
  const requests = [];
  const events = [];
  const timers = new Map();
  let nextTimer = 1;
  const map = fakeMap();
  const sessionStyle = { minimum: 0, midpoint: 50, maximum: 100 };
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      loadPreview(_item, options, signal) {
        if (options.viewBounds === null) {
          return Promise.resolve(CENTER_SAMPLE_DETAIL_PREVIEW);
        }
        const work = deferred();
        requests.push({ options, signal, work });
        return work.promise;
      },
      createPreviewLayer(_leaflet, preview, options = {}) {
        if (preview.scope === "currentView") {
          assert.equal(options.style, sessionStyle);
        }
        const presentation = {
          layer: {
            scope: preview.scope,
            bounds: preview.imageBounds,
            addTo() { events.push(`add:${preview.imageBounds.join(",")}`); },
          },
          focusBounds: [[48, -123], [50, -121]],
          style: sessionStyle,
          dispose() {},
        };
        return presentation;
      },
      setTimer(callback) {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      clearTimer(id) { timers.delete(id); },
      detailDebounceMilliseconds: 200,
    },
  );

  await controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample", "coarse");
  map.setZoom(5);
  map.setBounds({
    getWest: () => -122.8,
    getSouth: () => 48.2,
    getEast: () => -121.8,
    getNorth: () => 49.2,
  });
  map.emit("moveend");
  assert.equal(timers.size, 1);
  timers.values().next().value();
  timers.clear();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.density, "coarse");

  map.setBounds({
    getWest: () => -122.4,
    getSouth: () => 48.6,
    getEast: () => -121.4,
    getNorth: () => 49.6,
  });
  map.emit("moveend");
  assert.equal(requests[0].signal.aborted, true);
  timers.values().next().value();
  timers.clear();
  assert.equal(requests.length, 2);

  const currentResponse = {
    ...EXACT_CURRENT_VIEW_DETAIL_PREVIEW,
    imageBounds: [-122.4, 48.6, -121.4, 49.6],
  };
  requests[1].work.resolve(currentResponse);
  await new Promise((resolve) => setImmediate(resolve));
  requests[0].work.resolve(CURRENT_VIEW_DETAIL_PREVIEW);
  await new Promise((resolve) => setImmediate(resolve));

  const state = controller.getState(MOUNTED_GEOTIFF_ITEM);
  assert.equal(state.detailPreview, currentResponse);
  assert.equal(state.detailPreview.rendering, "exactSourceWindow");
  assert.equal(state.detailStatus, "ready");
  assert.equal(events.length, 2);

  map.setBounds({
    getWest: () => -122.1,
    getSouth: () => 48.8,
    getEast: () => -121.1,
    getNorth: () => 49.8,
  });
  map.emit("moveend");
  timers.values().next().value();
  timers.clear();
  assert.equal(requests.length, 3);
  map.setBounds({
    getWest: () => -122.4,
    getSouth: () => 48.6,
    getEast: () => -121.4,
    getNorth: () => 49.6,
  });
  map.emit("moveend");
  assert.equal(requests[2].signal.aborted, true);
  assert.equal(timers.size, 0);
  assert.equal(controller.getState().detailPreview, currentResponse);
  assert.equal(controller.getState().detailStatus, "ready");

  map.setBounds({
    getWest: () => -122.2,
    getSouth: () => 48.7,
    getEast: () => -121.2,
    getNorth: () => 49.7,
  });
  map.emit("moveend");
  timers.values().next().value();
  timers.clear();
  requests[3].work.reject(new Error("bounded refinement failed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getState().detailPreview, currentResponse);
  assert.equal(controller.getState().detailStatus, "error");
  assert.equal(controller.getState().detailError, "bounded refinement failed");

  map.setZoom(4);
  map.emit("moveend");
  assert.equal(controller.getState().detailPreview, null);
  assert.equal(controller.getState().detailStatus, "none");
  controller.destroy();
  assert.equal(map.listenerCount(), 0);
});

test("first finite detail establishes style after an all-nodata base", async () => {
  const map = fakeMap();
  const timers = [];
  const styleInputs = [];
  const fallbackStyle = {
    minimum: 0,
    midpoint: 50,
    maximum: 100,
  };
  const establishedStyle = {
    minimum: 250000,
    midpoint: 275000,
    maximum: 300000,
  };
  const firstDetail = {
    ...CURRENT_VIEW_DETAIL_PREVIEW,
    pixelValues: [250000, 260000, 270000, 280000, 290000, 300000],
    suggestedRange: establishedStyle,
  };
  const laterDetail = {
    ...CURRENT_VIEW_DETAIL_PREVIEW,
    imageBounds: [-122.25, 48.75, -121.25, 49.75],
    pixelValues: [1000, 2000, 3000, 4000, 5000, 6000],
    suggestedRange: { minimum: 1000, midpoint: 3500, maximum: 6000 },
  };
  let detailRequestCount = 0;
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      async loadPreview(_item, options) {
        if (options.viewBounds === null) return NODATA_DETAIL_PREVIEW;
        detailRequestCount += 1;
        return detailRequestCount === 1 ? firstDetail : laterDetail;
      },
      createPreviewLayer(_leaflet, preview, options = {}) {
        styleInputs.push(options);
        const style = options.style ?? (
          preview.suggestedRange === null ? fallbackStyle : establishedStyle
        );
        return {
          layer: { addTo() {} },
          focusBounds: [[48, -123], [50, -121]],
          style,
          dispose() {},
        };
      },
      setTimer(callback) {
        timers.push(callback);
        return callback;
      },
      clearTimer(timer) {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      },
    },
  );

  await controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample", "coarse");
  map.setZoom(5);
  map.setBounds({
    getWest: () => -122.5,
    getSouth: () => 48.5,
    getEast: () => -121.5,
    getNorth: () => 49.5,
  });
  map.emit("moveend");
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));

  map.setBounds({
    getWest: () => -122.25,
    getSouth: () => 48.75,
    getEast: () => -121.25,
    getNorth: () => 49.75,
  });
  map.emit("moveend");
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(Object.hasOwn(styleInputs[1], "style"), false);
  assert.equal(styleInputs[2].style, establishedStyle);
  assert.equal(Object.isFrozen(styleInputs[2].style), true);
  assert.notEqual(styleInputs[2].style, fallbackStyle);
  assert.equal(controller.getState().detailPreview, laterDetail);
});
