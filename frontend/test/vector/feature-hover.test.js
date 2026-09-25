import assert from "node:assert/strict";
import test from "node:test";
import { findVectorLayerAtPointer } from "../../src/vector/feature-hover.js";

const viewport = { crs: "EPSG:3857", bbox: [-100, -100, 100, 100], width: 400, height: 300, x: 200, y: 150 };
const targets = ["Top", "Middle", "Bottom"].map(label => ({ label,
    publication: { layerName: `eolab:${label}`, styleName: "filtered-style" }, propertyNames: ["name", "description"] }));

/** @param {boolean} hit Whether a feature exists. @return {Response} Bounded WMS result. */
function response(hit) {
    return Response.json({ type: "FeatureCollection", features: hit ? [{ type: "Feature", geometry: null, properties: { name: "Area" } }] : [] });
}

test("reuses bounded feature queries in top-first order and stops at first hit", async () => {
    const queries = [];
    const result = await findVectorLayerAtPointer({ targets, viewport, wmsUrl: "/geoserver/eolab/wms", signal: new AbortController().signal }, async url => {
        const query = new URL(url, "https://example.test").searchParams;
        queries.push(query);
        return response(queries.length === 2);
    });
    assert.equal(result, "Middle");
    assert.deepEqual(queries.map(query => query.get("layers")), ["eolab:Top", "eolab:Middle"]);
    assert.equal(queries[0].get("feature_count"), "5");
    assert.equal(queries[0].get("styles"), "filtered-style");
    assert.equal(queries[0].get("propertyName"), "name");
});

test("no visible targets or no matching feature returns no label", async () => {
    const options = { targets, viewport, wmsUrl: "/wms", signal: new AbortController().signal };
    assert.equal(await findVectorLayerAtPointer(options, async () => response(false)), null);
    assert.equal(await findVectorLayerAtPointer({ ...options, targets: [] }, () => assert.fail("No queries")), null);
});

test("cancellation stops later layers even if transport returns after abort", async () => {
    const abort = new AbortController();
    let calls = 0;
    await assert.rejects(findVectorLayerAtPointer({ targets, viewport, wmsUrl: "/wms", signal: abort.signal }, async () => {
        calls++; abort.abort(); return response(false);
    }), { name: "AbortError" });
    assert.equal(calls, 1);
});

test("one deadline bounds the whole lookup and aborts the active request", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    let suppliedSignal;
    const result = findVectorLayerAtPointer({ targets, viewport, wmsUrl: "/wms", signal: new AbortController().signal }, async (_, { signal }) => {
        suppliedSignal = signal;
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const rejected = assert.rejects(result, { name: "AbortError" });
    context.mock.timers.tick(2500);
    assert.equal(suppliedSignal.aborted, true);
    await rejected;
});

test("unavailable top layer does not misidentify a lower layer as topmost", async () => {
    let calls = 0;
    await assert.rejects(findVectorLayerAtPointer({ targets, viewport, wmsUrl: "/wms", signal: new AbortController().signal }, async () => {
        calls++; return Response.json({ detail: "Busy" }, { status: 503 });
    }), /Busy/);
    assert.equal(calls, 1);
});
