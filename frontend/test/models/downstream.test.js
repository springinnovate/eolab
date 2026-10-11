import test from "node:test";
import assert from "node:assert/strict";
import { ModelsController } from "../../src/models/controller.js";
import { ModelsView, describeModelProgress } from "../../src/models/view.js";
import { captureModelSubmission } from "../../src/models/inputs.js";
import { ProcessingApiClient } from "../../src/processing/api.js";
import { hydrologyKey, hydrologyReference } from "../../src/processing/hydrology.js";
import { hydrologyDetails } from "../../src/models/hydrology-view.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";
import { downstreamModel, hydrology, raster, selection, job, model, fileManifest } from "../../test-support/models/fixtures.js";

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
    const api = {discoverPreparedHydrology: async () => [structuredClone(hydrology)], resolvePreparedHydrology: async () => structuredClone(hydrology),
        submitModelRun: async value => { requests.push(value); return job(); }, getJob: async () => job(),
        readModelInvocation: async () => ({model: {...downstreamModel, definition: downstreamModel}, inputs: requests[0].inputs, parameters: requests[0].parameters, label: "Saved run", hydrology: {terrain: hydrology}}), ...overrides};
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

test("registered hydrology can run and its details do not claim full validation", async () => {
    const registered = structuredClone(hydrology);
    registered.validation.validator = "eolab.hydrology-registration/v1";
    const h = fixture({discoverPreparedHydrology: async () => [registered], resolvePreparedHydrology: async () => registered});
    await settle();
    assert.equal(h.view.setup.run.disabled, false);
    const rows = hydrologyDetails(registered);
    assert.ok(rows.some(([label]) => label === "Registered"));
    assert.ok(!rows.some(([label]) => label === "Validated"));
    await h.controller.submit();
    assert.deepEqual(h.requests[0].inputs.terrain, hydrologyReference(registered));
});

test("one prepared dataset suggests compatible inputs and captures the YAML-named vector mask", async () => {
    const h = fixture(); await settle();
    const draft = h.controller.state.draft;
    assert.equal(draft.raster.itemId, raster.itemId);
    assert.match(draft.hydrologyReason, /only prepared dataset/);
    assert.equal(draft.vectorInfo.matched, 1);
    assert.equal(h.view.setup.run.disabled, false);
    assert.deepEqual(h.view.setup.areaMode.children.map(option => option.value), ["vector", "raster"]);
    await h.controller.openVectorFilter();
    const filter = {...selection.filter, rules: [{field: "NAME", operator: "eq", value: "Cuba"}]};
    await h.filters[0].apply(filter); h.filters[0].complete();
    await h.controller.submit();
    assert.deepEqual(h.requests[0].inputs.terrain, hydrologyReference(hydrology));
    assert.deepEqual(h.requests[0].inputs.start.selection.filter, filter);
    assert.deepEqual(h.requests[0].inputs.people, {collectionId: raster.collectionId, itemId: raster.itemId});
    assert.equal(h.requests[0].parameters.summary, "sum(a)");
    h.context.vectors[0].filter.rules = []; h.context.rasters = []; h.controller.refreshMapLayers(); h.controller.setActive(false);
    assert.deepEqual(h.requests[0].inputs.start.selection.filter, filter);
    assert.deepEqual(h.cancelled, []);
});

test("raster masks have positive-cell semantics, do not follow map clicks, and reject removed inputs", async () => {
    const h = fixture(); await settle();
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

test("ambiguous datasets and rasters stay unresolved; matching both mapped sources suggests a dataset", async () => {
    const other = structuredClone(hydrology); other.definition.id = "other-region";
    other.definition.dem.itemId = "other-dem"; other.definition.watersheds.itemId = "other-watersheds";
    const h = fixture({discoverPreparedHydrology: async () => [hydrology, other]}); await settle();
    assert.equal(h.controller.state.draft.hydrology, null); assert.equal(h.view.setup.run.disabled, true);
    h.context.rasters.push({...hydrology.definition.dem, label: "Prepared DEM", visible: false}, {...raster, itemId: "another-value", visible: false});
    h.context.vectors.push({...hydrology.definition.watersheds, label: "Hydrology network"}); h.controller.refreshMapLayers();
    await h.controller.loadHydrology(); await settle();
    assert.equal(h.controller.state.draft.hydrology.definition.id, hydrology.definition.id);
    assert.match(h.controller.state.draft.hydrologyReason, /elevation and watershed layers/);
    // Explicitly hidden rasters are available, but are never the automatic values input.
    assert.equal(h.controller.state.draft.raster.itemId, raster.itemId);
    h.controller.editDraft({raster: null}); await h.controller.loadHydrology();
    assert.equal(h.controller.state.draft.raster, null, "Refresh must not undo a deliberate clear");
});

test("missing, failed and stale hydrology checks cannot enable Run or replace a newer draft", async () => {
    const h = fixture({discoverPreparedHydrology: async () => []}); await settle();
    assert.match(h.view.setup.hydrology.status.textContent, /No prepared datasets/);
    assert.equal(h.view.setup.run.disabled, true);
    let resolve;
    h.api.discoverPreparedHydrology = async () => [hydrology];
    h.api.resolvePreparedHydrology = () => new Promise(done => { resolve = done; });
    const checking = h.controller.loadHydrology(); await settle();
    assert.match(h.view.setup.hydrology.status.textContent, /Checking elevation/);
    assert.equal(h.view.setup.run.disabled, true);
    h.controller.chooseModel(model); resolve(hydrology); await checking;
    assert.equal(h.controller.state.draft.model.id, model.id); assert.equal(h.controller.state.draft.hydrology, null);
    h.api.resolvePreparedHydrology = async () => { throw new Error("Source changed"); };
    h.controller.chooseModel(downstreamModel); await settle();
    assert.match(h.view.setup.hydrology.error.textContent, /Source changed/);
    assert.equal(h.view.setup.run.disabled, true);
});

test("a superseded hydrology choice ignores late success and late failure", async () => {
    const other = structuredClone(hydrology); other.definition.id = "other";
    const h = fixture({discoverPreparedHydrology: async () => [hydrology, other]}); await settle();
    const pending = [];
    h.api.resolvePreparedHydrology = (_reference, signal) => new Promise((resolve, reject) => pending.push({resolve, reject, signal}));
    const first = h.controller.chooseHydrology(hydrologyKey(hydrologyReference(hydrology)));
    const second = h.controller.chooseHydrology(hydrologyKey(hydrologyReference(other)));
    assert.equal(pending[0].signal.aborted, true);
    pending[1].resolve(other); await second; pending[0].reject(new Error("Old response")); await first;
    assert.equal(h.controller.state.draft.hydrology.definition.id, "other"); assert.equal(h.controller.state.draft.hydrologyError, "");
});

test("duplicate preserves mask, formula and exact hydrology revision without starting a run", async () => {
    const h = fixture(); await settle(); await h.controller.submit();
    await h.controller.duplicateRun();
    const draft = h.controller.state.draft;
    assert.deepEqual(captureModelSubmission(draft, "c".repeat(32)).inputs, h.requests[0].inputs);
    assert.equal(h.requests.length, 1);
    const changed = structuredClone(hydrology); changed.effectiveSha256 = "e".repeat(64);
    h.api.discoverPreparedHydrology = async () => [changed];
    await h.controller.duplicateRun();
    assert.equal(h.controller.state.draft.hydrology, null);
    assert.match(h.controller.state.draft.hydrologyError, /original hydrology dataset revision is unavailable/);
    assert.equal(h.controller.state.draft.hydrologyReason, "");
    assert.equal(h.view.setup.run.disabled, true);
    await h.controller.loadHydrology();
    assert.equal(h.controller.state.draft.hydrology, null, "Refresh must not substitute a different revision");
});

test("parameters keep optional cutoff blank and reject invalid distance values", async () => {
    const h = fixture(); await settle();
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

test("saved hydrology must match the accepted input revision before displaying or duplicating it", async () => {
    const saved = {model: {...downstreamModel, definition: downstreamModel}, label: "Original run", parameters: {},
        inputs: {terrain: hydrologyReference(hydrology)}, hydrology: {terrain: structuredClone(hydrology)}};
    const api = new ProcessingApiClient(async url => new Response(JSON.stringify(url.endsWith("/jobs") ? {jobs: []} : saved)), null);
    assert.deepEqual((await api.readModelInvocation(job().jobId)).hydrology.terrain, hydrology);
    saved.hydrology.terrain.effectiveSha256 = "e".repeat(64);
    await assert.rejects(api.readModelInvocation(job().jobId), /does not match/);
    delete saved.hydrology.terrain;
    await assert.rejects(api.readModelInvocation(job().jobId), /Invalid prepared hydrology details/);
});

test("hydrology details retain focus and progress reports the actual downstream stages", async () => {
    const h = fixture(); await settle();
    const controls = h.view.setup.hydrology; controls.details.open = true; controls.select.focus(); h.controller.render();
    assert.equal(h.doc.activeElement, controls.select); assert.equal(controls.details.open, true);
    assert.ok(controls.body.children.some(node => /NEXT_SINK equals HYBAS_ID/.test(node.textContent)));
    for (const [phase, expected] of [["preparing_starting_mask", "Preparing starting cells"], ["routing_downstream", "Tracing downstream flow"],
        ["buffering_downstream_coverage", "Buffering downstream coverage"], ["summarizing_values", "Summarizing raster values"]])
        assert.equal(describeModelProgress(job({status: "running", progress: {phase}})), expected + "…");
    assert.match(describeModelProgress(job({status: "running", progress: {phase: "summarizing_values", completed: 2, total: 5, unit: "blocks"}})), /2 of 5 blocks/);
});

test("hydrology API checks identities, metadata and same-origin sessions", async () => {
    let response = hydrology; const calls = [];
    const api = new ProcessingApiClient(async (url, options) => {
        calls.push({url, options});
        const body = url.endsWith("/jobs") ? {jobs: []} : url.endsWith("/prepared-hydrology") ? {configurations: [response]} : response;
        return new Response(JSON.stringify(body));
    }, null);
    await api.discoverPreparedHydrology(); const abort = new AbortController();
    await api.resolvePreparedHydrology(hydrologyReference(hydrology), abort.signal);
    assert.equal(calls[2].options.credentials, "same-origin"); assert.equal(calls[2].options.signal, abort.signal);
    assert.equal(calls[2].options.headers["X-EOLab-Processing"], "1");
    assert.deepEqual(JSON.parse(calls[2].options.body), hydrologyReference(hydrology));
    response = {...hydrology, effectiveSha256: "e".repeat(64)};
    await assert.rejects(api.resolvePreparedHydrology(hydrologyReference(hydrology)), /changed/);
    response = {...hydrology, definition: {...hydrology.definition, topology: {}}};
    await assert.rejects(api.discoverPreparedHydrology(), /Invalid prepared hydrology details/);
    await assert.rejects(api.resolvePreparedHydrology({presetId: "../bad"}), /identity/);
});
