import test from "node:test";
import assert from "node:assert/strict";
import { ModelsView, describeModelProgress } from "../../src/models/view.js";
import { createModelDraft } from "../../src/models/inputs.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";
import { model, raster, area, invocation, job, clipModel, clipResult, statisticsResult, fileManifest } from "../../test-support/models/fixtures.js";

/** Render the actual Models view over current application markup.
 * @return {Object} View, document, mutable state and action log.
 */
function fixture() {
    const doc = new SummaryControlDocument(); const actions = [];
    const view = new ModelsView(doc);
    const callbacks = Object.fromEntries(["Open", "Close", "Page", "Query", "Choose", "Edit", "Area", "Vector", "EditFilter", "Submit", "Retry", "Refresh", "RefreshRuns", "More", "Run", "Cancel", "Duplicate", "Yaml"]
        .map(name => [`on${name}`, value => actions.push([name, value])]));
    view.bind(callbacks);
    const state = {page: "setup", library: [model], query: "", draft: createModelDraft(model, {rasters: [raster], area}, "draft-1"),
        runs: [], selectedRun: null, pending: null, error: "", yaml: null};
    view.render(state); return {doc, view, state, actions};
}

test("all model controls exist in production markup and progress retains field focus", () => {
    const h = fixture(); const field = h.view.setup.parameters.summary;
    field.value = "mean(a)"; field.focus();
    h.state.runs = [job({status: "running", progress: {phase: "calculating", completed: 5, total: 10, unit: "blocks"}})];
    h.view.render(h.state);
    assert.equal(h.doc.activeElement, field); assert.equal(field.value, "mean(a)"); assert.equal(h.view.setup.parameters.summary, field);
    assert.match(h.view.setup.areaDescription.textContent, /Box/);
    assert.match(h.view.setup.areaDescription.textContent, /W 0\.0000°/);
});

test("ready results show exact integer values and safe CSV/provenance/YAML links", () => {
    const h = fixture(); const id = job().jobId;
    const row = {label: "Total", expression: "sum(a)", state: "ok", value: "9007199254740993", valueType: "integer", aggregates: []};
    h.state.page = "run"; h.state.selectedRun = id; h.state.invocation = invocation;
    h.state.runs = [job({status: "ready", expiresAt: "2099-01-01T00:00:00Z", result: {...statisticsResult, rows: [row], url: `/api/processing/jobs/${id}/result`, provenanceUrl: `/api/processing/jobs/${id}/provenance`}})];
    h.view.render(h.state);
    assert.equal(h.view.run.result.children[1].children[2].textContent.replaceAll(",", ""), row.value);
    assert.equal(h.view.run.cancel.hidden, true); assert.equal(h.view.run.duplicate.disabled, false);
    assert.match(h.view.run.details.run.href, /run-yaml$/);
    h.state.runs[0].status = "expired"; h.state.runs[0].result = null; h.view.render(h.state);
    assert.equal(h.view.run.result.children.length, 0); assert.match(h.view.run.status.textContent, /expired/);
});

test("run files distinguish coverage from results and replace legacy duplicate links", () => {
    const h = fixture(), artifacts = fileManifest();
    h.state.page = "run"; h.state.selectedRun = artifacts.jobId;
    h.state.runs = [job({status: "ready", expiresAt: artifacts.expiresAt, result: clipResult, artifacts})];
    h.view.render(h.state);
    const children = h.view.run.result.children;
    assert.equal(children.length, 5); // Primary scientific card, heading, three file cards.
    assert.equal(children[1].textContent, "Files from this run");
    assert.match(children[3].children[1].textContent, /Intermediate result/);
    assert.equal(children[4].children[0].textContent, "Download Calculation details");
    for (let index = 0; index < 3; index++) assert.equal(children[index + 2].children[0].href, artifacts.files[index].url);
    h.state.runs[0].expiresAt = "2000-01-01T00:00:00Z";
    h.view.render(h.state);
    assert.equal(h.view.run.result.children.length, 0);
});

test("run controls and open details remain stable through progress updates", () => {
    const h = fixture(); h.state.page = "run"; h.state.selectedRun = job().jobId; h.state.runs = [job({status: "running"})];
    h.view.render(h.state); const cancel = h.view.run.cancel; cancel.focus(); h.view.run.details.root.open = true;
    h.state.runs[0].progress = {phase: "calculating", completed: 3, total: 8, unit: "blocks"}; h.view.render(h.state);
    assert.equal(h.view.run.cancel, cancel); assert.equal(h.doc.activeElement, cancel); assert.equal(h.view.run.details.root.open, true);
    assert.equal(h.view.run.progress.value, 3); assert.match(h.view.run.status.textContent, /3 of 8 blocks/);
    h.state.runs[0].status = "cancelling"; h.view.render(h.state); assert.equal(cancel.disabled, true);
});

test("stage feedback covers terminal states and an unknown total stays indeterminate", () => {
    for (const status of ["queued", "running", "cancelling", "ready", "failed", "cancelled", "interrupted", "expired"])
        assert.ok(describeModelProgress(job({status})));
    assert.equal(describeModelProgress(job({status: "running", progress: {phase: "preparing_polygon_mask"}})), "Creating the analysis mask…");
});


test("area choices use histogram terminology and follow the map without Update controls", () => {
    const h = fixture();
    const labels = () => h.view.setup.areaMode.children.map(option => option.textContent);
    assert.deepEqual(labels(), ["Entire raster", "Visible map area", "Sampling area", "Vector layer"]);
    assert.equal(h.view.setup.bounds, undefined); assert.equal(h.view.setup.updateArea, undefined);
    assert.match(h.view.setup.mapHelp.textContent, /sampling area shown in Raster distributions/);
    h.state.draft.areaOrigin = "run"; h.state.draft.areaMode = "captured"; h.view.render(h.state);
    assert.equal(labels().at(-1), "Area from original run"); assert.match(h.view.setup.mapHelp.textContent, /exact area from the original run/);
    h.state.draft = createModelDraft(model, {rasters: [raster]}, "no-selected-area"); h.view.render(h.state);
    assert.ok(labels().includes("Sampling area"));
    h.state.draft.areaMode = "viewport"; h.state.draft.area = area; h.view.render(h.state);
    assert.equal(h.view.setup.run.disabled, false); assert.match(h.view.setup.mapHelp.textContent, /Pan or zoom/);
    h.state.draft.area = null; h.view.render(h.state); assert.equal(h.view.setup.run.disabled, true);
});


test("vector setup offers Edit filter and describes the predicate belonging to this run", () => {
    const h = fixture(); h.state.draft.areaMode = "vector"; h.view.render(h.state);
    assert.equal(h.view.setup.editFilter.disabled, true);
    const source = {collectionId: "eolab-mounted-vectors", itemId: "basins", label: "Basins", filter: {enabled: true, match: "all", rules: [{field: "BASIN", operator: "eq", value: "North"}]}};
    h.state.draft.vectors = [source]; h.state.draft.vectorKey = JSON.stringify([source.collectionId, source.itemId]);
    h.state.draft.area = null; h.view.render(h.state);
    assert.equal(h.view.setup.editFilter.disabled, false); assert.match(h.view.setup.filterDescription.textContent, /BASIN equals "North"/);
    h.view.setup.editFilter.dispatchEvent(new Event("click")); assert.equal(h.actions.at(-1)[0], "EditFilter");
    h.state.draft.filterOpening = true; h.state.draft.filterEditing = true; h.view.render(h.state);
    assert.equal(h.view.setup.editFilter.disabled, true); assert.equal(h.view.setup.editFilter.textContent, "Opening filter…");
});


test("setup offers only map layers and explains how to add a missing raster", () => {
    const h = fixture();
    assert.equal(h.view.setup.rasterSearch, undefined); assert.equal(h.view.setup.vectorSearch, undefined);
    h.state.draft = createModelDraft(model, {}, "empty-map"); h.view.render(h.state);
    assert.match(h.view.setup.reason.textContent, /Add a raster to Map layers/);
    assert.equal(h.view.setup.run.disabled, true);
});


test("vector checks leave Edit filter available and show selection errors next to the count", () => {
    const h = fixture(); const draft = h.state.draft;
    draft.areaMode = "vector"; draft.vectorKey = '["vectors","countries"]';
    draft.vectors = [{collectionId: "vectors", itemId: "countries", label: "Countries"}];
    draft.area = null; draft.selecting = true; h.view.render(h.state);
    assert.equal(h.view.setup.editFilter.textContent, "Edit filter");
    assert.equal(h.view.setup.editFilter.disabled, false);
    assert.match(h.view.setup.selectedCount.textContent, /Checking selected features/);
    assert.equal(h.view.setup.vectorStatus.getAttribute("role"), "status");
    assert.match(h.view.setup.vectorStatus.textContent, /You can edit the filter while this check runs/);
    assert.equal(h.view.setup.run.disabled, true);
    draft.selecting = false; draft.selectionError = "Could not read this layer."; h.view.render(h.state);
    assert.equal(h.view.setup.vectorStatus.textContent, "Could not read this layer.");
    assert.equal(h.view.setup.editFilter.textContent, "Edit filter");
    assert.equal(h.view.setup.editFilter.disabled, false);
    assert.equal(h.view.setup.areaDescription.hidden, true);
});


test("selected features have one prominent count and predicate; removed layers keep their error visible", () => {
    const h = fixture(), draft = h.state.draft;
    const filter = {enabled: true, match: "all", rules: [{field: "NAME", operator: "eq", value: "Cuba"}]};
    draft.areaMode = "vector"; draft.vectorKey = '["vectors","countries"]';
    draft.vectors = [{collectionId: "vectors", itemId: "countries", label: "Countries", filter}];
    draft.area = {kind: "catalogSelection", selection: {filter}}; draft.vectorInfo = {matched: 1, total: 253};
    h.view.render(h.state);
    assert.equal(h.view.setup.selectedCount.textContent, "1 of 253 features selected");
    assert.equal(h.view.setup.filterDescription.textContent, 'NAME equals "Cuba"');
    assert.equal(h.view.setup.areaDescription.hidden, true);
    draft.filterEditing = true; h.view.render(h.state);
    assert.equal(h.view.getVectorFilterHost().hidden, false);
    assert.equal(h.view.setup.editFilter.getAttribute("aria-expanded"), "true");
    assert.equal(h.view.setup.run.disabled, true);
    draft.vectors = []; draft.vectorKey = ""; draft.area = null;
    draft.selectionError = "Add the vector layer to Map layers, or choose another layer."; h.view.render(h.state);
    assert.equal(h.view.setup.selectionCard.hidden, true);
    assert.equal(h.view.setup.areaDescription.hidden, false);
    assert.equal(h.view.setup.areaDescription.textContent, draft.selectionError);
});


test("clip setup shows supported areas and no summary formula", () => {
    const h = fixture(); h.state.draft = createModelDraft(clipModel, {rasters: [raster], area}, "clip"); h.view.render(h.state);
    assert.deepEqual(h.view.setup.areaMode.children.map(option => option.textContent), ["Visible map area", "Sampling area", "Vector layer"]);
    assert.deepEqual(h.view.setup.parameters, {}); assert.equal(h.view.setup.run.disabled, false);
});

test("clip results offer a GeoTIFF with dimensions, expire correctly and retain clip progress phases", () => {
    const h = fixture(), id = job().jobId;
    h.state.page = "run"; h.state.selectedRun = id;
    h.state.invocation = {...invocation, model: {...clipModel, definition: clipModel}, parameters: {}};
    h.state.runs = [job({model: clipModel, status: "ready", expiresAt: "2099-01-01T00:00:00Z", result: clipResult})];
    h.view.render(h.state);
    assert.equal(h.view.run.result.children[0].children[0].textContent, "Clipped raster");
    assert.equal(h.view.run.result.children[0].children[2].textContent, "10 × 10 pixels · 90 valid pixels");
    const links = h.view.run.result.children[1].children;
    assert.equal(links[0].textContent, "Download GeoTIFF"); assert.equal(links[0].href, clipResult.url);
    h.state.runs[0].status = "expired"; h.view.render(h.state); assert.equal(h.view.run.result.children.length, 0);
    for (const phase of ["clipping", "creating_cog", "validating", "checksumming"])
        assert.doesNotMatch(describeModelProgress(job({status: "running", progress: {phase}})), /Preparing calculation/);
});

test("result cards use captured YAML labels for unfamiliar models", () => {
    for (const output of [clipResult, statisticsResult]) {
        const h = fixture(); h.state.page = "run"; h.state.selectedRun = job().jobId;
        h.state.runs = [job({model: {...model, id: "habitat-model"}, status: "ready", expiresAt: "2099-01-01T00:00:00Z",
            result: {...output, name: "habitat", label: "Habitat output <script>"}})];
        h.view.render(h.state);
        const first = h.view.run.result.children[0];
        assert.equal(output.kind === "raster" ? first.children[0].textContent : first.textContent, "Habitat output <script>");
    }
});
