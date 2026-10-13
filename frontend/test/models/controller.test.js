import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ModelsView } from "../../src/models/view.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";
import { ModelsController } from "../../src/models/controller.js";
import { VectorFilterControls } from "../../src/vector/filter-controls.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { ProcessingRequestError } from "../../src/processing/api.js";
import { captureModelSubmission, createModelDraft, modelViewportArea } from "../../src/models/inputs.js";
import { model, raster, area, invocation, selection, job, clipModel, fileManifest } from "../../test-support/models/fixtures.js";

/** Compose the real controller and observer with controllable boundary responses.
 * @param {Object} [overrides={}] API behavior replacements.
 * @param {Object|null} [viewOverride=null] Optional real view for boundary tests.
 * @return {Object} Component and recorded user-visible effects.
 */
function fixture(overrides = {}, viewOverride = null) {
    const values = new Map(); const submitted = []; const cancelled = []; const filterRequests = []; const mapFilters = [];
    const api = {discoverModels: async () => [model], listModelRuns: async () => ({jobs: [], nextCursor: null}),
        getJob: async () => job(), readModelInvocation: async () => structuredClone(invocation),
        submitModelRun: async value => { submitted.push(value); return job(); },
        cancelJob: async id => { cancelled.push(id); return job({status: "cancelled"}); },
        readJobStatuses: async () => ({jobs: [job({status: "cancelled"})], unavailableJobIds: []}), listJobs: async () => [], ...overrides};
    const clock = {setTimeout: () => 1, clearTimeout: () => {}};
    const jobs = new ProcessingJobs(api, clock);
    const context = {rasters: [structuredClone(raster)], area: structuredClone(area)};
    let sequence = 0; let handlers;
    const view = viewOverride ?? {bind: value => { handlers = value; }, render: () => {}, focusHeading: () => {}, destroy: () => {}, getVectorFilterHost: () => ({id: "inline-host"})};
    const storage = {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)};
    const controller = new ModelsController({api, jobs, view, storage, clock, getContext: () => context,
        prepareVector: async () => ({selection, matched: 3, total: 8, bbox: [0, 0, 1, 1]}), editVectorFilter: async request => { filterRequests.push(request); },
        closeVectorFilter: () => filterRequests.at(-1)?.close(),
        applyMapFilter: async (source, filter) => {
            mapFilters.push({source, filter});
            context.vectors.find(value => value.collectionId === source.collectionId && value.itemId === source.itemId).filter = filter;
            return filter;
        }, onOpen: () => controller.setActive(true),
        onClose: () => controller.setActive(false), newId: () => String(++sequence).padStart(32, "0")});
    return {controller, api, jobs, context, storage, values, submitted, cancelled, filterRequests, mapFilters, handlers};
}

test("published results are explicit model choices without previews or map layers", async () => {
    const artifacts = fileManifest(), parent = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    const h = fixture({listModelRuns: async () => ({jobs: [parent], nextCursor: null})});
    h.context.rasters = [];
    await h.controller.loadRuns();
    const recipe = {...model, inputs: {habitat: {type: "raster", label: "Habitat"}, area: model.inputs.area}};
    h.controller.chooseModel(recipe);
    const draft = h.controller.state.draft;
    assert.equal(draft.raster, null);
    assert.equal(draft.sources.length, 2);
    assert.ok(draft.sources.every(source => source.kind === "runArtifact"));
    h.controller.editDraft({raster: draft.sources[1]});
    const request = captureModelSubmission(draft, "request-private-result");
    assert.deepEqual(request.inputs.habitat, {kind: "runArtifact", jobId: parent.jobId, artifactId: artifacts.files[1].artifactId});
    assert.deepEqual(request.inputs.area, area);
    h.controller.rememberRun({...parent, status: "expired", artifacts: {...artifacts, availability: "unavailable", files: []}});
    h.controller.refreshMapLayers();
    assert.equal(draft.raster.available, false);
    assert.match(draft.sourceReason, /no longer available/);
    assert.throws(() => captureModelSubmission(draft, "request-expired-result"), /no longer available/);
});

test("renewal updates the shared observer and all run consumers without resubmitting", async () => {
    const artifacts = fileManifest(), ready = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    const renewed = {...ready, expiresAt: "2099-02-01T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z"};
    const h = fixture({getJob: async () => ready, renewModelRun: async () => renewed});
    const changes = []; h.controller.onRunChange = value => changes.push(value);
    await h.controller.showRun(ready.jobId);
    await h.controller.renewRun();
    assert.equal(h.controller.runSnapshots.get(ready.jobId), renewed);
    assert.equal(h.jobs.jobs[0], renewed); assert.equal(changes.at(-1), renewed);
    assert.match(h.controller.state.actionMessage, /Results kept until/);
    h.controller.rememberRun(ready);
    assert.equal(h.controller.runSnapshots.get(ready.jobId), renewed);
    assert.equal(h.submitted.length, 0);
});

test("renaming an active run refreshes its consumers and duplicates the name without the old timestamp", async () => {
    const original = job({status: "running"}), renamed = job({status: "running", name: "Cuba biomass", updatedAt: "2026-10-09T00:00:00Z"});
    const requests = [], changes = [];
    const h = fixture({getJob: async () => original, renameModelRun: async (...args) => { requests.push(args); return renamed; }});
    h.controller.onRunChange = value => changes.push(value);
    await h.controller.loadLibrary(); await h.controller.showRun(original.jobId);
    assert.equal(await h.controller.renameRun(" Cuba biomass "), true);
    assert.deepEqual(requests, [[original.jobId, "Cuba biomass"]]);
    assert.equal(h.jobs.jobs[0], renamed); assert.equal(changes.at(-1), renamed);
    assert.equal(h.controller.state.invocation.label, renamed.name);
    assert.equal(h.controller.state.runs[0].nameTimestamp, original.nameTimestamp);
    h.controller.rememberRun(original); assert.equal(h.controller.state.runs[0], renamed);
    h.controller.state.invocation = {...h.controller.state.invocation, label: original.name};
    await h.controller.duplicateRun();
    assert.equal(h.controller.state.draft.label, "Cuba biomass");
    assert.deepEqual(h.submitted, []); assert.deepEqual(h.cancelled, []);
});

test("a rename failure preserves the run and a late rename does not edit a different run's inputs", async () => {
    const original = job(), h = fixture({getJob: async () => original,
        renameModelRun: async () => { throw new Error("Connection lost"); }});
    await h.controller.showRun(original.jobId);
    assert.equal(await h.controller.renameRun("New name"), false);
    assert.equal(h.controller.state.runs[0], original); assert.match(h.controller.state.error, /Could not rename.*Connection lost/);
    assert.equal(h.controller.state.actionBusy, false);
    let finish;
    h.api.renameModelRun = () => new Promise(resolve => { finish = resolve; });
    const pending = h.controller.renameRun("New name");
    const second = job({jobId: "2".repeat(32), name: "Other run"});
    h.api.getJob = async () => second; h.api.readModelInvocation = async () => ({...invocation, label: second.name});
    await h.controller.showRun(second.jobId);
    finish(job({name: "New name", updatedAt: "2026-10-09T00:00:00Z"})); await pending;
    assert.equal(h.controller.state.selectedRun, second.jobId);
    assert.equal(h.controller.state.invocation.label, second.name);
});

test("deletion needs confirmation and removes captured inputs and choices after success", async () => {
    const artifacts = fileManifest(), ready = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    const deleted = {...ready, status: "deleted", artifacts: {files: []}, updatedAt: "2026-10-10T00:00:00Z"};
    let calls = 0;
    const h = fixture({getJob: async () => ready, deleteModelRun: async () => { calls++; return deleted; },
        readJobStatuses: async () => ({jobs: [ready], unavailableJobIds: []})});
    await h.controller.showRun(ready.jobId);
    await h.controller.deleteRun(); assert.equal(calls, 0);
    h.controller.requestRunDeletion(); assert.equal(calls, 0);
    await h.controller.deleteRun();
    assert.equal(calls, 1); assert.equal(h.controller.state.deleteConfirmation, null);
    assert.equal(h.controller.state.invocation, null);
    assert.equal(h.controller.runSnapshots.get(ready.jobId).status, "deleted");
    assert.deepEqual(h.controller.state.runs, []);
    assert.equal(h.controller.state.page, "runs");
    assert.equal(h.controller.state.selectedRun, null);
    h.controller.rememberRun(ready);
    await h.controller.showRun(ready.jobId);
    assert.deepEqual(h.controller.state.runs, []);
    assert.equal(h.controller.state.page, "runs");
});

test("inline deletion returns focus on Keep or Escape and keeps a failed confirmation available", async () => {
    const doc = new SummaryControlDocument(), view = new ModelsView(doc);
    const ready = job({status: "ready", expiresAt: "2099-01-01T00:00:00Z"});
    let rejectDeletion, calls = 0;
    const h = fixture({getJob: async () => ready, deleteModelRun: () => {
        calls++; return new Promise((_resolve, reject) => { rejectDeletion = reject; });
    }}, view);
    await h.controller.showRun(ready.jobId);
    const remove = view.run.remove;
    remove.focus(); remove.dispatchEvent(new Event("click"));
    assert.equal(doc.activeElement, view.run.keep); assert.equal(calls, 0);
    view.run.keep.dispatchEvent(new Event("click"));
    assert.equal(h.controller.state.deleteConfirmation, null); assert.equal(doc.activeElement, remove);
    assert.equal(view.run.confirmation.hidden, true); assert.equal(calls, 0);

    remove.dispatchEvent(new Event("click"));
    const escape = new Event("keydown", {cancelable: true});
    Object.defineProperty(escape, "key", {value: "Escape"});
    view.run.confirmation.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(h.controller.state.deleteConfirmation, null); assert.equal(doc.activeElement, remove);
    assert.equal(calls, 0);

    remove.dispatchEvent(new Event("click")); view.run.confirm.focus();
    const confirmation = view.run.confirmation, confirm = view.run.confirm;
    const pending = h.controller.deleteRun();
    const busyEscape = new Event("keydown", {cancelable: true});
    Object.defineProperty(busyEscape, "key", {value: "Escape"});
    confirmation.dispatchEvent(busyEscape);
    assert.equal(h.controller.state.deleteConfirmation, ready.jobId);
    assert.equal(h.controller.state.runs[0].jobId, ready.jobId);
    rejectDeletion(new Error("Offline")); await pending;
    assert.equal(calls, 1); assert.equal(view.run.confirmation, confirmation);
    assert.equal(view.run.confirm, confirm); assert.equal(confirm.disabled, false);
    assert.equal(doc.activeElement, confirm); assert.match(view.elements.error.textContent, /Offline/);
    assert.equal(confirmation.hidden, false);

    h.api.deleteModelRun = async () => ({...ready, status: "deleted", updatedAt: "2026-10-10T00:00:00Z"});
    await h.controller.deleteRun();
    assert.equal(h.controller.state.page, "runs"); assert.deepEqual(h.controller.state.runs, []);
    assert.equal(doc.activeElement, view.elements.heading);
});

test("Undo restores its run and captured displays without extending expiry or changing the user's setup", async () => {
    const ready = job({status: "ready", expiresAt: "2099-01-01T00:00:00Z"});
    const deletionUndo = {deletionId: "d".repeat(32), expiresAt: new Date(Date.now() + 30000).toISOString()};
    const deleted = {...ready, status: "deleted", updatedAt: "2098-01-01T00:00:00Z", deletionUndo};
    const restored = {...ready, updatedAt: "2098-01-01T00:00:01Z"};
    const requests = [], layers = [{key: "hidden", visible: false}, {key: "visible", opacity: 0.4}];
    const h = fixture({getJob: async () => ready, deleteModelRun: async () => deleted,
        undoModelDeletion: async (...args) => { requests.push(args); return restored; }});
    h.controller.captureRunLayers = id => { assert.equal(id, ready.jobId); return layers; };
    h.controller.restoreRunLayers = async (snapshots, isCurrent) => { assert.equal(snapshots, layers); assert.ok(isCurrent()); };
    await h.controller.showRun(ready.jobId); h.controller.requestRunDeletion(); await h.controller.deleteRun();
    assert.equal(h.controller.deletions.size, 1); assert.equal(h.controller.state.runs.length, 0);
    const notice = h.controller.deletions.get(ready.jobId);
    h.controller.rememberRun(deleted); assert.equal(h.controller.deletions.get(ready.jobId), notice);
    h.controller.chooseModel(model); const draft = h.controller.state.draft;
    await h.controller.resolveDeletion(ready.jobId, true);
    assert.deepEqual(requests, [[ready.jobId, deletionUndo.deletionId]]);
    assert.equal(h.controller.state.runs[0].expiresAt, ready.expiresAt);
    assert.equal(h.controller.state.draft, draft); assert.equal(h.controller.state.page, "setup");
    assert.equal(h.controller.deletions.size, 0); assert.equal(h.values.size, 0);
    h.controller.rememberRun(deleted); assert.equal(h.controller.state.runs[0].status, "ready");
});

test("deletion notices survive reload, isolate dismissal, expire and retain retry on failure", async () => {
    const deletionUndo = {deletionId: "d".repeat(32), expiresAt: new Date(Date.now() + 30000).toISOString()};
    const first = job({status: "deleted", deletionUndo}), second = {...first, jobId: "2".repeat(32),
        deletionUndo: {...deletionUndo, deletionId: "e".repeat(32)}};
    const h = fixture(); h.controller.rememberRun(first); h.controller.rememberRun(second);
    const next = fixture({readJobStatuses: async ids => {
        assert.deepEqual(ids, [first.jobId, second.jobId]); return {jobs: [first, second], unavailableJobIds: []};
    }});
    next.controller.storage = h.storage; await next.controller.recoverDeletions();
    assert.equal(next.controller.deletions.size, 2); assert.equal(next.controller.state.runs.length, 0);
    next.api.dismissModelDeletion = async () => { throw new Error("Offline"); };
    await next.controller.resolveDeletion(first.jobId, false);
    assert.equal(next.controller.deletions.get(first.jobId).busy, false); assert.match(next.controller.state.error, /Offline/);
    next.api.dismissModelDeletion = async (id, deletionId) => {
        assert.equal(id, first.jobId); assert.equal(deletionId, deletionUndo.deletionId);
        return {...first, updatedAt: "2098-01-01T00:00:00Z", deletionUndo: null};
    };
    await next.controller.resolveDeletion(first.jobId, false);
    assert.equal(next.controller.deletions.size, 1); assert.ok(next.controller.deletions.has(second.jobId));
    next.controller.deletions.get(second.jobId).expiresAt = new Date(Date.now() - 1).toISOString();
    next.controller.scheduleDeletions(); assert.equal(next.controller.deletions.size, 0);
    assert.equal(h.values.size, 0);
});

test("deletion failure preserves the visible run and never offers Undo", async () => {
    const ready = job({status: "ready", expiresAt: "2099-01-01T00:00:00Z"});
    const h = fixture({getJob: async () => ready, deleteModelRun: async () => { throw new Error("Offline"); }});
    await h.controller.showRun(ready.jobId); h.controller.requestRunDeletion(); await h.controller.deleteRun();
    assert.equal(h.controller.state.runs.length, 1); assert.equal(h.controller.deletions.size, 0);
    assert.equal(h.controller.state.selectedRun, ready.jobId); assert.match(h.controller.state.error, /Offline/);
});

test("navigation during confirmation never deletes another run", async () => {
    const artifacts = fileManifest(), ready = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    let calls = 0;
    const h = fixture({getJob: async id => ({...ready, jobId: id}), deleteModelRun: async () => { calls++; return ready; }});
    await h.controller.showRun(ready.jobId); h.controller.requestRunDeletion();
    await h.controller.showRun("2".repeat(32)); await h.controller.deleteRun();
    assert.equal(calls, 0);
});

test("legacy catalog recipes exclude results and late history loads preserve the chosen input", async () => {
    const artifacts = fileManifest(), parent = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    const h = fixture({listModelRuns: async () => ({jobs: [parent], nextCursor: null})});
    h.context.rasters.push({kind: "runArtifact", jobId: parent.jobId, artifactId: artifacts.files[0].artifactId, label: "Displayed result"});
    h.controller.chooseModel(model); await h.controller.loadRuns();
    assert.equal(h.controller.state.draft.sources.length, 1);
    h.controller.chooseModel({...model, inputs: {...model.inputs, raster: {type: "raster", label: "Raster"}}});
    const draft = h.controller.state.draft;
    assert.equal(draft.sources.length, 3, "Displayed results and run history refer to the same original source");
    h.controller.editDraft({raster: draft.sources[1]});
    await h.controller.loadRuns();
    assert.equal(draft.raster.artifactId, artifacts.files[0].artifactId);
});

test("multiple map rasters require a choice; catalog-only inputs cannot become suggestions", () => {
    const hidden = {...raster, itemId: "hidden", visible: false};
    let draft = createModelDraft(model, {rasters: [raster, {...raster, itemId: "second"}, hidden]}, "draft");
    assert.equal(draft.raster, null); assert.equal(draft.sources.length, 3);
    draft = createModelDraft(model, {rasters: [raster], selectedRaster: hidden}, "draft");
    assert.equal(draft.raster.itemId, "population"); assert.equal(draft.sources.length, 1); assert.match(draft.sourceReason, /Map layers/);
});

test("Run captures the current box while later map edits and closing leave accepted work unchanged", async () => {
    const h = fixture(); h.controller.chooseModel(model);
    h.context.area.selectedBounds.west = -10; h.context.rasters[0].label = "Renamed layer";
    await h.controller.submit();
    assert.equal(h.submitted[0].inputs.raster.itemId, "population"); assert.equal(h.submitted[0].inputs.area.selectedBounds.west, -10);
    h.context.area.selectedBounds.west = -20; h.controller.refreshMapArea();
    assert.equal(h.submitted[0].inputs.area.selectedBounds.west, -10);
    h.handlers.onClose(); h.controller.navigate("library"); h.controller.destroy();
    assert.deepEqual(h.cancelled, []); assert.equal(h.values.size, 0);
});

test("a lost submission response survives reload and retries the exact captured request", async () => {
    const h = fixture({submitModelRun: async () => { throw new TypeError("Connection lost"); }});
    h.controller.chooseModel(model); await h.controller.submit();
    const captured = structuredClone(h.controller.state.pending); assert.ok(captured);
    assert.equal(captured.utcOffsetMinutes, 0 - new Date().getTimezoneOffset());
    assert.equal(captured.label, model.title);
    h.controller.chooseModel(model); h.controller.editDraft({label: "Different draft"});
    const next = fixture(); next.controller.storage = h.storage; next.controller.start();
    await next.controller.submit(true);
    assert.deepEqual(next.submitted[0], captured); assert.equal(next.controller.state.pending, null);
    assert.equal(next.controller.state.page, "run");
});

test("captured timezone offsets survive the recovery storage JSON round trip", () => {
    const draft = createModelDraft(model, {rasters: [raster], area}, "timezone-recovery");
    for (const offset of [-420, 0, -0, 330]) {
        const captured = captureModelSubmission(draft, "timezone-request", offset);
        assert.deepEqual(JSON.parse(JSON.stringify(captured)), captured);
    }
});

test("run names count Unicode characters consistently when capturing a submission", () => {
    const draft = createModelDraft(model, {rasters: [raster], area}, "unicode-name");
    draft.label = "🌳".repeat(80);
    assert.equal(captureModelSubmission(draft, "unicode-request", -420).label, draft.label);
    draft.label += "🌳";
    assert.throws(() => captureModelSubmission(draft, "unicode-request", -420), /1–80 characters/);
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


test("visible map area follows map changes and Run captures the latest viewport", async () => {
    const h = fixture(); h.context.area = null;
    h.context.viewportBounds = {west: -10, south: -5, east: 10, north: 5};
    h.controller.chooseModel(model); h.controller.chooseArea("viewport");
    assert.deepEqual(h.controller.state.draft.area, {kind: "selectedArea", selectedBounds: h.context.viewportBounds});
    h.context.viewportBounds.west = -20; h.controller.refreshMapArea();
    assert.equal(h.controller.state.draft.area.selectedBounds.west, -20);
    // Submission also reads the latest bounds if it precedes moveend.
    h.context.viewportBounds.west = -25;
    await h.controller.submit();
    assert.equal(h.submitted.length, 1); assert.equal(h.submitted[0].inputs.area.selectedBounds.west, -25);
    h.context.viewportBounds.west = -30; h.controller.refreshMapArea();
    assert.equal(h.submitted[0].inputs.area.selectedBounds.west, -25);
});

test("map box follows clicks and resizing; a cleared selection cannot run the previous box", async () => {
    const h = fixture(); h.controller.chooseModel(model);
    assert.equal(h.controller.state.draft.areaMode, "samplingArea");
    h.context.area.selectedBounds.west = -10; h.controller.refreshMapArea();
    assert.equal(h.controller.state.draft.area.selectedBounds.west, -10);
    h.context.area.selectedBounds.east = 10; h.controller.refreshMapArea();
    assert.equal(h.controller.state.draft.area.selectedBounds.east, 10);
    h.context.area = null; h.controller.refreshMapArea();
    assert.equal(h.controller.state.draft.area, null);
    assert.match(h.controller.state.draft.selectionError, /Click the map/);
    await h.controller.submit(); assert.equal(h.submitted.length, 0);
    h.context.area = structuredClone(area); h.controller.refreshMapArea();
    assert.equal(h.controller.state.draft.selectionError, "");
    await h.controller.submit(); assert.equal(h.submitted.length, 1);
});

test("map changes preserve duplicate areas, model vector filters and recoverable submissions", async () => {
    const h = fixture(); await h.controller.loadLibrary(); await h.controller.showRun(job().jobId);
    await h.controller.duplicateRun();
    h.context.area.selectedBounds.west = -10; h.controller.refreshMapArea();
    assert.deepEqual(h.controller.state.draft.area, invocation.inputs.area);
    await h.controller.submit(); assert.deepEqual(h.submitted[0].inputs.area, invocation.inputs.area);
    h.controller.chooseModel(model); h.controller.chooseArea("vector");
    const draft = h.controller.state.draft; draft.area = {kind: "catalogSelection", selection};
    h.controller.refreshMapArea(); assert.deepEqual(draft.area, {kind: "catalogSelection", selection});
    h.controller.chooseArea("samplingArea");
    h.api.submitModelRun = async () => { throw new TypeError("Connection lost"); };
    await h.controller.submit(); const pending = structuredClone(h.controller.state.pending);
    h.context.area.selectedBounds.west = -20; h.controller.refreshMapArea();
    assert.deepEqual(h.controller.state.pending, pending);
    assert.deepEqual(draft.area, pending.inputs.area);
});

test("map-linked setup refreshes after navigation and an invalid viewport clears its old bounds", () => {
    const h = fixture(); h.controller.chooseModel(model);
    h.controller.navigate("library"); h.context.area.selectedBounds.west = -5;
    h.controller.navigate("setup"); assert.equal(h.controller.state.draft.area.selectedBounds.west, -5);
    h.context.viewportBounds = {west: -10, south: -5, east: 10, north: 5}; h.controller.chooseArea("viewport");
    h.context.viewportBounds = null; h.controller.refreshMapArea();
    assert.equal(h.controller.state.draft.area, null); assert.match(h.controller.state.draft.selectionError, /unavailable/);
    h.context.viewportBounds = {west: -20, south: -5, east: 10, north: 5}; h.controller.setActive(true);
    assert.equal(h.controller.state.draft.area.selectedBounds.west, -20);
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


test("model filtering checks features then updates the map through composition without submitting a run", async () => {
    const h = fixture();
    h.context.vectors = [{collectionId: selection.collectionId, itemId: selection.itemId, label: "Basins", filter: structuredClone(selection.filter)}];
    h.controller.prepareVector = async source => ({selection: {...selection, filter: structuredClone(source.filter)}, matched: source.filter.rules[0]?.value === "South" ? 1 : 3, total: 8});
    h.controller.chooseModel(model); h.controller.chooseArea("vector");
    await h.controller.chooseVector(JSON.stringify([selection.collectionId, selection.itemId]));
    const doc = new FakeRasterControlDocument(); let request;
    const controls = new VectorFilterControls({documentContext: doc,
        getTarget: () => ({label: "Basins", fields: [{name: "BASIN", type: "str"}], filter: selection.filter,
            apply: () => assert.fail("Composition must own the map update"), cancelPending: () => assert.fail("Model filter must not cancel map work")}),
        inspection: {showFilter() {}, hideFilter() {}, updateLayerEditorName() {}},
        setTimer: () => assert.fail("Model filter must require explicit application"), clearTimer() {},
    });
    h.controller.editVectorFilter = value => { request = value; controls.open(value.key, {...value, applyLabel: "Apply filter", filterLabel: "Selected features", onClose: value.close, help: "Choose features for this model."}); };
    h.controller.closeVectorFilter = () => controls.close();
    await h.controller.openVectorFilter();
    assert.match(request.key, /^model:/); assert.equal(controls.applyButton.textContent, "Apply filter");
    assert.match(controls.applied.textContent, /^Selected features:/); assert.equal(controls.help.textContent, "Choose features for this model.");
    const input = controls.rules.children[0].children[2]; input.value = "South"; input.dispatchEvent(new Event("input"));
    assert.equal(h.controller.state.draft.area.selection.filter.rules[0].value, "North");
    controls.applyButton.dispatchEvent(new Event("click")); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.controller.state.draft.area.selection.filter.rules[0].value, "South");
    assert.equal(h.controller.state.draft.vectorInfo.matched, 1); assert.equal(controls.key, null);
    assert.equal(h.context.vectors[0].filter.rules[0].value, "South"); assert.equal(h.submitted.length, 0);
    await h.controller.openVectorFilter();
    controls.rules.children[0].children[2].value = "West"; controls.rules.children[0].children[2].dispatchEvent(new Event("input"));
    controls.close(); assert.equal(h.controller.state.draft.area.selection.filter.rules[0].value, "South");
    await h.controller.openVectorFilter();
    h.controller.prepareVector = (_source, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Closed", "AbortError"))));
    controls.applyButton.dispatchEvent(new Event("click")); controls.close(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.controller.state.draft.area.selection.filter.rules[0].value, "South");
    assert.equal(h.controller.state.draft.selecting, false);
    await h.controller.submit(); assert.equal(h.submitted[0].inputs.area.selection.filter.rules[0].value, "South");
    assert.equal(h.context.vectors[0].filter.rules[0].value, "South"); controls.destroy();
});

test("failed and cancelled filter reads preserve the prior reviewed vector selection", async () => {
    const h = fixture(); h.context.vectors = [{collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.chooseModel(model); h.controller.chooseArea("vector");
    await h.controller.chooseVector(JSON.stringify([selection.collectionId, selection.itemId]));
    const previous = structuredClone(h.controller.state.draft.area);
    await h.controller.openVectorFilter(); const action = h.filterRequests[0];
    h.controller.prepareVector = async () => { throw Error("No polygons match"); };
    await assert.rejects(action.apply(selection.filter), /No polygons match/);
    assert.deepEqual(h.controller.state.draft.area, previous); assert.match(h.controller.state.draft.selectionError, /unchanged/);
    h.controller.prepareVector = (_source, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError"))));
    const pending = action.apply(selection.filter); action.cancel(); assert.equal(await pending, null);
    assert.deepEqual(h.controller.state.draft.area, previous); assert.equal(h.controller.state.draft.selecting, false);
    assert.equal(h.submitted.length, 0); assert.deepEqual(h.cancelled, []);
});

test("old filter actions and late selection replies cannot change a newer model area", async () => {
    const h = fixture(); h.context.vectors = [{collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.chooseModel(model); h.controller.chooseArea("vector");
    const key = JSON.stringify([selection.collectionId, selection.itemId]); await h.controller.chooseVector(key);
    await h.controller.openVectorFilter(); const action = h.filterRequests[0];
    let finish; h.controller.prepareVector = () => new Promise(resolve => { finish = resolve; });
    const pending = action.apply(selection.filter); h.controller.chooseArea("whole");
    finish({selection, matched: 3, total: 8}); assert.equal(await pending, null);
    assert.deepEqual(h.controller.state.draft.area, {kind: "wholeRaster"});
    assert.throws(() => action.apply(selection.filter), /setup changed/);
    h.controller.chooseArea("vector"); await h.controller.chooseVector("");
    assert.equal(h.controller.state.draft.vectorKey, ""); assert.equal(h.controller.state.draft.area, null);
});

test("duplicated vector runs expose their original filter directly in the vector controls", async () => {
    const saved = structuredClone(invocation); saved.inputs.area = {kind: "catalogSelection", selection: structuredClone(selection)};
    const h = fixture({readModelInvocation: async () => saved});
    h.context.vectors = [{collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    await h.controller.loadLibrary(); await h.controller.showRun(job().jobId); await h.controller.duplicateRun();
    assert.equal(h.controller.state.draft.areaMode, "vector");
    await h.controller.openVectorFilter(); assert.deepEqual(h.filterRequests[0].filter, selection.filter);
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "another-request-id").inputs, saved.inputs);
    assert.equal(h.submitted.length, 0);
});


test("late catalog metadata cannot open a filter after the Models panel closes", async () => {
    const h = fixture(); h.context.vectors = [{collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.chooseModel(model); h.controller.chooseArea("vector");
    await h.controller.chooseVector(JSON.stringify([selection.collectionId, selection.itemId]));
    h.controller.setActive(true); let release; let opened = false;
    h.controller.editVectorFilter = async request => { await new Promise(resolve => { release = resolve; }); opened = request.isCurrent(); };
    const opening = h.controller.openVectorFilter(); h.controller.setActive(false); release(); await opening;
    assert.equal(opened, false); assert.equal(h.controller.state.draft.filterOpening, false);
});


test("cancelling a replacement filter read preserves the last reviewed selection", async () => {
    const h = fixture(); h.context.vectors = [{collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.chooseModel(model); h.controller.chooseArea("vector");
    await h.controller.chooseVector(JSON.stringify([selection.collectionId, selection.itemId]));
    const previous = structuredClone(h.controller.state.draft.area); await h.controller.openVectorFilter();
    const replies = []; h.controller.prepareVector = () => new Promise(resolve => replies.push(resolve));
    const action = h.filterRequests[0]; const first = action.apply(selection.filter); const second = action.apply(selection.filter);
    action.cancel(); replies[1]({selection, matched: 3, total: 8}); assert.equal(await second, null);
    replies[0]({selection, matched: 3, total: 8}); assert.equal(await first, null);
    assert.deepEqual(h.controller.state.draft.area, previous); assert.equal(h.controller.state.draft.selecting, false);
});

test("map-layer refresh keeps the reviewed model filter", async () => {
    const h = fixture(); const source = {collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter};
    h.context.vectors = [source]; h.controller.chooseModel(model); h.controller.chooseArea("vector");
    const key = JSON.stringify([selection.collectionId, selection.itemId]); await h.controller.chooseVector(key);
    const edited = structuredClone(selection.filter); edited.rules[0].value = "South";
    h.controller.prepareVector = async value => ({selection: {...selection, filter: value.filter}, matched: 1, total: 8});
    await h.controller.openVectorFilter(); await h.filterRequests[0].apply(edited);
    h.controller.refreshMapLayers();
    h.controller.chooseArea("whole"); h.controller.chooseArea("vector"); await h.controller.chooseVector(key);
    assert.equal(h.controller.state.draft.area.selection.filter.rules[0].value, "South");
    assert.equal(h.context.vectors[0].filter.rules[0].value, "South");
});


test("removed raster and vector inputs must be added to Map layers again before Run", async () => {
    const h = fixture(); h.controller.chooseModel(model);
    h.context.rasters = []; h.controller.refreshMapLayers();
    assert.equal(h.controller.state.draft.raster, null);
    await h.controller.submit(); assert.equal(h.submitted.length, 0); assert.match(h.controller.state.error, /Map layers/);
    h.context.rasters = [raster]; h.controller.refreshMapLayers(); h.controller.editDraft({raster});
    h.context.vectors = [{collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.refreshMapLayers(); h.controller.chooseArea("vector");
    await h.controller.chooseVector(JSON.stringify([selection.collectionId, selection.itemId]));
    h.context.vectors = []; h.controller.refreshMapLayers();
    assert.equal(h.controller.state.draft.area, null); assert.equal(h.controller.state.draft.vectorKey, "");
    await h.controller.submit(); assert.equal(h.submitted.length, 0);
});

test("duplication does not silently add missing original inputs to the map choices", async () => {
    const saved = structuredClone(invocation); saved.inputs.area = {kind: "catalogSelection", selection};
    const h = fixture({readModelInvocation: async () => saved}); h.context.rasters = [];
    await h.controller.loadLibrary(); await h.controller.showRun(job().jobId); await h.controller.duplicateRun();
    assert.equal(h.controller.state.draft.raster, null); assert.equal(h.controller.state.draft.area, null);
    assert.deepEqual(h.controller.state.draft.sources, []); assert.deepEqual(h.controller.state.draft.vectors, []);
    assert.match(h.controller.state.draft.selectionError, /original vector layer/);
});


test("filters can be edited during initial selection; closing before Apply leaves that check running", async () => {
    const h = fixture(); h.context.vectors = [{collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.chooseModel(model); h.controller.chooseArea("vector");
    let finish, signal;
    h.controller.prepareVector = (_source, abort) => { signal = abort; return new Promise(resolve => { finish = resolve; }); };
    const pending = h.controller.chooseVector(JSON.stringify([selection.collectionId, selection.itemId]));
    await h.controller.openVectorFilter();
    assert.equal(h.filterRequests.length, 1); assert.equal(h.controller.state.draft.filterEditing, true);
    h.filterRequests[0].close(); assert.equal(signal.aborted, false);
    finish({selection, matched: 3, total: 8}); await pending;
    assert.equal(h.controller.state.draft.vectorInfo.matched, 3); assert.equal(h.controller.state.draft.filterEditing, false);
});

test("applying while the original check runs cancels it and ignores its late reply", async () => {
    const h = fixture(); h.context.vectors = [{collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.chooseModel(model); h.controller.chooseArea("vector");
    const requests = [];
    h.controller.prepareVector = (source, signal) => new Promise(resolve => requests.push({source, signal, resolve}));
    const pending = h.controller.chooseVector(JSON.stringify([selection.collectionId, selection.itemId]));
    await h.controller.openVectorFilter(); const action = h.filterRequests[0];
    const changed = structuredClone(selection.filter); changed.rules[0].value = "South";
    const applying = action.apply(changed); assert.equal(requests[0].signal.aborted, true);
    requests[1].resolve({selection: {...selection, filter: changed}, matched: 1, total: 8}); await applying; action.complete();
    requests[0].resolve({selection, matched: 3, total: 8}); await pending;
    assert.equal(h.controller.state.draft.vectorInfo.matched, 1);
    assert.equal(h.context.vectors[0].filter.rules[0].value, "South");
    assert.equal(h.mapFilters.length, 1); assert.equal(h.submitted.length, 0);
});

test("map filter failures do not prevent a checked model selection from running", async () => {
    const h = fixture(); h.context.vectors = [{collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    h.controller.applyMapFilter = async () => { throw new Error("Map service unavailable"); };
    h.controller.chooseModel(model); h.controller.chooseArea("vector");
    await h.controller.chooseVector(JSON.stringify([selection.collectionId, selection.itemId]));
    await h.controller.openVectorFilter(); const action = h.filterRequests[0];
    await action.apply(selection.filter); action.complete();
    assert.match(h.controller.state.draft.mapFilterMessage, /Could not update the map filter: Map service unavailable/);
    await h.controller.submit(); assert.equal(h.submitted.length, 1);
});

test("late map filter feedback cannot overwrite a newer setup", async () => {
    const h = fixture(); h.context.vectors = [{collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter}];
    let finish; h.controller.applyMapFilter = () => new Promise(resolve => { finish = resolve; });
    h.controller.chooseModel(model); h.controller.chooseArea("vector");
    await h.controller.chooseVector(JSON.stringify([selection.collectionId, selection.itemId]));
    await h.controller.openVectorFilter(); await h.filterRequests[0].apply(selection.filter);
    h.controller.chooseModel(model); finish(selection.filter); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.controller.state.draft.mapFilterMessage, undefined);
});


test("choosing or clearing a raster immediately refreshes Run availability", () => {
    const view = new ModelsView(new SummaryControlDocument()); const h = fixture({}, view);
    h.context.rasters.push({...raster, itemId: "second"}); h.controller.chooseModel(model);
    assert.equal(view.setup.run.disabled, true);
    view.setup.source.value = JSON.stringify([raster.collectionId, raster.itemId]);
    view.setup.source.dispatchEvent(new Event("change"));
    assert.equal(view.setup.run.disabled, false);
    view.setup.source.value = ""; view.setup.source.dispatchEvent(new Event("change"));
    assert.equal(view.setup.run.disabled, true);
});


test("clip setup defaults to the visible map when the current area is unsupported", () => {
    const context = {rasters: [raster], area: {kind: "wholeRaster"}, viewportBounds: {west: 1, south: 2, east: 3, north: 4}};
    const draft = createModelDraft(clipModel, context, "clip");
    assert.equal(draft.areaMode, "viewport"); assert.deepEqual(draft.area.selectedBounds, context.viewportBounds);
    assert.deepEqual(captureModelSubmission(draft, "request").parameters, {});
    draft.area = {kind: "wholeRaster"}; assert.throws(() => captureModelSubmission(draft, "request"), /supported by this model/);
    const unavailable = createModelDraft(clipModel, {rasters: [raster]}, "no-view");
    assert.equal(unavailable.area, null); assert.match(unavailable.selectionError, /extent is unavailable/);
});

test("clip run duplication preserves its exact area and has no summary parameter", async () => {
    const saved = {...invocation, model: {...clipModel, definition: clipModel}, parameters: {}};
    const h = fixture({discoverModels: async () => [clipModel], readModelInvocation: async () => saved});
    await h.controller.loadLibrary(); await h.controller.showRun(job().jobId); await h.controller.duplicateRun();
    h.context.area.selectedBounds.west = -20; h.controller.refreshMapArea();
    assert.deepEqual(h.controller.state.draft.area, saved.inputs.area);
    assert.deepEqual(h.controller.state.draft.parameters, {});
    await h.controller.submit(); assert.deepEqual(h.submitted[0].inputs, saved.inputs);
    assert.equal(h.submitted[0].model.id, "raster-clip");
});
