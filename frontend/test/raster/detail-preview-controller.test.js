import assert from "node:assert/strict";
import test from "node:test";

import { initializeRasterDetailPreview } from "../../src/raster/detail-preview-controller.js";
import {
  CENTER_SAMPLE_DETAIL_PREVIEW,
  MOUNTED_GEOTIFF_ITEM,
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

test("detail preview ignores stale mode responses even when abort loses", async () => {
  const requests = [];
  const added = [];
  const removed = [];
  const fits = [];
  const map = {
    removeLayer(layer) { removed.push(layer); },
    fitBounds(bounds, options) { fits.push({ bounds, options }); },
  };
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
      loadPreview(_item, mode, signal) {
        const work = deferred();
        requests.push({ mode, signal, work });
        return work.promise;
      },
      createPreviewLayer,
    },
  );

  const oldShow = controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample");
  const currentShow = controller.show(
    MOUNTED_GEOTIFF_ITEM,
    "representativeSample",
  );
  assert.equal(requests[0].signal.aborted, true);
  requests[1].work.resolve(REPRESENTATIVE_SAMPLE_DETAIL_PREVIEW);
  assert.equal((await currentShow).mode, "representativeSample");
  requests[0].work.resolve(CENTER_SAMPLE_DETAIL_PREVIEW);
  assert.equal(await oldShow, null);

  assert.deepEqual(added.map((layer) => layer.mode), ["representativeSample"]);
  assert.deepEqual(removed, []);
  assert.equal(fits.length, 1);
  assert.equal(controller.contains(MOUNTED_GEOTIFF_ITEM), true);
});

test("a failed replacement preserves the current map preview", async () => {
  const removed = [];
  let fail = false;
  const layer = { addTo() {} };
  const controller = initializeRasterDetailPreview(
    {
      leafletMap: {
        removeLayer(value) { removed.push(value); },
        fitBounds() {},
      },
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

  await controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample");
  fail = true;
  await assert.rejects(
    controller.show(MOUNTED_GEOTIFF_ITEM, "representativeSample"),
    /bounded read failed/,
  );
  assert.equal(controller.contains(MOUNTED_GEOTIFF_ITEM), true);
  assert.deepEqual(removed, []);
});

test("successful replacement is atomic and preserves full-extent map focus", async () => {
  const events = [];
  const fits = [];
  const map = {
    removeLayer(layer) { events.push(`remove:${layer.mode}`); },
    fitBounds(bounds, options) { fits.push({ bounds, options }); },
  };
  const previews = new Map([
    ["centerSample", CENTER_SAMPLE_DETAIL_PREVIEW],
    ["representativeSample", REPRESENTATIVE_SAMPLE_DETAIL_PREVIEW],
    ["representativePatch", PATCH_DETAIL_PREVIEW],
  ]);
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      async loadPreview(_item, mode) { return previews.get(mode); },
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

  await controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample");
  await controller.show(MOUNTED_GEOTIFF_ITEM, "representativeSample");

  assert.deepEqual(events, [
    "add:centerSample",
    "add:representativeSample",
    "remove:centerSample",
  ]);
  assert.equal(fits.length, 1);

  await controller.show(MOUNTED_GEOTIFF_ITEM, "representativePatch");
  assert.deepEqual(events.slice(-2), [
    "add:representativePatch",
    "remove:representativeSample",
  ]);
  assert.equal(fits.length, 2);
  assert.deepEqual(fits[1].bounds, [[48.9, -122.1], [49.1, -121.9]]);
});

test("failed construction or map attachment cannot remove the current layer", async () => {
  const removed = [];
  let nextFailure = null;
  const map = {
    removeLayer(layer) { removed.push(layer.mode); },
    fitBounds() {},
  };
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      async loadPreview(_item, mode) {
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

  await controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample");
  nextFailure = "construct";
  await assert.rejects(
    controller.show(MOUNTED_GEOTIFF_ITEM, "representativeSample"),
    /construction failed/,
  );
  assert.deepEqual(removed, []);
  assert.equal(controller.contains(MOUNTED_GEOTIFF_ITEM), true);

  nextFailure = "attach";
  await assert.rejects(
    controller.show(MOUNTED_GEOTIFF_ITEM, "representativeSample"),
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
  const map = { removeLayer() {}, fitBounds() {} };
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      loadPreview(item, mode, signal) {
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

  const staleShow = controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample");
  const currentShow = controller.show(secondItem, "centerSample");
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
  const map = { removeLayer() {}, fitBounds() {} };
  const controller = initializeRasterDetailPreview(
    { leafletMap: map, leaflet: {} },
    {
      loadPreview(_item, _mode, signal) {
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

  const pending = controller.show(MOUNTED_GEOTIFF_ITEM, "centerSample");
  controller.remove();
  work.resolve(CENTER_SAMPLE_DETAIL_PREVIEW);

  assert.equal(await pending, null);
  assert.deepEqual(added, []);
  assert.equal(controller.contains(MOUNTED_GEOTIFF_ITEM), false);
});
