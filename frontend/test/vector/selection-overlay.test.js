import assert from "node:assert/strict";
import test from "node:test";
import { VectorSelectionOverlay } from "../../src/vector/selection-overlay.js";
import { vectorSelectionsEqual, validateVectorSelection } from "../../src/selected-area.js";

const selection = {
    collectionId: "eolab-mounted-vectors", itemId: "source", assetKey: "data",
    layerName: "polygons",
    filter: { enabled: true, match: "all", rules: [{ field: "NEXT_SINK", operator: "eq", value: 6060007000 }] },
};

test("selection identity ignores object property order and copies immutable rules", () => {
    const reordered = Object.fromEntries(Object.entries(selection).reverse());
    reordered.filter = { rules: [{ value: 6060007000, operator: "eq", field: "NEXT_SINK" }], match: "all", enabled: true };
    assert.equal(vectorSelectionsEqual(selection, reordered), true);
    const normalized = validateVectorSelection(reordered);
    reordered.filter.rules[0].value = 3;
    assert.equal(normalized.filter.rules[0].value, 6060007000);
    assert.equal(vectorSelectionsEqual(selection, reordered), false);
    assert.equal(Object.isFrozen(normalized.filter.rules[0]), true);
});

test("selection identity accepts only catalog identifiers and a filter", () => {
    assert.deepEqual(validateVectorSelection(selection), selection);
    assert.equal(vectorSelectionsEqual(selection, { ...selection, layerName: "other" }), false);
    assert.throws(() => validateVectorSelection({ ...selection, path: "/private/source" }), TypeError);
    assert.throws(() => validateVectorSelection({ ...selection, sourceSignature: "a".repeat(64) }), TypeError);
});

test("uploaded selection identity preserves its filter and distinguishes uploads", () => {
    const uploaded = { uploadId: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d", layerName: "areas", filter: selection.filter };
    const normalized = validateVectorSelection(uploaded);
    assert.deepEqual(normalized, uploaded);
    assert.equal(Object.isFrozen(normalized.filter.rules[0]), true);
    assert.equal(vectorSelectionsEqual(normalized, { filter: uploaded.filter, layerName: uploaded.layerName, uploadId: uploaded.uploadId }), true);
    assert.equal(vectorSelectionsEqual(normalized, { ...uploaded, uploadId: "146205e8-9eae-49fa-87cf-d55a715c44f4" }), false);
    assert.equal(vectorSelectionsEqual(normalized, selection), false);
    assert.throws(() => validateVectorSelection({ ...uploaded, path: "/private/source" }), TypeError);
});

test("uploaded outlines use the same browser owner as selection requests", async t => {
    const uploaded = { uploadId: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d", layerName: "areas", filter: selection.filter };
    let request;
    t.mock.method(globalThis, "fetch", async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({ geometry: { type: "FeatureCollection", features: [] } }));
    });
    const layer = { addTo() { return this; } };
    const overlay = new VectorSelectionOverlay({}, { geoJSON() { return layer; } });
    await overlay.load({ selection: uploaded });
    assert.equal(request.url, "/api/vector-sampling/outline");
    assert.equal(request.options.headers["X-EOLab-Uploads"], "1");
    assert.equal(request.options.credentials, "same-origin");
    assert.equal(request.options.cache, "no-store");
    assert.deepEqual(JSON.parse(request.options.body), uploaded);
    assert.equal(overlay.layer, layer);
});

test("a failed optional outline neither mutates nor invalidates the analysis descriptor", async (t) => {
    const area = Object.freeze({ selection: validateVectorSelection(selection) });
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("outline unavailable"); });
    const overlay = new VectorSelectionOverlay({}, { geoJSON() { assert.fail("No outline was returned"); } });
    await overlay.load(area);
    assert.equal(calls, 1);
    assert.equal(vectorSelectionsEqual(area.selection, selection), true);
    assert.equal(overlay.layer, null);
});

test("showing an area draws the filtered polygon and zooms to its original bounds on request", async t => {
    const ring = [[10, 30], [14, 30], [10, 32], [10, 30]];
    const geometry = {type: "FeatureCollection", features: [
        {type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [ring]}},
    ]};
    const fitted = [], drawn = [], removed = [];
    const map = {fitBounds: bounds => fitted.push(bounds), removeLayer: layer => removed.push(layer)};
    const layer = {addTo: () => layer};
    const overlay = new VectorSelectionOverlay(map, {geoJSON: (shape, options) => {
        drawn.push(shape); assert.equal(options.interactive, false); return layer;
    }});
    t.mock.method(globalThis, "fetch", async (_url, options) => {
        assert.deepEqual(JSON.parse(options.body), selection);
        return Response.json({geometry, bbox: [9, 29, 15, 33]});
    });
    await overlay.load({selection});
    assert.deepEqual(fitted, []);
    await overlay.load({selection}, {fitBounds: true});
    assert.deepEqual(fitted, [[[29, 9], [33, 15]]]);
    assert.deepEqual(drawn, [geometry, geometry]);
    overlay.clear();
    assert.deepEqual(removed, [layer, layer]);
    t.mock.method(globalThis, "fetch", async () => Response.json({geometry: {type: "FeatureCollection", features: []}, bbox: [0, 0, 0, 0]}));
    assert.equal(await overlay.load({selection}, {fitBounds: true}), undefined);
    assert.deepEqual(drawn, [geometry, geometry]);
    assert.equal(fitted.length, 1);
});

test("a late outline response cannot redraw a superseded selection", async (t) => {
    let finish;
    t.mock.method(globalThis, "fetch", () => new Promise(resolve => { finish = resolve; }));
    const calls = [];
    const layer = {addTo: () => layer};
    const map = {fitBounds: () => calls.push("zoom")};
    const overlay = new VectorSelectionOverlay(map, {geoJSON() { calls.push("draw"); return layer; }});
    const pending = overlay.load({ selection }, {fitBounds: true});
    overlay.clear();
    finish({ ok: true, json: async () => ({ geometry: { type: "FeatureCollection", features: [
        {type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [[[1, 2], [3, 2], [1, 4], [1, 2]]]}},
    ]}, bbox: [1, 2, 3, 4] }) });
    await pending;
    assert.deepEqual(calls, []);
    assert.equal(overlay.layer, null);
});
