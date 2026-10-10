import test from "node:test";
import assert from "node:assert/strict";
import { ModelOutputLayers, artifactLayerKey } from "../src/model-output-preview/controller.js";
import { readArtifactPreview, validateArtifactPreview } from "../src/model-output-preview/api.js";
import { fileManifest, job } from "../test-support/models/fixtures.js";

/** Compose display ownership against explicit map and HTTP boundary fakes.
 * @param {Object} [overrides={}] Optional transport replacements.
 * @return {Object} Preview owner, retained adapters, request counters and ready run.
 */
function fixture(overrides = {}) {
    const artifacts = fileManifest(), run = job({status: "ready", expiresAt: artifacts.expiresAt, artifacts});
    artifacts.files[0].mediaType = "application/geo+json";
    const data = {jobId: run.jobId, artifactId: artifacts.files[0].artifactId, sha256: artifacts.files[0].sha256,
        kind: "vector", bounds: [0, 0, 1, 1], geometryKind: "polygon", geojson: {type: "FeatureCollection", features: [{type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,0]]]}}]}};
    const records = new Map(); const calls = {reads: 0, releases: 0, changes: 0};
    const api = {getJob: async () => run, readJobStatuses: async () => ({jobs: [run], unavailableJobIds: []})};
    const owner = new ModelOutputLayers({api, clock: {setTimeout() {}, clearTimeout() {}},
        addLayer: (source, adapter) => records.set(source.key, {entry: source, adapter, state: adapter.createState()}),
        removeLayer: key => { const record = records.get(key); records.delete(key); record.adapter.removed(); },
        refreshLayers: () => {}, createLayer: () => ({setAppearance() {}, zoom() {}, release() { calls.releases++; }}),
        openRun: () => {}, onChange: () => { calls.changes++; },
        read: async () => { calls.reads++; return structuredClone(data); }, ...overrides});
    return {owner, records, calls, run, data, file: artifacts.files[0], api};
}

test("outputs are opt-in, keep run identities, and remove without deleting any run file", async () => {
    const h = fixture(); const key = artifactLayerKey(h.run.jobId, h.file.artifactId);
    assert.equal(h.records.size, 0);
    await h.owner.show(h.run, h.file); await h.owner.show(h.run, h.file);
    assert.equal(h.calls.reads, 1); assert.equal(h.records.size, 1);
    assert.equal(h.owner.state(h.run.jobId, h.file.artifactId, h.file).onMap, true);
    const record = h.records.get(key);
    assert.deepEqual(record.adapter.snapshot().group, {id: h.run.jobId, label: h.run.label});
    h.owner.removeLayer(key);
    assert.equal(h.owner.layers.size, 0); assert.equal(h.calls.releases, 1);
    assert.equal(h.run.artifacts.files.length, 3);
    await h.owner.show(h.run, h.file); assert.equal(h.calls.reads, 2);
});

test("separate runs can show the same file identifier without sharing appearance", async () => {
    const h = fixture(); const other = {...h.run, jobId: "2".repeat(32), label: "Another run"};
    await h.owner.show(h.run, h.file); await h.owner.show(other, h.file);
    const [first, second] = [...h.owner.layers.values()];
    h.owner.applyAppearance(first.key, {...first.appearance, fillColor: "#112233"});
    assert.notEqual(first.appearance.fillColor, second.appearance.fillColor);
    assert.equal(h.records.size, 2);
});

test("Undo checks the server again and retains style without copying preview bytes", async () => {
    const h = fixture(); await h.owner.show(h.run, h.file);
    const [state] = h.owner.layers.values(), record = h.records.get(state.key);
    const local = record.adapter.copyLayerForUndo();
    assert.equal(JSON.stringify(local).includes("values"), false);
    h.owner.removeLayer(state.key);
    await h.owner.restore({key: state.key, local, visible: false, opacity: 0.4}, () => true);
    assert.equal(h.calls.reads, 2); assert.equal(h.records.get(state.key).entry.visible, false);
    assert.equal(h.records.get(state.key).entry.opacity, 0.4);
    h.owner.removeLayer(state.key); h.run.artifacts.files = [];
    await assert.rejects(h.owner.restore({local}, () => true), /no longer available/);
});

test("expiry and foreign/deleted status remove previews even when Models is closed", async () => {
    const h = fixture(); await h.owner.show(h.run, h.file);
    h.api.readJobStatuses = async () => ({jobs: [], unavailableJobIds: [h.run.jobId]});
    await h.owner.refreshAvailability(); assert.equal(h.records.size, 0);
    assert.match(h.owner.state(h.run.jobId, h.file.artifactId, h.file).error, /no longer available/);
    await h.owner.show(h.run, h.file);
    [...h.owner.layers.values()][0].expiresAt = "2000-01-01T00:00:00Z";
    h.api.readJobStatuses = async () => { throw new Error("Network failed"); };
    await h.owner.refreshAvailability(); assert.equal(h.records.size, 0);
    assert.match(h.owner.state(h.run.jobId, h.file.artifactId, h.file).error, /expired/);
});

test("obsolete display requests never attach and preview failures leave downloads available", async () => {
    let resolve; const h = fixture({read: () => new Promise(done => { resolve = done; })});
    const pending = h.owner.show(h.run, h.file); h.owner.destroy(); resolve(h.data); await pending;
    assert.equal(h.records.size, 0);
    const failed = fixture({read: async () => { throw new Error("Preview timed out; download instead."); }});
    await failed.owner.show(failed.run, failed.file);
    assert.match(failed.owner.state(failed.run.jobId, failed.file.artifactId, failed.file).error, /timed out/);
    assert.ok(failed.file.url); assert.equal(failed.run.status, "ready");
});

test("browser preview boundary rejects substituted files, unsupported geometries and coordinates", () => {
    const h = fixture(); assert.equal(validateArtifactPreview(h.data, h.run.jobId, h.file), h.data);
    for (const changes of [{jobId: "2".repeat(32)}, {sha256: "b".repeat(64)}, {geometryKind: "point"}, {geojson: {}}, {bounds: [-181, 0, 1, 1]}]) {
        assert.throws(() => validateArtifactPreview({...h.data, ...changes}, h.run.jobId, h.file), /invalid/);
    }
});

test("preview transport uses same-origin no-store requests and cancels oversized responses", async () => {
    const h = fixture(); let request;
    const data = await readArtifactPreview(h.run.jobId, h.file, new AbortController().signal, async (url, options) => {
        request = {url, options}; return new Response(JSON.stringify(h.data));
    });
    assert.equal(data.kind, "vector"); assert.equal(request.options.cache, "no-store");
    assert.equal(request.options.credentials, "same-origin"); assert.match(request.url, /\/artifacts\/[a-f0-9]{32}\/preview$/);
    await assert.rejects(readArtifactPreview(h.run.jobId, h.file, undefined,
        async () => new Response(" ".repeat(8 * 1024 * 1024 + 1025))), /too large/);
});


test("raster display delegates to the common raster owner using original identity and metadata", async () => {
    let attachment, copy;
    const h = fixture({read: () => { throw new Error("Raster previews must not be loaded"); },
        describe: async source => ({source, version: "a".repeat(64), bounds: [0,0,1,1], capabilities: {pixels: {supported: true}, statistics: {supported: true}}}),
        addRaster: (raster, lifecycle, presentation) => { attachment = {raster, lifecycle, presentation}; copy = lifecycle.copy({kind: "raster"}); }});
    h.file.mediaType = "image/tiff"; h.file.sha256 = "a".repeat(64);
    await h.owner.show(h.run, h.file);
    assert.deepEqual(attachment.raster.source, {kind: "runArtifact", jobId: h.run.jobId, artifactId: h.file.artifactId});
    assert.deepEqual(attachment.raster.group, {id: h.run.jobId, label: h.run.label});
    assert.equal(attachment.raster.capabilities.calculations, true);
    assert.equal(attachment.raster.item, undefined);
    assert.equal(copy.artifactId, h.file.artifactId); assert.equal(copy.appearance.kind, "raster");
    attachment.lifecycle.removed(); assert.equal(h.owner.layers.size, 0);
});


test("closing during raster publication cancels attachment without removing an unattached layer", async () => {
    let finish, presentation;
    const h = fixture({describe: async source => ({source, version:"a".repeat(64), bounds:[0,0,1,1],
        capabilities:{pixels:{supported:true},statistics:{supported:true}}}),
        addRaster: async (_raster, _lifecycle, options) => {
            presentation = options; await new Promise(resolve => {finish=resolve;});
            assert.equal(options.signal.aborted, true); assert.equal(options.isCurrent(), false); return null;
        }});
    h.file.mediaType="image/tiff"; h.file.sha256="a".repeat(64);
    const work=h.owner.show(h.run,h.file); await Promise.resolve();
    assert.ok(presentation); assert.equal(h.owner.layers.size,0);
    h.owner.destroy(); finish(); await work;
    assert.equal(h.owner.layers.size,0); assert.equal(h.owner.pending.size,0);
});
