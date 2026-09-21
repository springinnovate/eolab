import assert from "node:assert/strict";
import test from "node:test";
import { requestRasterStatistics } from "../../src/raster/statistics-request.js";
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

test("independent reads start together and an aborted result is discarded", async () => {
    const controller = new AbortController();
    let finish;
    const first = requestRasterStatistics(() => new Promise(resolve => { finish = resolve; }), controller.signal);
    const canceled = assert.rejects(first, { name: "AbortError" });
    assert.equal(await requestRasterStatistics(async () => 2, new AbortController().signal), 2);
    controller.abort();
    finish(1);
    await canceled;
});

test("full server queue recovers with bounded backoff", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const current = requestRasterStatistics(async () => { if (++attempts < 3) throw busy(); return 42; }, new AbortController().signal, clock);
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
    const controller = new AbortController();
    let attempts = 0;
    const stale = requestRasterStatistics(async () => { attempts++; throw busy(); }, controller.signal, clock);
    const aborted = assert.rejects(stale, { name: "AbortError" });
    await flush();
    controller.abort();
    await aborted;
    assert.equal(clock.timers.size, 0);
    assert.equal(await requestRasterStatistics(async () => 7, new AbortController().signal, clock), 7);
    assert.equal(attempts, 1);
});

test("persistent overload exhausts five retries and a later request can succeed", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const result = requestRasterStatistics(async () => { attempts++; throw busy(); }, new AbortController().signal, clock);
    const failed = assert.rejects(result, /Read capacity occupied/);
    for (const delay of [250, 500, 1000, 2000, 4000]) {
        await flush();
        assert.deepEqual([...clock.timers.values()], [delay]);
        clock.tick();
    }
    await failed;
    assert.equal(attempts, 6);
    assert.equal(clock.timers.size, 0);
    assert.equal(await requestRasterStatistics(async () => "next", new AbortController().signal, clock), "next");
});

test("ordinary conflicts and transport failures are not automatically repeated", async () => {
    const clock = fakeClock();
    for (const error of [new RasterAnalysisRequestError("No overlap", 409), new Error("offline")]) {
        let attempts = 0;
        await assert.rejects(requestRasterStatistics(async () => { attempts++; throw error; }, new AbortController().signal, clock), error);
        assert.equal(attempts, 1);
        assert.equal(clock.timers.size, 0);
    }
});
