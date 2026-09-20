import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationController } from "../../src/annotations/controller.js";
import { AnnotationModel } from "../../src/annotations/model.js";

/**
 * Connect controller status behavior to a model and minimal browser/storage substitutes.
 * @return {AnnotationController} Controller with closed panel and successful empty storage.
 */
function controller() {
    const annotations = Object.create(AnnotationController.prototype);
    Object.assign(annotations, {
        model: new AnnotationModel(), loaded: true, dirty: false, saving: false, pendingSave: false,
        panel: { open: false, show() { this.open = true; }, showLayer(key) { this.open = true; this.selectedKey = key; } }, status: { textContent: "" },
        fileStatus: { textContent: "", classList: { add() {}, remove() {} } },
        retryButton: { hidden: true }, createButton: { disabled: true }, importButton: { disabled: true },
        storage: { async load() { return []; }, async save() {} },
        document: { createElement() { return { remove() {} }; } },
    });
    return annotations;
}

test("storage failure reveals Retry saving without discarding unsaved annotation data", async () => {
    const annotations = controller();
    annotations.model.createLayer();
    const before = annotations.model.document();
    annotations.storage.save = async () => { throw new Error("Device storage is full"); };
    await annotations.save();
    assert.equal(annotations.panel.open, true);
    assert.equal(annotations.retryButton.hidden, false);
    assert.equal(annotations.dirty, true);
    assert.match(annotations.status.textContent, /Not saved: Device storage is full/);
    assert.deepEqual(annotations.model.document(), before);
    annotations.panel.open = false;
    annotations.storage.save = async () => {};
    await annotations.save();
    assert.equal(annotations.panel.open, false, "successful autosave does not force tools open");
    assert.equal(annotations.dirty, false);
    assert.equal(annotations.retryButton.hidden, true);
});

test("successful startup leaves panel closed but a storage load failure reveals the panel", async () => {
    const annotations = controller();
    annotations.loaded = false;
    await annotations.load();
    assert.equal(annotations.panel.open, false);
    assert.equal(annotations.createButton.disabled, false);
    const failed = controller();
    failed.loaded = false;
    failed.storage.load = async () => { throw new Error("Cannot open database"); };
    await failed.load();
    assert.equal(failed.panel.open, true);
    assert.equal(failed.loaded, false);
    assert.equal(failed.createButton.disabled, true);
    assert.match(failed.status.textContent, /Cannot open saved annotations/);
});

test("action and export errors open the panel while draft errors stay in the map editor", () => {
    const annotations = controller();
    annotations.perform(() => { throw new Error("Layer limit reached"); });
    assert.equal(annotations.panel.open, true);
    assert.equal(annotations.status.textContent, "Layer limit reached");
    annotations.panel.open = false;
    annotations.exportGeoJSONFile("missing-layer");
    assert.equal(annotations.panel.open, true);
    assert.match(annotations.fileStatus.textContent, /Cannot export GeoJSON/);
    annotations.panel.open = false;
    const layer = annotations.model.createLayer();
    annotations.model.beginPolygon(layer.id);
    let editorMessage;
    annotations.renderEditor = message => { editorMessage = message; };
    annotations.perform(() => annotations.model.savePolygon());
    assert.match(editorMessage, /at least 3 vertices/);
    assert.equal(annotations.panel.open, false);
    assert.ok(annotations.model.draft);
});

test("polygon deletion opens the panel so its existing Undo action remains discoverable", () => {
    const annotations = controller();
    const layer = annotations.model.createLayer();
    annotations.model.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    const polygon = annotations.model.savePolygon();
    annotations.updateEditor = () => {};
    annotations.refreshLayer = () => {};
    annotations.save = async () => {};
    annotations.deletePolygon(layer.id, polygon.id);
    assert.equal(annotations.panel.open, true);
    assert.equal(annotations.model.deleted.polygon.id, polygon.id);
});

test("callers awaiting a coalesced save wait for the final document, including the restored layer", async () => {
    const annotations = controller();
    let release;
    const documents = [];
    annotations.storage.save = async document => {
        documents.push(document);
        if (documents.length === 1) await new Promise(resolve => { release = resolve; });
    };
    const first = annotations.save();
    const layer = annotations.model.createLayer();
    let finished = false;
    const second = annotations.save().then(() => { finished = true; });
    await Promise.resolve();
    assert.equal(finished, false);
    release();
    await Promise.all([first, second]);
    assert.equal(documents.length, 2);
    assert.equal(documents[1].layers[0].id, layer.id);
    assert.equal(annotations.dirty, false);
});

test("failed Undo persistence can retry without overwriting the restored annotation's edits", async () => {
    const annotations = controller();
    annotations.restoredLayers = new WeakMap();
    annotations.layers = new Map(); annotations.controls = new Map();
    annotations.attachLayer = () => {};
    annotations.mapLayers = { reorder() {}, snapshots: () => annotations.model.layers };
    const layer = annotations.model.createLayer();
    const snapshot = { local: structuredClone(layer), key: `local:annotation:${layer.id}`, index: 0 };
    annotations.model.layers = [];
    annotations.storage.save = async () => { throw new Error("Device storage is full"); };
    await assert.rejects(annotations.restoreRemovedLayer(snapshot, () => true), /Device storage is full/);
    const restored = annotations.model.layer(layer.id);
    restored.name = "Edited after restoring";
    annotations.storage.save = async () => {};
    await annotations.restoreRemovedLayer(snapshot, () => true);
    assert.equal(annotations.model.layer(layer.id), restored);
    assert.equal(restored.name, "Edited after restoring");
    annotations.model.layers = [structuredClone(restored)];
    await assert.rejects(annotations.restoreRemovedLayer(snapshot, () => true), /already on the map/);
    await assert.rejects(annotations.restoreRemovedLayer(snapshot, () => false), /superseded/);
});

test("sharing reads the last device-saved polygons while a new save is pending or fails", async () => {
    const annotations = controller();
    const layer = annotations.model.createLayer();
    await annotations.save();
    const saved = annotations.sharableLayers();
    let release;
    annotations.storage.save = () => new Promise(resolve => { release = resolve; });
    layer.name = "Changed layer";
    const saving = annotations.save();
    assert.deepEqual(annotations.sharableLayers(), saved);
    release(); await saving;
    assert.equal(annotations.sharableLayers()[0].collection.name, "Changed layer");
    annotations.storage.save = async () => { throw new Error("Storage full"); };
    layer.name = "Unsaved layer";
    await annotations.save();
    assert.equal(annotations.sharableLayers()[0].collection.name, "Changed layer");
});

test("creating a layer announces its identity before saving, while sharing sees only committed data", async () => {
    const annotations = controller();
    annotations.savedSharingLayers = [];
    annotations.attachLayer = () => {};
    const events = []; let release;
    annotations.onLayerCreated = id => events.push(["created", id]);
    annotations.onCommittedChange = () => events.push(["saved", annotations.sharableLayers().map(layer => layer.id)]);
    annotations.storage.save = () => new Promise(resolve => { release = resolve; });
    const id = annotations.createLayer();
    assert.deepEqual(events, [["created", id]]);
    assert.deepEqual(annotations.sharableLayers(), []);
    release(); await annotations.savePromise;
    assert.deepEqual(events, [["created", id], ["saved", [id]]]);
    annotations.storage.save = async () => { throw new Error("Storage full"); };
    const unsavedId = annotations.createLayer(); await annotations.savePromise;
    assert.equal(annotations.sharableLayers().some(layer => layer.id === unsavedId), false);
    annotations.loaded = false;
    assert.throws(() => annotations.createLayer(), /not available/);
});


test("session guidance updates independently of polygon contents and clears on leave", () => {
    const annotations = controller();
    const label = { share: {}, sharing: {}, revealDrawing() { this.revealed = true; } };
    annotations.controls = new Map([["layer", label]]);
    annotations.setShareLabel("layer", "Shared · Saved", "Watershed planning");
    assert.equal(label.sharing.textContent, "Shared with Watershed planning");
    assert.equal(label.sharing.hidden, false);
    annotations.revealDrawing("layer");
    assert.equal(label.revealed, true);
    assert.equal(annotations.model.draft, null);
    annotations.setShareLabel("layer", "Share");
    assert.equal(label.sharing.hidden, true);
});

test("successful local saves clear the transient status instead of retaining a success paragraph", async () => {
    const annotations = controller();
    let finish;
    annotations.storage.save = () => new Promise(resolve => { finish = resolve; });
    const saving = annotations.save();
    assert.match(annotations.status.textContent, /Saving/);
    finish(); await saving;
    assert.equal(annotations.status.textContent, "");
    assert.equal(annotations.panel.open, false);
});
