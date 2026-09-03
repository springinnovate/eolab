import assert from "node:assert/strict";
import test from "node:test";

import {
  MAXIMUM_RASTER_CURSOR_SAMPLE_PARTICIPANTS,
  RASTER_CURSOR_SAMPLE_CONCURRENCY,
  RASTER_CURSOR_SAMPLE_DEBOUNCE_MILLISECONDS,
  RasterCursorSamplesController,
} from "../../src/raster/cursor-samples.js";
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

function createClock() {
  const timers = new Map();
  let nextId = 1;
  return {
    delays: [],
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, callback);
      this.delays.push(delay);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    runNext() {
      const entry = timers.entries().next().value;
      assert.ok(entry, "expected a pending cursor dwell timer");
      const [id, callback] = entry;
      timers.delete(id);
      callback();
    },
    get pendingCount() {
      return timers.size;
    },
  };
}

function participant(index) {
  return {
    key: `raster-${index}`,
    label: `raster-${index}`,
    item: {
      ...MOUNTED_GEOTIFF_ITEM,
      id: `geotiff-${index}`,
      assets: {
        data: { href: `https://example.test/assets/raster-${index}.tif` },
      },
    },
  };
}

test("cursor sampling dwells, uses a fixed worker pool, and reports progressively", async () => {
  const clock = createClock();
  const requests = [];
  const snapshots = [];
  const controller = new RasterCursorSamplesController(
    (item, position, signal) => {
      const deferred = createDeferred();
      requests.push({ deferred, item, position, signal });
      return deferred.promise;
    },
    snapshot => snapshots.push(snapshot),
    clock,
  );

  controller.move(
    [participant(1), participant(2), participant(3)],
    { longitude: 20, latitude: 40 },
  );

  assert.equal(requests.length, 0);
  assert.deepEqual(clock.delays, [RASTER_CURSOR_SAMPLE_DEBOUNCE_MILLISECONDS]);
  clock.runNext();
  assert.equal(requests.length, RASTER_CURSOR_SAMPLE_CONCURRENCY);
  assert.deepEqual(
    snapshots[0].samples.map(sample => sample.state),
    ["loading", "loading", "loading"],
  );
  assert.equal(Object.isFrozen(snapshots[0]), true);
  assert.equal(Object.isFrozen(snapshots[0].position), true);
  assert.equal(Object.isFrozen(snapshots[0].samples), true);
  assert.equal(Object.isFrozen(snapshots[0].samples[0]), true);

  requests[0].deferred.resolve({ inBounds: true, value: 12.5 });
  await Promise.resolve();
  assert.equal(requests.length, 3);
  assert.equal(snapshots.at(-1).samples[0].value, 12.5);
  assert.equal(snapshots.at(-1).samples[2].state, "loading");

  requests[1].deferred.resolve({ inBounds: true, value: null });
  requests[2].deferred.resolve({ inBounds: false, value: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(
    snapshots.at(-1).samples.map(sample => sample.state),
    ["value", "nodata", "outside"],
  );
});

test("a newer cursor position cancels dwell and in-flight stale work", async () => {
  const clock = createClock();
  const requests = [];
  const snapshots = [];
  const layer = participant(1);
  const controller = new RasterCursorSamplesController(
    (_item, position, signal) => {
      const deferred = createDeferred();
      requests.push({ deferred, position, signal });
      return deferred.promise;
    },
    snapshot => snapshots.push(snapshot),
    clock,
  );

  controller.move([layer], { longitude: 1, latitude: 2 });
  controller.move([layer], { longitude: 3, latitude: 4 });
  assert.equal(clock.pendingCount, 1);
  clock.runNext();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].position.longitude, 3);

  controller.move([layer], { longitude: 5, latitude: 6 });
  assert.equal(requests[0].signal.aborted, true);
  const snapshotCount = snapshots.length;
  requests[0].deferred.resolve({ inBounds: true, value: 99 });
  await Promise.resolve();
  assert.equal(snapshots.length, snapshotCount);
  clock.runNext();
  assert.equal(requests[1].position.longitude, 5);
});

test("cursor stack applies a fixed participant ceiling and reports omissions", () => {
  const clock = createClock();
  const snapshots = [];
  const participants = Array.from(
    { length: MAXIMUM_RASTER_CURSOR_SAMPLE_PARTICIPANTS + 3 },
    (_, index) => participant(index),
  );
  const controller = new RasterCursorSamplesController(
    () => new Promise(() => {}),
    snapshot => snapshots.push(snapshot),
    clock,
  );

  controller.move(participants, { longitude: 1, latitude: 2 });
  clock.runNext();

  assert.equal(
    snapshots[0].samples.length,
    MAXIMUM_RASTER_CURSOR_SAMPLE_PARTICIPANTS,
  );
  assert.equal(snapshots[0].omittedCount, 3);
  controller.clear();
});

test("cursor input and response contracts reject ambiguous state", async () => {
  const clock = createClock();
  const snapshots = [];
  const controller = new RasterCursorSamplesController(
    async () => ({ inBounds: true, value: Number.NaN }),
    snapshot => snapshots.push(snapshot),
    clock,
  );
  assert.throws(
    () => controller.move([participant(1)], { longitude: 181, latitude: 2 }),
    /canonical WGS 84/,
  );
  assert.throws(
    () => controller.move([participant(1), participant(1)], { longitude: 1, latitude: 2 }),
    /distinct/,
  );

  controller.move([participant(1)], { longitude: 1, latitude: 2 });
  clock.runNext();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(snapshots.at(-1).samples[0].state, "error");
  assert.match(snapshots.at(-1).samples[0].errorMessage, /finite or null/);
});
