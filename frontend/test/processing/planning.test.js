import assert from "node:assert/strict";
import test from "node:test";
import { ProcessingApiClient, ProcessingRequestError } from "../../src/processing/api.js";

/** Let chained admission and snapshot promises settle. @return {Promise<void>} Microtask completion. */
async function flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

test("planning and job observers share one event connection until the last subscriber leaves", () => {
    const streams = [];
    class Events {
        /** Capture the connection used by the client. */
        constructor() { streams.push(this); this.closed = false; }
        /** @param {string} type Event type. @param {Function} listener Listener. @return {void} */
        addEventListener(type, listener) { this.listener = listener; }
        /** @return {void} */
        removeEventListener() { this.listener = null; }
        /** @return {void} */
        close() { this.closed = true; }
    }
    const api = new ProcessingApiClient(null, Events);
    let planning = 0, jobs = 0;
    const stopPlanning = api.watchJobs(() => planning++);
    const stopJobs = api.watchJobs(() => jobs++);
    assert.equal(streams.length, 1);
    streams[0].listener({data:"{}"});
    assert.equal(planning, 1); assert.equal(jobs, 1);
    stopPlanning(); stopPlanning();
    streams[0].listener({data:"{}"});
    assert.equal(planning, 1); assert.equal(jobs, 2);
    assert.equal(streams[0].closed, false);
    stopJobs(); assert.equal(streams[0].closed, true);
    api.watchJobs(() => {})(); assert.equal(streams.length, 2);
});

/** Connect a queued plan to controlled HTTP and owner-scoped event hints.
 * @return {Object} Client, requests, cancellation and state controls.
 */
function fixture() {
    const requests = [];
    let state = "queued", changed, closed = false, id;
    const api = new ProcessingApiClient(async (url, options) => {
        requests.push({url, ...options});
        if (options.method === "DELETE") return {ok: true, json: async () => ({discarded: true})};
        id = url.split("/").at(-1);
        return {ok: true, json: async () => ({planId: id, status: state,
            result: state === "ready" ? {planId: id, value: 42} : null, error: null})};
    }, null);
    api.watchJobs = callback => { changed = callback; return () => { closed = true; }; };
    return {api, requests, abort: new AbortController(),
        notify: () => changed(), setState: value => { state = value; }, get closed() {return closed;} };
}

test("queued planning reacts to an SSE hint and fetches the authoritative result", async () => {
    const h = fixture(), progress = [];
    const result = h.api.preparePlan("raster-calculations", {a: 1}, h.abort.signal, value => progress.push(value));
    await flush();
    assert.deepEqual(progress, ["queued"]);
    assert.equal(h.requests.length, 1);
    h.setState("planning"); h.notify(); await flush();
    assert.deepEqual(progress, ["queued", "planning"]);
    h.setState("ready"); h.notify();
    assert.equal((await result).value, 42);
    assert.equal(h.requests.filter(request => request.method === "POST").length, 1);
    assert.equal(h.requests.filter(request => request.method === "DELETE").length, 0);
    assert.equal(h.closed, true);
});

test("missing plan notifications retain two-second fallback polling", async context => {
    context.mock.timers.enable({apis: ["setTimeout"]});
    const h = fixture();
    const result = h.api.preparePlan("raster-clips", {}, h.abort.signal);
    await flush(); h.setState("ready");
    context.mock.timers.tick(1999); await flush();
    assert.equal(h.requests.length, 1);
    context.mock.timers.tick(1);
    assert.equal((await result).value, 42);
    assert.equal(h.requests.length, 2);
});

test("superseding a waiting plan cancels its known identity and closes observation", async () => {
    const h = fixture();
    const result = h.api.preparePlan("raster-calculations", {}, h.abort.signal);
    await flush(); h.abort.abort();
    await assert.rejects(result, {name: "AbortError"});
    const first = h.requests[0].url.split("/").at(-1);
    assert.equal(h.requests.at(-1).url, `/api/processing/plans/${first}`);
    assert.equal(h.requests.at(-1).method, "DELETE");
    assert.equal(h.closed, true);
});

test("a lost admission response is recovered using the same client plan ID", async () => {
    const h = fixture(), fetch = h.api.fetch;
    h.setState("ready");
    h.api.fetch = async (url, options) => {
        if (options.method === "POST") { h.requests.push({url, ...options}); throw new TypeError("connection lost"); }
        return fetch(url, options);
    };
    const result = await h.api.preparePlan("raster-calculations", {}, h.abort.signal);
    assert.equal(h.requests.length, 2);
    assert.ok(h.requests.every(request => request.url.endsWith(result.planId)));
});

test("an admission that cannot be recovered is cancelled by its stable ID", async () => {
    const h = fixture(), fetch = h.api.fetch;
    h.api.fetch = async (url, options) => {
        if (options.method !== "DELETE") {h.requests.push({url, ...options}); throw new TypeError("connection lost");}
        return fetch(url, options);
    };
    await assert.rejects(h.api.preparePlan("raster-clips", {}, h.abort.signal), /connection lost/);
    const id = h.requests[0].url.split("/").at(-1);
    assert.ok(h.requests.every(request => request.url.endsWith(id)));
    assert.equal(h.requests.at(-1).method, "DELETE");
});

test("a definitive full-queue response does not allocate a cancellation record", async () => {
    const h = fixture();
    h.api.fetch = async (url, options) => {
        h.requests.push({url, ...options});
        throw new ProcessingRequestError("Queue full", 429, "plan_queue_full");
    };
    await assert.rejects(h.api.preparePlan("raster-clips", {}, h.abort.signal), /Queue full/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.closed, true);
});
