import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRasterPixelValue,
  getCatalogRasterBasename,
  getRasterPixelProbePosition,
  RasterPixelProbeController,
} from "../../src/raster/pixel-probe.js";
import { createFakeClock } from "../../test-support/raster/fakes.js";
import { MOUNTED_GEOTIFF_ITEM } from "../../test-support/raster/fixtures.js";

test("RasterPixelProbeController samples immediately then keeps the latest point", async () => {
  const clock = createFakeClock();
  const requests = [];
  const results = [];
  const controller = new RasterPixelProbeController(
    (_item, point, signal) => {
      requests.push({ point, signal });
      return Promise.resolve({ inBounds: true, value: point.longitude });
    },
    (result, point) => results.push({ result, point }),
    () => assert.fail("Unexpected pixel error"),
    { clock, now: () => clock.time },
  );

  controller.activate(MOUNTED_GEOTIFF_ITEM);
  controller.move({ longitude: 1, latitude: 10 });
  await Promise.resolve();
  clock.time = 20;
  controller.move({ longitude: 2, latitude: 20 });
  clock.time = 50;
  controller.move({ longitude: 3, latitude: 30 });

  assert.equal(requests.length, 1);
  clock.advanceTo(100);
  await Promise.resolve();

  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal.aborted, false);
  assert.deepEqual(requests[1].point, {
    longitude: 3,
    latitude: 30,
  });
  assert.deepEqual(results, [
    {
      result: { inBounds: true, value: 1 },
      point: { longitude: 1, latitude: 10 },
    },
    {
      result: { inBounds: true, value: 3 },
      point: { longitude: 3, latitude: 30 },
    },
  ]);
});

test("RasterPixelProbeController aborts and ignores cleared work", async () => {
  const requests = [];
  const results = [];
  const controller = new RasterPixelProbeController(
    (_item, point, signal) => new Promise((resolve) => {
      requests.push({ point, signal, resolve });
    }),
    (result) => results.push(result),
    () => assert.fail("Unexpected pixel error"),
  );

  controller.activate(MOUNTED_GEOTIFF_ITEM);
  controller.move({ longitude: 1, latitude: 2 });
  controller.clear();
  requests[0].resolve({ inBounds: true, value: 7 });
  await Promise.resolve();

  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(results, []);
});

test("RasterPixelProbeController completes one read before sampling the latest point", async () => {
  const clock = createFakeClock();
  const requests = [];
  const results = [];
  const controller = new RasterPixelProbeController(
    (_item, point, signal) => new Promise((resolve) => {
      requests.push({ point, signal, resolve });
    }),
    (result, point) => results.push({ result, point }),
    () => assert.fail("Unexpected pixel error"),
    { clock, now: () => clock.time },
  );

  controller.activate(MOUNTED_GEOTIFF_ITEM);
  controller.move({ longitude: 1, latitude: 10 });
  clock.time = 20;
  controller.move({ longitude: 2, latitude: 20 });
  requests[0].resolve({ inBounds: true, value: 1 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests[0].signal.aborted, false);
  assert.deepEqual(results, [
    {
      result: { inBounds: true, value: 1 },
      point: { longitude: 1, latitude: 10 },
    },
  ]);
  clock.advanceTo(100);
  assert.deepEqual(requests[1].point, { longitude: 2, latitude: 20 });
});

test("pixel probe position follows the pointer and flips at viewport edges", () => {
  const probeSize = { width: 100, height: 40 };
  const viewport = { width: 500, height: 300 };

  assert.deepEqual(
    getRasterPixelProbePosition({ x: 100, y: 100 }, probeSize, viewport),
    { x: 112, y: 112 },
  );
  assert.deepEqual(
    getRasterPixelProbePosition({ x: 490, y: 290 }, probeSize, viewport),
    { x: 378, y: 238 },
  );
});

test("pixel probe formats small values with four significant digits", () => {
  assert.equal(formatRasterPixelValue(0.0001), "1.000e-4");
  assert.equal(formatRasterPixelValue(0.0000123456), "1.235e-5");
  assert.equal(formatRasterPixelValue(-0.0001), "-1.000e-4");
  assert.equal(formatRasterPixelValue(0), "0");
});

test("pixel probe labels the selected raster by its decoded basename", () => {
  assert.equal(
    getCatalogRasterBasename(MOUNTED_GEOTIFF_ITEM),
    "annual temperature.tif",
  );
});
