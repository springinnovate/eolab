import test from "node:test";
import assert from "node:assert/strict";
import { ModelsController } from "../../src/models/controller.js";
import { ModelsView } from "../../src/models/view.js";
import { captureModelSubmission, modelSourceKey } from "../../src/models/inputs.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";
import { model, selection, job, fileManifest, clipResult } from "../../test-support/models/fixtures.js";

const habitat = {...model, id: "habitat-condition", title: "Habitat condition",
    description: "Fit expected habitat responses from reference sites and map their similarity.", parameters: {}, inputs: {
    stack: {type: "habitat_stack", label: "Predictors and observed responses"},
    area: {type: "summary_area", label: "Analysis area"},
    references: {type: "habitat_references", label: "Reference sites"},
    habitat_mask: {type: "optional_raster", label: "Habitat assessment mask"},
}, steps: [{id: "calculate", operation: "habitat.condition.v1", inputs: {
    stack: {input: "stack"}, area: {input: "area"}, references: {input: "references"}, habitat_mask: {input: "habitat_mask"}, settings: {value: {
    fold_count: 5, sampling_block_size_meters: 25000, validation_block_size_meters: 50000,
    minimum_predictor_coverage: 0.8, maximum_row_missing_fraction: 0.2, spline_knot_count: 6,
    minimum_response_coverage: 0.5, ridge_alpha: 1, samples_per_class_per_block: 100,
    random_seed: 42, tile_size_pixels: 128, tile_origin: [0, 0], window_size_pixels: 256, covariance_shrinkage: 0.1,
}}}, parameters: {}}], outputs: {
    reference_similarity: {type: "raster", label: "Reference similarity", source: "calculate.reference_similarity", role: "result", presentation: "map", saveEligible: true},
    diagnostics: {type: "raster", label: "Response diagnostics", source: "calculate.diagnostics", role: "intermediate", presentation: "download", saveEligible: false},
}};

/** Flush selection and view callbacks after a user action.
 * @return {Promise<void>} Resolves after pending promise reactions.
 */
const settle = () => new Promise(resolve => setImmediate(resolve));

/** Change a rendered form field through its actual event handler.
 * @param {HTMLElement} control Rendered input or select.
 * @param {string} value User-entered value.
 * @param {string} [event="change"] Event consumed by this control.
 * @return {void}
 */
function edit(control, value, event = "change") {
    control.value = value; control.dispatchEvent(new Event(event));
}

/** Open Habitat setup with real Models components and explicit API boundaries.
 * @return {Promise<Object>} Controller, view, source choices and captured API requests.
 */
async function fixture() {
    const requests = [], filters = [], values = new Map();
    const context = {
        rasters: ["Environment", "Habitat class", "Productivity", "Reference mask", "Assessment mask"].map((label, index) =>
            ({collectionId: "eolab-mounted-geotiffs", itemId: `geotiff-${index.toString(16).padStart(24, "0")}`, label, visible: false})),
        vectors: [{...selection, label: "Catalog basins", fields: [{name: "BASIN", type: "str"}]},
            {uploadId: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d", layerName: "reference_sites", label: "Uploaded sites",
                filter: structuredClone(selection.filter), fields: [{name: "BASIN", type: "str"}]}],
        area: {kind: "selectedArea", selectedBounds: {west: 0, south: 0, east: 1, north: 1}},
    };
    const api = {discoverModels: async () => [model, habitat], listModelRuns: async () => ({jobs: [], nextCursor: null}),
        submitModelRun: async request => { requests.push(request); return job({model: habitat}); },
        getJob: async () => job({model: habitat}),
        readModelInvocation: async () => ({...requests[0], model: {...habitat, definition: habitat}})};
    const doc = new SummaryControlDocument(), view = new ModelsView(doc);
    const jobs = {subscribe: () => () => {}, tracked: new Set(), schedule() {}, accept() {}};
    let id = 0;
    const controller = new ModelsController({api, jobs, view, getContext: () => context,
        prepareVector: async source => ({selection: source.uploadId
            ? {uploadId: source.uploadId, layerName: source.layerName, filter: source.filter}
            : {...selection, filter: source.filter}, matched: source.filter.rules[0].value === "North" ? 3 : 1, total: 8}),
        editVectorFilter: request => { filters.push(request); }, closeVectorFilter: () => filters.at(-1)?.close(),
        applyMapFilter: async (_source, filter) => filter, onOpen: () => {}, onClose: () => {},
        storage: {getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)},
        newId: () => String(++id).padStart(32, "0")});
    await controller.loadLibrary();
    assert.deepEqual(controller.state.library.map(recipe => recipe.id), [model.id, habitat.id]);
    controller.setActive(true); controller.chooseModel(habitat);
    return {controller, view, doc, context, api, jobs, requests, filters};
}

/** Select a vector and review the named input's filter using the composed editor.
 * @param {Object} harness Actual Models controller and view fixture.
 * @param {string} name Recipe input receiving this independent selection.
 * @param {Object} source Catalog or uploaded vector offered by the map.
 * @param {string} basin Attribute value to select.
 * @return {Promise<void>} Resolves after the filter is applied.
 */
async function chooseVector(harness, name, source, basin) {
    const controls = harness.view.setup.inputs[name];
    edit(controls.areaMode, "vector"); edit(controls.vector, modelSourceKey(source)); await settle();
    controls.editFilter.dispatchEvent(new Event("click")); await settle();
    const action = harness.filters.at(-1), filter = structuredClone(selection.filter);
    assert.equal(action.host, controls.filterHost);
    filter.rules[0].value = basin; await action.apply(filter); action.complete();
}

/** Fill the predictor/response lists through their rendered controls.
 * @param {Object} harness Actual Models controller and view fixture.
 * @return {void}
 */
function chooseStack(harness) {
    const controls = harness.view.setup.inputs.stack;
    edit(controls.predictors[0].name, "environment", "input");
    edit(controls.predictors[0].source, modelSourceKey(harness.context.rasters[0]));
    controls.addPredictor.dispatchEvent(new Event("click"));
    edit(controls.predictors[1].name, "habitat_type", "input");
    edit(controls.predictors[1].source, modelSourceKey(harness.context.rasters[1]));
    edit(controls.responses[0].name, "productivity", "input");
    edit(controls.responses[0].source, modelSourceKey(harness.context.rasters[2]));
    edit(controls.categorical, "habitat_type");
}

for (const [label, areaIndex, referenceIndex, withMask] of [
    ["Catalog area and uploaded reference sites", 0, 1, false],
    ["uploaded area and Catalog reference sites", 1, 0, false],
    ["raster reference sites and an assessment mask", 0, null, true],
]) test(`Habitat submits ${label} through the ordinary Models workflow`, async () => {
    const h = await fixture(); chooseStack(h);
    await chooseVector(h, "area", h.context.vectors[areaIndex], "North");
    const references = h.view.setup.inputs.references;
    if (referenceIndex === null) {
        edit(references.areaMode, "raster");
        edit(references.maskRaster, modelSourceKey(h.context.rasters[3]));
        assert.match(references.maskGroup.children.at(-1).textContent, /equal to 1/);
        assert.doesNotMatch(references.maskGroup.children.at(-1).textContent, /greater than zero/);
    } else {
        await chooseVector(h, "references", h.context.vectors[referenceIndex], "South");
        assert.equal(h.view.setup.inputs.area.selectedCount.textContent, "3 of 8 features selected");
        assert.equal(references.selectedCount.textContent, "1 of 8 features selected");
    }
    assert.equal(references.maskRaster.required, referenceIndex === null);
    assert.equal(h.view.setup.inputs.habitat_mask.source.required, false);
    if (withMask) edit(h.view.setup.inputs.habitat_mask.source, modelSourceKey(h.context.rasters[4]));
    assert.equal(h.requests.length, 0); assert.equal(h.view.setup.run.disabled, false);
    assert.deepEqual(h.view.setup.parameters, {});
    await h.controller.submit();
    assert.equal(h.requests.length, 1); assert.equal(h.controller.state.error, "");
    const request = h.requests[0], sources = h.context.rasters.map(({collectionId, itemId}) => ({collectionId, itemId}));
    assert.deepEqual(request.inputs.stack, {predictors: [{name: "environment", source: sources[0]}, {name: "habitat_type", source: sources[1]}],
        responses: [{name: "productivity", source: sources[2]}], categoricalPredictor: "habitat_type"});
    assert.equal(request.inputs.area.selection.filter.rules[0].value, "North");
    assert.equal(request.inputs.area.selection.uploadId, h.context.vectors[areaIndex].uploadId);
    if (referenceIndex === null) assert.deepEqual(request.inputs.references, {kind: "raster", source: sources[3]});
    else {
        assert.equal(request.inputs.references.kind, "vector");
        assert.equal(request.inputs.references.selection.filter.rules[0].value, "South");
        assert.equal(request.inputs.references.selection.uploadId, h.context.vectors[referenceIndex].uploadId);
    }
    assert.deepEqual(request.inputs.habitat_mask, withMask ? sources[4] : null);
    assert.deepEqual(request.parameters, {});
    h.controller.destroy();
});

test("Habitat stack edits preserve other rows and require unambiguous roles before Run", async () => {
    const h = await fixture(), controls = h.view.setup.inputs.stack;
    const settings = controls.settings.children.at(-1).children.map(node => node.textContent);
    const folds = settings.indexOf("Spatial validation folds"), width = settings.indexOf("Sampling block width (m)");
    assert.equal(settings[folds + 1], String(habitat.steps[0].inputs.settings.value.fold_count));
    assert.equal(settings[width + 1], String(habitat.steps[0].inputs.settings.value.sampling_block_size_meters));
    assert.equal(h.view.setup.run.disabled, true);
    chooseStack(h);
    edit(h.view.setup.inputs.references.areaMode, "raster");
    edit(h.view.setup.inputs.references.maskRaster, modelSourceKey(h.context.rasters[3]));
    assert.equal(h.view.setup.run.disabled, false);
    const category = controls.predictors[1].name;
    category.focus(); edit(category, "", "input");
    assert.equal(h.view.setup.run.disabled, true);
    edit(category, "land_class", "input");
    assert.equal(h.doc.activeElement, category); assert.equal(controls.categorical.value, "land_class");
    edit(controls.responses[0].name, "environment", "input");
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "duplicate-name"), /unique|different|duplicate/i);
    edit(controls.responses[0].name, "response", "input");
    edit(controls.responses[0].source, modelSourceKey(h.context.rasters[4]));
    controls.addResponse.dispatchEvent(new Event("click"));
    assert.equal(h.view.setup.run.disabled, true);
    edit(controls.responses[1].name, "productivity", "input");
    edit(controls.responses[1].source, modelSourceKey(h.context.rasters[2]));
    const remaining = controls.responses[1].name;
    controls.responses[0].remove.dispatchEvent(new Event("click"));
    assert.equal(controls.responses[0].name, remaining);
    const stack = captureModelSubmission(h.controller.state.draft, "edited-stack").inputs.stack;
    assert.deepEqual(stack.responses, [{name: "productivity", source: {collectionId: h.context.rasters[2].collectionId, itemId: h.context.rasters[2].itemId}}]);
    assert.equal(stack.predictors[0].name, "environment"); assert.equal(stack.categoricalPredictor, "land_class");
    controls.predictors[1].remove.dispatchEvent(new Event("click"));
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "removed-category"), /categorical/i);
    h.controller.destroy();
});

test("Habitat duplicates a large mixed stack and preserves unavailable private selections", async () => {
    const h = await fixture(), artifacts = fileManifest(), parentId = "2".repeat(32);
    artifacts.jobId = parentId;
    for (const file of artifacts.files) file.url = `/api/processing/jobs/${parentId}/artifacts/${file.artifactId}`;
    const parent = job({jobId: parentId, status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    h.controller.rememberRun(parent);
    h.context.rasters.push(...Array.from({length: 17}, (_, index) => ({collectionId: "eolab-mounted-geotiffs",
        itemId: `geotiff-${(index + 10).toString(16).padStart(24, "0")}`, label: `Response ${index + 1}`})));
    h.controller.refreshMapLayers(); chooseStack(h);
    const source = h.controller.state.draft.sources.find(value => value.kind === "runArtifact");
    const controls = h.view.setup.inputs.stack;
    edit(controls.responses[0].source, modelSourceKey(source));
    for (let index = 0; index < 17; index += 1) {
        controls.addResponse.dispatchEvent(new Event("click"));
        edit(controls.responses[index + 1].name, `response_${index + 1}`, "input");
        edit(controls.responses[index + 1].source, modelSourceKey(h.context.rasters[index + 5]));
    }
    await chooseVector(h, "area", h.context.vectors[0], "North");
    await chooseVector(h, "references", h.context.vectors[1], "South");
    edit(h.view.setup.inputs.habitat_mask.source, modelSourceKey(source));
    await h.controller.submit();
    assert.equal(h.requests.length, 1);
    const expected = structuredClone(h.requests[0].inputs);
    assert.equal(expected.stack.responses.length, 18);
    assert.deepEqual(expected.stack.responses[0].source, {kind: "runArtifact", jobId: parentId, artifactId: source.artifactId});
    assert.equal(new Set(expected.stack.responses.map(value => modelSourceKey(value.source))).size, 18);
    await h.controller.duplicateRun();
    h.context.vectors.forEach(value => { value.filter = {enabled: false, match: "all", rules: []}; });
    h.context.area.selectedBounds.west = -5; h.controller.refreshMapLayers(); h.controller.refreshMapArea();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "copied-stack").inputs, expected);
    assert.equal(h.requests.length, 1);
    h.controller.rememberRun({...parent, status: "expired", updatedAt: "2026-10-09T00:00:00Z",
        artifacts: {...artifacts, availability: "unavailable", files: []}});
    h.controller.refreshMapLayers();
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "expired-parent"), /available|expired/i);
    const draft = h.controller.state.draft;
    assert.equal(draft.inputs.stack.responses[0].raster.artifactId, source.artifactId);
    assert.equal(draft.inputs.habitat_mask.raster.artifactId, source.artifactId);
    edit(h.view.setup.inputs.stack.responses[0].source, modelSourceKey(h.context.rasters[2]));
    assert.equal(h.view.setup.run.disabled, true, "The unavailable optional mask must not become an omitted mask");
    edit(h.view.setup.inputs.habitat_mask.source, "");
    assert.equal(h.view.setup.run.disabled, false);
    assert.equal(captureModelSubmission(draft, "mask-omitted").inputs.habitat_mask, null);
    h.controller.destroy();
});

test("Habitat keeps raster reference and assessment choices separate through duplication and removal", async () => {
    const h = await fixture(); chooseStack(h);
    edit(h.view.setup.inputs.references.areaMode, "raster");
    edit(h.view.setup.inputs.references.maskRaster, modelSourceKey(h.context.rasters[3]));
    edit(h.view.setup.inputs.habitat_mask.source, modelSourceKey(h.context.rasters[4]));
    await h.controller.submit(); await h.controller.duplicateRun();
    assert.deepEqual(captureModelSubmission(h.controller.state.draft, "copied-masks").inputs, h.requests[0].inputs);
    h.context.rasters.pop(); h.controller.refreshMapLayers();
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "missing-mask"), /available|Map layers|mask/i);
    edit(h.view.setup.inputs.habitat_mask.source, "");
    assert.equal(h.view.setup.run.disabled, false);
    const inputs = captureModelSubmission(h.controller.state.draft, "without-mask").inputs;
    assert.deepEqual(inputs.references, h.requests[0].inputs.references); assert.equal(inputs.habitat_mask, null);
    const parentId = "2".repeat(32), artifacts = fileManifest();
    artifacts.jobId = parentId;
    for (const file of artifacts.files) file.url = `/api/processing/jobs/${parentId}/artifacts/${file.artifactId}`;
    const parent = job({jobId: parentId, status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    h.controller.rememberRun(parent); h.controller.refreshMapLayers();
    const privateReference = h.controller.state.draft.sources.find(source => source.kind === "runArtifact");
    const referenceControls = h.view.setup.inputs.references;
    edit(referenceControls.maskRaster, modelSourceKey(privateReference));
    assert.equal(h.jobs.tracked.has(parentId), true);
    edit(referenceControls.areaMode, "vector");
    assert.equal(h.jobs.tracked.has(parentId), false);
    edit(referenceControls.areaMode, "raster");
    assert.equal(h.jobs.tracked.has(parentId), true); assert.equal(h.view.setup.run.disabled, false);
    edit(referenceControls.areaMode, "vector");
    h.controller.rememberRun({...parent, status: "expired", updatedAt: "2026-10-09T00:00:00Z",
        artifacts: {...artifacts, availability: "unavailable", files: []}});
    edit(referenceControls.areaMode, "raster");
    assert.equal(h.controller.state.draft.inputs.references.maskRaster.artifactId, privateReference.artifactId);
    assert.equal(h.controller.state.draft.inputs.references.maskRaster.available, false);
    assert.equal(h.view.setup.run.disabled, true);
    assert.throws(() => captureModelSubmission(h.controller.state.draft, "expired-reference"), /available|expired/i);
    h.controller.destroy();
});

test("Habitat shows Reference similarity first and diagnostics under Details with an omitted mask", async () => {
    const h = await fixture(); chooseStack(h);
    edit(h.view.setup.inputs.references.areaMode, "raster");
    edit(h.view.setup.inputs.references.maskRaster, modelSourceKey(h.context.rasters[3]));
    const artifacts = fileManifest(), [primary, diagnostics, provenance] = artifacts.files;
    Object.assign(primary, {name: "reference_similarity", label: "Reference similarity", displayName: "Reference similarity · Habitat condition"});
    Object.assign(diagnostics, {name: "diagnostics", label: "Response diagnostics", displayName: "Response diagnostics · Habitat condition",
        filename: "diagnostics.zip", mediaType: "application/zip"});
    artifacts.files = [diagnostics, provenance, primary];
    h.api.getJob = async () => job({model: habitat, status: "ready", expiresAt: artifacts.expiresAt, artifacts,
        result: {...clipResult, name: primary.name, label: primary.label}});
    h.controller.outputState = (_jobId, _artifactId, file) => ({canShow: file.mediaType === "image/tiff"});
    await h.controller.submit();
    assert.equal(h.controller.state.error, "");
    const [result, details] = h.view.run.result.children;
    assert.equal(result.children[0].textContent, "Reference similarity");
    assert.equal(details.className, "models-details"); assert.equal(Boolean(details.open), false);
    assert.equal(result.children.at(-2).children[0].hidden, false);
    assert.equal(details.children[1].children[0].textContent, diagnostics.displayName);
    assert.equal(details.children[1].children.at(-2).children[0].hidden, true);
    assert.equal(details.children[1].children.at(-2).children[1].href, diagnostics.url);
    const savedInputs = h.view.run.inputsBody.children[0].children.map(node => node.textContent);
    assert.ok(savedInputs.includes("Predictor: environment")); assert.ok(savedInputs.includes("Observed response: productivity"));
    assert.ok(savedInputs.includes("Predictor: habitat_type (categorical)"));
    assert.deepEqual(savedInputs.slice(-2), ["Habitat assessment mask", "None"]);
    h.controller.destroy();
});
