import test from "node:test";
import assert from "node:assert/strict";
import { ModelsController } from "../../src/models/controller.js";
import { ModelsView } from "../../src/models/view.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { captureModelSubmission, createModelDraft } from "../../src/models/inputs.js";
import { validateModelResult } from "../../src/processing/model-results.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";
import { model, job, clipResult, fileManifest } from "../../test-support/models/fixtures.js";

const recipe = {...model, id: "vector-summary", title: "Vector summary", description: "Sum a field for each group of polygons.",
    inputs: {vector: {type: "vector_summary", label: "Polygon layer"}},
    parameters: {boundary_tolerance_m: {type: "number", label: "Boundary detail", unit: "m", minimum: 0, default: 1000}},
    outputs: {vector: {source: "summarize.vector", role: "result", presentation: "map", saveEligible: false}}};
const filter = {enabled: true, match: "all", rules: [{field: "state_name", operator: "eq", value: "California"}]};
const emptyFilter = {enabled: false, match: "all", rules: []};
const selection = {collectionId: "eolab-mounted-vectors", itemId: "ecosystems", assetKey: "data", layerName: "ecosystems", filter};
const fields = [{name: "state_name", type: "str"}, {name: "total_es", type: "float"}, {name: "year", type: "int"}];
const source = {...selection, key: "view-1", label: "Ecosystem values", fields, scalarFields: fields, numericFields: fields.slice(1),
    selection, allSelection: {...selection, filter: emptyFilter}};

/** Connect the actual setup view and controller to recorded Processing requests.
 * @return {Object} Components, mutable map context and recorded submissions.
 */
function setup() {
    const doc = new SummaryControlDocument(), view = new ModelsView(doc), submitted = [], saved = new Map();
    const context = {vectors: [structuredClone(source)], rasters: []};
    const api = {submitModelRun: async value => { submitted.push(value); return job({model: recipe}); },
        getJob: async () => job({model: recipe}), readModelInvocation: async () => ({model: {...recipe, definition: recipe},
            inputs: submitted.at(-1)?.inputs, parameters: {boundary_tolerance_m: 1000}}),
        readJobStatuses: async () => ({jobs: []})};
    const clock = {setTimeout() {}, clearTimeout() {}}, jobs = new ProcessingJobs(api, clock);
    const controller = new ModelsController({api, jobs, view, clock, getContext: () => context,
        storage: {getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)},
        prepareVector: () => { throw Error("Summary setup must not preflight scan features"); },
        closeVectorFilter() {}, onOpen() {}, onClose() {}, newId: () => "d".repeat(32)});
    controller.chooseModel(recipe);
    return {controller, doc, view, context, submitted};
}

test("summary form sends fields and the current accepted filter through ordinary Processing submission", async t => {
    const h = setup(); t.after(() => h.controller.destroy());
    const controls = h.view.setup.inputs.vector;
    assert.equal(h.view.setup.run.disabled, true);
    controls.source.value = source.key; controls.source.dispatchEvent(new Event("change"));
    controls.group.value = "state_name"; controls.group.dispatchEvent(new Event("change"));
    controls.value.value = "total_es"; controls.value.dispatchEvent(new Event("change"));
    assert.equal(h.view.setup.run.disabled, false);
    assert.match(controls.description.textContent, /layer's filter when you run the tool/);
    assert.equal(controls.value.children.some(option => option.value === "state_name"), false);
    const updatedFilter = {...filter, rules: [{...filter.rules[0], value: "Oregon"}]};
    h.context.vectors[0].filter = updatedFilter;
    h.context.vectors[0].selection.filter = updatedFilter;
    await h.controller.submit();
    assert.equal(h.submitted.length, 1);
    assert.deepEqual(h.submitted[0].inputs.vector, {selection: {...selection, filter: updatedFilter}, groupField: "state_name", valueField: "total_es"});
    assert.equal(h.submitted[0].parameters.boundary_tolerance_m, 1000);
    h.context.vectors[0].selection.filter.rules[0].value = "Washington";
    assert.equal(h.submitted[0].inputs.vector.selection.filter.rules[0].value, "Oregon");
});

test("all features explicitly clears only the captured predicate and accepts numeric grouping", () => {
    const draft = createModelDraft(recipe, {vectors: [source]}, "draft");
    Object.assign(draft.inputs.vector, {vectorKey: source.key, featureScope: "all", groupField: "total_es", valueField: "year"});
    const submitted = captureModelSubmission(draft, "d".repeat(32));
    assert.deepEqual(submitted.inputs.vector.selection.filter, emptyFilter);
    assert.deepEqual(source.selection.filter, filter);
    assert.equal(submitted.inputs.vector.groupField, "total_es");
    draft.inputs.vector.valueField = "state_name";
    assert.throws(() => captureModelSubmission(draft, "d".repeat(32)), /Choose fields/);
});

test("uploaded source identities and duplicated run selections retain their native layer", () => {
    const uploaded = {uploadId: "11111111-1111-4111-8111-111111111111", layerName: "original", filter};
    const draft = createModelDraft(recipe, {vectors: [{...source, selection: uploaded, allSelection: {...uploaded, filter: emptyFilter}}]}, "draft");
    Object.assign(draft.inputs.vector, {vectorKey: source.key, groupField: "state_name", valueField: "total_es"});
    assert.deepEqual(captureModelSubmission(draft, "d".repeat(32)).inputs.vector.selection, uploaded);
    Object.assign(draft.inputs.vector, {vectors: [], vectorKey: "", capturedSelection: uploaded});
    assert.deepEqual(captureModelSubmission(draft, "d".repeat(32)).inputs.vector.selection, uploaded);
});

test("removing the chosen layer clears summary controls without silently selecting another source", t => {
    const h = setup(); t.after(() => h.controller.destroy());
    h.controller.editInput("vector", {vectorKey: source.key, groupField: "state_name", valueField: "total_es"});
    h.context.vectors = []; h.controller.refreshMapLayers();
    assert.equal(h.controller.state.draft.inputs.vector.vectorKey, "");
    assert.equal(h.view.setup.run.disabled, true);
    assert.match(h.view.setup.inputs.vector.status.textContent, /Add the polygon layer/);
});

test("duplicating a run retains its captured source and fields when map layers change", async t => {
    const h = setup(); t.after(() => h.controller.destroy());
    h.controller.state.library = [recipe];
    h.controller.state.invocation = {model: recipe, label: "State totals", parameters: {boundary_tolerance_m: 1000},
        inputs: {vector: {selection, groupField: "state_name", valueField: "total_es"}}};
    await h.controller.duplicateRun();
    h.context.vectors = [];
    h.controller.refreshMapLayers();
    const controls = h.view.setup.inputs.vector;
    assert.equal(controls.source.children[0].textContent, "Layer and filter from original run");
    assert.equal(controls.scope.disabled, true);
    assert.equal(controls.group.value, "state_name");
    assert.equal(controls.value.value, "total_es");
    assert.equal(h.view.setup.run.disabled, false);
    await h.controller.submit();
    assert.deepEqual(h.submitted[0].inputs.vector, {selection, groupField: "state_name", valueField: "total_es"});
});

test("vector result validation and run presentation expose the GeoPackage and ordinary map action", () => {
    const result = {...clipResult, name: "vector", label: "Grouped totals", kind: "vector", mediaType: "application/geopackage+sqlite3",
        layerName: "summary", featureCount: 2, summaryField: "sum_total_es"};
    validateModelResult(result);
    validateModelResult({...result, summaryField: undefined});
    assert.throws(() => validateModelResult({...result, featureCount: -1}), /invalid vector/);
    const doc = new SummaryControlDocument(), view = new ModelsView(doc), artifacts = fileManifest();
    Object.assign(artifacts.files[0], {name: "vector", label: "Grouped totals", mediaType: result.mediaType, filename: "summary.gpkg"});
    const run = job({status: "ready", model: recipe, result, artifacts, expiresAt: artifacts.expiresAt});
    view.bind(new Proxy({}, {get: () => () => {}}));
    view.render({page: "run", library: [recipe], runs: [run], selectedRun: run.jobId, error: "", query: "",
        outputPreviews: {[artifacts.files[0].artifactId]: {canShow: true}}});
    const text = view.run.result.children[0].children.map(node => node.textContent).join(" ");
    assert.match(text, /2 features/);
    assert.match(text, /sum_total_es/);
    assert.ok(view.elements.run.querySelectorAll("a").some(link => link.textContent === "Download"));
    assert.equal(view.run.fileActions[0].button.hidden, false);
});
