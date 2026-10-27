import assert from "node:assert/strict";
import test from "node:test";

import {
    createVectorWmsLayer,
    VECTOR_DEFAULT_SYMBOLOGY,
} from "../../src/vector/leaflet.js";
import { normalizeVectorStyle } from "../../src/vector/style.js";

test("vector WMS uses one bounded layer and no raster environment", () => {
    let capturedRequest;
    let tileErrorHandler;
    const wmsLayer = {
        on() {},
        once(type, handler) {
            assert.equal(type, "tileerror");
            tileErrorHandler = handler;
        },
    };
    const leaflet = {
        tileLayer: {
            wms(url, options) {
                capturedRequest = { url, options };
                return wmsLayer;
            },
        },
    };
    let failures = 0;
    const style = normalizeVectorStyle({
        geometryKind: "line", strokeColor: "#112233", strokeOpacity: 0.7, strokeWidth: 2,
    });

    assert.equal(createVectorWmsLayer(
        leaflet,
        "/geoserver/eolab/wms",
        {
            layerName: "eolab:roads",
            bbox: [-123, 48, -122, 49],
            geometryKind: "line",
            styleName: "vector-line",
            style,
        },
        () => { failures += 1; }
    ), wmsLayer);
    assert.deepEqual(capturedRequest, {
        url: "/geoserver/eolab/wms",
        options: {
            layers: "eolab:roads",
            styles: "vector-line",
            vector_style: JSON.stringify(style),
            format: "image/png",
            transparent: true,
            tiled: true,
            tilesorigin: "-20037508.342789244,-20037508.342789244",
            version: "1.3.0",
            noWrap: true,
            maxZoom: 22,
            bounds: [[48, -123], [49, -122]],
        },
    });
    assert.equal("env" in capturedRequest.options, false);
    tileErrorHandler();
    assert.equal(failures, 1);
});

test("default vector geometry families use blue symbols with black outlines", () => {
    assert.deepEqual(VECTOR_DEFAULT_SYMBOLOGY, {
        point: { label: "Point", fill: "#2b83ba", stroke: "#000000" },
        line: { label: "Line", fill: "transparent", stroke: "#2b83ba" },
        polygon: { label: "Polygon", fill: "#2b83ba", stroke: "#000000" },
    });
});

test("crossing vector WMS retains both map edges without wrapping world copies", () => {
    let options;
    const layer = { once() {}, on() {} };
    createVectorWmsLayer(
        { tileLayer: { wms(_url, candidate) { options = candidate; return layer; } } },
        "/geoserver/eolab/wms",
        { layerName: "eolab:pacific", styleName: "vector-polygon", bbox: [170, -10, -170, 10],
            style: normalizeVectorStyle({ geometryKind: "polygon", fillColor: "#112233", fillOpacity: 1,
                strokeColor: "#000000", strokeOpacity: 1, strokeWidth: 1 }) },
        () => {},
    );
    assert.deepEqual(options.bounds, [[-10, -180], [10, 180]]);
    assert.equal(options.noWrap, true);
});

/**
 * Exercise the public Leaflet tile hooks with controlled HTTP and image completion.
 * @param {import("node:test").TestContext} context Test-scoped browser mocks.
 * @return {Object} Layer, requests, image completions and released URLs.
 */
function transportFixture(context) {
    const previousDocument = globalThis.document;
    globalThis.document = {
        createElement: () => ({ src: "", removeAttribute() { this.src = ""; } }),
    };
    context.after(() => {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
    });
    const calls = [], completed = [], created = [], revoked = [], handlers = new Map();
    context.mock.method(globalThis, "fetch", (url, options) => new Promise((resolve, reject) => {
        calls.push({ url, ...options, resolve, reject });
    }));
    context.mock.method(URL, "createObjectURL", blob => {
        const url = `blob:tile-${created.length}`;
        created.push({ url, blob });
        return url;
    });
    context.mock.method(URL, "revokeObjectURL", url => revoked.push(url));
    const layer = {
        once() {},
        on(events, handler) { for (const event of events.split(" ")) handlers.set(event, handler); },
        emit(event, tile) { handlers.get(event)({ tile }); },
        getTileUrl: coords => `/wms?${new URLSearchParams({ ...layer.options,
            bbox: `${coords.x},${coords.y},10,20`, width: "256", height: "256" })}`,
        setParams(parameters) { Object.assign(this.options, parameters); },
    };
    const style = normalizeVectorStyle({ geometryKind: "polygon", fillColor: "#123456",
        fillOpacity: 1, strokeColor: "#000000", strokeOpacity: 1, strokeWidth: 1 });
    createVectorWmsLayer({ tileLayer: { wms(_url, options) {
        layer.options = options; return layer;
    } } }, "/wms", { layerName: "eolab:parcels", styleName: "opaque-approval", style,
        bbox: [-10, -10, 10, 10], geometryKind: "polygon" }, () => {});
    return { layer, calls, completed, created, revoked, style,
        createTile: () => layer.createTile({ x: 2, y: 3, z: 4 }, (error, tile) => completed.push({ error, tile })),
    };
}

/** Flush fetch and image-installation continuations. @return {Promise<void>} Pending microtasks. */
async function flushTransport() { await new Promise(resolve => setImmediate(resolve)); }

/** @return {Object} Successful tile HTTP response with immediate body completion. */
function tileResponse() { return { ok: true, blob: async () => new Blob(["tile"], { type: "image/png" }) }; }

test("vector tiles post Leaflet parameters and release their image URL after decoding", async context => {
    const f = transportFixture(context), tile = f.createTile();
    assert.equal(tile.alt, "");
    assert.equal(f.calls[0].url, "/wms");
    assert.equal(f.calls[0].method, "POST");
    assert.equal(f.calls[0].headers["X-EOLab-Uploads"], "1");
    assert.equal(f.calls[0].body.get("bbox"), "2,3,10,20");
    assert.equal(f.calls[0].body.get("styles"), "opaque-approval");
    assert.deepEqual(JSON.parse(f.calls[0].body.get("vector_style")), f.style);
    f.calls[0].resolve(tileResponse());
    await flushTransport();
    assert.equal(tile.src, "blob:tile-0");
    assert.equal(f.completed.length, 0, "HTTP completion waits for image decoding");
    tile.onload();
    assert.deepEqual(f.completed, [{ error: null, tile }]);
    assert.deepEqual(f.revoked, ["blob:tile-0"]);
    f.layer.emit("tileunload", tile);
    assert.deepEqual(f.revoked, ["blob:tile-0"]);
});

test("retry and unload cancel obsolete POSTs without installing their late images", async context => {
    const f = transportFixture(context), tile = f.createTile();
    f.layer.setParams({ styles: "new-approval" });
    const retry = f.layer.reloadTile(tile);
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.calls[1].body.get("styles"), "new-approval");
    f.calls[0].resolve(tileResponse());
    await flushTransport();
    assert.equal(f.created.length, 0);
    f.calls[1].resolve(tileResponse());
    await retry;
    f.layer.emit("tileunload", tile);
    assert.equal(f.calls[1].signal.aborted, true);
    assert.deepEqual(f.revoked, ["blob:tile-0"]);
    const abandoned = f.createTile();
    f.layer.emit("tileabort", abandoned);
    f.calls[2].resolve(tileResponse());
    await flushTransport();
    assert.equal(f.created.length, 1);
    assert.equal(f.completed.length, 0);
});

test("HTTP and image failures notify Leaflet and a retry performs a fresh POST", async context => {
    const f = transportFixture(context), tile = f.createTile();
    f.calls[0].resolve(new Response("busy", { status: 503 }));
    await flushTransport();
    assert.match(f.completed[0].error.message, /503/);
    const retry = f.layer.reloadTile(tile);
    f.calls[1].resolve(tileResponse());
    await retry;
    tile.onerror();
    assert.match(f.completed[1].error.message, /image could not be read/);
    assert.deepEqual(f.revoked, ["blob:tile-0"]);
    const recovered = f.layer.reloadTile(tile);
    f.calls[2].resolve(tileResponse());
    await recovered;
    tile.onload();
    assert.equal(f.completed[2].error, null);
    assert.deepEqual(f.revoked, ["blob:tile-0", "blob:tile-1"]);
});
