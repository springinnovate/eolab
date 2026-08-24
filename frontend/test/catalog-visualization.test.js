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
    };
    const mapLayerController = {
        show(item, adapter) {
            calls.push(["show-vector", item, adapter]);
            return Promise.resolve("vector");
        },
        contains() { return true; },
        remove(item) { calls.push(["remove", item]); },
    };
    const vectorMapLayerAdapter = { label: "vector adapter" };
    const coordinator = new CatalogVisualizationCoordinator(
        viewer,
        mapLayerController,
        vectorMapLayerAdapter,
        async (item) => ({ kind: "raster", item }),
        async (item) => ({ kind: "vector", item })
    );

    assert.equal((await coordinator.assess(RASTER_ITEM)).kind, "raster");
    assert.equal((await coordinator.assess(VECTOR_ITEM)).kind, "vector");
    assert.equal(await coordinator.show(RASTER_ITEM), "raster");
    assert.equal(await coordinator.show(VECTOR_ITEM), "vector");
    assert.equal(coordinator.contains(VECTOR_ITEM), true);
    coordinator.remove(VECTOR_ITEM);
    assert.deepEqual(calls, [
        ["show-raster", RASTER_ITEM],
        ["show-vector", VECTOR_ITEM, vectorMapLayerAdapter],
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
