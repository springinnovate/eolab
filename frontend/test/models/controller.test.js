import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ModelsController } from "../../src/models/controller.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { ProcessingRequestError } from "../../src/processing/api.js";
import { captureModelSubmission, createModelDraft, modelViewportArea } from "../../src/models/inputs.js";
import { model, raster, area, invocation, selection, job } from "../../test-support/models/fixtures.js";

/** Compose the real controller and observer with controllable boundary responses.
 * @param {Object} [overrides={}] API behavior replacements.
 * @return {Object} Component and recorded user-visible effects.
 */
function fixture(overrides = {}) {
    const values = new Map(); const submitted = []; const cancelled = [];
    const api = {discoverModels: async () => [model], listModelRuns: async () => ({jobs: [], nextCursor: null}),
        getJob: async () => job(), readModelInvocation: async () => structuredClone(invocation),
        submitModelRun: async value => { submitted.push(value); return job(); },
        cancelJob: async id => { cancelled.push(id); return job({status: "cancelled"}); },
        readJobStatuses: async () => ({jobs: [job({status: "cancelled"})], unavailableJobIds: []}), listJobs: async () => [], ...overrides};
    const clock = {setTimeout: () => 1, clearTimeout: () => {}};
    const jobs = new ProcessingJobs(api, clock);
    const context = {rasters: [structuredClone(raster)], area: structuredClone(area)};
    let sequence = 0; let handlers;
    const view = {bind: value => { handlers = value; }, render: () => {}, focusHeading: () => {}, destroy: () => {}};
    const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
    const controller = new ModelsController({api, jobs, view, storage, getContext: () => context, searchSources: async () => ({sources: [], next: null}),
        prepareVector: async () => ({selection, matched: 3, total: 8, bbox: [0, 0, 1, 1]}), onOpen: () => controller.setActive(true),
        onClose: () => controller.setActive(false), newId: () => String(++sequence).padStart(32, "0")});
    return {controller, api, jobs, context, storage, values, submitted, cancelled, handlers};
}

test("ambiguous rasters require a choice; hidden and selected catalog inputs remain available", () => {
    const hidden = {...raster, itemId: "hidden", visible: false};
    let draft = createModelDraft(model, {rasters: [raster, {...raster, itemId: "second"}, hidden]}, "draft");
    assert.equal(draft.raster, null); assert.equal(draft.sources.length, 3);
    draft = createModelDraft(model, {rasters: [raster], selectedRaster: hidden}, "draft");
    assert.equal(draft.raster.itemId, "hidden"); assert.match(draft.sourceReason, /catalog/);
});

test("map edits and closing the tool do not mutate captured inputs or cancel accepted work", async () => {
    const h = fixture(); h.controller.chooseModel(model);
    h.context.area.selectedBounds.west = -10; h.context.rasters[0].itemId = "changed";
    await h.controller.submit();
    assert.equal(h.submitted[0].inputs.raster.itemId, "population"); assert.equal(h.submitted[0].inputs.area.selectedBounds.west, 0);
    h.handlers.onClose(); h.controller.navigate("library"); h.controller.destroy();
    assert.deepEqual(h.cancelled, []); assert.equal(h.values.size, 0);
});

test("a lost submission response survives reload and retries the exact captured request", async () => {
    const h = fixture({submitModelRun: async () => { throw new TypeError("Connection lost"); }});
    h.controller.chooseModel(model); await h.controller.submit();
    const captured = structuredClone(h.controller.state.pending); assert.ok(captured);
    h.controller.chooseModel(model); h.controller.editDraft({label: "Different draft"});
    const next = fixture(); next.controller.storage = h.storage; next.controller.start();
    await next.controller.submit(true);
    assert.deepEqual(next.submitted[0], captured); assert.equal(next.controller.state.pending, null);
    assert.equal(next.controller.state.page, "run");
});

test("definite rejection leaves the draft editable and does not silently retry", async () => {
    const h = fixture({submitModelRun: async () => { throw new ProcessingRequestError("Invalid formula", 422); }});
    h.controller.chooseModel(model); await h.controller.submit();
    assert.equal(h.controller.state.pending, null); assert.match(h.controller.state.error, /Invalid formula/); assert.equal(h.values.size, 0);
});

test("late submission and saved-input replies cannot replace a newly selected draft", async () => {
    let accept; const h = fixture({submitModelRun: () => new Promise(resolve => { accept = resolve; })});
    h.controller.chooseModel(model); const pending = h.controller.submit();
    h.controller.chooseModel(model); const current = h.controller.state.draft.id;
    accept(job()); await pending;
    assert.equal(h.controller.state.page, "setup"); assert.equal(h.controller.state.draft.id, current); assert.equal(h.controller.state.runs.length, 1);
    let reply; h.api.readModelInvocation = () => new Promise(resolve => { reply = resolve; });
    const reading = h.controller.showRun(job().jobId); h.controller.chooseModel(model); reply(invocation); await reading;
    assert.equal(h.controller.state.page, "setup"); assert.equal(h.controller.state.invocation, null);
});

test("progress observation preserves setup and explicit cancellation targets just its run", async () => {
    const h = fixture(); h.controller.chooseModel(model); const draft = h.controller.state.draft;
    h.jobs.accept(job({status: "running", progress: {phase: "calculating", completed: 2, total: 4, unit: "blocks"}}));
    assert.equal(h.controller.state.draft, draft); assert.equal(h.controller.state.page, "setup");
    await h.controller.showRun(job().jobId); await h.controller.cancelRun();
    assert.deepEqual(h.cancelled, [job().jobId]); assert.equal(h.controller.state.runs[0].status, "cancelled");
});

test("history pagination is independent of the shared recent-job preview", async () => {
    const cursors = []; const h = fixture({listModelRuns: async cursor => { cursors.push(cursor); return {jobs: [job({jobId: (cursor ? "2" : "1").repeat(32)})], nextCursor: cursor ? null : "older"}; }});
    await h.controller.loadRuns(); await h.controller.loadRuns(true);
    assert.deepEqual(cursors, [null, "older"]); assert.equal(h.controller.state.runs.length, 2);
    assert.equal(h.jobs.tracked.size, 2);
});

test("duplicate uses the saved recipe and inputs without submitting or changing its source run", async () => {
    const h = fixture(); await h.controller.loadLibrary(); await h.controller.showRun(job().jobId);
    await h.controller.duplicateRun();
    const draft = h.controller.state.draft;
    assert.deepEqual(captureModelSubmission(draft, "retry-key-1234567").inputs, invocation.inputs);
    draft.parameters.summary = "mean(a)";
    assert.equal(h.controller.state.invocation.parameters.summary, "sum(a)"); assert.equal(h.submitted.length, 0);
    h.controller.state.library = []; h.controller.state.page = "run";
    await h.controller.duplicateRun(); assert.match(h.controller.state.error, /no longer installed/);
});

test("a late vector preparation cannot overwrite a newer area choice", async () => {
    const h = fixture(); h.controller.chooseModel(model); const draft = h.controller.state.draft;
    draft.vectors = [{collectionId: selection.collectionId, itemId: selection.itemId, label: "Basins", filter: selection.filter}];
    let resolve; h.controller.prepareVector = () => new Promise(done => { resolve = done; });
    h.controller.chooseArea("vector"); const reading = h.controller.chooseVector(JSON.stringify([selection.collectionId, selection.itemId]));
    h.controller.chooseArea("whole"); resolve({selection, matched: 3, total: 8}); await reading;
    assert.deepEqual(draft.area, {kind: "wholeRaster"}); assert.equal(draft.selecting, false);
});

test("model modules do not import sibling controllers, rendering or map state", () => {
    const files = readdirSync(new URL("../../src/models/", import.meta.url)).filter(file => file.endsWith(".js"));
    for (const file of files) {
        const source = readFileSync(new URL(`../../src/models/${file}`, import.meta.url), "utf8");
        assert.doesNotMatch(source, /from ["'][^"']*(?:summary-statistics|raster-clips|raster\/|map-layers|vector\/|main\.js)/);
        assert.doesNotMatch(source, /beforeunload|pagehide|cancelOnClose/);
    }
});


test("duplicating a run cannot inherit an in-flight vector suggestion from the current map", async () => {
    const h = fixture();
    h.context.area = {kind: "catalogSelection", catalogSelection: selection};
    let prepared = 0; h.controller.prepareVector = async () => { prepared += 1; return {selection, matched: 3, total: 8}; };
    await h.controller.loadLibrary(); await h.controller.showRun(job().jobId); await h.controller.duplicateRun();
    await Promise.resolve();
    assert.equal(prepared, 0); assert.deepEqual(h.controller.state.draft.area, invocation.inputs.area);
    h.controller.chooseArea("whole"); h.controller.chooseArea("captured");
    assert.deepEqual(h.controller.state.draft.area, invocation.inputs.area);
});


test("visible map extent runs without a clicked selection and changes only when explicitly updated", async () => {
    const h = fixture(); h.context.area = null;
    h.context.viewportBounds = {west: -10, south: -5, east: 10, north: 5};
    h.controller.chooseModel(model); h.controller.chooseArea("viewport");
    const original = structuredClone(h.controller.state.draft.area);
    assert.deepEqual(original, {kind: "selectedArea", selectedBounds: h.context.viewportBounds});
    h.context.viewportBounds.west = -20;
    assert.deepEqual(h.controller.state.draft.area, original);
    h.handlers.onUpdateArea();
    assert.equal(h.controller.state.draft.area.selectedBounds.west, -20);
    await h.controller.submit();
    assert.equal(h.submitted.length, 1);
    assert.equal(h.submitted[0].inputs.area.selectedBounds.west, -20);
    h.context.viewportBounds.west = -30;
    assert.equal(h.submitted[0].inputs.area.selectedBounds.west, -20);
});

test("a missing analysis selection explains alternatives and can be copied after a map click", async () => {
    const h = fixture(); h.context.area = null; h.controller.chooseModel(model);
    h.controller.chooseArea("map"); await h.controller.submit();
    assert.equal(h.submitted.length, 0);
    assert.match(h.controller.state.error, /No selected analysis area.*Use visible map extent/);
    h.context.area = structuredClone(area);
    assert.equal(h.controller.state.draft.area, null);
    h.handlers.onUpdateArea();
    assert.deepEqual(h.controller.state.draft.area, area); assert.equal(h.controller.state.error, "");
    await h.controller.submit(); assert.equal(h.submitted.length, 1);
});

test("viewport capture excludes blank world margins and rejects unavailable or empty bounds", () => {
    assert.deepEqual(modelViewportArea({west: -240, south: -95, east: 240, north: 95}),
        {kind: "selectedArea", selectedBounds: {west: -180, south: -90, east: 180, north: 90}});
    assert.throws(() => modelViewportArea(null), /unavailable/);
    assert.throws(() => modelViewportArea({west: 0, east: 0, south: 0, north: 10}), /no visible area/);
    assert.throws(() => modelViewportArea({west: NaN, south: 0, east: 20, north: 10}), /unavailable/);
    assert.throws(() => modelViewportArea({west: 190, south: 0, east: 200, north: 10}), /inside the world/);
    const h = fixture(); h.controller.chooseModel(model); h.controller.chooseArea("viewport");
    assert.equal(h.controller.state.draft.area, null); assert.match(h.controller.state.draft.selectionError, /unavailable/);
});
