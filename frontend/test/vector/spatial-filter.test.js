import assert from "node:assert/strict";
import test from "node:test";
import {VectorFilterControls} from "../../src/vector/filter-controls.js";
import {SpatialFilterViews} from "../../src/vector/spatial-filter.js";
import {FakeRasterControlDocument} from "../../test-support/raster/fake-controls-document.js";

const firstId = "00000000-0000-4000-8000-000000000001";
const copyId = "00000000-0000-4000-8000-000000000002";
const all = {enabled: true, match: "all", rules: []};
const condition = layerId => ({operator: "intersects", layerId});
const filtered = value => ({...all, rules: [{field: "zone", operator: "eq", value}]});

test("a hidden duplicate follows its own filter and keeps its identity across renames", async () => {
    const source = {collectionId: "land", itemId: "zones", layerName: "zones", assetKey: "data"};
    const original = {key: "first", id: firstId, label: "Zones", selection: source, filter: filtered("west")};
    const copy = {...original, key: "copy", id: copyId, visible: false, filter: filtered("east")};
    const layers = [original, copy];
    const views = new SpatialFilterViews({layers: () => layers});
    const requested = {...all, rules: [condition(copyId)]};
    assert.deepEqual((await views.bind("parcels", requested)).rules[0].source, {...source, filter: filtered("east")});
    const updates = [];
    const targets = [{key: "parcels", filter: requested, update: (_, current) => updates.push(current)}];
    views.follow(targets);
    original.filter = filtered("north");
    copy.label = "Eastern zones";
    views.follow(targets);
    assert.equal(updates.length, 1);
    copy.filter = filtered("south");
    views.follow(targets);
    assert.equal(updates.length, 2);
    assert.equal(updates[0](), false);
    assert.deepEqual((await views.bind("parcels", requested)).rules[0].source.filter, filtered("south"));
    layers.pop();
    await assert.rejects(views.bind("parcels", requested), /unavailable/);
    const disabled = await views.bind("parcels", {...requested, enabled: false});
    assert.equal(disabled.rules[0].layerId, copyId);
    assert.equal(disabled.rules[0].source.polygonArea, null);
    original.filter = {...all, rules: [condition(firstId)]};
    await assert.rejects(views.bind("parcels", original.filter), /refer back/);
});

test("Add condition selects a filtered polygon view and keeps the choice after cancelling a draw", async () => {
    const doc = new FakeRasterControlDocument();
    const layers = [{id: firstId, label: "Zones"}, {id: copyId, label: "Zones copy", count: "2 of 5 features match"}];
    const target = {fields: [], label: "Parcels", filter: all, status: "", cancelPending() {},
        async apply(candidate) { this.filter = candidate; return candidate; }};
    let drawn = null;
    const editor = new VectorFilterControls({documentContext: doc, getTarget: () => target,
        getPolygonLayers: () => layers, drawPolygon: async () => drawn,
        inspection: {showFilter() {}, hideFilter() {}, updateLayerEditorName() {}}, setTimer: () => 1, clearTimer() {}});
    editor.open("parcels");
    editor.add.dispatchEvent(new Event("click"));
    assert.equal(editor.conditionChoices.hidden, false);
    assert.equal(editor.conditionChoices.children[0].disabled, true);
    editor.conditionChoices.children[1].dispatchEvent(new Event("click"));
    const picker = editor.polygonSelects[0].select;
    assert.deepEqual(picker.children.map(option => option.textContent), [
        "Choose a polygon layer", "Zones", "Zones copy (2 of 5 features match)", "Draw a polygon…"]);
    picker.value = copyId;
    picker.dispatchEvent(new Event("change"));
    picker.value = "draw";
    picker.dispatchEvent(new Event("change"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(picker.value, copyId);
    drawn = "00000000-0000-4000-8000-000000000003";
    layers.push({id: drawn, label: "My boundary"});
    picker.value = "draw";
    picker.dispatchEvent(new Event("change"));
    await new Promise(resolve => setImmediate(resolve));
    editor.close();
    assert.deepEqual(target.filter.rules, [condition(drawn)]);
    editor.destroy();
});
