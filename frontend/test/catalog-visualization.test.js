import assert from "node:assert/strict";
import test from "node:test";

import { CatalogVisualizationCoordinator } from "../src/catalog-visualization.js";

const RASTER_ITEM = Object.freeze({
    collection: "eolab-mounted-geotiffs",
    id: "geotiff-a",
    assets: { data: {} },
});
const VECTOR_ITEM = Object.freeze({
    collection: "eolab-mounted-vectors",
    id: "geopackage-a",
    properties: {},
});

test("catalog visualization routes explicit source kinds to owned adapters", async () => {
    const calls = [];
    const viewer = {
        show(item) {
            calls.push(["show-raster", item]);
            return Promise.resolve("raster");
        },
        stage(item, presentation) {
            calls.push(["stage-raster", item, presentation]);
            return Promise.resolve("staged raster");
        },
    };
    const mapLayerController = {
        show(item, adapter) {
            calls.push(["show-vector", item, adapter]);
            return Promise.resolve("vector");
        },
        stage(item, adapter, presentation) {
            calls.push(["stage-vector", item, adapter, presentation]);
            return Promise.resolve("staged vector");
        },
        contains() { return true; },
        remove(item) { calls.push(["remove", item]); },
    };
    const vectorMapLayerAdapter = { label: "vector adapter" };
    const coordinator = new CatalogVisualizationCoordinator(
        viewer,
        mapLayerController,
        vectorMapLayerAdapter,
        async (item) => ({ kind: "vector", item })
    );

    assert.equal(await coordinator.prepare(RASTER_ITEM), RASTER_ITEM);
    assert.equal((await coordinator.prepare(VECTOR_ITEM)).kind, "vector");
    assert.equal(await coordinator.show(RASTER_ITEM), "raster");
    assert.equal(await coordinator.show(VECTOR_ITEM), "vector");
    const presentation = { visible: false, opacity: 0.4 };
    assert.equal(
        await coordinator.stage(RASTER_ITEM, presentation),
        "staged raster"
    );
    assert.equal(
        await coordinator.stage(VECTOR_ITEM, presentation),
        "staged vector"
    );
    assert.equal(coordinator.contains(VECTOR_ITEM), true);
    coordinator.remove(VECTOR_ITEM);
    assert.deepEqual(calls, [
        ["show-raster", RASTER_ITEM],
        ["show-vector", VECTOR_ITEM, vectorMapLayerAdapter],
        ["stage-raster", RASTER_ITEM, presentation],
        ["stage-vector", VECTOR_ITEM, vectorMapLayerAdapter, presentation],
        ["remove", VECTOR_ITEM],
    ]);
});

test("raster source revisions come from neutral Catalog source metadata", () => {
    const coordinator = new CatalogVisualizationCoordinator({}, {}, {});
    const signature = { size: 42, mtime_ns: 99 };
    const item = {
        ...RASTER_ITEM,
        assets: { data: { "eolab:source": { source_signature: signature } } },
    };

    assert.equal(coordinator.sourceRevision(item), signature);
});

test("remote collections are not reinterpreted as mounted vectors", () => {
    const coordinator = new CatalogVisualizationCoordinator({}, {}, {});
    const remoteItem = {
        collection: "remote-vectors",
        id: "remote-object",
        assets: { data: { href: "https://example.invalid/secret.geojson" } },
    };

    assert.equal(coordinator.describe(remoteItem), null);
    assert.throws(() => coordinator.show(remoteItem), /no map visualization adapter/);
});

test("Undo re-fetches the source and applies appearance and filtering before attachment", async () => {
    const calls = [];
    let discarded = false;
    const record = { entry: { label: "Fresh title" }, adapter: {
        restoreRemovedStyle: async (_record, style) => { calls.push(["style", style]); },
        applyFilterState: async (_record, filter) => { calls.push(["filter", filter]); },
        discardStaged: () => { discarded = true; },
    } };
    const staged = { record, layer: {} };
    const coordinator = new CatalogVisualizationCoordinator({}, {
        stage: async () => { calls.push(["stage"]); return staged; },
        restoreStagedLayer: (layer, index) => { calls.push(["attach", index]); assert.equal(layer, staged); },
    }, {}, async item => { calls.push(["assess"]); return item; });
    const snapshot = { item: VECTOR_ITEM, label: "My original label", style: { color: "red" }, filter: { enabled: true }, index: 2 };
    await coordinator.restoreRemovedLayer(snapshot, async identity => { calls.push(["fetch", identity]); return VECTOR_ITEM; }, () => true);
    assert.deepEqual(calls, [["fetch", VECTOR_ITEM], ["assess"], ["stage"], ["style", snapshot.style], ["filter", snapshot.filter], ["attach", 2]]);
    assert.equal(record.entry.label, snapshot.label);
    assert.equal(discarded, false);
});

test("filter failure and superseded Undo discard staged work without exposing an unfiltered layer", async () => {
    for (const fails of [true, false]) {
        let current = true, attached = false, discarded = false, removed = false;
        const record = { entry: {}, adapter: {
            applySavedState: async () => {},
            applyFilterState: async () => {
                if (fails) throw new Error("Filter unavailable");
                current = false;
            },
            discardStaged: () => { discarded = true; },
        } };
        const coordinator = new CatalogVisualizationCoordinator({ stage: async () => ({ record, layer: { remove() { removed = true; } } }) }, {
            restoreStagedLayer: () => { attached = true; },
        }, {});
        await assert.rejects(coordinator.restoreRemovedLayer({ item: RASTER_ITEM, filter: {} }, async () => RASTER_ITEM, () => current), fails ? /Filter unavailable/ : /superseded/);
        assert.equal(attached, false);
        assert.equal(discarded, true);
        assert.equal(removed, true);
    }
});

test("catalog user removal requests Undo while internal removal keeps its existing lifecycle", () => {
    const calls = [];
    const coordinator = new CatalogVisualizationCoordinator({}, {
        remove: item => calls.push(["internal", item]),
        removeWithUndo: key => calls.push(["user", key]),
    }, {});
    coordinator.remove(RASTER_ITEM);
    coordinator.remove(RASTER_ITEM, true);
    assert.equal(calls[0][0], "internal");
    assert.equal(calls[1][0], "user");
    assert.equal(typeof calls[1][1], "string");
});
