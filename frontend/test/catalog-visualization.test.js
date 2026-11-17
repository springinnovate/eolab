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
const ASSESSED_VECTOR_ITEM = Object.freeze({
    ...VECTOR_ITEM,
    properties: {
        "eolab:vector_rendering": {
            policy: "vector-v1",
            eligible: true,
            reason_code: null,
            reason: null,
            reader_contract: "geoserver-3.0.1-geotools-35.1-vector-v1",
            reader_compatible: true,
            geometry_kind: "polygon",
        },
    },
});

test("current admitted vector support goes directly to the publication adapter", async () => {
    const calls = [];
    const adapter = {};
    const coordinator = new CatalogVisualizationCoordinator({}, {
        show(item, selectedAdapter) {
            calls.push([item, selectedAdapter]);
            return Promise.resolve("published");
        },
    }, adapter, async () => { assert.fail("an admitted vector must not be reassessed"); });

    const prepared = await coordinator.prepare(ASSESSED_VECTOR_ITEM);
    assert.equal(prepared, ASSESSED_VECTOR_ITEM);
    assert.equal(await coordinator.show(prepared), "published");
    assert.deepEqual(calls, [[ASSESSED_VECTOR_ITEM, adapter]]);
});

test("missing, obsolete and ineligible vector assessments retain the assessment workflow", async () => {
    const current = ASSESSED_VECTOR_ITEM.properties["eolab:vector_rendering"];
    for (const metadata of [
        undefined,
        { ...current, policy: "vector-old" },
        { ...current, reader_contract: "old-reader" },
        { ...current, reader_contract: undefined },
        { ...current, eligible: false, reason: "Reader unavailable" },
    ]) {
        const item = { ...VECTOR_ITEM, properties: { "eolab:vector_rendering": metadata } };
        const calls = [];
        const coordinator = new CatalogVisualizationCoordinator({}, {}, {}, async source => {
            calls.push(source);
            return ASSESSED_VECTOR_ITEM;
        });
        assert.equal(await coordinator.prepare(item), ASSESSED_VECTOR_ITEM);
        assert.deepEqual(calls, [item]);
    }
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
        restoreSavedState: async (_record, style) => { calls.push(["style", style]); },
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

test("Undo reuses the freshly fetched admitted assessment before restoring a layer", async () => {
    const calls = [];
    const staged = { record: { entry: {}, adapter: {
        applySavedState: async () => { calls.push("style"); },
    } }, layer: {} };
    const coordinator = new CatalogVisualizationCoordinator({}, {
        stage: async item => { assert.equal(item, ASSESSED_VECTOR_ITEM); calls.push("stage"); return staged; },
        restoreStagedLayer: layer => { assert.equal(layer, staged); calls.push("attach"); },
    }, {}, async () => { assert.fail("the fetched assessment is current"); });

    await coordinator.restoreRemovedLayer(
        { item: VECTOR_ITEM, label: "Restored", style: {}, index: 0 },
        async identity => { assert.equal(identity, VECTOR_ITEM); calls.push("fetch"); return ASSESSED_VECTOR_ITEM; },
        () => true
    );
    assert.deepEqual(calls, ["fetch", "stage", "style", "attach"]);
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
    const target = {key: "local:view:topmost", label: "Custom rain", count: 2};
    const coordinator = new CatalogVisualizationCoordinator({}, {
        remove: item => calls.push(["internal", item]),
        removalTarget: item => item === RASTER_ITEM ? target : null,
        findLayerKey: item => item === RASTER_ITEM ? "local:view:topmost" : null,
        removeWithUndo: key => calls.push(["user", key]),
    }, {});
    assert.equal(coordinator.removalTarget(RASTER_ITEM), target);
    assert.equal(coordinator.removalTarget(VECTOR_ITEM), null);
    coordinator.remove(RASTER_ITEM);
    coordinator.remove(RASTER_ITEM, true);
    assert.equal(calls[0][0], "internal");
    assert.equal(calls[1][0], "user");
    assert.equal(calls[1][1], "local:view:topmost");
    coordinator.remove(VECTOR_ITEM, true);
    assert.equal(calls.length, 2, "a missing view has nothing to remove");
});


test("temporal Catalog actions use the raster viewer's independent dataset views", async () => {
    const item = { collection: "eolab-temporal-datasets", id: "era5" };
    const calls = [];
    const target = {key: "local:temporal:topmost", label: "Temperature · January", count: 2};
    const viewer = {
        showTemporal: async source => { calls.push(["show", source]); return "first view"; },
        containsTemporal: source => { calls.push(["contains", source]); return true; },
        temporalRemovalTarget: source => { assert.equal(source, item); return target; },
        removeTemporal: (source, allowUndo) => calls.push(["remove", source, allowUndo]),
    };
    const coordinator = new CatalogVisualizationCoordinator(viewer, {}, {});
    assert.equal(await coordinator.prepare(item), item);
    assert.equal(await coordinator.show(item), "first view");
    assert.equal(coordinator.contains(item), true);
    assert.equal(coordinator.removalTarget(item), target);
    coordinator.remove(item, true);
    coordinator.remove(item);
    assert.deepEqual(calls, [
        ["show", item], ["contains", item], ["remove", item, true], ["remove", item, false],
    ]);
});
