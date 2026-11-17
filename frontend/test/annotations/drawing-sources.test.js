import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationController } from "../../src/annotations/controller.js";
import { AnnotationModel, readAnnotationLayers } from "../../src/annotations/model.js";
import { DrawingSourceApi, DrawingSourceError } from "../../src/annotations/source-api.js";
import { exportDrawingCollection } from "../../src/annotations/source-document.js";

const SOURCE = "11111111-1111-4111-8111-111111111111";

/** Construct a linked-drawing owner with real model/save behavior and explicit I/O boundaries.
 * @return {Object} Controller, original layer, recorded storage/HTTP calls and a mutable server record.
 */
function fixture() {
    let sequence = 0;
    const controller = Object.create(AnnotationController.prototype);
    const model = new AnnotationModel([], () => `view-${++sequence}`);
    const layer = model.createLayer();
    layer.name = "Original drawing";
    layer.polygons = [
        {id: "parcel-a", name: "Duplicate name", note: "First", vertices: [[0, 0], [2, 0], [0, 2]]},
        {id: "parcel-b", name: "Duplicate name", note: "Second", vertices: [[3, 0], [5, 0], [3, 2]]},
    ];
    const saved = [], calls = [], records = new Map();
    const server = {record: null};
    const sourceApi = {
        async create(localLayerId, collection) {
            calls.push({method: "POST", localLayerId, collection: structuredClone(collection)});
            server.record ??= {id: SOURCE, revision: 1, collection: structuredClone(collection), canEdit: true};
            return structuredClone(server.record);
        },
        async get(id) { assert.equal(id, SOURCE); calls.push({method: "GET"}); return structuredClone(server.record); },
        async update(id, expectedRevision, collection) {
            calls.push({method: "PUT", id, expectedRevision, collection: structuredClone(collection)});
            if (server.record.revision !== expectedRevision) throw new DrawingSourceError("Drawing changed. Reopen before saving.", 409);
            server.record = {...server.record, revision: expectedRevision + 1, collection: structuredClone(collection)};
            return structuredClone(server.record);
        },
    };
    Object.assign(controller, {model, sourceApi, loaded: true, layers: new Map(), controls: new Map(), shared: new Map(),
        savedDrawingContents: new Map(), creatingDrawingSources: new Map(), unavailableDrawingSources: new Set(),
        savedSharingLayers: [], dirty: false, pendingSave: false, savePromise: null, saving: false,
        status: {textContent: ""}, retryButton: {hidden: true}, drawButton: {}, importButton: {},
        panel: {show() {}}, clearedFilterLayerIds: new Set(), restoredLayers: new WeakMap(),
        storage: {async save(document) { saved.push(structuredClone(document)); }},
        refreshLayer() {}, updateEditor() {},
        attachLayer(value) {
            this.layers.set(value.id, {});
            this.controls.set(value.id, {setDrawingSource(canEdit) { this.canEdit = canEdit; }});
            records.set(`local:annotation:${value.id}`, {entry: {legendIncluded: true}});
        },
        mapLayers: {
            getRecord(key) { return records.get(key); },
            setLegendIncluded(key, included) { records.get(key).entry.legendIncluded = included; },
            reorder() {}, snapshots() { return controller.model.layers; },
            removeKey(key) {
                const id = key.slice("local:annotation:".length);
                controller.model.layers = controller.model.layers.filter(value => value.id !== id);
                controller.layers.delete(id); records.delete(key);
                controller.savedDrawingContents.delete(id); controller.unavailableDrawingSources.delete(id);
            },
        },
    });
    controller.attachLayer(layer);
    return {controller, layer, saved, calls, server, key: `local:annotation:${layer.id}`};
}

/** Return this view's portable definition with an independently chosen filter.
 * @param {Object} fixture Drawing fixture. @return {Object} Geometry-free definition.
 */
function definition({controller, key}) { return {...controller.exportDrawingLayer(key), customName: "Independent view"}; }

test("ordinary drawings remain local until explicitly linked; linking includes filtered-out original IDs", async () => {
    const h = fixture();
    assert.equal(h.controller.exportDrawingLayer(h.key), null, "portable maps omit device-only drawings");
    h.layer.polygons[0].name = " Duplicate name ";
    h.layer.filter = {enabled: true, match: "all", rules: [{field: "name", operator: "eq", value: "Nothing"}]};
    await h.controller.save();
    assert.deepEqual(h.calls, []);
    await Promise.all([h.controller.ensureDrawingSource(h.key), h.controller.ensureDrawingSource(h.key)]);
    assert.equal(h.calls.filter(call => call.method === "POST").length, 1);
    assert.deepEqual(h.server.record.collection.features.map(feature => feature.id), ["parcel-a", "parcel-b"]);
    assert.equal(h.server.record.collection.features[0].properties.name, " Duplicate name ");
    assert.equal(h.controller.exportDrawingLayer(h.key).drawingLayerId, SOURCE);
    assert.equal(Object.hasOwn(h.controller.exportDrawingLayer(h.key), "collection"), false);
    assert.deepEqual(h.controller.sharableLayers(), [], "linked sources never become live collaboration contributions");
    h.layer.name = "View label"; h.layer.style.color = "#123456"; h.layer.visible = false;
    await h.controller.save();
    assert.equal(h.calls.filter(call => call.method === "PUT").length, 0);
    assert.equal(h.server.record.collection.name, "Original drawing");
    assert.equal(h.saved.at(-1).layers[0].drawingSource.pending, false);
    h.controller.model.beginPolygon(h.layer.id);
    await assert.rejects(h.controller.ensureDrawingSource(h.key), /unfinished polygon/);
});

test("edits made during a failed source request remain in the persisted local document", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    let started, release;
    const began = new Promise(resolve => { started = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    h.controller.sourceApi.update = async () => { started(); await wait; throw new Error("Offline"); };
    h.layer.polygons[0].note = "First change";
    const saving = h.controller.save(); await began;
    h.layer.polygons[0].note = "Change made while saving";
    const latest = h.controller.save(); release();
    await Promise.all([saving, latest]);
    assert.equal(h.saved.at(-1).layers[0].polygons[0].note, "Change made while saving");
    assert.equal(h.saved.at(-1).layers[0].drawingSource.pending, true);
    assert.equal(h.saved.at(-1).layers[0].drawingSource.revision, 1);
    assert.match(h.controller.status.textContent, /Offline/);
});

test("coalesced linked saves persist locally first and retain changes arriving during the request", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    let release, started;
    const began = new Promise(resolve => { started = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const update = h.controller.sourceApi.update;
    let first = true;
    h.controller.sourceApi.update = async (...args) => {
        if (first) { first = false; started(); await wait; }
        return update(...args);
    };
    h.layer.polygons[0].note = "First change";
    const saving = h.controller.save(); await began;
    assert.equal(h.saved.at(-1).layers[0].polygons[0].note, "First change");
    assert.equal(h.saved.at(-1).layers[0].drawingSource.pending, true);
    h.layer.polygons[0].note = "Latest change";
    const latest = h.controller.save(); release();
    await Promise.all([saving, latest]);
    const writes = h.calls.filter(call => call.method === "PUT");
    assert.deepEqual(writes.map(call => call.expectedRevision), [1, 2]);
    assert.deepEqual(writes.map(call => call.collection.features[0].properties.note), ["First change", "Latest change"]);
    assert.equal(h.saved.at(-1).layers[0].drawingSource.revision, 3);
    assert.equal(h.saved.at(-1).layers[0].drawingSource.pending, false);
    assert.equal(h.controller.dirty, false);
});

test("failed and conflicting source writes retain local edits and never acquire a newer revision to overwrite them", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    const update = h.controller.sourceApi.update;
    h.controller.sourceApi.update = async () => { throw new Error("Offline"); };
    h.layer.polygons[0].note = "Unsaved choice";
    await h.controller.save();
    assert.equal(h.saved.at(-1).layers[0].drawingSource.pending, true);
    assert.equal(h.controller.retryButton.hidden, false);
    assert.equal(h.controller.dirty, true);
    h.controller.sourceApi.update = update;
    h.server.record.revision = 2;
    await h.controller.retrySaving();
    assert.equal(h.layer.drawingSource.revision, 1);
    assert.equal(h.layer.polygons[0].note, "Unsaved choice");
    assert.equal(h.layer.drawingSource.pending, true);
    assert.match(h.controller.status.textContent, /changed/);
    const calls = h.calls.length;
    await assert.rejects(h.controller.restoreDrawingLayer(definition(h), () => true), /local changes/);
    assert.equal(h.calls.length, calls, "reopening cannot fetch a new revision to overwrite pending edits");
});

test("a source acknowledgement cannot overwrite edits made in another local view while saving", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    await h.controller.restoreDrawingLayer(definition(h), () => true);
    const peer = h.controller.model.layers[0];
    let release, started;
    const began = new Promise(resolve => { started = resolve; });
    const wait = new Promise(resolve => { release = resolve; });
    const update = h.controller.sourceApi.update;
    let first = true;
    h.controller.sourceApi.update = async (...args) => {
        if (first) { first = false; started(); await wait; }
        return update(...args);
    };
    h.layer.polygons[0].note = "First view edit";
    const saving = h.controller.save(); await began;
    peer.polygons[0].note = "Other view edit";
    const latest = h.controller.save(); release();
    await Promise.all([saving, latest]);
    assert.equal(h.server.record.collection.features[0].properties.note, "First view edit");
    assert.equal(peer.polygons[0].note, "Other view edit");
    assert.equal(peer.drawingSource.revision, 1);
    assert.equal(peer.drawingSource.pending, true);
    assert.match(h.controller.status.textContent, /changed in another tab/);
});

test("reopening uses latest polygons in independent views while preserving IDs and local settings", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    h.server.record.revision = 2;
    h.server.record.collection.features[0].properties.note = "Changed remotely";
    const view = definition(h);
    view.filter = {enabled: true, match: "all", rules: [{field: "note", operator: "eq", value: "Changed remotely"}]};
    const key = await h.controller.restoreDrawingLayer(view, () => true);
    assert.notEqual(key, h.key);
    const restored = h.controller.model.layers[0];
    assert.deepEqual(restored.polygons.map(polygon => polygon.id), ["parcel-a", "parcel-b"]);
    assert.equal(restored.polygons[0].note, "Changed remotely");
    assert.equal(h.layer.polygons[0].note, "Changed remotely");
    assert.deepEqual(h.layer.filter.rules, []);
    assert.equal(restored.filter.enabled, true);
    assert.equal(restored.name, "Independent view");
    assert.doesNotThrow(() => readAnnotationLayers(h.controller.model.document()));
    restored.polygons[0].note = "Changed in this view";
    await h.controller.save();
    assert.equal(h.layer.polygons[0].note, "Changed in this view");
    assert.equal(h.layer.drawingSource.revision, 3);
    assert.equal(restored.drawingSource.revision, 3);
    assert.equal(h.server.record.collection.name, "Original drawing");
});

test("out-of-order drawing reads cannot replace a newer source admitted by another view", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    const view = definition(h), old = structuredClone(h.server.record);
    const latest = structuredClone(old);
    latest.revision = 2; latest.collection.features[0].properties.note = "Latest saved polygons";
    await h.controller.prepareDrawingMapRestore(() => true);
    const reads = [];
    h.controller.sourceApi.get = () => new Promise(resolve => reads.push(resolve));
    const earlier = h.controller.restoreDrawingLayer(view, () => true);
    const rejection = assert.rejects(earlier, /changed while it was opening/);
    const later = h.controller.restoreDrawingLayer({...view, customName: "Latest view"}, () => true);
    reads[1](latest); const key = await later;
    reads[0](old); await rejection;
    assert.equal(h.controller.model.layers.length, 1);
    assert.equal(h.controller.exportDrawingLayer(key).customName, "Latest view");
    assert.equal(h.controller.model.layers[0].drawingSource.revision, 2);
    assert.equal(h.controller.model.layers[0].polygons[0].note, "Latest saved polygons");
    assert.equal(h.saved.at(-1).layers[0].drawingSource.revision, 2);
});

test("a delayed read cannot undo a successful polygon save in an existing view", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    const old = structuredClone(h.server.record);
    let release;
    h.controller.sourceApi.get = () => new Promise(resolve => { release = resolve; });
    const restoring = h.controller.restoreDrawingLayer(definition(h), () => true);
    const rejection = assert.rejects(restoring, /changed while it was opening/);
    h.layer.polygons[0].note = "Newly saved polygon";
    await h.controller.save();
    assert.equal(h.layer.drawingSource.revision, 2);
    release(old); await rejection;
    assert.equal(h.controller.model.layers.length, 1);
    assert.equal(h.layer.polygons[0].note, "Newly saved polygon");
    assert.equal(h.layer.drawingSource.revision, 2);
    assert.equal(h.layer.drawingSource.pending, false);
});

test("another browser's drawing is read-only but still supports local filters, styles and references", async () => {
    const h = fixture();
    h.server.record = {id: SOURCE, revision: 1, collection: exportDrawingCollection(h.layer), canEdit: false};
    const view = {drawingLayerId: SOURCE, customName: "Shared input", isCustom: true, visible: true, opacity: 1,
        appearance: {...h.layer.style}, filter: {...h.layer.filter}};
    const key = await h.controller.restoreDrawingLayer(view, () => true);
    const restored = h.controller.model.layers[0];
    assert.equal(restored.drawingSource.canEdit, false);
    assert.throws(() => h.controller.deletePolygon(restored.id, restored.polygons[0].id), /read-only/);
    h.controller.beginPolygon(restored.id);
    assert.equal(h.controller.model.draft, null);
    assert.match(h.controller.status.textContent, /read-only/);
    h.controller.model.beginPolygon(restored.id, restored.polygons[0].id);
    assert.throws(() => h.controller.finishPolygon(), /read-only/);
    h.controller.model.cancelPolygon();
    h.controller.model.deletePolygon(restored.id, restored.polygons[0].id);
    assert.throws(() => h.controller.undoPolygonDeletion(), /read-only/);
    h.controller.model.undoDeletion();
    restored.style.color = "#abcdef";
    restored.filter = {enabled: true, match: "all", rules: [{field: "name", operator: "eq", value: "Nothing"}]};
    await h.controller.save();
    assert.equal(await h.controller.ensureDrawingSource(key), SOURCE);
    assert.equal(h.calls.filter(call => call.method === "PUT").length, 0);
    assert.equal(h.controller.exportDrawingLayer(key).appearance.color, "#abcdef");
});

test("saved drawing definitions without a custom label retain the source name", async () => {
    for (const customName of [undefined, null]) {
        const h = fixture(); await h.controller.ensureDrawingSource(h.key);
        await h.controller.restoreDrawingLayer({...definition(h), customName}, () => true);
        assert.equal(h.controller.model.layers[0].name, "Original drawing");
    }
});

test("ordinary map restoration replaces cached drawing views without multiplying them", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    const first = definition(h), second = {...first, customName: "Second view", opacity: 0.4};
    delete second.filter;
    const local = h.controller.model.createLayer(); h.controller.attachLayer(local);
    for (let count = 0; count < 3; count++) {
        await h.controller.prepareDrawingMapRestore(() => true);
        assert.deepEqual(h.controller.model.layers.map(layer => layer.id), [local.id]);
        const keys = await Promise.all([first, second].map(view => h.controller.restoreDrawingLayer(view, () => true)));
        assert.equal(new Set(keys).size, 2, "two views of one source remain distinct");
        const linked = h.controller.model.layers.filter(layer => layer.drawingSource);
        assert.equal(linked.length, 2);
        assert.equal(linked.find(layer => layer.name === "Second view").opacity, 0.4);
        assert.deepEqual(linked.find(layer => layer.name === "Second view").filter.rules, []);
        assert.deepEqual(linked.map(layer => layer.polygons.map(polygon => polygon.id)), [["parcel-a", "parcel-b"], ["parcel-a", "parcel-b"]]);
        assert.equal(h.saved.at(-1).layers.length, 3);
    }
    assert.equal(h.calls.filter(call => call.method === "PUT").length, 0);
});

test("map restoration preserves pending drawing edits, drafts and their original revisions", async () => {
    for (const pending of [false, true]) {
        const h = fixture(); await h.controller.ensureDrawingSource(h.key);
        if (pending) {
            h.layer.polygons[0].note = "Unsent change";
            h.layer.drawingSource.pending = true;
        } else h.controller.model.beginPolygon(h.layer.id, "parcel-a");
        await h.controller.prepareDrawingMapRestore(() => true);
        assert.equal(h.controller.model.layers[0], h.layer);
        assert.equal(h.layer.drawingSource.revision, 1);
        assert.ok(h.controller.layers.has(h.layer.id));
        assert.equal(h.controller.model.draft !== null, !pending);
        await assert.rejects(h.controller.restoreDrawingLayer(definition(h), () => true), /local changes/);
    }
});

test("replacing a clean view cannot discard a conflicting edit or draft in another view", async () => {
    for (const draft of [false, true]) {
        const h = fixture(); await h.controller.ensureDrawingSource(h.key);
        const cleanKey = await h.controller.restoreDrawingLayer(definition(h), () => true);
        if (draft) h.controller.model.beginPolygon(h.layer.id, "parcel-a");
        else {
            h.layer.polygons[0].note = "Conflicting local edit";
            h.layer.drawingSource.pending = true;
            h.server.record.revision = 2;
        }
        await h.controller.prepareDrawingMapRestore(() => true);
        assert.equal(h.controller.mapLayers.getRecord(cleanKey), undefined);
        assert.deepEqual(h.controller.model.layers.map(layer => layer.id), [h.layer.id]);
        assert.equal(h.layer.drawingSource.revision, 1);
        assert.equal(h.controller.model.draft !== null, draft);
        if (!draft) {
            assert.equal(h.layer.polygons[0].note, "Conflicting local edit");
            assert.equal(h.saved.at(-1).layers[0].polygons[0].note, "Conflicting local edit");
            assert.equal(h.layer.drawingSource.pending, true);
            assert.match(h.controller.status.textContent, /changed in another tab/);
        }
    }
});

test("full-map restore also removes clean cached views that were not attached in a shared viewer", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    h.controller.layers.delete(h.layer.id);
    await h.controller.prepareDrawingMapRestore(() => true);
    assert.deepEqual(h.controller.model.layers, []);
    assert.equal(h.controller.savedDrawingContents.has(h.layer.id), false);
    assert.equal(h.saved.at(-1).layers.length, 0);
    assert.equal(h.calls.filter(call => call.method === "PUT").length, 0);
});

test("a superseded map restoration cannot remove drawings after waiting for a save", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    let release, current = true;
    h.controller.savePromise = new Promise(resolve => { release = resolve; });
    const restoring = h.controller.prepareDrawingMapRestore(() => current);
    current = false; release(); await restoring;
    assert.equal(h.controller.model.layers[0], h.layer);
    assert.ok(h.controller.layers.has(h.layer.id));
});

test("undoing a clean drawing-view removal restores latest source content without writing it", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    h.layer.name = "Local view";
    const snapshot = {key: h.key, index: 0, local: structuredClone(h.layer)};
    h.controller.mapLayers.removeKey(h.key);
    h.server.record.revision = 2;
    h.server.record.collection.features[0].properties.note = "Updated after removal";
    await h.controller.restoreRemovedLayer(snapshot, () => true);
    const restored = h.controller.model.layers[0];
    assert.equal(restored.name, "Local view");
    assert.equal(restored.polygons[0].note, "Updated after removal");
    assert.equal(restored.drawingSource.revision, 2);
    assert.equal(restored.drawingSource.pending, false);
    assert.equal(h.calls.filter(call => call.method === "PUT").length, 0);
});

test("undoing removal of pending source edits preserves their original revision and reports conflicts", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    h.layer.polygons[0].note = "Unsaved local choice";
    h.layer.drawingSource.pending = true;
    const snapshot = {key: h.key, index: 0, local: structuredClone(h.layer)};
    h.controller.mapLayers.removeKey(h.key);
    h.server.record.revision = 2;
    await assert.rejects(h.controller.restoreRemovedLayer(snapshot, () => true), /changed in another tab/);
    const restored = h.controller.model.layers[0];
    assert.equal(restored.polygons[0].note, "Unsaved local choice");
    assert.equal(restored.drawingSource.revision, 1);
    assert.equal(restored.drawingSource.pending, true);
    assert.equal(h.calls.filter(call => call.method === "GET").length, 0);
});

test("polygon deletion and its Undo update the source while retaining the original polygon ID", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    h.controller.deletePolygon(h.layer.id, "parcel-a"); await h.controller.savePromise;
    assert.deepEqual(h.server.record.collection.features.map(feature => feature.id), ["parcel-b"]);
    h.controller.undoPolygonDeletion(); await h.controller.savePromise;
    assert.deepEqual(h.server.record.collection.features.map(feature => feature.id), ["parcel-a", "parcel-b"]);
});

test("startup refresh preserves pending local changes and never substitutes a newer source revision", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    h.layer.polygons[0].note = "Local unsaved edit";
    h.layer.drawingSource.pending = true;
    h.controller.savedDrawingContents.clear();
    h.server.record.revision = 2;
    h.server.record.collection.features[0].properties.note = "Remote edit";
    await h.controller.refreshDrawingSources();
    assert.equal(h.layer.polygons[0].note, "Local unsaved edit");
    assert.equal(h.layer.drawingSource.revision, 1);
    await h.controller.save();
    assert.equal(h.layer.drawingSource.pending, true);
    assert.match(h.controller.status.textContent, /changed/);
});

test("startup presents Retry for device-saved changes that have not reached their source", async () => {
    const h = fixture(); await h.controller.ensureDrawingSource(h.key);
    h.layer.polygons[0].note = "Local unsaved edit";
    h.layer.drawingSource.pending = true;
    const document = h.controller.model.document();
    h.controller.storage.load = async () => structuredClone(document.layers);
    h.controller.savedDrawingContents.clear(); h.controller.loaded = false;
    await h.controller.load();
    assert.equal(h.controller.model.layers[0].polygons[0].note, "Local unsaved edit");
    assert.equal(h.controller.retryButton.hidden, false);
    assert.match(h.controller.status.textContent, /saved only on this device/);
    assert.equal(h.controller.dirty, true);
});

test("drawing API preserves exact source content and expected revisions through private same-site HTTP", async () => {
    const h = fixture(); const collection = exportDrawingCollection(h.layer), calls = [];
    const api = new DrawingSourceApi(async (url, options) => {
        calls.push({url, options});
        return Response.json({id: SOURCE, revision: options.method === "PUT" ? 2 : 1, collection, canEdit: true});
    });
    await api.create(h.layer.id, collection); await api.get(SOURCE); await api.update(SOURCE, 1, collection);
    assert.deepEqual(calls.map(call => call.options.method), ["POST", "GET", "PUT"]);
    for (const {options} of calls) { assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store"); }
    assert.equal(calls[0].options.headers["X-EOLab-Drawings"], "1");
    assert.deepEqual(JSON.parse(calls[2].options.body), {expectedRevision: 1, collection});
    assert.deepEqual(JSON.parse(calls[0].options.body), {localLayerId: h.layer.id, collection});
    await assert.rejects(api.get("../../source"), DrawingSourceError);
    const conflict = new DrawingSourceApi(async () => Response.json({detail: "Another tab saved first."}, {status: 409}));
    await assert.rejects(conflict.update(SOURCE, 1, collection), error => error.status === 409 && /Another tab/.test(error.message));
});
