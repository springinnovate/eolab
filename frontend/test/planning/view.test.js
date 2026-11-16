import assert from "node:assert/strict";
import test from "node:test";
import {PlanningView} from "../../src/planning/view.js";
import {SummaryControlDocument} from "../../test-support/processing/summary-document.js";

/** Return complete presentation state for the retained author form.
 * @return {Object} Editor state with a same-view AOI and parcel role.
 */
function editorState() {
    return {page: "editor", active: true, loading: false, saving: false, error: "", message: "", library: [], dirty: true,
        choices: [{key: "custom", label: "Restoration parcels", filterSummary: "Region is north", idFields: [{name: "parcel_id", type: "int"}]}],
        draft: {title: "<script>text only</script>", aoiKey: "custom", parcelKey: "custom", parcelIdField: "parcel_id",
            interventions: [{id: "first", label: "Reforestation"}, {id: "second", label: "Silvopasture"}]},
        idCheck: {phase: "idle", message: ""}};
}

test("real shell controls expose linked role filters and preserve intervention input focus while typing", () => {
    const document = new SummaryControlDocument(), view = new PlanningView(document), events = [];
    view.bind({onOpen: () => events.push("open"), onFilter: role => events.push(role), onIntervention: (...values) => events.push(values), onSave: () => events.push("save")});
    const state = editorState(); view.render(state, new Map());
    assert.equal(view.title.value, state.draft.title); assert.equal(view.aoi.value, "custom"); assert.equal(view.parcels.value, "custom");
    assert.equal(view.aoiSummary.textContent, "Region is north"); assert.equal(view.parcelSummary.textContent, "Region is north");
    view.openButton.dispatchEvent(new Event("click")); view.aoiFilter.dispatchEvent(new Event("click")); view.parcelFilter.dispatchEvent(new Event("click"));
    const input = view.interventionRows.get("first").input; input.focus(); input.value = "Native forest"; input.dispatchEvent(new Event("input"));
    state.draft.interventions[0].label = "Native forest"; view.render(state, new Map());
    assert.equal(view.interventionRows.get("first").input, input); assert.equal(document.activeElement, input);
    view.form.dispatchEvent(new Event("submit", {cancelable: true}));
    assert.deepEqual(events, ["open", "aoi", "parcels", ["first", "Native forest"], "save"]);
    assert.equal(input.getAttribute("aria-label"), "Intervention 1 name");
    view.destroy(); view.openButton.dispatchEvent(new Event("click")); assert.equal(events.length, 5);
});

test("unavailable saved layer is explicit and save progress disables editing", () => {
    const view = new PlanningView(new SummaryControlDocument()), state = editorState(); view.bind({});
    state.draft.parcelKey = "missing:parcel-layer";
    view.render(state, new Map([["parcel-layer", {customName: "Saved parcels", catalogItem: {id: "source"}}]]));
    assert.equal(view.parcels.value, "missing:parcel-layer"); assert.match(view.parcelSummary.textContent, /Saved parcels.*could not restore/);
    assert.equal(view.parcelFilter.disabled, true); assert.equal(view.idField.disabled, true);
    state.saving = true; state.error = "IDs are not unique"; view.render(state, new Map());
    assert.equal(view.saveButton.disabled, true); assert.equal(view.title.disabled, true);
    assert.equal(view.interventionRows.get("first").input.disabled, true); assert.equal(view.error.hidden, false);
    assert.equal(view.error.getAttribute("role"), "alert"); assert.equal(view.panel.getAttribute("aria-busy"), "true");
});

test("intervention limit disables Add with the limit explained in the form", () => {
    const view = new PlanningView(new SummaryControlDocument()), state = editorState(); view.bind({});
    state.draft.interventions = Array.from({length: 64}, (_, index) => ({id: String(index), label: `Choice ${index}`}));
    view.render(state, new Map()); assert.equal(view.addIntervention.disabled, true);
    state.draft.interventions.pop(); view.render(state, new Map()); assert.equal(view.addIntervention.disabled, false);
});
