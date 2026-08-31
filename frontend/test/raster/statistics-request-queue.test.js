import assert from "node:assert/strict";
import test from "node:test";
import { RasterStatisticsRequestQueue } from "../../src/raster/statistics-request-queue.js";
import { RasterAnalysisRequestError } from "../../src/raster/analysis-api.js";

/** Flush promise callbacks without advancing retry timers. @return {Promise<void>} */
const flush = () => new Promise(resolve => setImmediate(resolve));
/** Create the backend's structured temporary-admission conflict. @return {Error} */
const busy = () => new RasterAnalysisRequestError("Read capacity occupied", 409, "statistics_capacity_busy");
/** Create a manually advanced timer clock. @return {Object} Clock and retained timers. */
function fakeClock() {
    const timers = new Map();
    return {
        timers,
        /** Retain one timer until explicitly advanced. @return {Function} Timer token. */
        setTimeout(callback, delay) { timers.set(callback, delay); return callback; },
        /** Remove a canceled timer. @return {void} */
        clearTimeout(callback) { timers.delete(callback); },
        /** Execute the oldest retained timer once. @return {void} */
        tick() { const callback = timers.keys().next().value; timers.delete(callback); callback(); },
    };
}

test("ordinary and paired jobs use one slot; a rejection releases it", async () => {
    const queue = new RasterStatisticsRequestQueue();
    const calls = [];
    let finish;
    const first = queue.run(() => {
        calls.push("ordinary");
        return new Promise(resolve => { finish = resolve; });
    }, new AbortController().signal);
    const second = queue.run(async () => { calls.push("paired"); throw new Error("No overlap"); }, new AbortController().signal);
    const failure = assert.rejects(second, /No overlap/);
    const third = queue.run(async () => { calls.push("next"); return 3; }, new AbortController().signal);
    assert.deepEqual(calls, ["ordinary"]);
    finish(1);
    assert.equal(await first, 1);
    await failure;
    assert.equal(await third, 3);
    assert.deepEqual(calls, ["ordinary", "paired", "next"]);
});

test("queued cancellation removes work; active ignored abort still holds its slot", async () => {
    const queue = new RasterStatisticsRequestQueue();
    const active = new AbortController();
    const obsolete = new AbortController();
    let finish;
    let currentStarted = false;
    const first = queue.run(() => new Promise(resolve => { finish = resolve; }), active.signal);
    const firstAbort = assert.rejects(first, { name: "AbortError" });
    const stale = queue.run(() => assert.fail("obsolete queued read started"), obsolete.signal);
    const staleAbort = assert.rejects(stale, { name: "AbortError" });
    obsolete.abort();
    active.abort();
    const current = queue.run(async () => { currentStarted = true; return 2; }, new AbortController().signal);
    await Promise.all([firstAbort, staleAbort]);
    assert.equal(queue.pending.length, 1);
    assert.equal(currentStarted, false);
    finish(1);
    assert.equal(await current, 2);
});

test("capacity conflict stays queued and recovers with bounded backoff", async () => {
    const clock = fakeClock();
    const queue = new RasterStatisticsRequestQueue(clock);
    let attempts = 0;
    const current = queue.run(async () => { if (++attempts < 3) throw busy(); return 42; }, new AbortController().signal);
    await flush();
    assert.deepEqual([...clock.timers.values()], [250]);
    clock.tick();
    await flush();
    assert.deepEqual([...clock.timers.values()], [500]);
    clock.tick();
    assert.equal(await current, 42);
    assert.equal(attempts, 3);
    assert.equal(clock.timers.size, 0);
});

test("canceling a capacity retry clears its timer and permits current work", async () => {
    const clock = fakeClock();
    const queue = new RasterStatisticsRequestQueue(clock);
    const controller = new AbortController();
    let attempts = 0;
    const stale = queue.run(async () => { attempts++; throw busy(); }, controller.signal);
    const aborted = assert.rejects(stale, { name: "AbortError" });
    await flush();
    controller.abort();
    await aborted;
    assert.equal(clock.timers.size, 0);
    assert.equal(await queue.run(async () => 7, new AbortController().signal), 7);
    assert.equal(attempts, 1);
});

test("persistent contention exhausts five retries, then releases the queue", async () => {
    const clock = fakeClock();
    const queue = new RasterStatisticsRequestQueue(clock);
    let attempts = 0;
    const result = queue.run(async () => { attempts++; throw busy(); }, new AbortController().signal);
    const failed = assert.rejects(result, /Read capacity occupied/);
    for (const delay of [250, 500, 1000, 2000, 4000]) {
        await flush();
        assert.deepEqual([...clock.timers.values()], [delay]);
        clock.tick();
    }
    await failed;
    assert.equal(attempts, 6);
    assert.equal(clock.timers.size, 0);
    assert.equal(await queue.run(async () => "next", new AbortController().signal), "next");
});

test("ordinary conflicts and transport failures are not automatically repeated", async () => {
    const clock = fakeClock();
    const queue = new RasterStatisticsRequestQueue(clock);
    for (const error of [new RasterAnalysisRequestError("No overlap", 409), new Error("offline")]) {
        let attempts = 0;
        await assert.rejects(queue.run(async () => { attempts++; throw error; }, new AbortController().signal), error);
        assert.equal(attempts, 1);
        assert.equal(clock.timers.size, 0);
    }
});
