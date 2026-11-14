import assert from "node:assert/strict";
import test from "node:test";
import { HabitatAdminController } from "../../src/habitat-admin/controller.js";

const selection = { collectionId: "eolab-mounted-vectors", itemId: "areas", assetKey: "data", layerName: "polygons",
    filter: { enabled: true, match: "all", rules: [] } };
const source = { key: "areas", label: "Project areas", selection, fields: [{ name: "project", type: "int64" }] };
const options = { minimumYear: 2015, maximumYear: 2019, defaultYear: 2018 };

/** Supply a controlled external response without starting timers or native work.
 * @returns {{promise:Promise<unknown>,resolve:Function,reject:Function}} Response controls.
 */
function deferred() {
    let resolve, reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    return { promise, resolve, reject };
}

/** Create an authoritative job snapshot for transport-boundary tests.
 * @param {Object} [changes={}] Server fields changed by the scenario.
 * @returns {Object} Administrator preparation job.
 */
function job(changes = {}) {
    return { jobId: "a".repeat(32), operation: "habitat.prepare-inputs.v1", status: "queued", createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z", expiresAt: "2030-01-01T00:00:00Z", metadataExpiresAt: null,
        inputs: { name: "North", selection: structuredClone(selection), year: 2018, configurationSha256: "b".repeat(64) },
        progress: {}, error: null, result: null, ...changes };
}

/** Create a durable server-side bulk-check receipt.
 * @param {Object} [changes={}] Lifecycle or result fields for the scenario.
 * @returns {Object} Bulk receipt sharing the ordinary Processing lifecycle.
 */
function bulkJob(changes = {}) {
    return job({jobId: "d".repeat(32), operation: "habitat.retry-missing-inputs.v1", inputs: {areaCount: 3}, ...changes});
}

/** Create a uniquely ordered history attempt for pagination scenarios.
 * @param {number} number Increasing creation order and identifier.
 * @param {Object} [changes={}] Lifecycle or input overrides.
 * @returns {Object} Retained preparation snapshot.
 */
function historyJob(number, changes = {}) {
    return job({jobId: number.toString(16).padStart(32, "0"),
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, number)).toISOString(), ...changes});
}

/** Compose the controller with observable browser, storage and transport boundaries.
 * @param {Object} [overrides={}] API methods replaced by the test.
 * @param {Map<string,string>} [values=new Map()] Persistent command storage shared across reloads.
 * @returns {Object} Controller, handlers and recorded boundary effects.
 */
function fixture(overrides = {}, values = new Map()) {
    const document = new EventTarget(), window = new EventTarget();
    document.hidden = false; document.visibilityState = "visible";
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    window.localStorage = storage;
    const timers = new Map(); let nextTimer = 0, nextId = 0;
    const clock = { setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; }, clearTimeout: id => timers.delete(id) };
    const submitted = [], retried = [], bulkRequests = [], checked = [], listed = [], fetched = [], cancelled = [];
    const api = { getOptions: async () => structuredClone(options), searchAreas: async () => ({ sources: [structuredClone(source)], next: null }),
        coverage: async (value, year) => { checked.push({ value, year }); return { year, cachedTiles: 1, missingTiles: 1, requiredTiles: 2 }; },
        submit: async value => { submitted.push(structuredClone(value)); return job({ jobId: String(submitted.length).padStart(32, "0") }); },
        list: async request => { listed.push(request); return { jobs: [], nextCursor: null }; },
        get: async id => { fetched.push(id); return job({ jobId: id }); },
        cancel: async id => { cancelled.push(id); return job({ jobId: id, status: "cancelled", updatedAt: "2026-01-01T00:01:00Z" }); },
        retry: async (id, requestId) => { retried.push({ id, requestId }); return job({ jobId: "c".repeat(32) }); },
        retryAll: async requestId => { bulkRequests.push(requestId); return bulkJob(); }, ...overrides };
    let handlers; const renders = [];
    const view = { bind: value => { handlers = value; }, render: state => renders.push(structuredClone(state)), destroy() {} };
    const controller = new HabitatAdminController({ api, view, documentContext: document, windowContext: window, clock,
        newId: () => (++nextId).toString(16).padStart(32, "0") });
    return { controller, api, document, window, storage, values, timers, submitted, retried, bulkRequests, checked, listed, fetched, cancelled, renders, handlers };
}

/** Load metadata and capture the fixture Catalog area without checking it.
 * @param {Object} context Controller fixture.
 * @returns {Promise<void>} Resolves once an area and default year are available.
 */
async function chooseArea(context) {
    await context.controller.start(); await context.handlers.search("project");
    assert.equal(context.handlers.addArea("North", source.key, selection.filter), true);
}

/** Allow event-triggered promise continuations to finish.
 * @returns {Promise<void>} Resolves on the next Node event-loop turn.
 */
function flush() { return new Promise(resolve => setImmediate(resolve)); }

test("initial metadata/history reads do not check coverage or start preparations", async t => {
    const h = fixture(); t.after(() => h.controller.destroy());
    await h.controller.start();
    assert.deepEqual(h.controller.state.years, [2018]);
    assert.deepEqual(h.checked, []); assert.deepEqual(h.submitted, []);
    assert.equal(h.controller.state.sources.length, 0);
    assert.equal([...h.timers.values()][0].delay, 30000);
});

test("incomplete ready reports are retryable and failure logs only load on explicit expansion", async t => {
    const report = {sha256: "c".repeat(64), tileCount: 0, requiredTileCount: 1, failedTileCount: 1};
    const original = job({status: "ready", result: report});
    const reads = [], failures = [{column: 7, row: -5, stage: "download", code: "earth_engine_access_denied",
        detail: "Access to a source dataset was denied.", httpStatus: 403}];
    const h = fixture({list: async () => ({jobs: [original], nextCursor: null}), failureLog: (_report, signal) => {
        const request = deferred(); reads.push({request, signal}); return request.promise;
    }});
    t.after(() => h.controller.destroy());
    await h.controller.start();
    assert.equal(reads.length, 0);
    const first = h.handlers.openFailureLog(original.jobId);
    await h.handlers.openFailureLog(original.jobId);
    assert.equal(reads.length, 1);
    assert.equal(h.renders.at(-1).failureLogs.get(original.jobId).loading, true);
    h.handlers.closeFailureLog(original.jobId);
    assert.equal(reads[0].signal.aborted, true);
    const second = h.handlers.openFailureLog(original.jobId);
    reads[0].request.resolve(failures); await first;
    assert.equal(h.renders.at(-1).failureLogs.get(original.jobId).loading, true);
    reads[1].request.reject(new Error("Could not reach EOLab.")); await second;
    assert.equal(h.renders.at(-1).failureLogs.get(original.jobId).error, "Could not reach EOLab.");
    const third = h.handlers.openFailureLog(original.jobId);
    reads[2].request.resolve(failures); await third;
    assert.deepEqual(h.renders.at(-1).failureLogs.get(original.jobId).failures, failures);
    h.handlers.closeFailureLog(original.jobId);
    await h.handlers.openFailureLog(original.jobId);
    assert.equal(reads.length, 3);
    await h.handlers.retry(original.jobId);
    assert.equal(h.retried[0].id, original.jobId);
    original.expiresAt = "2000-01-01T00:00:00Z";
    await h.handlers.refreshHistory();
    assert.equal(h.renders.at(-1).failureLogs.has(original.jobId), false);
    await h.handlers.openFailureLog(original.jobId);
    assert.equal(reads.length, 3);
});

test("named Catalog filters are validated and frozen without preparing or checking", async t => {
    const h = fixture(); t.after(() => h.controller.destroy());
    await h.controller.start(); await h.handlers.search("areas");
    const filter = { enabled: true, match: "all", rules: [{ field: "project", operator: "eq", value: 1 }] };
    assert.equal(h.handlers.addArea("North", source.key, filter), true);
    filter.rules[0].value = 9;
    const captured = h.controller.state.areas[0];
    assert.equal(captured.selection.filter.rules[0].value, 1);
    assert.equal(Object.isFrozen(captured.selection.filter.rules[0]), true);
    assert.equal(h.handlers.addArea("Duplicate", source.key, { ...filter, rules: [{ field: "project", operator: "eq", value: 1 }] }), false);
    assert.equal(h.handlers.addArea("Invalid", source.key, { ...filter, rules: [{ field: "project", operator: "eq", value: "1" }] }), false);
    h.handlers.setYears([2019, 2018, 2019]);
    assert.deepEqual(h.controller.state.years, [2018, 2019]);
    assert.equal(h.controller.state.coverageRows.length, 2);
    assert.equal(h.controller.state.canPrepare, true);
    assert.deepEqual(h.checked, []); assert.deepEqual(h.submitted, []);
});

test("editing the area or years aborts an explicit coverage check and ignores its late reply", async t => {
    const pending = deferred(); let signal;
    const h = fixture({ coverage: async (value, year, requestSignal) => { signal = requestSignal; return pending.promise; } });
    t.after(() => h.controller.destroy()); await chooseArea(h);
    const checking = h.handlers.check();
    assert.equal(h.controller.state.checking, true);
    h.handlers.setYears([2019]);
    assert.equal(signal.aborted, true);
    pending.resolve({ cachedTiles: 99 }); await checking;
    assert.equal(h.controller.state.coverageRows[0].year, 2019);
    assert.equal(h.controller.state.coverageRows[0].coverage, null);
    assert.equal(h.controller.state.checking, false);
});

test("multiple years submit distinct commands once and continue definite row failures", async t => {
    const requests = [];
    const h = fixture({ submit: async request => { requests.push(structuredClone(request));
        if (request.year === 2018) throw Object.assign(new Error("This area is unavailable."), { status: 409, uncertain: false });
        return job({ jobId: "d".repeat(32), status: "ready" }); } });
    t.after(() => h.controller.destroy()); await chooseArea(h); h.handlers.setYears([2018, 2019]);
    await h.handlers.prepare();
    assert.equal(requests.length, 2); assert.notEqual(requests[0].requestId, requests[1].requestId);
    assert.deepEqual(h.controller.state.submissions.map(row => row.status), ["failed", "accepted"]);
    assert.equal(h.controller.state.areaRows.length, 1);
    assert.equal(h.renders.at(-1).areaRows[0].latest.status, "ready");
    assert.equal(h.values.size, 0); assert.equal(h.controller.state.canPrepare, true);
    await h.handlers.prepare();
    assert.equal(requests.length, 3); assert.equal(requests.at(-1).year, 2018);
    assert.notEqual(requests.at(-1).requestId, requests[0].requestId);
});

test("double preparation clicks cannot duplicate accepted area/year commands", async t => {
    const pending = deferred(); let calls = 0;
    const h = fixture({ submit: async () => { calls++; return pending.promise; } });
    t.after(() => h.controller.destroy()); await chooseArea(h);
    const first = h.handlers.prepare(); await h.handlers.prepare();
    assert.equal(calls, 1); assert.equal(h.values.size, 1);
    pending.resolve(job()); await first; await h.handlers.prepare();
    assert.equal(calls, 1); assert.equal(h.controller.state.canPrepare, false);
});

test("unknown acceptance survives reload and recovers the exact original request explicitly", async t => {
    const values = new Map(), attempts = [];
    const first = fixture({ submit: async request => { attempts.push(structuredClone(request));
        throw Object.assign(new Error("Connection lost"), { status: null, uncertain: true }); } }, values);
    await chooseArea(first); await first.handlers.prepare();
    const key = first.controller.state.submissions[0].key;
    assert.equal(first.controller.state.submissions[0].status, "uncertain");
    first.controller.destroy();
    const second = fixture({ submit: async request => { attempts.push(structuredClone(request)); return job(); } }, values);
    t.after(() => second.controller.destroy()); await second.controller.start();
    assert.equal(attempts.length, 1); assert.equal(second.controller.state.submissions[0].status, "uncertain");
    await second.handlers.search("project"); second.handlers.addArea("Renamed draft", source.key, selection.filter);
    await second.handlers.prepare(); assert.equal(attempts.length, 1);
    await second.handlers.recover(key);
    assert.deepEqual(attempts[1], attempts[0]); assert.equal(values.size, 0);
    assert.equal(second.controller.state.areaRows[0].latest.jobId, job().jobId);
});

test("storage failure prevents POSTs whose request identity cannot be recovered", async t => {
    const h = fixture(); t.after(() => h.controller.destroy()); await chooseArea(h);
    h.storage.setItem = () => { throw new Error("Browser storage is full."); };
    await h.handlers.prepare();
    assert.equal(h.submitted.length, 0);
    assert.equal(h.controller.state.submissions[0].status, "failed");
    assert.match(h.controller.state.submissions[0].error, /storage is full/);
});

test("explicit retry keeps the original handle and command ID across an uncertain response", async t => {
    const attempts = []; let fail = true;
    const original = job({ status: "interrupted" });
    const h = fixture({ list: async () => ({ jobs: [original], nextCursor: null }), retry: async (id, requestId) => {
        attempts.push({ id, requestId }); if (fail) throw Object.assign(new Error("Server response lost"), { status: 503, uncertain: true });
        return job({ jobId: "e".repeat(32) }); } });
    t.after(() => h.controller.destroy()); await h.controller.start(); await h.handlers.retry(original.jobId);
    const row = h.controller.state.submissions[0]; assert.equal(row.kind, "retry"); assert.equal(row.status, "uncertain");
    fail = false; await h.handlers.recover(row.key);
    assert.deepEqual(attempts[1], attempts[0]); assert.equal(attempts[0].id, original.jobId);
    assert.equal(h.controller.state.jobs.find(value => value.jobId === original.jobId).status, "interrupted");
    assert.equal(h.controller.state.submissions[0].jobId, "e".repeat(32)); assert.equal(h.values.size, 0);
});

test("expired saved-input metadata cannot create a fresh retry from an old history snapshot", async t => {
    const original = job({ status: "failed", metadataExpiresAt: "2000-01-01T00:00:00Z" });
    const h = fixture({ list: async () => ({ jobs: [original], nextCursor: null }) });
    t.after(() => h.controller.destroy()); await h.controller.start(); await h.handlers.retry(original.jobId);
    assert.deepEqual(h.retried, []); assert.equal(h.controller.state.submissions.length, 0);
    assert.match(h.controller.state.error, /saved inputs have expired/);
});

test("retry all hands one request to the server without browser planning or changing chosen inputs", async t => {
    const h = fixture(); t.after(() => h.controller.destroy()); await chooseArea(h);
    const drafts = structuredClone({areas: h.controller.state.areas, years: h.controller.state.years, coverage: h.controller.state.coverageRows});
    await h.handlers.retryAll();
    assert.equal(h.bulkRequests.length, 1); assert.equal(h.listed.length, 1);
    assert.deepEqual(h.checked, []); assert.deepEqual(h.submitted, []); assert.deepEqual(h.retried, []);
    assert.deepEqual({areas: h.controller.state.areas, years: h.controller.state.years, coverage: h.controller.state.coverageRows}, drafts);
    const row = h.controller.state.submissions[0];
    assert.equal(row.kind, "retryAll"); assert.equal(row.year, null); assert.equal(row.status, "accepted");
    assert.deepEqual(row.request, {requestId: h.bulkRequests[0]}); assert.equal(row.jobId, bulkJob().jobId);
    assert.equal(h.values.size, 0);
    await h.handlers.retryAll(); assert.equal(h.bulkRequests.length, 1, "known active bulk work keeps its existing receipt");
});

test("pagehide does not abort a bulk handoff and the receipt needs no follow-up submissions", async t => {
    const pending = deferred(); let signal, calls = 0;
    const h = fixture({retryAll: async (_requestId, requestSignal) => { calls++; signal = requestSignal; return pending.promise; }});
    t.after(() => h.controller.destroy()); await h.controller.start();
    const submitted = h.handlers.retryAll(); await h.handlers.retryAll();
    assert.equal(calls, 1); assert.equal(h.values.size, 1);
    h.window.dispatchEvent(new Event("pagehide"));
    assert.equal(signal.aborted, false);
    pending.resolve(bulkJob()); await submitted;
    assert.equal(h.controller.state.submissions[0].status, "accepted");
    assert.equal(h.values.size, 0); assert.deepEqual(h.submitted, []); assert.deepEqual(h.cancelled, []);
});

test("closing before the bulk response retains its exact command for recovery after reload", async t => {
    const pending = deferred(), values = new Map(), attempts = []; let signal;
    const first = fixture({retryAll: async (requestId, requestSignal) => { attempts.push(requestId); signal = requestSignal; return pending.promise; }}, values);
    await first.controller.start(); const submitting = first.handlers.retryAll();
    first.controller.destroy(); assert.equal(signal.aborted, true);
    pending.reject(new DOMException("Page closed", "AbortError")); await submitting;
    assert.deepEqual(first.cancelled, []);
    const saved = JSON.parse([...values.values()][0]);
    assert.equal(saved.length, 1); assert.equal(saved[0].kind, "retryAll");
    assert.deepEqual(saved[0].request, {requestId: attempts[0]});
    const second = fixture({retryAll: async requestId => { attempts.push(requestId); return bulkJob(); }}, values);
    t.after(() => second.controller.destroy()); await second.controller.start();
    assert.equal(second.controller.state.submissions[0].status, "uncertain"); assert.equal(attempts.length, 1);
    await second.handlers.retryAll(); assert.equal(attempts.length, 1);
    assert.match(second.controller.state.error, /Use Recover submission in Requests from this visit/);
    await second.handlers.recover(second.controller.state.submissions[0].key);
    assert.deepEqual(attempts, [saved[0].request.requestId, saved[0].request.requestId]);
    assert.equal(second.controller.state.submissions[0].jobId, bulkJob().jobId); assert.equal(values.size, 0);
});

test("bulk storage refusal prevents handoff and definite rejection permits a fresh command", async t => {
    const h = fixture(); t.after(() => h.controller.destroy()); await h.controller.start();
    const setItem = h.storage.setItem;
    h.storage.setItem = () => { throw new Error("Browser storage is full."); };
    await h.handlers.retryAll();
    assert.deepEqual(h.bulkRequests, []); assert.equal(h.controller.state.submissions[0].status, "failed");
    assert.match(h.controller.state.submissions[0].error, /storage is full/);
    h.storage.setItem = setItem;
    const rejected = [];
    h.api.retryAll = async requestId => { rejected.push(requestId); throw Object.assign(new Error("Access denied"), {status: 403, uncertain: false}); };
    await h.handlers.retryAll(); assert.equal(h.controller.state.submissions.at(-1).status, "failed"); assert.equal(h.values.size, 0);
    h.api.retryAll = async requestId => { h.bulkRequests.push(requestId); return bulkJob(); };
    await h.handlers.retryAll(); assert.notEqual(h.bulkRequests[0], rejected[0]);
    assert.equal(h.controller.state.submissions.at(-1).status, "accepted");
});

test("unresolved individual commands still require recovery before requesting bulk work", async t => {
    const original = job({status: "failed"});
    const h = fixture({list: async () => ({jobs: [original], nextCursor: null}),
        retry: async () => { throw Object.assign(new Error("Response lost"), {uncertain: true}); }});
    t.after(() => h.controller.destroy()); await h.controller.start(); await h.handlers.retry(original.jobId);
    await h.handlers.retryAll(); assert.deepEqual(h.bulkRequests, []);
    assert.match(h.controller.state.error, /Use Recover submission in Requests from this visit/);
});

test("returning to the page observes the bulk receipt and child jobs without resubmitting either", async t => {
    const receipt = bulkJob({status: "running"}), child = job();
    const h = fixture({list: async () => ({jobs: [receipt, child], nextCursor: null})});
    t.after(() => h.controller.destroy()); await h.controller.start();
    assert.deepEqual(h.controller.state.jobs.map(value => value.operation).sort(), ["habitat.prepare-inputs.v1", "habitat.retry-missing-inputs.v1"]);
    assert.deepEqual(h.bulkRequests, []); assert.deepEqual(h.submitted, []);
    h.window.dispatchEvent(new Event("pagehide")); h.window.dispatchEvent(new Event("pageshow")); await flush();
    assert.deepEqual(h.bulkRequests, []); assert.deepEqual(h.submitted, []); assert.deepEqual(h.cancelled, []);
});

test("bulk failures load from the protected report and cancellation targets only the parent receipt", async t => {
    const report = {sha256: "b".repeat(64), areaCount: 3, queuedCount: 1, cachedCount: 1, activeCount: 0, failedCount: 1};
    const receipt = bulkJob({status: "ready", result: report}), child = job(), failures = [{name: "North", year: 2018, detail: "Source unavailable."}];
    const reads = [], cancelled = [];
    const h = fixture({list: async () => ({jobs: [receipt, child], nextCursor: null}),
        retryAllFailures: async value => { reads.push(value); return failures; },
        failureLog: async () => assert.fail("Bulk reports do not contain tile failures"),
        cancel: async id => { cancelled.push(id); return bulkJob({status: "cancelling"}); }});
    t.after(() => h.controller.destroy()); await h.controller.start();
    assert.equal(reads.length, 0); await h.handlers.openFailureLog(receipt.jobId);
    assert.deepEqual(reads, [report]); assert.deepEqual(h.renders.at(-1).failureLogs.get(receipt.jobId).failures, failures);
    await h.handlers.retry(receipt.jobId); assert.deepEqual(h.retried, []);
    h.controller.mergeJob(bulkJob({status: "running"}), true); await h.handlers.cancel(receipt.jobId);
    assert.deepEqual(cancelled, [receipt.jobId]); assert.equal(h.controller.jobs.get(child.jobId).status, "queued");
});

test("a definite admission failure without HTTP status still permits correcting and preparing again", async t => {
    const h = fixture({ submit: async () => { throw Object.assign(new Error("Invalid metadata"), { status: null, uncertain: false }); } });
    t.after(() => h.controller.destroy()); await chooseArea(h); await h.handlers.prepare();
    assert.equal(h.controller.state.submissions[0].status, "failed");
    assert.equal(h.controller.state.canPrepare, true); assert.equal(h.values.size, 0);
});

test("older history responses cannot undo a cancellation acknowledgement", async t => {
    const pending = deferred(); let reads = 0;
    const h = fixture({ list: async () => ++reads === 1 ? { jobs: [job()], nextCursor: null } : pending.promise });
    t.after(() => h.controller.destroy()); await h.controller.start();
    const refresh = h.handlers.refreshHistory(); await h.handlers.cancel(job().jobId);
    pending.resolve({ jobs: [job()], nextCursor: null }); await refresh;
    assert.equal(h.controller.state.jobs[0].status, "cancelled");
});

test("initial history follows every page and polling refreshes older active jobs", async t => {
    const older = job({ jobId: "f".repeat(32), createdAt: "2025-01-01T00:00:00Z" });
    const cursors = [], fetched = [];
    const h = fixture({ list: async ({ cursor }) => { cursors.push(cursor);
        return cursor ? { jobs: [older], nextCursor: null } : { jobs: [job()], nextCursor: "older" }; },
        get: async id => { fetched.push(id); return job({ ...older, jobId: id, status: "ready", updatedAt: "2026-01-01T00:02:00Z" }); } });
    t.after(() => h.controller.destroy()); await h.controller.start();
    assert.equal(h.controller.state.jobs.length, 2); assert.equal(h.controller.state.historyComplete, true);
    assert.deepEqual(cursors, [null, "older"]);
    const timer = [...h.timers.values()].at(-1); assert.equal(timer.delay, 2000);
    await timer.callback();
    assert.equal(h.controller.state.jobs.length, 2); assert.deepEqual(cursors, [null, "older", null]);
    assert.deepEqual(fetched, [older.jobId]);
    assert.equal(h.controller.state.jobs.find(value => value.jobId === older.jobId).status, "ready");
});

test("area rows group exact source predicates and years across labels, configurations and expired reports", async t => {
    const first = historyJob(1, {status: "expired"});
    const latest = historyJob(2, {inputs: {...first.inputs, name: "Renamed North", configurationSha256: "c".repeat(64)}});
    const anotherYear = historyJob(3, {inputs: {...first.inputs, year: 2019}});
    const anotherSource = historyJob(4, {inputs: {...first.inputs, selection: {...selection, itemId: "other-areas"}}});
    const anotherFilter = historyJob(5, {inputs: {...first.inputs, selection: {...selection,
        filter: {enabled: true, match: "all", rules: [{field: "project", operator: "eq", value: 1}]}}}});
    const expiredInputs = historyJob(6, {status: "expired", metadataExpiresAt: "2020-01-01T00:00:00Z"});
    const noInputs = historyJob(7, {status: "expired", inputs: null});
    const bulk = bulkJob();
    const h = fixture({list: async () => ({jobs: [first, latest, anotherYear, anotherSource, anotherFilter, expiredInputs, noInputs, bulk], nextCursor: null})});
    t.after(() => h.controller.destroy()); await h.controller.start();
    assert.equal(h.controller.state.areaRows.length, 4);
    const grouped = h.controller.state.areaRows.find(row => row.latest.jobId === latest.jobId);
    assert.equal(grouped.name, "Renamed North"); assert.deepEqual(grouped.previous.map(row => row.jobId), [first.jobId]);
    assert.equal(new Set(h.controller.state.areaRows.map(row => row.key)).size, 4);
    assert.deepEqual(h.controller.state.expiredJobs.map(row => row.jobId), [noInputs.jobId, expiredInputs.jobId]);
    assert.deepEqual(h.controller.state.bulkJobs, [bulk]);
    assert.equal(grouped.coverage, null); assert.deepEqual(h.checked, []);
});

test("polling follows more than fifty new arrivals until the previous newest attempt", async t => {
    const original = historyJob(1, {status: "ready"}), arrivals = Array.from({length: 75}, (_, index) => historyJob(index + 2));
    let incoming = false; const cursors = [];
    const h = fixture({list: async ({cursor}) => { cursors.push(cursor);
        if (!incoming) return {jobs: [original], nextCursor: null};
        const rows = [...arrivals].reverse().concat(original), offset = cursor === null ? 0 : Number(cursor);
        return {jobs: rows.slice(offset, offset + 50), nextCursor: offset + 50 < rows.length ? String(offset + 50) : null};
    }});
    t.after(() => h.controller.destroy()); await h.controller.start(); incoming = true;
    await [...h.timers.values()].at(-1).callback();
    assert.deepEqual(cursors, [null, null, "50"]);
    assert.equal(h.controller.state.jobs.length, 76); assert.equal(h.controller.state.historyComplete, true);
    assert.equal(h.controller.state.areaRows[0].previous.length, 75);
    assert.equal(h.controller.state.areaRows[0].latest.jobId, arrivals.at(-1).jobId);
});

test("full refresh reconciles all pages without deleting a retry accepted during the read", async t => {
    const original = historyJob(1, {status: "cancelled"}), removed = historyJob(2, {status: "expired"});
    const child = historyJob(3), tail = deferred(); let refreshing = false; const cursors = [];
    const h = fixture({list: async ({cursor}) => { cursors.push(cursor);
        if (!refreshing) return {jobs: [removed, original], nextCursor: null};
        return cursor === null ? {jobs: [original], nextCursor: "tail"} : tail.promise;
    }, retry: async () => child});
    t.after(() => h.controller.destroy()); await h.controller.start(); refreshing = true;
    const refresh = h.handlers.refreshHistory(); await flush();
    assert.equal(h.controller.state.historyComplete, false);
    await h.handlers.retry(original.jobId);
    tail.resolve({jobs: [], nextCursor: null}); await refresh;
    assert.deepEqual(cursors, [null, null, "tail"]);
    assert.deepEqual(h.controller.state.jobs.map(row => row.jobId), [child.jobId, original.jobId]);
    assert.equal(h.controller.state.historyComplete, true); assert.ok(h.controller.state.historyCheckedAt);
});

test("an incomplete initial traversal remains labelled incomplete and retries every page", async t => {
    const newest = historyJob(2), older = historyJob(1); let fail = true; const cursors = [];
    const h = fixture({list: async ({cursor}) => { cursors.push(cursor);
        if (cursor === null) return {jobs: [newest], nextCursor: "older"};
        if (fail) throw new Error("History unavailable");
        return {jobs: [older], nextCursor: null};
    }});
    t.after(() => h.controller.destroy()); await h.controller.start();
    assert.equal(h.controller.state.historyComplete, false); assert.equal(h.controller.state.historyCheckedAt, null);
    assert.equal(h.controller.state.jobs.length, 1); assert.match(h.controller.state.historyError, /History unavailable/);
    fail = false; await [...h.timers.values()].at(-1).callback();
    assert.deepEqual(cursors, [null, "older", null, "older"]);
    assert.equal(h.controller.state.historyComplete, true); assert.equal(h.controller.state.jobs.length, 2);
    assert.equal(h.controller.state.historyError, "");
});

test("visibility changes stop reads/timers and immediately refresh on return", async t => {
    const pending = deferred(); let reads = 0, hiddenSignal;
    const h = fixture({ list: async ({ signal }) => { reads++; if (reads === 2) { hiddenSignal = signal; return pending.promise; }
        return { jobs: [job({ status: "ready" })], nextCursor: null }; } });
    t.after(() => h.controller.destroy()); await h.controller.start();
    const reading = h.handlers.refreshHistory();
    h.document.hidden = true; h.document.visibilityState = "hidden"; h.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(hiddenSignal.aborted, true); assert.equal(h.timers.size, 0);
    pending.resolve({ jobs: [job()], nextCursor: null }); await reading;
    assert.equal(h.controller.state.jobs[0].status, "ready");
    h.document.hidden = false; h.document.visibilityState = "visible"; h.document.dispatchEvent(new Event("visibilitychange")); await flush();
    assert.equal(reads, 3); assert.equal([...h.timers.values()][0].delay, 30000);
});

test("destroy aborts page-owned requests and never cancels accepted server work", async () => {
    const pending = deferred(); let signal;
    const h = fixture({ coverage: async (value, year, requestSignal) => { signal = requestSignal; return pending.promise; } });
    await chooseArea(h); const checking = h.handlers.check(); const renders = h.renders.length;
    h.controller.destroy(); assert.equal(signal.aborted, true); assert.equal(h.timers.size, 0);
    pending.resolve({ cachedTiles: 10 }); await checking;
    h.document.dispatchEvent(new Event("visibilitychange")); h.window.dispatchEvent(new Event("pageshow")); await flush();
    assert.equal(h.renders.length, renders); assert.deepEqual(h.cancelled, []);
});


test("inventory reads require explicit refresh and remain separate from coverage and history", async t => {
    const reads = [], h = fixture({inventory: async signal => { reads.push(signal); return []; }});
    t.after(() => h.controller.destroy());
    await chooseArea(h);
    assert.equal(reads.length, 0);
    await h.handlers.refreshInventory();
    assert.equal(reads.length, 1); assert.deepEqual(h.controller.state.inventory, []);
    assert.ok(h.controller.state.inventoryCheckedAt);
    assert.equal(h.controller.state.inventoryLoading, false);
    assert.equal(h.controller.state.areas.length, 1);
    assert.equal(h.controller.state.coverageRows[0].coverage, null);
    assert.equal(h.submitted.length, 0); assert.equal(h.checked.length, 0);
    await h.handlers.refreshHistory();
    assert.equal(reads.length, 1);
    h.api.inventory = async () => { throw new Error("Private cache is temporarily unavailable."); };
    await h.handlers.refreshInventory();
    assert.deepEqual(h.controller.state.inventory, []);
    assert.match(h.controller.state.inventoryError, /temporarily unavailable/);
});


test("hiding the page cancels inventory reads and late replies cannot replace an explicit newer snapshot", async t => {
    const pending = deferred(); let signal, calls = 0;
    const h = fixture({inventory: async requestSignal => { calls++; signal = requestSignal; return pending.promise; }});
    t.after(() => h.controller.destroy());
    await h.controller.start();
    const read = h.handlers.refreshInventory();
    assert.equal(h.controller.state.inventoryLoading, true);
    h.document.hidden = true; h.document.visibilityState = "hidden";
    h.document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(signal.aborted, true); assert.equal(h.controller.state.inventoryLoading, false);
    h.document.hidden = false; h.document.visibilityState = "visible";
    h.document.dispatchEvent(new Event("visibilitychange")); await flush();
    assert.equal(calls, 1, "visibility/history must not schedule inventory reads");
    h.api.inventory = async () => [{configurationSha256: "b".repeat(64)}];
    await h.handlers.refreshInventory();
    pending.resolve([{configurationSha256: "a".repeat(64)}]); await read;
    assert.deepEqual(h.controller.state.inventory, [{configurationSha256: "b".repeat(64)}]);
    assert.equal(h.controller.state.inventoryError, "");
});

test("saved-area cache checks remain explicit timestamped snapshots across history and failures", async t => {
    const h = fixture({list: async () => ({jobs: [job({status: "expired"})], nextCursor: null})});
    t.after(() => h.controller.destroy()); await h.controller.start();
    const key = h.controller.state.areaRows[0].key;
    assert.deepEqual(h.checked, []); assert.equal(h.controller.state.areaRows[0].coverage, null);
    await h.handlers.checkSavedArea(key);
    const snapshot = h.controller.state.areaRows[0];
    assert.equal(snapshot.coverage.missingTiles, 1); assert.ok(snapshot.checkedAt);
    assert.equal(h.checked.length, 1);
    await h.handlers.refreshHistory();
    h.window.dispatchEvent(new Event("pagehide")); h.window.dispatchEvent(new Event("pageshow")); await flush();
    assert.equal(h.checked.length, 1);
    h.api.coverage = async () => { throw new Error("Cache unavailable"); };
    await h.handlers.checkSavedArea(key);
    const failed = h.controller.state.areaRows[0];
    assert.deepEqual(failed.coverage, snapshot.coverage); assert.equal(failed.checkedAt, snapshot.checkedAt);
    assert.match(failed.coverageError, /Cache unavailable/); assert.equal(failed.checking, false);
    assert.deepEqual(h.submitted, []); assert.deepEqual(h.bulkRequests, []);
});

test("hiding cancels a saved-area check and its late reply cannot replace a newer explicit check", async t => {
    const reads = [], h = fixture({list: async () => ({jobs: [job()], nextCursor: null}),
        coverage: (selected, year, signal) => { const request = deferred(); reads.push({selected, year, signal, request}); return request.promise; }});
    t.after(() => h.controller.destroy()); await h.controller.start();
    const key = h.controller.state.areaRows[0].key;
    const first = h.handlers.checkSavedArea(key); await h.handlers.checkSavedArea(key);
    assert.equal(reads.length, 1); assert.equal(h.controller.state.areaRows[0].checking, true);
    assert.deepEqual(reads[0].selected, selection); assert.equal(reads[0].year, 2018);
    h.window.dispatchEvent(new Event("pagehide"));
    assert.equal(reads[0].signal.aborted, true); assert.equal(h.controller.state.areaRows[0].checking, false);
    h.window.dispatchEvent(new Event("pageshow")); await flush(); assert.equal(reads.length, 1);
    const second = h.handlers.checkSavedArea(key), current = {year: 2018, requiredTiles: 4, cachedTiles: 4, missingTiles: 0};
    reads[1].request.resolve(current); await second;
    reads[0].request.resolve({year: 2018, requiredTiles: 4, cachedTiles: 1, missingTiles: 3}); await first;
    assert.deepEqual(h.controller.state.areaRows[0].coverage, current);
    assert.equal(h.controller.state.areaRows[0].checking, false); assert.deepEqual(h.cancelled, []);
});

test("checking the chosen area shares its explicit snapshot with the matching saved row", async t => {
    const h = fixture({list: async () => ({jobs: [job()], nextCursor: null})});
    t.after(() => h.controller.destroy()); await chooseArea(h); await h.handlers.check();
    assert.deepEqual(h.controller.state.areaRows[0].coverage, h.controller.state.coverageRows[0].coverage);
    assert.equal(h.controller.state.areaRows[0].checkedAt, h.controller.state.coverageRows[0].checkedAt);
    assert.equal(h.checked.length, 1); assert.deepEqual(h.submitted, []);
});
