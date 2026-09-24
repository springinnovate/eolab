import assert from "node:assert/strict";
import test from "node:test";
import { createCancelableWmsLayer } from "../src/leaflet-wms.js";

/** @return {Promise<void>} Flush fetch and blob promises. */
async function flush() { await new Promise(resolve => setImmediate(resolve)); }

/**
 * Fake the browser transport and Leaflet lifecycle while retaining the real loader.
 * @param {Object} context Node test context that restores browser globals.
 * @return {Object} Layer, pending HTTP requests, completion events and blob URLs.
 */
function fixture(context) {
    const calls = [], completed = [], revoked = [], created = [], handlers = new Map();
    context.mock.method(globalThis, "fetch", (url, options) => new Promise((resolve, reject) => {
        calls.push({ url, signal: options.signal, resolve, reject });
    }));
    context.mock.method(URL, "createObjectURL", blob => {
        const url = `blob:${created.length}`; created.push({ url, blob }); return url;
    });
    context.mock.method(URL, "revokeObjectURL", url => revoked.push(url));
    globalThis.document = { createElement: () => ({ complete: true }) };
    context.after(() => { delete globalThis.document; });
    const originalAborts = [];
    const base = {
        _tiles: {}, _tileZoom: 3,
        getTileUrl: coords => `/wms?z=${coords.z}&x=${coords.x}&style=original`,
        on(events, handler) {
            for (const event of events.split(" ")) handlers.set(event, handler);
        },
        _removeTile(key) {
            const tile = this._tiles[key].el;
            delete this._tiles[key]; handlers.get("tileunload")({ tile });
        },
        _abortLoading() { originalAborts.push(this._tileZoom); },
    };
    const layer = createCancelableWmsLayer({ tileLayer: { wms: () => base } }, "/wms", {});
    return { layer, calls, completed, created, revoked, originalAborts,
        tile(x = 0, z = 3, key = `${x}:${z}`) {
            const coords = { x, y: 0, z };
            const tile = layer.createTile(coords, (error, image) => completed.push({ error, image }));
            layer._tiles[key] = { el: tile, coords };
            return tile;
        },
    };
}

/** @return {Object} Successful image HTTP response. */
function response() { return { ok: true, blob: async () => new Blob(["image"]) }; }

test("successful images retain their blob until unloaded and are not retried", async context => {
    const f = fixture(context), tile = f.tile();
    assert.equal(tile.alt, "");
    f.calls[0].resolve(response()); await flush(); tile.onload();
    assert.deepEqual(f.completed, [{ error: null, image: tile }]);
    f.layer.retryTile(tile); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.revoked, []);
    f.layer._removeTile("0:3");
    assert.deepEqual(f.revoked, [tile.src]);
});

test("HTTP rejection reports an error and retry uses the original URL and a fresh signal", async context => {
    const f = fixture(context), tile = f.tile();
    f.calls[0].resolve({ ok: false, status: 503 }); await flush();
    assert.match(f.completed[0].error.message, /503/);
    f.layer.getTileUrl = () => "/changed";
    f.layer.retryTile(tile);
    assert.equal(f.calls[1].url, f.calls[0].url);
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.calls[1].signal.aborted, false);
    f.calls[1].resolve(response()); await flush(); tile.onload();
    assert.equal(f.completed[1].error, null);
});

test("image decode failure stays retryable and releases the previous blob", async context => {
    const f = fixture(context), tile = f.tile();
    f.calls[0].resolve(response()); await flush(); tile.onerror();
    assert.match(f.completed[0].error.message, /decoded/);
    f.layer.retryTile(tile);
    assert.deepEqual(f.revoked, ["blob:0"]);
    f.calls[1].resolve(response()); await flush(); tile.onload();
    assert.equal(f.completed[1].error, null);
});

test("unload aborts fetch and late network failure cannot report an error or retry", async context => {
    const f = fixture(context), tile = f.tile();
    f.layer._removeTile("0:3");
    assert.equal(f.calls[0].signal.aborted, true);
    f.calls[0].reject(new Error("aborted")); await flush();
    f.layer.retryTile(tile);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.completed, []);
});

test("unload while reading the body prevents late blob allocation", async context => {
    const f = fixture(context); f.tile();
    let finishBody;
    f.calls[0].resolve({ ok: true, blob: () => new Promise(resolve => { finishBody = resolve; }) });
    await flush(); f.layer._removeTile("0:3");
    finishBody(new Blob()); await flush();
    assert.equal(f.calls[0].signal.aborted, true);
    assert.deepEqual(f.created, []); assert.deepEqual(f.completed, []);
});

test("unload during decoding revokes the blob and suppresses a captured load callback", async context => {
    const f = fixture(context), tile = f.tile();
    f.calls[0].resolve(response()); await flush();
    const loaded = tile.onload;
    f.layer._removeTile("0:3"); loaded();
    assert.deepEqual(f.revoked, ["blob:0"]);
    assert.deepEqual(f.completed, []);
});

test("zoom aborts unfinished old tiles even when empty images are complete, retaining loaded tiles", async context => {
    const f = fixture(context), old = f.tile(0, 3, "wrapped-world-key"), loaded = f.tile(1);
    f.calls[1].resolve(response()); await flush(); loaded.onload();
    const current = f.tile(0, 4);
    f.layer._tileZoom = 4; f.layer._abortLoading();
    assert.equal(old.complete, true);
    assert.equal(f.calls[0].signal.aborted, true);
    assert.equal(f.calls[1].signal.aborted, false);
    assert.equal(f.calls[2].signal.aborted, false);
    assert.deepEqual(Object.values(f.layer._tiles).map(tile => tile.el), [loaded, current]);
    assert.deepEqual(f.originalAborts, [4]);
});

test("a replaced attempt cannot assign its late response to the retained image", async context => {
    const f = fixture(context), tile = f.tile();
    f.layer.retryTile(tile);
    f.calls[1].resolve(response()); await flush(); tile.onload();
    f.calls[0].resolve(response()); await flush();
    assert.equal(f.created.length, 1); assert.equal(f.completed.length, 1);
});
