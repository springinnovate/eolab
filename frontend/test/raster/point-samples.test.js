import assert from "node:assert/strict";
import test from "node:test";

import { RasterPointSamplesController } from "../../src/raster/point-samples.js";
import {
  formatRasterPixelValue,
  getCatalogRasterBasename,
} from "../../src/raster/value-format.js";
import { MOUNTED_GEOTIFF_ITEM } from "../../test-support/raster/fixtures.js";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function participant(key, axis = null) {
  return {
    key,
    label: `${key}.tif`,
    item: {
      ...MOUNTED_GEOTIFF_ITEM,
      id: `geotiff-${key}`,
      assets: {
        data: { href: `https://example.test/assets/${key}.tif` },
      },
    },
    axis,
  };
}

test("point samples run concurrently and publish immutable ordered results", async () => {
  const requests = [];
  const snapshots = [];
  const controller = new RasterPointSamplesController(
    (item, point, signal) => {
      const deferred = createDeferred();
      requests.push({ deferred, item, point, signal });
      return deferred.promise;
    },
    (snapshot) => snapshots.push(snapshot),
  );
  const first = participant("first");
  const second = participant("second");

  controller.sample([first, second], { longitude: -122, latitude: 49 });

  assert.equal(requests.length, 2);
  assert.deepEqual(
    snapshots[0].samples.map(({ key, state }) => ({ key, state })),
    [
      { key: "first", state: "loading" },
      { key: "second", state: "loading" },
    ],
  );
  assert.equal(Object.isFrozen(snapshots[0]), true);
  assert.equal(Object.isFrozen(snapshots[0].position), true);
  assert.equal(Object.isFrozen(snapshots[0].samples), true);
  assert.equal(Object.isFrozen(snapshots[0].samples[0]), true);
  requests[1].deferred.resolve({ inBounds: false, value: null });
  await Promise.resolve();
  assert.equal(snapshots.at(-1).samples[1].state, "outside");
  requests[0].deferred.resolve({ inBounds: true, value: 12.5 });
  await Promise.resolve();
  assert.deepEqual(
    snapshots.at(-1).samples.map(({ state, value }) => ({ state, value })),
    [
      { state: "value", value: 12.5 },
      { state: "outside", value: null },
    ],
  );
});

test("point samples distinguish no-data and request failures", async () => {
  const snapshots = [];
  const controller = new RasterPointSamplesController(
    async (item) => {
      if (item.id.endsWith("failure")) {
        throw new Error("Source is temporarily unavailable");
      }
      return { inBounds: true, value: null };
    },
    (snapshot) => snapshots.push(snapshot),
  );

  controller.sample(
    [participant("nodata"), participant("failure")],
    { longitude: 1, latitude: 2 },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    snapshots.at(-1).samples.map(({ state, errorMessage }) => ({
      state,
      errorMessage,
    })),
    [
      { state: "nodata", errorMessage: "" },
      { state: "error", errorMessage: "Source is temporarily unavailable" },
    ],
  );
});

test("a newer click aborts and prevents stale results from repainting", async () => {
  const requests = [];
  const snapshots = [];
  const layer = participant("temperature");
  const controller = new RasterPointSamplesController(
    (_item, point, signal) => {
      const deferred = createDeferred();
      requests.push({ deferred, point, signal });
      return deferred.promise;
    },
    (snapshot) => snapshots.push(snapshot),
  );

  controller.sample([layer], { longitude: 1, latitude: 2 });
  controller.sample([layer], { longitude: 3, latitude: 4 });
  const snapshotCountAfterSecondClick = snapshots.length;
  requests[0].deferred.resolve({ inBounds: true, value: 99 });
  await Promise.resolve();

  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);
  assert.equal(snapshots.length, snapshotCountAfterSecondClick);
  requests[1].deferred.resolve({ inBounds: true, value: 7 });
  await Promise.resolve();
  assert.equal(snapshots.at(-1).position.longitude, 3);
  assert.equal(snapshots.at(-1).samples[0].value, 7);
});

test("synchronization reorders unchanged axes and clears changed participants", async () => {
  const snapshots = [];
  let requestCount = 0;
  const first = participant("first", "X");
  const second = participant("second", "Y");
  const controller = new RasterPointSamplesController(
    async (item) => {
      requestCount += 1;
      return { inBounds: true, value: item === first.item ? 1 : 2 };
    },
    (snapshot) => snapshots.push(snapshot),
  );
  controller.sample([first, second], { longitude: 1, latitude: 2 });
  await new Promise((resolve) => setImmediate(resolve));

  controller.synchronize([
    { ...second, axis: "X" },
    { ...first, axis: "Y" },
  ]);
  assert.equal(requestCount, 2);
  assert.deepEqual(
    snapshots.at(-1).samples.map(({ key, axis, value }) => ({ key, axis, value })),
    [
      { key: "second", axis: "X", value: 2 },
      { key: "first", axis: "Y", value: 1 },
    ],
  );

  controller.synchronize([participant("replacement")]);
  assert.equal(snapshots.at(-1), null);
});

test("point sample input and response contracts are closed and bounded", async () => {
  const controller = new RasterPointSamplesController(
    async () => ({ inBounds: true, value: Number.NaN }),
    () => {},
  );
  assert.throws(
    () => controller.sample(
      [participant("one"), participant("two"), participant("three")],
      { longitude: 1, latitude: 2 },
    ),
    /at most two participants/,
  );
  assert.throws(
    () => controller.sample([participant("one")], { longitude: 181, latitude: 2 }),
    /canonical WGS 84/,
  );
  const snapshots = [];
  const invalidResponseController = new RasterPointSamplesController(
    async () => ({ inBounds: true, value: Number.NaN }),
    (snapshot) => snapshots.push(snapshot),
  );
  invalidResponseController.sample(
    [participant("one")],
    { longitude: 1, latitude: 2 },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshots.at(-1).samples[0].state, "error");
  assert.match(snapshots.at(-1).samples[0].errorMessage, /finite or null/);
});

test("point-value helpers format values and decode the Catalog basename", () => {
  assert.equal(formatRasterPixelValue(0.0001), "1.000e-4");
  assert.equal(formatRasterPixelValue(0.0000123456), "1.235e-5");
  assert.equal(formatRasterPixelValue(-0.0001), "-1.000e-4");
  assert.equal(formatRasterPixelValue(0), "0");
  assert.throws(() => formatRasterPixelValue(Number.NaN), /must be finite/);
  assert.equal(
    getCatalogRasterBasename(MOUNTED_GEOTIFF_ITEM),
    "annual temperature.tif",
  );
});
