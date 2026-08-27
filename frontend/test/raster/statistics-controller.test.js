import assert from "node:assert/strict";
import test from "node:test";

import {
  RasterPairedStatisticsController,
  RasterStatisticsController,
} from "../../src/raster/statistics-controller.js";
import {
  MOUNTED_GEOTIFF_ITEM,
  RASTER_STATISTICS,
  SELECTED_BOUNDS,
  SELECTED_RASTER_STATISTICS,
  TEMPORARY_AOI_ID,
  TEMPORARY_AOI_RASTER_STATISTICS,
} from "../../test-support/raster/fixtures.js";

test("RasterStatisticsController aborts and ignores stale Item results", async () => {
  const requests = [];
  const loading = [];
  const results = [];
  const controller = new RasterStatisticsController(
    (item, samplingArea, signal) => new Promise((resolve) => {
      requests.push({ item, samplingArea, signal, resolve });
    }),
    (item, _samplingArea, context) => loading.push({ item, context }),
    (statistics, item, _samplingArea, context) => {
      results.push({ statistics, item, context });
    },
    () => assert.fail("Unexpected statistics error"),
  );
  const secondItem = { ...MOUNTED_GEOTIFF_ITEM, id: "geotiff-second" };

  const firstRequest = controller.activate(
    MOUNTED_GEOTIFF_ITEM,
    { kind: "wholeRaster" },
    { styleRevision: 0 },
  );
  const secondRequest = controller.activate(
    secondItem,
    { kind: "wholeRaster" },
    { styleRevision: 1 },
  );
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(RASTER_STATISTICS);
  requests[1].resolve(RASTER_STATISTICS);
  await Promise.all([firstRequest, secondRequest]);

  assert.equal(loading.length, 2);
  assert.deepEqual(results, [
    {
      statistics: RASTER_STATISTICS,
      item: secondItem,
      context: { styleRevision: 1 },
    },
  ]);
});

test("RasterStatisticsController aborts and ignores a stale clicked area", async () => {
  const requests = [];
  const results = [];
  const controller = new RasterStatisticsController(
    (item, samplingArea, signal) => new Promise((resolve) => {
      requests.push({ item, samplingArea, signal, resolve });
    }),
    () => {},
    (statistics) => results.push(statistics),
    () => assert.fail("Unexpected statistics error"),
  );
  const secondBounds = { ...SELECTED_BOUNDS, west: -120, east: -118 };

  const firstRequest = controller.activate(
    MOUNTED_GEOTIFF_ITEM,
    { kind: "selectedArea", selectedBounds: SELECTED_BOUNDS },
  );
  const secondRequest = controller.activate(
    MOUNTED_GEOTIFF_ITEM,
    { kind: "selectedArea", selectedBounds: secondBounds },
  );
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(requests.map(({ samplingArea }) => samplingArea), [
    { kind: "selectedArea", selectedBounds: SELECTED_BOUNDS },
    { kind: "selectedArea", selectedBounds: secondBounds },
  ]);

  requests[0].resolve(SELECTED_RASTER_STATISTICS);
  requests[1].resolve({
    ...SELECTED_RASTER_STATISTICS,
    selectedBounds: secondBounds,
  });
  await Promise.all([firstRequest, secondRequest]);
  assert.deepEqual(results, [{
    ...SELECTED_RASTER_STATISTICS,
    selectedBounds: secondBounds,
  }]);
});

test("RasterStatisticsController retains its Item for a recoverable retry", async () => {
  let attempts = 0;
  const requestedBounds = [];
  const errors = [];
  const results = [];
  const controller = new RasterStatisticsController(
    async (_item, samplingArea) => {
      attempts += 1;
      requestedBounds.push(samplingArea.selectedBounds);
      if (attempts === 1) {
        throw new Error("Statistics service busy");
      }
      return RASTER_STATISTICS;
    },
    () => {},
    (statistics) => results.push(statistics),
    (error) => errors.push(error.message),
  );

  assert.equal(
    await controller.activate(
      MOUNTED_GEOTIFF_ITEM,
      { kind: "selectedArea", selectedBounds: SELECTED_BOUNDS },
    ),
    null,
  );
  assert.deepEqual(errors, ["Statistics service busy"]);
  assert.equal(await controller.retry(), RASTER_STATISTICS);
  assert.deepEqual(requestedBounds, [SELECTED_BOUNDS, SELECTED_BOUNDS]);
  assert.deepEqual(results, [RASTER_STATISTICS]);
});

test("RasterStatisticsController aborts and ignores a replaced AOI lifecycle", async () => {
  const replacementId = "R".repeat(32);
  const requests = [];
  const results = [];
  const controller = new RasterStatisticsController(
    (_item, samplingArea, signal) =>
      new Promise((resolve) => {
        requests.push({ resolve, samplingArea, signal });
      }),
    () => {},
    (statistics) => results.push(statistics),
    () => assert.fail("Unexpected statistics error"),
  );

  const firstRequest = controller.activate(
    MOUNTED_GEOTIFF_ITEM,
    { kind: "temporaryAoi", temporaryAoiId: TEMPORARY_AOI_ID },
  );
  const replacementRequest = controller.activate(
    MOUNTED_GEOTIFF_ITEM,
    { kind: "temporaryAoi", temporaryAoiId: replacementId },
  );

  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(
    requests.map(({ samplingArea }) => samplingArea),
    [
      { kind: "temporaryAoi", temporaryAoiId: TEMPORARY_AOI_ID },
      { kind: "temporaryAoi", temporaryAoiId: replacementId },
    ],
  );
  requests[0].resolve(TEMPORARY_AOI_RASTER_STATISTICS);
  requests[1].resolve({
    ...TEMPORARY_AOI_RASTER_STATISTICS,
    temporaryAoiId: replacementId,
  });
  await Promise.all([firstRequest, replacementRequest]);

  assert.deepEqual(results, [{
    ...TEMPORARY_AOI_RASTER_STATISTICS,
    temporaryAoiId: replacementId,
  }]);
});

test("RasterPairedStatisticsController invalidates swapped reference roles", async () => {
  const xItem = { collection: "rasters", id: "x" };
  const yItem = { collection: "rasters", id: "y" };
  const requests = [];
  const results = [];
  const controller = new RasterPairedStatisticsController(
    (x, y, area, signal) => new Promise((resolve) => {
      requests.push({ x, y, area, signal, resolve });
    }),
    () => {},
    (statistics, x, y) => results.push({ statistics, x, y }),
    () => assert.fail("Unexpected paired statistics error"),
  );

  const first = controller.activate(
    xItem,
    yItem,
    { kind: "wholeOverlap" },
  );
  const swapped = controller.activate(
    yItem,
    xItem,
    { kind: "wholeOverlap" },
  );
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({ revision: "obsolete" });
  requests[1].resolve({ revision: "current" });
  await Promise.all([first, swapped]);

  assert.deepEqual(results, [{
    statistics: { revision: "current" },
    x: yItem,
    y: xItem,
  }]);
  assert.deepEqual(requests.map(({ x, y }) => [x.id, y.id]), [
    ["x", "y"],
    ["y", "x"],
  ]);
});
