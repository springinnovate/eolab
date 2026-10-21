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

test("a late outline response cannot redraw a superseded selection", async (t) => {
    let finish;
    t.mock.method(globalThis, "fetch", () => new Promise(resolve => { finish = resolve; }));
    const overlay = new VectorSelectionOverlay({}, { geoJSON() { assert.fail("Stale response was drawn"); } });
    const pending = overlay.load({ selection });
    overlay.clear();
    finish({ ok: true, json: async () => ({ geometry: { type: "FeatureCollection", features: [] } }) });
    await pending;
    assert.equal(overlay.layer, null);
});
