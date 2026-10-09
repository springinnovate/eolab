import test from "node:test";
import assert from "node:assert/strict";
import { ModelsView, describeModelProgress } from "../../src/models/view.js";
import { createModelDraft } from "../../src/models/inputs.js";
import { SummaryControlDocument } from "../../test-support/processing/summary-document.js";
import { model, raster, area, invocation, job } from "../../test-support/models/fixtures.js";

/** Render the actual Models view over current application markup.
 * @return {Object} View, document, mutable state and action log.
 */
function fixture() {
    const doc = new SummaryControlDocument(); const actions = [];
    const view = new ModelsView(doc);
    const callbacks = Object.fromEntries(["Open", "Close", "Page", "Query", "Choose", "Edit", "Area", "UpdateArea", "Vector", "Search", "Submit", "Retry", "Refresh", "RefreshRuns", "More", "Run", "Cancel", "Duplicate", "Yaml"]
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
    h.state.runs = [job({status: "ready", expiresAt: "2099-01-01T00:00:00Z", result: {rows: [row], url: `/api/processing/jobs/${id}/result`, provenanceUrl: `/api/processing/jobs/${id}/provenance`}})];
    h.view.render(h.state);
    assert.equal(h.view.run.result.children[0].children[2].textContent.replaceAll(",", ""), row.value);
    assert.equal(h.view.run.cancel.hidden, true); assert.equal(h.view.run.duplicate.disabled, false);
    assert.match(h.view.run.details.run.href, /run-yaml$/);
    h.state.runs[0].status = "expired"; h.state.runs[0].result = null; h.view.render(h.state);
    assert.equal(h.view.run.result.children.length, 0); assert.match(h.view.run.status.textContent, /expired/);
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


test("area controls distinguish visible extent from a selection and prevent running without an area", () => {
    const h = fixture();
    const labels = h.view.setup.areaMode.children.map(option => option.textContent);
    assert.ok(labels.includes("Use visible map extent")); assert.ok(labels.includes("Copy selected analysis area"));
    h.state.draft.areaMode = "map"; h.state.draft.area = null;
    h.state.draft.selectionError = "No selected analysis area. Choose Use visible map extent.";
    h.view.render(h.state);
    assert.equal(h.view.setup.run.disabled, true); assert.equal(h.view.setup.updateArea.hidden, false);
    assert.match(h.view.setup.areaDescription.textContent, /No selected analysis area/);
    h.view.setup.updateArea.dispatchEvent(new Event("click")); assert.equal(h.actions.at(-1)[0], "UpdateArea");
    h.state.draft.areaMode = "viewport"; h.state.draft.area = area; h.state.draft.selectionError = "";
    h.view.render(h.state);
    assert.equal(h.view.setup.run.disabled, false); assert.match(h.view.setup.areaDescription.textContent, /Box/);
    assert.match(h.view.setup.mapHelp.textContent, /Panning|After changing the map/);
    h.state.draft.areaMode = "whole"; h.view.render(h.state); assert.equal(h.view.setup.updateArea.hidden, true);
});
