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
    const callbacks = Object.fromEntries(["Open", "Close", "Page", "Query", "Choose", "Edit", "Area", "Vector", "EditFilter", "Submit", "Retry", "Refresh", "RefreshRuns", "More", "Run", "Cancel", "Duplicate", "Yaml", "ShowOutput", "Renew", "Rename", "Delete", "ConfirmDelete", "KeepRun", "UndoDelete", "DismissDelete"]
        .map(name => [`on${name}`, value => actions.push([name, value])]));
    view.bind(callbacks);
    const state = {page: "setup", library: [model], query: "", draft: createModelDraft(model, {rasters: [raster], area}, "draft-1"),
        runs: [], selectedRun: null, pending: null, error: "", yaml: null};
    view.render(state); return {doc, view, state, actions};
}

test("separate Undo offers retain full names, action identity and the other notice's focus", () => {
    const h = fixture(), first = {jobId: "1".repeat(32), deletionId: "d".repeat(32),
        label: "Downstream beneficiaries for the full watershed and coastal communities · 2026_10_08_00_00_00"};
    const second = {jobId: "2".repeat(32), deletionId: "e".repeat(32), label: "Cuba population · 2026_10_08_00_00_01"};
    h.state.deletions = [first, second]; h.view.render(h.state);
    const firstNotice = h.view.deletionNotices.get(first.deletionId), secondNotice = h.view.deletionNotices.get(second.deletionId);
    assert.equal(h.view.elements.deletions.children.length, 2);
    for (const [deletion, notice] of [[first, firstNotice], [second, secondNotice]]) {
        assert.ok(notice.root.children[0].textContent.includes(deletion.label));
        assert.equal(notice.root.children[0].getAttribute("role"), "status");
        assert.equal(notice.undo.getAttribute("aria-label"), `Undo deletion of ${deletion.label}`);
        assert.equal(notice.dismiss.getAttribute("aria-label"), `Dismiss Undo for ${deletion.label}`);
    }
    secondNotice.undo.focus(); h.view.render(h.state);
    assert.equal(h.view.deletionNotices.get(second.deletionId).undo, secondNotice.undo);
    assert.equal(h.doc.activeElement, secondNotice.undo);
    firstNotice.dismiss.dispatchEvent(new Event("click")); secondNotice.undo.dispatchEvent(new Event("click"));
    assert.deepEqual(h.actions.slice(-2), [["DismissDelete", first.jobId], ["UndoDelete", second.jobId]]);
    h.state.deletions = [second]; h.view.render(h.state);
    assert.equal(h.view.deletionNotices.has(first.deletionId), false);
    assert.equal(h.doc.activeElement, secondNotice.undo);
    h.state.deletions = []; h.view.render(h.state);
    assert.equal(h.view.elements.deletions.children.length, 0); assert.equal(h.doc.activeElement, h.view.elements.heading);
});

test("Undo busy and failed-retry states preserve the named notice and its controls", () => {
    const h = fixture(), deletion = {jobId: "1".repeat(32), deletionId: "d".repeat(32), label: "Cuba population"};
    h.state.deletions = [deletion]; h.view.render(h.state);
    const notice = h.view.deletionNotices.get(deletion.deletionId);
    notice.undo.focus(); deletion.busy = true; h.view.render(h.state);
    assert.equal(notice.undo.disabled, true); assert.equal(notice.dismiss.disabled, true);
    assert.equal(notice.root.getAttribute("aria-busy"), "true");
    assert.ok(notice.root.children[0].textContent.includes(deletion.label));
    assert.match(notice.root.children[0].textContent, /Updating…/);
    deletion.busy = false; h.state.error = "Could not undo deletion: Offline"; h.view.render(h.state);
    assert.equal(h.view.deletionNotices.get(deletion.deletionId), notice);
    assert.equal(notice.undo.disabled, false); assert.equal(notice.dismiss.disabled, false);
    assert.notEqual(notice.root.getAttribute("aria-busy"), "true");
    assert.equal(h.doc.activeElement, notice.undo);
    assert.equal(h.view.elements.error.hidden, false);
    assert.equal(h.view.elements.error.textContent, h.state.error);
    notice.undo.dispatchEvent(new Event("click"));
    assert.deepEqual(h.actions.at(-1), ["UndoDelete", deletion.jobId]);
});

test("raster choices separate map layers from completed runs and explain unavailable results", () => {
    const h = fixture(), recipe = {...model, inputs: {...model.inputs, raster: {type: "raster", label: "Raster"}}};
    const result = {kind: "runArtifact", jobId: "1".repeat(32), artifactId: "a".repeat(32), label: "Cuba clip · Clipped raster", expiresAt: "2099-01-01T00:00:00Z"};
    h.state.draft = createModelDraft(recipe, {rasters: [raster, result], area}, "private-draft");
    h.state.draft.raster = result; h.state.nextCursor = "older";
    h.view.render(h.state);
    assert.deepEqual(h.view.setup.source.children.slice(1).map(group => group.label), ["Map layers", "Completed runs"]);
    assert.equal(h.view.setup.run.disabled, false);
    assert.equal(h.view.setup.resultActions.hidden, false);
    assert.equal(h.view.setup.olderResults.hidden, false);
    h.state.draft.raster.available = false; h.state.draft.sources[1].available = false; h.view.render(h.state);
    assert.equal(h.view.setup.run.disabled, true);
    assert.match(h.view.setup.source.children[2].children[0].textContent, /unavailable/);
    assert.equal(h.view.setup.source.children[2].children[0].disabled, true);
});

test("removed history entries leave the DOM while unrelated run cards retain their controls", () => {
    const h = fixture(), first = job(), second = job({jobId: "2".repeat(32), label: "Another run"});
    Object.assign(h.state, {page: "runs", runs: [first, second]}); h.view.render(h.state);
    const retained = h.view.runCards.get(second.jobId).button;
    h.state.runs = [second]; h.view.render(h.state);
    assert.equal(h.view.runCards.has(first.jobId), false);
    assert.equal(h.view.elements["runs-list"].children.length, 1);
    assert.equal(h.view.runCards.get(second.jobId).button, retained);
    h.state.runs = []; h.view.render(h.state);
    assert.equal(h.view.elements["runs-list"].children.length, 0);
    assert.match(h.view.elements["runs-status"].textContent, /No model runs/);
});

test("library and run cards use the same presentation and invoke their existing navigation", () => {
    const h = fixture(), run = job();
    Object.assign(h.state, {page: "library", runs: [run]}); h.view.render(h.state);
    const libraryCard = h.view.elements["library-items"].children[0];
    const libraryButton = libraryCard.children[0].children[0];
    const runCard = h.view.runCards.get(run.jobId);
    assert.equal(libraryCard.className, runCard.root.className);
    assert.equal(libraryButton.className, runCard.button.className);
    assert.equal(libraryButton.type, "button"); assert.equal(runCard.button.type, "button");
    assert.equal(libraryButton.getAttribute("aria-label"), `Set up ${model.title}`);
    libraryButton.dispatchEvent(new Event("click")); runCard.button.dispatchEvent(new Event("click"));
    assert.deepEqual(h.actions.slice(-2), [["Choose", model], ["Run", run.jobId]]);
    libraryButton.focus(); h.view.render(h.state);
    assert.equal(h.view.elements["library-items"].children[0], libraryCard);
    assert.equal(libraryCard.contains(h.doc.activeElement), true);
});

test("run renewal and deletion have explicit scope, confirmation and busy feedback", () => {
    const h = fixture(), artifacts = fileManifest();
    const ready = job({name: "Downstream beneficiaries for the full watershed and coastal communities",
        status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    Object.assign(h.state, {page: "run", runs: [ready], selectedRun: ready.jobId});
    h.view.render(h.state);
    assert.equal(h.view.run.renew.hidden, false);
    assert.equal(h.view.run.remove.hidden, false);
    assert.equal(h.view.run.confirmation.hidden, true);
    assert.equal(h.view.run.remove.parentNode, h.view.run.confirmation.parentNode);
    assert.ok(h.view.run.remove.className.split(" ").includes("models-action-danger"));
    assert.ok(h.view.run.confirm.className.split(" ").includes("models-action-danger"));
    assert.equal(h.view.run.keep.className.split(" ").includes("models-action-danger"), false);
    assert.equal(h.view.run.confirmation.getAttribute("role"), "group");
    assert.equal(h.view.run.confirmation.getAttribute("aria-describedby"), h.view.run.warning.id);
    assert.ok(h.view.run.warning.id);
    assert.equal(h.view.run.keep.textContent, "Keep run");
    assert.equal(h.view.run.confirm.textContent, "Delete run and results");
    h.view.run.remove.dispatchEvent(new Event("click")); assert.equal(h.actions.at(-1)[0], "Delete");
    h.state.deleteConfirmation = ready.jobId; h.view.render(h.state);
    assert.ok(h.view.run.warning.textContent.includes(ready.label));
    assert.match(h.view.run.warning.textContent, /all its result files/);
    assert.match(h.view.run.warning.textContent, /removed from the map/);
    assert.equal(h.view.run.remove.hidden, true); assert.equal(h.view.run.confirmation.hidden, false);
    assert.equal(h.state.runs[0], ready);
    h.view.focusDeleteConfirmation(); assert.equal(h.doc.activeElement, h.view.run.keep);
    const keep = h.view.run.keep, confirm = h.view.run.confirm;
    h.view.render(h.state); assert.equal(h.doc.activeElement, keep);
    keep.dispatchEvent(new Event("click")); assert.equal(h.actions.at(-1)[0], "KeepRun");
    confirm.focus(); confirm.dispatchEvent(new Event("click")); assert.equal(h.actions.at(-1)[0], "ConfirmDelete");
    h.state.actionBusy = true; h.view.render(h.state);
    assert.equal(h.view.run.confirm.disabled, true); assert.equal(h.view.run.renew.disabled, true);
    assert.equal(h.view.run.keep.disabled, true); assert.equal(h.view.run.confirm.textContent, "Please wait…");
    assert.equal(h.view.run.confirmation.getAttribute("aria-busy"), "true");
    assert.equal(h.view.run.confirm, confirm); assert.equal(h.view.run.keep, keep);
    Object.assign(h.state, {actionBusy: false, error: "Deletion could not be confirmed: Offline"}); h.view.render(h.state);
    assert.equal(h.view.run.confirm.disabled, false); assert.equal(h.view.run.keep.disabled, false);
    assert.equal(h.view.run.confirm.textContent, "Delete run and results");
    assert.notEqual(h.view.run.confirmation.getAttribute("aria-busy"), "true");
    assert.equal(h.view.run.confirmation.hidden, false); assert.equal(h.doc.activeElement, confirm);
    assert.equal(h.view.elements.error.textContent, h.state.error);
    Object.assign(h.state, {actionBusy: false, actionMessage: "Results kept until tomorrow."}); h.view.render(h.state);
    assert.equal(h.view.run.feedback.textContent, h.state.actionMessage);
    ready.status = "deleted"; h.view.render(h.state);
    assert.equal(h.view.run.confirmation.hidden, true); assert.equal(h.view.run.remove.hidden, true);
    assert.equal(h.view.run.renew.hidden, true); assert.equal(h.view.run.inputs.hidden, true);
});

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
    assert.equal(children[4].children[0].textContent, artifacts.files[2].displayName);
    for (let index = 0; index < 3; index++) assert.equal(children[index + 2].children[3].children[1].href, artifacts.files[index].url);
    h.state.runs[0].expiresAt = "2000-01-01T00:00:00Z";
    h.view.render(h.state);
    assert.equal(h.view.run.result.children.length, 0);
});

test("run controls and open details remain stable through progress updates", () => {
    const h = fixture(); h.state.page = "run"; h.state.selectedRun = job().jobId; h.state.runs = [job({status: "running"})];
    h.view.render(h.state); const cancel = h.view.run.cancel; cancel.focus(); h.view.run.details.root.open = true;
    h.state.runs[0].progress = {phase: "unfamiliar_stage", description: "Measuring habitat", completed: 3, total: 8, unit: "blocks"}; h.view.render(h.state);
    assert.equal(h.view.run.cancel, cancel); assert.equal(h.doc.activeElement, cancel); assert.equal(h.view.run.details.root.open, true);
    assert.equal(h.view.run.progress.value, 3); assert.equal(h.view.run.status.textContent, "Measuring habitat · 3 of 8 blocks");
    h.state.runs[0].status = "cancelling"; h.view.render(h.state); assert.equal(cancel.disabled, true);
});

test("the inline run name survives progress updates and closes only after a successful save", async () => {
    const h = fixture(), running = job({status: "running"});
    Object.assign(h.state, {page: "run", selectedRun: running.jobId, runs: [running]}); h.view.render(h.state);
    assert.equal(h.view.run.rename.getAttribute("aria-label"), "Rename run");
    assert.equal(h.view.run.rename.children[0].getAttribute("aria-hidden"), "true");
    h.view.run.rename.dispatchEvent(new Event("click"));
    const input = h.view.run.nameInput;
    assert.equal(input.value, running.name); assert.equal(h.doc.activeElement, input);
    input.value = "Cuba biomass";
    running.progress = {phase: "calculating", completed: 3, total: 8}; h.view.render(h.state);
    assert.equal(h.view.run.nameInput, input); assert.equal(input.value, "Cuba biomass"); assert.equal(h.doc.activeElement, input);
    h.view.handlers.onRename = async label => { assert.equal(label, "Cuba biomass"); return false; };
    await h.view.saveRunName(); assert.equal(h.view.run.nameEditor.hidden, false);
    h.state.actionBusy = true; h.state.renamingRun = running.jobId; h.view.render(h.state);
    assert.equal(input.disabled, true); assert.equal(h.view.run.saveName.textContent, "Saving…");
    h.state.actionBusy = false; h.view.handlers.onRename = async () => true;
    await h.view.saveRunName(); assert.equal(h.view.run.nameEditor.hidden, true); assert.equal(h.doc.activeElement, h.view.run.rename);
});

test("run and output headings show complete names with separate download actions", () => {
    const h = fixture(), artifacts = fileManifest();
    const ready = job({status: "ready", expiresAt: artifacts.expiresAt, result: clipResult, artifacts});
    Object.assign(h.state, {page: "run", selectedRun: ready.jobId, runs: [ready]}); h.view.render(h.state);
    const card = h.view.runCards.get(ready.jobId);
    assert.equal(card.button.textContent, ready.label); assert.equal(card.button.title, ready.label);
    assert.equal(card.button.getAttribute("aria-label"), ready.label); assert.match(card.status.textContent, /2026-10-08 00:00:00/);
    assert.equal(h.view.run.title.textContent, ready.label);
    assert.equal(h.view.elements.run.querySelectorAll("summary").some(summary => summary.textContent === "Full name"), false);
    for (const [index, file] of artifacts.files.entries()) {
        const fileCard = h.view.run.result.children[index + 2];
        assert.equal(fileCard.children[0].textContent, file.displayName);
        assert.equal(fileCard.children[2].textContent, file.filename);
        const download = fileCard.children[3].children[1];
        assert.equal(download.textContent, "Download");
        assert.equal(download.getAttribute("aria-label"), `Download ${file.displayName}`);
        assert.equal(download.href, file.url); assert.equal(download.download, "");
    }
    h.state.runs = [job({...ready, name: "Cuba biomass"})]; h.view.render(h.state);
    assert.equal(h.view.run.title.textContent, `Cuba biomass · ${ready.nameTimestamp}`);
});

test("run history shows distinct complete names and refreshes a renamed run without losing focus", () => {
    const h = fixture(), first = job({name: "Downstream ecosystem beneficiaries"});
    const second = job({jobId: "2".repeat(32), name: first.name, nameTimestamp: "2026_10_08_00_00_01"});
    Object.assign(h.state, {page: "runs", runs: [first, second]}); h.view.render(h.state);
    const firstButton = h.view.runCards.get(first.jobId).button;
    const secondButton = h.view.runCards.get(second.jobId).button;
    assert.equal(firstButton.textContent, first.label);
    assert.equal(secondButton.textContent, second.label);
    assert.notEqual(firstButton.textContent, secondButton.textContent);
    firstButton.focus();
    const renamed = job({...first, name: "Cuba biomass"});
    h.state.runs = [renamed, second]; h.view.render(h.state);
    assert.equal(h.view.runCards.get(first.jobId).button, firstButton);
    assert.equal(h.doc.activeElement, firstButton);
    assert.equal(firstButton.textContent, `Cuba biomass · ${first.nameTimestamp}`);
    assert.equal(firstButton.title, renamed.label);
    assert.equal(firstButton.getAttribute("aria-label"), renamed.label);
    firstButton.dispatchEvent(new Event("click"));
    assert.deepEqual(h.actions.at(-1), ["Run", first.jobId]);
});

test("file cards show independent opt-in map actions and display loading and map inclusion", () => {
    const h = fixture(), artifacts = fileManifest();
    const rasterFiles = artifacts.files.filter(file => file.mediaType === "image/tiff");
    const firstFile = rasterFiles[0];
    h.state.page = "run"; h.state.selectedRun = artifacts.jobId;
    h.state.runs = [job({status: "ready", expiresAt: artifacts.expiresAt, result: clipResult, artifacts})];
    h.state.outputPreviews = Object.fromEntries(rasterFiles.map(file => [file.artifactId, {canShow: true}]));
    h.view.render(h.state);
    for (const [index, file] of rasterFiles.entries()) {
        const card = h.view.run.result.children[index + 2], button = card.children[3].children[0];
        assert.equal(card.children[0].textContent, file.displayName);
        assert.equal(card.children[3].children[1].href, file.url);
        assert.equal(button.textContent, "Show on map");
        assert.equal(button.getAttribute("aria-label"), `Show on map: ${file.displayName}`);
        button.dispatchEvent(new Event("click"));
        assert.deepEqual(h.actions.at(-1), ["ShowOutput", file.artifactId]);
    }
    const card = h.view.run.result.children[2], button = card.children[3].children[0];
    const otherButton = h.view.run.result.children[3].children[3].children[0];
    button.focus();
    const actionCount = h.actions.length;
    h.state.outputPreviews[firstFile.artifactId].busy = true; h.view.render(h.state);
    assert.equal(h.view.run.result.children[2], card);
    assert.equal(h.view.run.result.contains(button), true);
    assert.equal(h.doc.activeElement, button);
    assert.equal(button.textContent, "Adding to map…"); assert.equal(button.getAttribute("aria-disabled"), "true");
    button.dispatchEvent(new Event("click")); assert.equal(h.actions.length, actionCount);
    assert.equal(otherButton.textContent, "Show on map"); assert.equal(otherButton.getAttribute("aria-disabled"), "false");
    h.state.outputPreviews[firstFile.artifactId] = {canShow: true, onMap: true}; h.view.render(h.state);
    assert.equal(button.textContent, "On map"); assert.equal(button.getAttribute("aria-disabled"), "true");
    assert.equal(h.doc.activeElement, button); assert.equal(h.view.run.result.contains(button), true);
    button.dispatchEvent(new Event("click")); assert.equal(h.actions.length, actionCount);
    assert.equal(otherButton.textContent, "Show on map"); assert.equal(otherButton.getAttribute("aria-disabled"), "false");
    const download = card.children[3].children[1]; download.focus();
    h.state.outputPreviews[firstFile.artifactId] = {canShow: true, error: "Could not add this output. Try again."}; h.view.render(h.state);
    assert.equal(h.doc.activeElement, download); assert.equal(h.view.run.result.contains(download), true);
    assert.equal(card.children[4].hidden, false); assert.match(card.children[4].textContent, /Try again/);
    assert.equal(button.getAttribute("aria-disabled"), "false");
    button.dispatchEvent(new Event("click")); assert.equal(h.actions.length, actionCount + 1);
    h.state.outputPreviews[firstFile.artifactId] = {canShow: false}; h.view.render(h.state);
    assert.equal(button.hidden, true); assert.equal(card.children[4].hidden, true);
    button.dispatchEvent(new Event("click")); assert.equal(h.actions.length, actionCount + 1);
});

test("model progress uses the supplied description without reading operation phases", () => {
    const progress = {description: "Measuring habitat", completed: 2, total: 5, unit: "regions"};
    Object.defineProperty(progress, "phase", {get: () => assert.fail("Models must not inspect operation phases.")});
    const run = job({model: {...model, id: "unfamiliar-habitat-model"}, status: "running", progress});
    assert.equal(describeModelProgress(run), "Measuring habitat · 2 of 5 regions");
    progress.completed = null; progress.unit = null;
    assert.equal(describeModelProgress(run), "Measuring habitat · 0 of 5 units");
    progress.total = null;
    assert.equal(describeModelProgress(run), "Measuring habitat…");
});

test("historical progress uses a generic running label while lifecycle states take precedence", () => {
    for (const progress of [{phase: "preparing_polygon_mask"}, {phase: "unfamiliar_stage", description: null}, {}]) {
        assert.equal(describeModelProgress(job({status: "running", progress})), "Running model…");
        assert.equal(describeModelProgress(job({status: "running", progress: {...progress, completed: 2, total: 5, unit: "blocks"}})), "Running model · 2 of 5 blocks");
    }
    for (const [status, expected] of Object.entries({queued: "Queued", cancelling: "Cancelling…", ready: "Ready", failed: "Failed",
        cancelled: "Cancelled", interrupted: "Interrupted", expired: "Results expired", deleted: "Deleted"})) {
        assert.equal(describeModelProgress(job({status, expiresAt: "2099-01-01T00:00:00Z", progress: {description: "Measuring habitat"}})), expected);
    }
    assert.equal(describeModelProgress(job({status: "ready", expiresAt: "2000-01-01T00:00:00Z", progress: {description: "Measuring habitat"}})), "Results expired");
});

test("run and history progress render descriptions as text and keep unknown totals indeterminate", () => {
    const h = fixture(), description = '<img src=x onerror="alert(1)">';
    const run = job({status: "running", progress: {phase: "unfamiliar_stage", description, completed: 1, total: 4, unit: "regions"}});
    Object.assign(h.state, {page: "run", selectedRun: run.jobId, runs: [run]});
    h.view.render(h.state);
    const status = h.view.run.status, historyStatus = h.view.runCards.get(run.jobId).status;
    assert.equal(status.textContent, `${description} · 1 of 4 regions`);
    assert.equal(historyStatus.textContent, `${description} · 1 of 4 regions · 2026-10-08 00:00:00`);
    for (const node of [status, historyStatus]) {
        assert.equal(node.children.length, 0);
        Object.defineProperty(node, "innerHTML", {set: () => assert.fail("Progress must remain literal text.")});
    }
    h.view.run.progress.setAttribute("value", "1");
    run.progress = {phase: "another_unfamiliar_stage", description: "Checking <strong>habitat</strong>"};
    h.view.render(h.state);
    assert.equal(h.view.run.status, status); assert.equal(h.view.runCards.get(run.jobId).status, historyStatus);
    assert.equal(status.textContent, "Checking <strong>habitat</strong>…");
    assert.equal(historyStatus.textContent, "Checking <strong>habitat</strong>… · 2026-10-08 00:00:00");
    assert.equal(h.view.run.progress.hidden, false); assert.equal(h.view.run.progress.getAttribute("value"), null);
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

test("clip results offer a GeoTIFF with dimensions and expire correctly", () => {
    const h = fixture(), id = job().jobId;
    h.state.page = "run"; h.state.selectedRun = id;
    h.state.invocation = {...invocation, model: {...clipModel, definition: clipModel}, parameters: {}};
    h.state.runs = [job({model: clipModel, status: "ready", expiresAt: "2099-01-01T00:00:00Z", result: clipResult})];
    h.view.render(h.state);
    assert.equal(h.view.run.result.children[0].children[0].textContent, "Clipped raster");
    assert.equal(h.view.run.result.children[0].children[1].textContent, clipResult.filename);
    assert.equal(h.view.run.result.children[0].children[2].textContent, "10 × 10 pixels · 90 valid pixels");
    const links = h.view.run.result.children[1].children;
    assert.equal(links[0].textContent, "Download GeoTIFF"); assert.equal(links[0].href, clipResult.url);
    h.state.runs[0].status = "expired"; h.view.render(h.state); assert.equal(h.view.run.result.children.length, 0);
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
