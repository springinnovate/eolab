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
        addLayer: (source, adapter) => records.set(source.key, {entry: {...source, label: source.customName ?? source.label}, adapter, state: adapter.createState()}),
        updateLayer: (key, presentation) => {
            const record = records.get(key);
            Object.assign(record.entry, presentation, {label: record.entry.customName ?? presentation.sourceName});
        },
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
    assert.equal(record.entry.label, h.file.displayName ?? `${h.file.label} · ${h.run.label}`);
    assert.deepEqual(record.adapter.snapshot().group, {id: h.run.jobId, label: h.run.label, actionLabel: "Delete run and results"});
    h.owner.removeLayer(key);
    assert.equal(h.owner.layers.size, 0); assert.equal(h.calls.releases, 1);
    assert.equal(h.run.artifacts.files.length, 3);
    await h.owner.show(h.run, h.file); assert.equal(h.calls.reads, 2);
});

/** Rename a run fixture and its output labels as returned by the API.
 * @param {Object} run Previous run response.
 * @param {string} name New readable run name.
 * @return {Object} Newer response with matching output display names.
 */
function renamedRun(run, name) {
    const label = `${name} · ${run.nameTimestamp ?? "2026_10_08_00_00_00"}`;
    return {...run, name, label, updatedAt: "2026-10-10T00:00:00Z",
        artifacts: {...run.artifacts, files: run.artifacts.files.map(file => ({...file, displayName: `${file.label} · ${label}`}))}};
}

test("run renaming refreshes output names and groups without rereading files, including Undo", async () => {
    const h = fixture(); await h.owner.show(h.run, h.file);
    const key = artifactLayerKey(h.run.jobId, h.file.artifactId), record = h.records.get(key);
    const renamed = renamedRun(h.run, "Cuba biomass");
    h.owner.updateRun(renamed);
    assert.equal(record.entry.label, renamed.artifacts.files[0].displayName);
    assert.equal(record.adapter.snapshot().group.label, renamed.label);
    assert.equal(h.calls.reads, 1);
    record.entry.customName = "My comparison"; record.entry.label = record.entry.customName;
    const latest = {...renamedRun(renamed, "Updated biomass"), updatedAt: "2026-10-11T00:00:00Z"};
    h.owner.updateRun(latest);
    assert.equal(record.entry.label, "My comparison");
    assert.equal(record.entry.sourceName, latest.artifacts.files[0].displayName);
    assert.equal(record.adapter.snapshot().group.label, latest.label);
    const snapshot = {key, customName: record.entry.customName, local: record.adapter.copyLayerForUndo()};
    h.owner.removeLayer(key); h.api.getJob = async () => latest;
    await h.owner.restore(snapshot, () => true);
    assert.equal(h.records.get(key).entry.label, "My comparison");
    assert.equal(h.records.get(key).entry.sourceName, latest.artifacts.files[0].displayName);
    assert.equal(h.calls.reads, 2);
});

test("an output attaches with the current run name when it changes during a preview read", async () => {
    let finish;
    const h = fixture({read: () => new Promise(resolve => { finish = resolve; })});
    const pending = h.owner.show(h.run, h.file);
    const renamed = renamedRun(h.run, "New name while reading");
    h.owner.updateRun(renamed);
    finish(h.data); await pending;
    const record = [...h.records.values()][0];
    assert.equal(record.entry.label, renamed.artifacts.files[0].displayName);
    assert.equal(record.adapter.snapshot().group.label, renamed.label);
});

test("a rename during raster publication updates the attached name once", async () => {
    let finishMetadata, finishPublication, attached;
    const changes = [];
    const h = fixture({describe: () => new Promise(resolve => { finishMetadata = resolve; }),
        updateLayer: (key, presentation) => {
            assert.ok(attached);
            changes.push({key, presentation});
            Object.assign(attached, presentation);
        },
        addRaster: async (_raster, _lifecycle, presentation) => {
            await new Promise(resolve => { finishPublication = resolve; });
            attached = {...presentation};
            return {};
        }});
    h.file.mediaType = "image/tiff";
    const pending = h.owner.show(h.run, h.file);
    h.owner.updateRun(renamedRun(h.run, "Name during metadata read"));
    finishMetadata({version: h.file.sha256, bounds: [0,0,1,1], capabilities: {pixels: {supported: true}, statistics: {supported: true}}});
    await Promise.resolve();
    const latest = {...renamedRun(h.run, "Name during publication"), updatedAt: "2026-10-11T00:00:00Z"};
    h.owner.updateRun(latest);
    finishPublication(); await pending;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].key, artifactLayerKey(h.run.jobId, h.file.artifactId));
    assert.equal(attached.label, latest.artifacts.files[0].displayName);
    assert.equal(attached.sourceName, latest.artifacts.files[0].displayName);
    assert.equal(attached.group.label, latest.label);
    assert.equal([...h.owner.layers.values()][0].runName, latest.label);
    h.owner.updateRun(h.run);
    assert.equal([...h.owner.layers.values()][0].runName, latest.label);
    assert.equal(changes.length, 1);
});

test("a rename observed as raster attachment completes updates the retained presentation", async () => {
    const changes = [];
    let latest;
    const h = fixture({describe: async () => ({version: "a".repeat(64), bounds: [0,0,1,1],
        capabilities: {pixels: {supported: true}, statistics: {supported: true}}}),
        updateLayer: (key, presentation) => changes.push({key, presentation}),
        addRaster: async () => {
            h.owner.updateRun(latest);
            return {};
        }});
    h.file.mediaType = "image/tiff";
    latest = renamedRun(h.run, "Rename during attachment");
    await h.owner.show(h.run, h.file);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].presentation.label, latest.artifacts.files[0].displayName);
    assert.equal(changes[0].presentation.group.label, latest.label);
});

test("renewal updates the map deadline and late reads cannot shorten it", async () => {
    const h = fixture(); await h.owner.show(h.run, h.file);
    const renewed = {...h.run, expiresAt: "2099-02-01T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z"};
    h.owner.updateRun(renewed);
    await h.owner.refreshAvailability(); // The in-flight server read still contains the old deadline.
    assert.equal([...h.owner.layers.values()][0].expiresAt, renewed.expiresAt);
    assert.equal(h.records.size, 1);
});

test("unrelated run updates do not postpone output availability checks", async () => {
    let schedules = 0;
    const h = fixture({clock: {setTimeout: () => { schedules++; }, clearTimeout: () => {}}});
    await h.owner.show(h.run, h.file);
    const before = schedules;
    h.owner.updateRun({...h.run});
    h.owner.updateRun({...h.run, jobId: "2".repeat(32), status: "running"});
    assert.equal(schedules, before);
});

test("a failed old availability read does not remove a freshly renewed output", async () => {
    const h = fixture(); await h.owner.show(h.run, h.file);
    let fail;
    h.api.readJobStatuses = () => new Promise((_resolve, reject) => { fail = reject; });
    const pending = h.owner.refreshAvailability();
    h.owner.updateRun({...h.run, expiresAt: "2099-02-01T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z"});
    fail(new Error("Obsolete network error")); await pending;
    assert.equal(h.records.size, 1);
});

test("expiry revalidation discovers renewal in another tab before removing the layer", async () => {
    const observed = [];
    const h = fixture({onRunObserved: job => observed.push(job)}); await h.owner.show(h.run, h.file);
    [...h.owner.layers.values()][0].expiresAt = "2000-01-01T00:00:00Z";
    const renewed = {...h.run, updatedAt: "2026-10-09T00:00:00Z"};
    h.api.readJobStatuses = async () => ({jobs: [renewed], unavailableJobIds: []});
    await h.owner.refreshAvailability();
    assert.equal(h.records.size, 1);
    assert.equal([...h.owner.layers.values()][0].expiresAt, renewed.expiresAt);
    assert.deepEqual(observed, [renewed]);
});

test("revalidation shares another tab's deletion with run controls through composition", async () => {
    const observed = [];
    const h = fixture({onRunObserved: job => observed.push(job)}); await h.owner.show(h.run, h.file);
    const deleted = {...h.run, status: "deleted", artifacts: {files: []}, updatedAt: "2026-10-10T00:00:00Z"};
    h.api.readJobStatuses = async () => ({jobs: [deleted], unavailableJobIds: []});
    await h.owner.refreshAvailability();
    assert.equal(h.records.size, 0);
    assert.deepEqual(observed, [deleted]);
});

test("run deletion removes all its displayed outputs while preserving other runs", async () => {
    const h = fixture();
    const second = {...h.file, artifactId: "d".repeat(32)};
    h.run.artifacts.files.push(second);
    await h.owner.show(h.run, h.file); await h.owner.show(h.run, second);
    const other = {...h.run, jobId: "2".repeat(32)};
    await h.owner.show(other, h.file);
    h.owner.updateRun({...h.run, status: "deleted", artifacts: {files: []}, updatedAt: "2026-10-10T00:00:00Z"});
    assert.equal(h.records.size, 1);
    assert.equal([...h.owner.layers.values()][0].jobId, other.jobId);
    await h.owner.show(h.run, h.file); // An obsolete display request cannot restore it.
    assert.equal(h.records.size, 1);
});

test("deletion cancels pending original-raster publication before map attachment", async () => {
    let finish, presentation;
    const h = fixture({describe: async () => ({version: "a".repeat(64), bounds: [0,0,1,1],
        capabilities: {pixels: {supported: true}, statistics: {supported: true}}}),
        addRaster: (_raster, _lifecycle, options) => { presentation = options; return new Promise(resolve => { finish = resolve; }); }});
    h.file.mediaType = "image/tiff";
    const pending = h.owner.show(h.run, h.file); await Promise.resolve(); await Promise.resolve();
    assert.ok(presentation);
    h.owner.updateRun({...h.run, status: "deleted", artifacts: {files: []}, updatedAt: "2026-10-10T00:00:00Z"});
    assert.equal(presentation.signal.aborted, true);
    assert.equal(presentation.isCurrent(), false);
    finish(null); await pending;
    assert.equal(h.owner.layers.size, 0);
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
    for (const changes of [{jobId: "2".repeat(32)}, {artifactId: "3".repeat(32)}, {sha256: "b".repeat(64)}, {geometryKind: "point"}, {geojson: {}}, {bounds: [-181, 0, 1, 1]}]) {
        assert.throws(() => validateArtifactPreview({...h.data, ...changes}, h.run.jobId, h.file), /invalid/);
    }
});

test("GeoJSON previews retain feature, coordinate and extent limits", () => {
    const h = fixture();
    const point = {type: "Feature", properties: {}, geometry: {type: "Point", coordinates: [0.5, 0.5]}};
    for (const features of [
        Array(5001).fill(point),
        [{...point, geometry: {type: "MultiPoint", coordinates: Array(100001).fill([0.5, 0.5])}}],
        [{...point, geometry: {type: "Point", coordinates: [2, 0.5]}}],
        [{...point, geometry: {type: "Point", coordinates: [Number.NaN, 0.5]}}],
    ]) {
        const data = {...h.data, geometryKind: "point", geojson: {type: "FeatureCollection", features}};
        assert.throws(() => validateArtifactPreview(data, h.run.jobId, h.file), /invalid/);
    }
});

test("GeoJSON preview validation rejects the retired raster grid response", () => {
    const h = fixture();
    const file = {...h.file, mediaType: "image/tiff"};
    const raster = {jobId: h.run.jobId, artifactId: file.artifactId, sha256: file.sha256,
        kind: "raster", bounds: [0, 0, 1, 1], width: 1, height: 1, values: [42]};
    assert.throws(() => validateArtifactPreview(raster, h.run.jobId, file), /invalid/);
    assert.throws(() => validateArtifactPreview(raster, h.run.jobId, h.file), /invalid/);
});

test("TIFF files cannot request the GeoJSON preview endpoint", async () => {
    const h = fixture(); let requests = 0;
    await assert.rejects(readArtifactPreview(h.run.jobId, {...h.file, mediaType: "image/tiff"}, undefined,
        async () => { requests++; return new Response(JSON.stringify(h.data)); }), /no supported map preview/);
    assert.equal(requests, 0);
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
        updateLayer: () => assert.fail("Unchanged names do not need a presentation update"),
        describe: async source => ({source, version: "a".repeat(64), bounds: [0,0,1,1], capabilities: {pixels: {supported: true}, statistics: {supported: true}}}),
        addRaster: (raster, lifecycle, presentation) => { attachment = {raster, lifecycle, presentation}; copy = lifecycle.copy({kind: "raster"}); }});
    h.file.mediaType = "image/tiff"; h.file.sha256 = "a".repeat(64);
    assert.equal(h.owner.state(h.run.jobId, h.file.artifactId, h.file).canShow, true);
    await h.owner.show(h.run, h.file);
    assert.deepEqual(h.owner.state(h.run.jobId, h.file.artifactId, h.file),
        {canShow: true, onMap: true, busy: false, error: ""});
    assert.deepEqual(attachment.raster.source, {kind: "runArtifact", jobId: h.run.jobId, artifactId: h.file.artifactId});
    assert.deepEqual(attachment.raster.group, {id: h.run.jobId, label: h.run.label, actionLabel: "Delete run and results"});
    assert.equal(attachment.presentation.sourceName, attachment.raster.label);
    assert.deepEqual(attachment.presentation.group, attachment.raster.group);
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
