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
