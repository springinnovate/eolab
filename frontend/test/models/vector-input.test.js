import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {ModelsController} from "../../src/models/controller.js";
import {ModelsView} from "../../src/models/view.js";
import {ProcessingJobs} from "../../src/processing/jobs.js";
import {captureModelSubmission, createModelDraft} from "../../src/models/inputs.js";
import {getModelInputHandler, supportsModelInput} from "../../src/models/input-handlers.js";
import {validateModelResult} from "../../src/processing/model-results.js";
import {SummaryControlDocument} from "../../test-support/processing/summary-document.js";
import {model, job, clipResult, fileManifest} from "../../test-support/models/fixtures.js";

const definition = {type: "vector", label: "Observations", geometry: "polygon", fields: {
    identifier: {label: "Location identifier", kind: "scalar"}, measurement: {label: "Measured amount", kind: "numeric"},
}};
const alternateDefinition = {type: "vector", label: "Comparison regions", geometry: "polygon", fields: {
    baseline: {label: "Baseline measurement", kind: "numeric"}, comparison: {label: "Comparison measurement", kind: "numeric"},
    category: {label: "Region category", kind: "scalar"},
}};
const predicate = {enabled: true, match: "all", rules: [{field: "region_name", operator: "eq", value: "West"}]};
const allFeatures = {enabled: false, match: "all", rules: []};
const selection = {collectionId: "vectors", itemId: "regions", assetKey: "data", layerName: "observations", filter: predicate};
const fields = [{name: "region_name", type: "str"}, {name: "measurement", type: "float"}, {name: "year", type: "int"}];
const source = {key: "view-1", label: "Region observations", filter: predicate, fields, scalarFields: fields,
    numericFields: fields.slice(1), selection, allSelection: {...selection, filter: allFeatures}};

/** Declare an example recipe using the reusable input and ordinary numeric parameters.
 * @param {Object} [input=definition] Field-selector configuration.
 * @return {Object} Independent recipe using a neutral example operation.
 */
function recipeFor(input = definition) {
    return {...model, id: "configured-vector-example", title: "Configured vector example", description: "Choose a vector and its attributes.",
        inputs: {features: input}, parameters: {scale: {type: "number", label: "Scale", unit: "factor", minimum: 0, default: 1}},
        outputs: {vector: {source: "calculate.vector", role: "result", presentation: "map", saveEligible: false}}};
}

/** Connect real Data tools controls to recorded Processing requests and mutable source metadata.
 * @param {Object} [recipe=recipeFor()] Installed example definition.
 * @return {Object} Controller, view, composed context, API and detached submitted requests.
 */
function setup(recipe = recipeFor()) {
    const doc = new SummaryControlDocument(), view = new ModelsView(doc), submitted = [], saved = new Map();
    const context = {vectors: [structuredClone(source)], rasters: []};
    const api = {discoverModels: async () => [recipe],
        submitModelRun: async value => { submitted.push(value); return job({model: recipe}); },
        getJob: async () => job({model: recipe}), readModelInvocation: async () => ({model: {...recipe, definition: recipe},
            inputs: submitted.at(-1)?.inputs, parameters: {scale: 1}}), readJobStatuses: async () => ({jobs: []})};
    const clock = {setTimeout() {}, clearTimeout() {}}, jobs = new ProcessingJobs(api, clock);
    const controller = new ModelsController({api, jobs, view, clock, getContext: () => context,
        storage: {getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)},
        prepareVector: () => { throw Error("Configured vector inputs must not preflight scan features"); },
        closeVectorFilter() {}, onOpen() {}, onClose() {}, newId: () => "d".repeat(32)});
    controller.chooseModel(recipe);
    return {controller, doc, view, context, submitted, api};
}

/** Apply a browser selection through its actual input event.
 * @param {HTMLSelectElement} control Retained selection control.
 * @param {string} value User-selected option.
 * @return {void}
 */
function choose(control, value) { control.value = value; control.dispatchEvent(new Event("change")); }

test("registered vector inputs use configured labels and roles in ordinary Processing submission", async t => {
    const h = setup(); t.after(() => h.controller.destroy());
    await h.controller.loadLibrary();
    assert.equal(h.controller.state.library.length, 1);
    const controls = h.view.setup.inputs.features;
    assert.equal(h.view.setup.run.disabled, true);
    assert.deepEqual(Object.keys(controls.fields), ["identifier", "measurement"]);
    assert.ok(controls.root.querySelectorAll("label").some(label => label.textContent === "Measured amount"));
    choose(controls.source, source.key);
    choose(controls.fields.identifier, "region_name");
    choose(controls.fields.measurement, "measurement");
    assert.equal(h.view.setup.run.disabled, false);
    assert.equal(controls.fields.measurement.children.some(option => option.value === "region_name"), false);
    const updated = {...predicate, rules: [{...predicate.rules[0], value: "East"}]};
    Object.assign(h.context.vectors[0], {filter: updated, selection: {...selection, filter: updated}});
    await h.controller.submit();
    assert.deepEqual(h.submitted[0].inputs.features, {selection: {...selection, filter: updated},
        fields: {identifier: "region_name", measurement: "measurement"}});
    assert.equal(h.submitted[0].parameters.scale, 1);
    updated.rules[0].value = "North";
    assert.equal(h.submitted[0].inputs.features.selection.filter.rules[0].value, "East");
});

test("a second recipe configures three different field roles without changes to the shared controls", async t => {
    const h = setup(recipeFor(alternateDefinition)); t.after(() => h.controller.destroy());
    const controls = h.view.setup.inputs.features;
    choose(controls.source, source.key);
    choose(controls.fields.baseline, "measurement");
    choose(controls.fields.comparison, "year");
    choose(controls.fields.category, "measurement");
    choose(controls.scope, "all");
    assert.equal(h.view.setup.run.disabled, false);
    await h.controller.submit();
    assert.deepEqual(h.submitted[0].inputs.features, {selection: {...selection, filter: allFeatures},
        fields: {baseline: "measurement", comparison: "year", category: "measurement"}});
    assert.deepEqual(source.selection.filter, predicate);
    const handler = getModelInputHandler("vector");
    const state = handler.createDraft(alternateDefinition, {vectors: [source]});
    Object.assign(state, {vectorKey: source.key, fields: {baseline: "region_name", comparison: "year", category: "region_name"}});
    assert.throws(() => handler.capture(state, alternateDefinition), /Baseline measurement/);
});

test("source-only vector inputs omit field controls and capture an empty field mapping", async t => {
    for (const fieldConfig of [undefined, {}]) {
        const input = {type: "vector", label: "Clipping features", geometry: "polygon", ...(fieldConfig ? {fields: fieldConfig} : {})};
        const h = setup(recipeFor(input)); t.after(() => h.controller.destroy());
        const controls = h.view.setup.inputs.features;
        assert.deepEqual(Object.keys(controls.fields), []);
        choose(controls.source, source.key);
        assert.equal(h.view.setup.run.disabled, false);
        await h.controller.submit();
        assert.deepEqual(h.submitted[0].inputs.features, {selection, fields: {}});
    }
});

test("multiple configured vector inputs retain independent source, field and filter choices", () => {
    const recipe = recipeFor(); recipe.inputs.reference = alternateDefinition;
    const draft = createModelDraft(recipe, {vectors: [source]}, "draft");
    Object.assign(draft.inputs.features, {vectorKey: source.key, fields: {identifier: "region_name", measurement: "measurement"}});
    Object.assign(draft.inputs.reference, {vectorKey: source.key, featureScope: "all",
        fields: {baseline: "year", comparison: "measurement", category: "region_name"}});
    const captured = captureModelSubmission(draft, "d".repeat(32));
    assert.deepEqual(captured.inputs.features.selection.filter, predicate);
    assert.deepEqual(captured.inputs.reference.selection.filter, allFeatures);
    assert.equal(captured.inputs.features.fields.measurement, "measurement");
    assert.equal(captured.inputs.reference.fields.baseline, "year");
});

test("removing the chosen source clears its live choices and never selects a replacement", t => {
    const h = setup(); t.after(() => h.controller.destroy());
    h.controller.editInput("features", {vectorKey: source.key, fields: {identifier: "region_name", measurement: "measurement"}});
    h.context.vectors = [{...source, key: "replacement"}]; h.controller.refreshMapLayers();
    const state = h.controller.state.draft.inputs.features;
    assert.equal(state.vectorKey, "");
    assert.deepEqual(state.fields, {identifier: "", measurement: ""});
    assert.equal(h.view.setup.run.disabled, true);
    assert.match(h.view.setup.inputs.features.status.textContent, /Add the vector layer/);
});

test("unavailable field kinds prevent running and identify the configured selector", t => {
    const h = setup(); t.after(() => h.controller.destroy());
    h.context.vectors[0].numericFields = [];
    h.controller.refreshMapLayers();
    choose(h.view.setup.inputs.features.source, source.key);
    assert.equal(h.view.setup.run.disabled, true);
    assert.match(h.view.setup.inputs.features.status.textContent, /Measured amount/);
});

test("duplicated runs preserve captured upload identity and configured roles after map changes", async t => {
    const h = setup(); t.after(() => h.controller.destroy());
    const uploaded = {uploadId: "11111111-1111-4111-8111-111111111111", layerName: "original", filter: predicate};
    const input = {selection: uploaded, fields: {identifier: "region_name", measurement: "measurement"}};
    h.controller.state.library = [recipeFor()];
    h.controller.state.invocation = {model: recipeFor(), label: "Repeated analysis", parameters: {scale: 2}, inputs: {features: input}};
    await h.controller.duplicateRun();
    h.context.vectors = []; h.controller.refreshMapLayers();
    const controls = h.view.setup.inputs.features;
    assert.equal(controls.source.children[0].textContent, "Layer and filter from original run");
    assert.equal(controls.source.required, false, "The captured selection must pass native form validation without a live layer key");
    assert.equal(controls.scope.disabled, true);
    assert.equal(controls.fields.measurement.value, "measurement");
    assert.equal(h.view.setup.run.disabled, false);
    await h.controller.submit();
    assert.deepEqual(h.submitted[0].inputs.features, input);
    input.fields.measurement = "year";
    assert.equal(h.submitted[0].inputs.features.fields.measurement, "measurement");
});

test("saved input descriptions use recipe labels instead of operation-specific wording", () => {
    const handler = getModelInputHandler("vector");
    assert.equal(handler.describe({selection, fields: {baseline: "year", comparison: "measurement", category: "region_name"}},
        alternateDefinition, {describeFilter: () => "West regions"}),
    "Baseline measurement: year · Comparison measurement: measurement · Region category: region_name · West regions");
});

test("input registration is the only vector-type dispatch in the shared Models lifecycle", () => {
    assert.equal(supportsModelInput("vector"), true);
    assert.equal(supportsModelInput("summary_area"), true);
    assert.equal(supportsModelInput("unregistered-input"), false);
    for (const name of ["controller.js", "inputs.js", "view.js"]) {
        const sourceText = readFileSync(new URL(`../../src/models/${name}`, import.meta.url), "utf8");
        assert.doesNotMatch(sourceText, /(?:input|definition)\.type\s*===\s*["']vector["']/);
        assert.doesNotMatch(sourceText, /vector_summary|VectorSummary|groupField|valueField/);
        assert.match(sourceText, /getModelInputHandler/);
    }
});

test("generic vector results support preferred numeric styling and ordinary file actions", () => {
    const result = {...clipResult, name: "vector", label: "Processed features", kind: "vector", mediaType: "application/geopackage+sqlite3",
        layerName: "output", featureCount: 2, defaultNumericField: "measurement"};
    validateModelResult(result);
    validateModelResult({...result, defaultNumericField: undefined});
    assert.throws(() => validateModelResult({...result, featureCount: -1}), /invalid vector/);
    assert.throws(() => validateModelResult({...result, defaultNumericField: ""}), /invalid vector/);
    const doc = new SummaryControlDocument(), view = new ModelsView(doc), artifacts = fileManifest();
    Object.assign(artifacts.files[0], {name: "vector", label: "Processed features", mediaType: result.mediaType, filename: "processed.gpkg"});
    const recipe = recipeFor(), run = job({status: "ready", model: recipe, result, artifacts, expiresAt: artifacts.expiresAt});
    view.bind(new Proxy({}, {get: () => () => {}}));
    view.render({page: "run", library: [recipe], runs: [run], selectedRun: run.jobId, error: "", query: "",
        outputPreviews: {[artifacts.files[0].artifactId]: {canShow: true}}});
    const text = view.run.result.children[0].children.map(node => node.textContent).join(" ");
    assert.match(text, /2 features/);
    assert.doesNotMatch(text, /Total field/);
    assert.ok(view.elements.run.querySelectorAll("a").some(link => link.textContent === "Download"));
    assert.equal(view.run.fileActions[0].button.hidden, false);
});
