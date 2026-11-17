import assert from "node:assert/strict";
import test from "node:test";
import {PlanningController} from "../../src/planning/controller.js";

const TOOL_ID = "10000000-0000-4000-8000-000000000001";
const LAYER_ID = "20000000-0000-4000-8000-000000000001";
const INTERVENTION_ID = "30000000-0000-4000-8000-000000000001";

/** Return an externally completed operation for race tests. @return {{promise:Promise<unknown>,resolve:Function,reject:Function}} Deferred operation. */
function deferred() {
    let resolve, reject;
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
    return {promise, resolve, reject};
}

/** Create a portable custom vector definition with ordinary filter state.
 * @param {string} [item="parcels"] Catalog item. @return {Object} Portable definition.
 */
function definition(item = "parcels") {
    return {catalogItem: {collection: "local", id: item}, isCustom: true, visible: true, opacity: 1,
        style: {kind: "vector", definition: {}}, filter: {enabled: false, match: "all", rules: []}};
}

/** Connect the real controller to small map/API boundary fakes.
 * @param {Object} [apiOverrides={}] Deferred or failing API operations. @return {Object} Mutable map, controller and observations.
 */
function fixture(apiOverrides = {}) {
    const definitions = new Map([["view-a", definition()], ["view-b", definition()]]);
    let choices = [...definitions.keys()].map(key => ({key, label: key,
        source: {collectionId: "local", itemId: "parcels"}, idFields: [{name: "parcel_id", type: "int"}, {name: "code", type: "str"}], filterSummary: "All parcels"}));
    const submissions = [], filters = [], restores = [];
    const view = {bind(callbacks) { this.callbacks = callbacks; }, render(state) { this.state = structuredClone(state); }, focusTitle() {}, focusLastIntervention() {}, destroy() {}};
    const record = {id: TOOL_ID, revision: 1, title: "Watershed planning", createdAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:00:00Z",
        layers: [{id: LAYER_ID, definition: definition()}], aoiLayerId: LAYER_ID, parcelLayerId: LAYER_ID,
        parcelIdField: "parcel_id", interventions: [{id: INTERVENTION_ID, label: "Reforestation"}]};
    const api = {list: async () => [], get: async () => structuredClone(record),
        create: async document => { submissions.push(structuredClone(document)); return {...record, ...document}; },
        update: async (id, revision, document) => { submissions.push({id, revision, document: structuredClone(document)}); return {...record, ...document, revision: revision + 1}; },
        validateIds: async () => ({featureCount: 12}), ...apiOverrides};
    let nextId = 0;
    const controller = new PlanningController({api, view, getLayerChoices: () => choices,
        exportLayer: key => structuredClone(definitions.get(key)),
        restoreLayers: async (layers, isCurrent) => {
            restores.push(layers); assert.equal(isCurrent(), true);
            return layers.map((layer, index) => {
                const key = `restored-${index}`;
                definitions.set(key, structuredClone(layer.definition));
                choices.push({...choices[0], key});
                return {id: layer.id, key, error: null};
            });
        }, editLayerFilter: key => filters.push(key), onOpen() {}, onClose() {},
        newId: () => `40000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`});
    return {controller, view, api, definitions, submissions, filters, restores, record,
        setChoices(value) { choices = value; }, get choices() { return choices; }};
}

/** Fill a valid new tool through its author actions.
 * @param {PlanningController} controller Editor. @param {string} [parcelKey="view-a"] Parcel view. @return {void}
 */
function configure(controller, parcelKey = "view-a") {
    controller.newTool(); controller.editTitle("Restoration choices"); controller.chooseLayer("aoi", "view-a");
    controller.chooseLayer("parcels", parcelKey); controller.chooseIdField("parcel_id"); controller.addIntervention();
    controller.editIntervention(controller.state.draft.interventions[0].id, "Reforestation");
}

test("same view in both roles saves once, keeps intervention IDs and reads live filters at save", async () => {
    const f = fixture(); configure(f.controller);
    const interventionId = f.controller.state.draft.interventions[0].id;
    f.controller.editIntervention(interventionId, "Native reforestation");
    f.definitions.get("view-a").filter = {enabled: true, match: "all", rules: [{field: "code", operator: "eq", value: "north"}]};
    f.controller.refreshMapLayers(); await f.controller.save();
    const saved = f.submissions[0];
    assert.equal(saved.layers.length, 1); assert.equal(saved.aoiLayerId, saved.parcelLayerId);
    assert.deepEqual(saved.layers[0].definition, f.definitions.get("view-a"));
    assert.deepEqual(saved.interventions, [{id: interventionId, label: "Native reforestation"}]);
    assert.equal(JSON.stringify(saved).includes("view-a"), false); assert.equal(f.view.state.dirty, false);
    f.controller.openFilter("aoi"); f.controller.openFilter("parcels"); assert.deepEqual(f.filters, ["view-a", "view-a"]);
});

test("different custom views of one source retain separate definitions and role IDs", async () => {
    const f = fixture(); configure(f.controller, "view-b");
    f.definitions.get("view-b").filter.enabled = true;
    await f.controller.save(); const saved = f.submissions[0];
    assert.equal(saved.layers.length, 2); assert.notEqual(saved.aoiLayerId, saved.parcelLayerId);
    assert.equal(saved.layers[0].definition.filter.enabled, false); assert.equal(saved.layers[1].definition.filter.enabled, true);
});

test("reopen restores same-role layer once and update uses saved identities and revision", async () => {
    const f = fixture(); await f.controller.loadTool(TOOL_ID);
    assert.equal(f.restores[0].length, 1); assert.equal(f.controller.state.draft.aoiKey, "restored-0");
    assert.equal(f.controller.state.draft.parcelKey, "restored-0"); assert.equal(f.view.state.dirty, false);
    f.controller.editIntervention(INTERVENTION_ID, "Silvopasture"); await f.controller.save();
    const update = f.submissions[0]; assert.equal(update.id, TOOL_ID); assert.equal(update.revision, 1);
    assert.equal(update.document.aoiLayerId, LAYER_ID); assert.equal(update.document.layers.length, 1);
    assert.deepEqual(update.document.interventions, [{id: INTERVENTION_ID, label: "Silvopasture"}]);
});

test("removed layer remains unavailable and prevents saving instead of substituting another view", async () => {
    const f = fixture(); configure(f.controller); f.setChoices(f.choices.filter(choice => choice.key !== "view-a"));
    f.controller.refreshMapLayers(); await f.controller.save();
    assert.equal(f.controller.state.draft.parcelKey, "view-a"); assert.equal(f.submissions.length, 0);
    assert.match(f.view.state.error, /available custom layers/);
});

test("ID validation survives filter edits but ignores late results after changing original field", async () => {
    const checks = [deferred(), deferred()]; let calls = 0;
    const f = fixture({validateIds: () => checks[calls++].promise}); configure(f.controller);
    const first = f.controller.checkIds(); f.definitions.get("view-a").filter.enabled = true; f.controller.refreshMapLayers();
    checks[0].resolve({featureCount: 100}); await first; assert.equal(f.view.state.idCheck.phase, "valid");
    const second = f.controller.checkIds(); f.controller.chooseIdField("code");
    checks[1].resolve({featureCount: 100}); await second; assert.equal(f.view.state.idCheck.phase, "idle");
    assert.equal(f.controller.state.draft.parcelIdField, "code");
});

test("new draft and returning to library both ignore a late tool response", async () => {
    for (const navigation of ["newTool", "showLibrary"]) {
        const response = deferred(), f = fixture({get: () => response.promise});
        const loading = f.controller.loadTool(TOOL_ID); f.controller[navigation]();
        response.resolve(f.record); await loading;
        assert.equal(f.restores.length, 0); assert.equal(f.view.state.loading, false);
        assert.equal(f.view.state.page, navigation === "newTool" ? "editor" : "library");
        assert.equal(f.view.state.draft?.id ?? null, null);
    }
});

test("new draft invalidates an in-progress map restoration and ignores its late bindings", async () => {
    const restoration = deferred(), f = fixture(); let isCurrent;
    f.controller.restoreLayers = (_layers, current) => { isCurrent = current; return restoration.promise; };
    const loading = f.controller.loadTool(TOOL_ID); await Promise.resolve(); assert.equal(isCurrent(), true);
    f.controller.newTool(); assert.equal(isCurrent(), false);
    restoration.resolve([{id: LAYER_ID, key: "late-view", error: null}]); await loading;
    assert.equal(f.view.state.draft.id, null); assert.equal(f.view.state.draft.aoiKey, "");
    assert.equal(f.controller.bindings.has("late-view"), false);
});

test("revision conflict preserves draft edits and saved revision for an explicit recovery", async () => {
    const f = fixture({update: async () => { throw Object.assign(new Error("This tool changed elsewhere."), {status: 409}); }});
    await f.controller.loadTool(TOOL_ID); f.controller.editTitle("My unsaved edits"); await f.controller.save();
    assert.equal(f.view.state.draft.title, "My unsaved edits"); assert.equal(f.view.state.draft.revision, 1);
    assert.equal(f.view.state.dirty, true); assert.equal(f.view.state.saving, false); assert.match(f.view.state.error, /changes remain here/);
});

test("map filter edit during save stays dirty against the version actually saved", async () => {
    const pending = deferred(); let submitted;
    const f = fixture({create: document => { submitted = document; return pending.promise; }}); configure(f.controller);
    const saving = f.controller.save(); f.definitions.get("view-a").filter.enabled = true; f.controller.refreshMapLayers();
    pending.resolve({...f.record, ...submitted}); await saving;
    assert.equal(f.view.state.dirty, true); assert.equal(submitted.layers[0].definition.filter.enabled, false);
    assert.equal(f.controller.buildDocument().layers[0].definition.filter.enabled, true);
});

test("restoration failure retains saved choices and reports the failure", async () => {
    const f = fixture(); f.controller.restoreLayers = async layers => layers.map(layer => ({id: layer.id, key: null, error: "Source unavailable"}));
    await f.controller.loadTool(TOOL_ID); assert.equal(f.view.state.draft.aoiKey, `missing:${LAYER_ID}`);
    assert.equal(f.view.state.draft.parcelKey, `missing:${LAYER_ID}`); assert.match(f.view.state.error, /Source unavailable/);
    await f.controller.save(); assert.equal(f.submissions.length, 0);
});

test("successful save ignores server object-key ordering but still notices changed filter values", async () => {
    const f = fixture({create: async document => {
        const shuffled = JSON.parse(JSON.stringify(document, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).reverse()) : value));
        return {...f.record, ...shuffled};
    }});
    configure(f.controller); await f.controller.save(); assert.equal(f.view.state.dirty, false);
    f.definitions.get("view-a").filter.enabled = true; f.controller.refreshMapLayers(); assert.equal(f.view.state.dirty, true);
});
