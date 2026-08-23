import assert from "node:assert/strict";
import test from "node:test";

import { initializeRasterDetailPreview } from "../../src/raster/detail-preview-controller.js";
import {
  CENTER_PIXEL_DETAIL_PREVIEW,
  MOUNTED_GEOTIFF_ITEM,
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

  const oldShow = controller.show(MOUNTED_GEOTIFF_ITEM, "centerPixel");
  const currentShow = controller.show(MOUNTED_GEOTIFF_ITEM, "samplingGrid");
  assert.equal(requests[0].signal.aborted, true);
  requests[1].work.resolve({
    ...CENTER_PIXEL_DETAIL_PREVIEW,
    mode: "samplingGrid",
  });
  assert.equal((await currentShow).mode, "samplingGrid");
  requests[0].work.resolve(CENTER_PIXEL_DETAIL_PREVIEW);
  assert.equal(await oldShow, null);

  assert.deepEqual(added.map((layer) => layer.mode), ["samplingGrid"]);
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
        return CENTER_PIXEL_DETAIL_PREVIEW;
      },
      createPreviewLayer() {
        return { layer, focusBounds: [[48, -123], [50, -121]] };
      },
    },
  );

  await controller.show(MOUNTED_GEOTIFF_ITEM, "centerPixel");
  fail = true;
  await assert.rejects(
    controller.show(MOUNTED_GEOTIFF_ITEM, "samplingGrid"),
    /bounded read failed/,
  );
  assert.equal(controller.contains(MOUNTED_GEOTIFF_ITEM), true);
  assert.deepEqual(removed, []);
});
