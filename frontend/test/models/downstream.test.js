import test from "node:test";
import assert from "node:assert/strict";
import { ModelsController } from "../../src/models/controller.js";
import { ModelsView } from "../../src/models/view.js";
import { captureModelSubmission, modelSourceKey } from "../../src/models/inputs.js";
import { ProcessingApiClient } from "../../src/processing/api.js";
import { hydrologyReference } from "../../src/processing/hydrology.js";
import { hydrologyDetails } from "../../src/models/hydrology-view.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";
import { downstreamModel, hydrology, raster, selection, job, fileManifest } from "../../test-support/models/fixtures.js";

/** Flush asynchronous discovery and selection callbacks.
 * @return {Promise<void>} Resolves after pending promise reactions.
 */
const settle = () => new Promise(resolve => setImmediate(resolve));

/** Compose the real Models controller and view with explicit external boundaries.
 * @param {Object} [overrides={}] Controlled API responses.
 * @return {Object} Components, context and captured user actions.
 */
function fixture(overrides = {}) {
    const requests = [], filters = [], cancelled = [], values = new Map();
    const context = {rasters: [structuredClone(raster)], vectors: [{...selection, itemId: "starting-areas", label: "Starting areas"}]};
    const api = {submitModelRun: async value => { requests.push(value); return job(); }, getJob: async () => job(),
        readModelInvocation: async () => ({model: {...downstreamModel, definition: downstreamModel}, inputs: requests[0].inputs, parameters: requests[0].parameters, label: "Saved run"}), ...overrides};
    const doc = new SummaryControlDocument(), view = new ModelsView(doc);
    const jobs = {subscribe: () => () => {}, tracked: new Set(), schedule() {}, accept() {}, action: async (id, action) => { cancelled.push([id, action]); return job({status: "cancelled"}); }};
    let id = 0;
    const controller = new ModelsController({api, jobs, view, getContext: () => context,
        prepareVector: async source => ({selection: {...selection, itemId: source.itemId, filter: source.filter}, matched: 1, total: 3}),
        editVectorFilter: request => { filters.push(request); }, closeVectorFilter: () => {}, applyMapFilter: async (_source, filter) => filter,
        onOpen: () => {}, onClose: () => {}, storage: {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)},
        newId: () => String(++id).padStart(32, "0")});
    controller.state.library = [downstreamModel]; controller.setActive(true); controller.chooseModel(downstreamModel);
    return {controller, view, doc, context, api, requests, filters, cancelled};
}

/** Choose the model's two user inputs without any hydrology discovery request.
 * @param {Object} harness Model controller and explicit map sources.
 * @return {Promise<void>} Resolves after the selected vector has been captured.
 */
async function chooseInputs(harness) {
    harness.controller.editDraft({raster: harness.context.rasters[0]});
    await harness.controller.chooseVector(modelSourceKey(harness.context.vectors[0]));
}

test("model-configured hydrology has no setup control or eligibility request", async () => {
    const h = fixture(); await settle();
    assert.equal(h.controller.state.draft.raster, null);
    assert.equal(h.controller.state.draft.area, null);
    assert.equal(h.view.setup.run.disabled, true);
    assert.equal(h.view.setup.hydrology, undefined);
    assert.equal(h.view.setup.fields.children.some(node => node.className === "models-hydrology"), false);
    await chooseInputs(h);
    assert.equal(h.view.setup.run.disabled, false);
    await h.controller.submit();
    assert.deepEqual(Object.keys(h.requests[0].inputs).sort(), ["people", "start"]);
    assert.deepEqual(h.requests[0].model, {id: downstreamModel.id, version: downstreamModel.version, definitionSha256: downstreamModel.definitionSha256});
    assert.equal(h.controller.state.error, "");
});

test("explicit vector and values choices capture the YAML-named inputs and selected filter", async () => {
    const h = fixture(); await chooseInputs(h);
    const draft = h.controller.state.draft;
    assert.equal(draft.raster.itemId, raster.itemId);
    assert.equal(draft.vectorInfo.matched, 1);
    assert.equal(h.view.setup.run.disabled, false);
    assert.deepEqual(h.view.setup.areaMode.children.map(option => option.value), ["vector", "raster"]);
    await h.controller.openVectorFilter();
    const filter = {...selection.filter, rules: [{field: "NAME", operator: "eq", value: "Cuba"}]};
    await h.filters[0].apply(filter); h.filters[0].complete();
    await h.controller.submit();
    assert.deepEqual(h.requests[0].inputs.start.selection.filter, filter);
    assert.deepEqual(h.requests[0].inputs.people, {collectionId: raster.collectionId, itemId: raster.itemId});
    assert.equal(h.requests[0].parameters.summary, "sum(a)");
    h.context.vectors[0].filter.rules = []; h.context.rasters = []; h.controller.refreshMapLayers(); h.controller.setActive(false);
    assert.deepEqual(h.requests[0].inputs.start.selection.filter, filter);
    assert.deepEqual(h.cancelled, []);
});

test("raster masks have positive-cell semantics, do not follow map clicks, and reject removed inputs", async () => {
    const h = fixture(); await chooseInputs(h);
    h.context.rasters.push({...raster, itemId: "start", label: "Starting mask", visible: false}); h.controller.refreshMapLayers();
    h.controller.chooseArea("raster");
    h.controller.editDraft({maskRaster: h.controller.state.draft.sources[1]});
    const body = captureModelSubmission(h.controller.state.draft, "a".repeat(32));
    assert.deepEqual(body.inputs.start, {kind: "catalogRaster", source: {collectionId: raster.collectionId, itemId: "start"}});
    assert.equal(h.view.setup.maskGroup.hidden, false); assert.equal(h.view.setup.vectorGroup.hidden, true);
    assert.match(h.view.setup.maskGroup.children[1].textContent, /valid cells greater than zero/);
    h.context.area = {kind: "selectedArea", selectedBounds: {west: 0, east: 1, south: 0, north: 1}}; h.controller.refreshMapArea();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "b".repeat(32)).inputs, body.inputs);
    h.context.rasters.pop(); h.controller.refreshMapLayers();
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "c".repeat(32)), /starting raster/);
});

test("map refresh does not guess or replace the user's mask and values choices", async () => {
    const h = fixture(); await settle();
    h.context.rasters.push({...raster, itemId: "another-value", visible: false});
    h.context.vectors.push({...selection, itemId: "another-mask"});
    h.controller.refreshMapLayers();
    assert.equal(h.controller.state.draft.raster, null);
    assert.equal(h.controller.state.draft.area, null);
    await chooseInputs(h);
    h.controller.refreshMapLayers();
    assert.equal(h.controller.state.draft.raster.itemId, raster.itemId);
    assert.equal(h.controller.state.draft.area.selection.itemId, "starting-areas");
    h.controller.editDraft({raster: null}); h.controller.refreshMapLayers();
    assert.equal(h.controller.state.draft.raster, null);
});

test("duplicate preserves mask, values and formula without a hydrology check or new run", async () => {
    const h = fixture(); await chooseInputs(h); await h.controller.submit();
    await h.controller.duplicateRun();
    const draft = h.controller.state.draft;
    assert.deepEqual(captureModelSubmission(draft, "c".repeat(32)).inputs, h.requests[0].inputs);
    assert.equal(h.requests.length, 1);
    assert.equal(h.view.setup.run.disabled, false);
    assert.equal(h.controller.state.error, "");
});

test("parameters keep optional cutoff blank and reject invalid distance values", async () => {
    const h = fixture(); await chooseInputs(h);
    assert.equal(h.view.setup.parameters.cutoff.value, "");
    assert.equal(h.view.setup.parameters.cutoff.required, false);
    for (const parameters of [{buffer: -1}, {buffer: null}, {cutoff: 0}, {cutoff: -1}, {cutoff: Infinity}]) {
        const draft = {...h.controller.state.draft, parameters: {...h.controller.state.draft.parameters, ...parameters}};
        assert.throws(() => captureModelSubmission(draft, "x".repeat(32)), /must be|Enter a number/);
    }
    assert.equal(captureModelSubmission(h.controller.state.draft, "x".repeat(32)).parameters.cutoff, null);
});

test("a raster-mask run can use a completed raster as values and duplicate those exact choices", async () => {
    const h = fixture(); await settle();
    const previous = job({status: "ready", expiresAt: "2099-01-01T00:00:00Z", artifacts: fileManifest()});
    h.controller.rememberRun(previous); h.controller.refreshMapLayers();
    const source = h.controller.state.draft.sources.find(value => value.kind === "runArtifact");
    h.controller.chooseArea("raster");
    h.controller.editDraft({maskRaster: raster, raster: source});
    const expected = captureModelSubmission(h.controller.state.draft, "d".repeat(32));
    assert.deepEqual(expected.inputs.people, {kind: "runArtifact", jobId: source.jobId, artifactId: source.artifactId});
    assert.deepEqual(expected.inputs.start, {kind: "catalogRaster", source: {collectionId: raster.collectionId, itemId: raster.itemId}});
    h.controller.state.invocation = {model: downstreamModel, inputs: expected.inputs, parameters: expected.parameters, label: expected.label};
    await h.controller.duplicateRun();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "e".repeat(32)).inputs, expected.inputs);
    assert.deepEqual(h.requests, []);
    h.controller.editDraft({maskRaster: source});
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "f".repeat(32)), /starting raster/);
});

test("saved model-configured runs need only their captured recipe and user inputs", async () => {
    const h = fixture(); await chooseInputs(h);
    const submission = captureModelSubmission(h.controller.state.draft, "g".repeat(32));
    const saved = {...submission, model: {...downstreamModel, definition: downstreamModel}};
    const calls = [];
    const api = new ProcessingApiClient(async url => {
        calls.push(url);
        return new Response(JSON.stringify(url.endsWith("/jobs") ? {jobs: []} : saved));
    }, null);
    assert.deepEqual(await api.readModelInvocation(job().jobId), saved);
    assert.deepEqual(calls, ["/api/processing/jobs", `/api/processing/jobs/${job().jobId}/invocation`]);
});

test("historical hydrology reports remain readable and must match their saved input revision", async () => {
    const historicalModel = {...downstreamModel, inputs: {...downstreamModel.inputs, terrain: {type: "prepared_hydrology", label: "Prepared hydrology"}}};
    const saved = {model: {...historicalModel, definition: historicalModel}, label: "Original run", parameters: {},
        inputs: {terrain: hydrologyReference(hydrology)}, hydrology: {terrain: structuredClone(hydrology)}};
    const api = new ProcessingApiClient(async url => new Response(JSON.stringify(url.endsWith("/jobs") ? {jobs: []} : saved)), null);
    assert.deepEqual((await api.readModelInvocation(job().jobId)).hydrology.terrain, hydrology);
    saved.hydrology.terrain.effectiveSha256 = "e".repeat(64);
    await assert.rejects(api.readModelInvocation(job().jobId), /does not match/);
    delete saved.hydrology.terrain;
    await assert.rejects(api.readModelInvocation(job().jobId), /Invalid prepared hydrology details/);
});

test("historical hydrology details stay read-only", () => {
    const registered = structuredClone(hydrology);
    registered.validation.validator = "eolab.hydrology-registration/v1";
    const rows = hydrologyDetails(registered);
    assert.ok(rows.some(([label]) => label === "Registered"));
    assert.ok(!rows.some(([label]) => label === "Validated"));
    assert.ok(rows.some(([, value]) => /NEXT_SINK equals HYBAS_ID/.test(value)));
});
