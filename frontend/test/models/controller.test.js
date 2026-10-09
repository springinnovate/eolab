import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { ModelsController } from "../../src/models/controller.js";
import { VectorFilterControls } from "../../src/vector/filter-controls.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { ProcessingRequestError } from "../../src/processing/api.js";
import { captureModelSubmission, createModelDraft, modelViewportArea } from "../../src/models/inputs.js";
import { model, raster, area, invocation, selection, job } from "../../test-support/models/fixtures.js";

/** Compose the real controller and observer with controllable boundary responses.
 * @param {Object} [overrides={}] API behavior replacements.
 * @return {Object} Component and recorded user-visible effects.
 */
function fixture(overrides = {}) {
    const values = new Map(); const submitted = []; const cancelled = []; const filterRequests = [];
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
        prepareVector: async () => ({selection, matched: 3, total: 8, bbox: [0, 0, 1, 1]}), editVectorFilter: async request => { filterRequests.push(request); }, onOpen: () => controller.setActive(true),
        onClose: () => controller.setActive(false), newId: () => String(++sequence).padStart(32, "0")});
    return {controller, api, jobs, context, storage, values, submitted, cancelled, filterRequests, handlers};
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

test("a copied map box is named by its source and changes only on an explicit update", async () => {
    const h = fixture(); h.controller.chooseModel(model);
    assert.equal(h.controller.state.draft.areaOrigin, "map");
    h.context.area.selectedBounds.west = -10;
    assert.equal(h.controller.state.draft.area.selectedBounds.west, 0);
    h.handlers.onUpdateArea(); assert.equal(h.controller.state.draft.area.selectedBounds.west, -10);
    h.context.area = null; h.handlers.onUpdateArea();
    assert.match(h.controller.state.error, /unchanged/);
    assert.equal(h.controller.state.draft.area.selectedBounds.west, -10);
    await h.controller.submit(); assert.equal(h.submitted[0].inputs.area.selectedBounds.west, -10);
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


test("model filtering uses the existing editor without modifying the map filter or submitting a run", async () => {
    const h = fixture();
    h.context.vectors = [{collectionId: selection.collectionId, itemId: selection.itemId, label: "Basins", filter: structuredClone(selection.filter)}];
    h.controller.prepareVector = async source => ({selection: {...selection, filter: structuredClone(source.filter)}, matched: source.filter.rules[0]?.value === "South" ? 1 : 3, total: 8});
    h.controller.chooseModel(model); h.controller.chooseArea("vector");
    await h.controller.chooseVector(JSON.stringify([selection.collectionId, selection.itemId]));
    const doc = new FakeRasterControlDocument(); let request;
    const controls = new VectorFilterControls({documentContext: doc,
        getTarget: () => ({label: "Basins", fields: [{name: "BASIN", type: "str"}], filter: selection.filter,
            apply: () => assert.fail("Model filter must not change the map"), cancelPending: () => assert.fail("Model filter must not cancel map work")}),
        inspection: {showFilter() {}, hideFilter() {}, updateLayerEditorName() {}},
        setTimer: () => assert.fail("Model filter must require explicit application"), clearTimer() {},
    });
    h.controller.editVectorFilter = value => { request = value; controls.open(value.key, {...value, applyLabel: "Use filter", filterLabel: "Model filter", onClose: value.cancel, help: "Choose features for this model."}); };
    await h.controller.openVectorFilter();
    assert.match(request.key, /^model:/); assert.equal(controls.applyButton.textContent, "Use filter");
    assert.match(controls.applied.textContent, /^Model filter:/); assert.equal(controls.help.textContent, "Choose features for this model.");
    const input = controls.rules.children[0].children[2]; input.value = "South"; input.dispatchEvent(new Event("input"));
    assert.equal(h.controller.state.draft.area.selection.filter.rules[0].value, "North");
    controls.applyButton.dispatchEvent(new Event("click")); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.controller.state.draft.area.selection.filter.rules[0].value, "South");
    assert.equal(h.controller.state.draft.vectorInfo.matched, 1); assert.equal(controls.key, null);
    assert.equal(h.context.vectors[0].filter.rules[0].value, "North"); assert.equal(h.submitted.length, 0);
    await h.controller.openVectorFilter();
    controls.rules.children[0].children[2].value = "West"; controls.rules.children[0].children[2].dispatchEvent(new Event("input"));
    controls.close(); assert.equal(h.controller.state.draft.area.selection.filter.rules[0].value, "South");
    await h.controller.openVectorFilter();
    h.controller.prepareVector = (_source, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Closed", "AbortError"))));
    controls.applyButton.dispatchEvent(new Event("click")); controls.close(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.controller.state.draft.area.selection.filter.rules[0].value, "South");
    assert.equal(h.controller.state.draft.selecting, false);
    await h.controller.submit(); assert.equal(h.submitted[0].inputs.area.selection.filter.rules[0].value, "South");
    assert.equal(h.context.vectors[0].filter.rules[0].value, "North"); controls.destroy();
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

test("catalog search cannot replace a filter edited for this model draft", async () => {
    const h = fixture(); const source = {collectionId: selection.collectionId, itemId: selection.itemId, filter: selection.filter};
    h.context.vectors = [source]; h.controller.chooseModel(model); h.controller.chooseArea("vector");
    const key = JSON.stringify([selection.collectionId, selection.itemId]); await h.controller.chooseVector(key);
    const edited = structuredClone(selection.filter); edited.rules[0].value = "South";
    h.controller.prepareVector = async value => ({selection: {...selection, filter: value.filter}, matched: 1, total: 8});
    await h.controller.openVectorFilter(); await h.filterRequests[0].apply(edited);
    h.controller.searchSources = async () => ({sources: [source], next: null}); await h.controller.search("vector");
    h.controller.chooseArea("whole"); h.controller.chooseArea("vector"); await h.controller.chooseVector(key);
    assert.equal(h.controller.state.draft.area.selection.filter.rules[0].value, "South");
    assert.equal(h.context.vectors[0].filter.rules[0].value, "North");
});
