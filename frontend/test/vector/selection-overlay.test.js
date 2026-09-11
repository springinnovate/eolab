import assert from "node:assert/strict";
import test from "node:test";
import { VectorSelectionOverlay } from "../../src/vector/selection-overlay.js";
import { catalogSelectionsEqual, validateCatalogSelection } from "../../src/selected-area.js";

const selection = {
    collectionId: "eolab-mounted-vectors", itemId: "source", assetKey: "data",
    layerName: "polygons", sourceSignature: "a".repeat(64),
    filter: { enabled: true, match: "all", rules: [{ field: "NEXT_SINK", operator: "eq", value: 6060007000 }] },
};

test("selection identity ignores object property order and copies immutable rules", () => {
    const reordered = Object.fromEntries(Object.entries(selection).reverse());
    reordered.filter = { rules: [{ value: 6060007000, operator: "eq", field: "NEXT_SINK" }], match: "all", enabled: true };
    assert.equal(catalogSelectionsEqual(selection, reordered), true);
    const normalized = validateCatalogSelection(reordered);
    reordered.filter.rules[0].value = 3;
    assert.equal(normalized.filter.rules[0].value, 6060007000);
    assert.equal(catalogSelectionsEqual(selection, reordered), false);
    assert.equal(Object.isFrozen(normalized.filter.rules[0]), true);
});

test("a failed optional outline neither mutates nor invalidates the analysis descriptor", async (t) => {
    const area = Object.freeze({ selection: validateCatalogSelection(selection) });
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => { calls += 1; throw new Error("outline unavailable"); });
    const overlay = new VectorSelectionOverlay({}, { geoJSON() { assert.fail("No outline was returned"); } });
    await overlay.load(area);
    assert.equal(calls, 1);
    assert.equal(catalogSelectionsEqual(area.selection, selection), true);
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
