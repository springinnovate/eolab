import test from "node:test";
import assert from "node:assert/strict";
import { AnnotationController } from "../../src/annotations/controller.js";
import { AnnotationModel } from "../../src/annotations/model.js";
import { exportAnnotationGeoJSON } from "../../src/annotations/geojson.js";

/**
 * Connect controller status behavior to a model and minimal browser/storage substitutes.
 * @return {AnnotationController} Controller with closed panel and successful empty storage.
 */
function controller() {
    const annotations = Object.create(AnnotationController.prototype);
    Object.assign(annotations, {
        model: new AnnotationModel(), layers: new Map(), shared: new Map(), loaded: true, dirty: false, saving: false, pendingSave: false,
        controls: new Map(), inspectionMatches: [], inspectedPolygon: null, hoverCard: { hide() {}, setEnabled() {} },
        panel: { open: false, show() { this.open = true; }, showLayer(key) { this.open = true; this.selectedKey = key; } }, status: { textContent: "" },
        fileStatus: { textContent: "", classList: { add() {}, remove() {} } },
        retryButton: { hidden: true }, importButton: { disabled: true },
        storage: { async load() { return []; }, async save() {} },
        document: { createElement() { return { remove() {} }; } },
    });
    return annotations;
}

test("shared viewer keeps private layers stored but never attaches or exposes them as summary targets", async () => {
    const annotations = controller();
    const privateLayer = annotations.model.createLayer("Private notes");
    privateLayer.name = "Private notes";
    const original = annotations.model.document();
    const attached = [];
    annotations.storage.load = async () => structuredClone(original.layers);
    annotations.attachLayer = layer => { attached.push(layer.id); annotations.layers.set(layer.id, {}); };
    await annotations.load({ attachSavedLayers: false });
    assert.deepEqual(attached, []);
    assert.deepEqual(annotations.summaryTargets(), []);
    await annotations.restoreSharedContribution("Included shared layer", { type: "FeatureCollection", features: [] });
    assert.equal(attached.length, 1);
    assert.equal(annotations.model.layer(privateLayer.id).name, "Private notes");
    assert.equal(annotations.sharableLayers().some(layer => layer.id === privateLayer.id), true, "private data is retained during saves");
    assert.equal(annotations.summaryTargets().length, 1);
});

/** Connect the drawing lifecycle to the real model and recorded presentation/save boundaries.
 * @return {Object} Controller, layer and observed UI transitions.
 */
function drawingController() {
    const annotations = controller();
    const layer = annotations.model.createLayer("Habitat areas");
    const calls = [];
    annotations.controls = new Map([[layer.id, { clearPolygonInspection() {}, refresh() { calls.push("controls"); } }]]);
    annotations.layers = new Map();
    annotations.undoButton = {};
    annotations.onEditingChange = editing => calls.push(["editing", editing]);
    annotations.mapLayers = { setVisible() {} };
    annotations.editor = {
        render(draft, message, style, name) { calls.push(["render", !!draft, name]); },
        showPolygonTextEditor(name, polygon) { calls.push(["complete", name, polygon.id]); },
        closePolygonTextEditor() { calls.push("close"); },
        hasUnsavedText() { return false; }, textError: {},
    };
    annotations.refreshLayer = (...args) => calls.push(["refresh", ...args]);
    return { annotations, layer, calls };
}

/** @return {Object} Real annotation owner/model with observable panel, hit and highlight boundaries. */
function inspectionController() {
    const annotations = controller();
    const layer = annotations.model.createLayer("Habitats");
    layer.name = "Habitats";
    annotations.model.beginPolygon(layer.id);
    for (const vertex of [[0, 0], [2, 0], [1, 2]]) annotations.model.addVertex(vertex);
    const own = annotations.model.savePolygon();
    const peer = { ...own, id: "peer-0", name: "A neighbour's polygon", contributor: "Maria" };
    annotations.shared.set(layer.id, { contributors: [{ own: true, name: "Lee" }], polygons: [peer], canContribute: true });
    const controls = { inspection: { scrollIntoView() {} }, clearPolygonInspection() { this.hit = null; },
        showPolygonInspection(hit, matches, select) { Object.assign(this, { hit, matches, select }); }, setCollaboration() {} };
    const rendering = { polygonsAt: () => annotations.displayLayer(layer).polygons.slice().reverse(),
        setInspectedPolygon(id) { this.highlight = id; }, refresh() {} };
    annotations.layers.set(layer.id, rendering); annotations.controls.set(layer.id, controls);
    annotations.mapLayers = { render() {} };
    return { annotations, layer, own, peer, controls, rendering };
}

test("click selects the topmost peer read-only and offers the author's own polygon without changing ownership", () => {
    const h = inspectionController();
    assert.equal(h.annotations.inspectAt({ lat: 0.5, lng: 1 }), true);
    assert.equal(h.controls.hit.polygon.id, h.peer.id);
    assert.equal(h.controls.hit.canEdit, false);
    assert.equal(h.rendering.highlight, h.peer.id);
    assert.equal(h.annotations.panel.selectedKey, `local:annotation:${h.layer.id}`);
    h.controls.select(1);
    assert.equal(h.controls.hit.polygon.id, h.own.id);
    assert.equal(h.controls.hit.canEdit, true);
    assert.equal(h.rendering.highlight, h.own.id);
    h.annotations.shared.get(h.layer.id).canContribute = false;
    h.annotations.refreshInspection();
    assert.equal(h.controls.hit.canEdit, false, "a membership change removes editing actions");
});

test("hiding, filtering, deleting, drawing and empty clicks cannot retain stale polygon details", () => {
    const h = inspectionController();
    const click = () => h.annotations.inspectAt({ lat: 0.5, lng: 1 });
    click(); h.layer.visible = false; h.annotations.refreshInspection();
    assert.equal(h.controls.hit, null); assert.equal(h.rendering.highlight, null);
    assert.equal(click(), false);
    h.layer.visible = true; click(); h.layer.filter = "no match"; h.annotations.refreshInspection();
    assert.equal(h.controls.hit, null);
    h.layer.filter = ""; click(); h.annotations.shared.get(h.layer.id).polygons = []; h.annotations.refreshInspection();
    assert.equal(h.controls.hit, null);
    click(); h.layer.polygons = []; h.annotations.refreshInspection();
    assert.equal(h.controls.hit, null);
    h.layer.polygons = [h.own]; h.annotations.model.beginPolygon(h.layer.id);
    assert.equal(click(), false);
    h.annotations.model.cancelPolygon(); h.layer.opacity = 0;
    assert.equal(click(), false);
});

test("layer order decides overlapping hits and background updates do not reopen or focus the panel", () => {
    const h = inspectionController();
    const upper = h.annotations.model.createLayer("Upper layer");
    upper.name = "Upper layer";
    upper.position = 0; h.layer.position = 1;
    h.annotations.layers.set(upper.id, { polygonsAt: () => [h.peer] });
    assert.deepEqual(h.annotations.polygonsAt({ lat: 0.5, lng: 1 }).map(hit => hit.layerName), ["Upper layer", "Habitats", "Habitats"]);
    h.annotations.layers.delete(upper.id);
    h.annotations.inspectAt({ lat: 0.5, lng: 1 }); h.controls.select(1);
    h.annotations.panel.open = false;
    h.own.note = "Updated note"; h.annotations.refreshInspection();
    assert.equal(h.controls.hit.polygon.note, "Updated note");
    assert.equal(h.annotations.panel.open, false);
});

test("replacing a peer contribution clears its selection instead of selecting a reused positional ID", () => {
    const h = inspectionController();
    h.annotations.inspectAt({ lat: 0.5, lng: 1 });
    const collection = exportAnnotationGeoJSON(h.layer);
    collection.features[0].id = h.peer.id;
    collection.features[0].properties.contributor = "Maria";
    h.annotations.updateSharedLayer(h.layer.id, { contributors: [], collections: [collection], canContribute: true });
    assert.equal(h.controls.hit, null);
    assert.equal(h.rendering.highlight, null);
});

test("finish offers private naming; Save commits text and drawing another retains the first polygon", async () => {
    const { annotations, layer, calls } = drawingController();
    annotations.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    annotations.finishPolygon();
    const polygon = layer.polygons[0];
    assert.equal(annotations.model.draft, null);
    assert.deepEqual(annotations.textEditingPolygon, { layerId: layer.id, polygonId: polygon.id });
    assert.ok(calls.some(call => call[0] === "complete" && call[1] === layer.name));
    assert.deepEqual(calls.filter(call => call[0] === "editing").at(-1), ["editing", true], "keep map space and pause inspection while naming");
    annotations.savePolygonText("River corridor", "Connect habitats");
    await annotations.save();
    assert.equal(annotations.sharableLayers()[0].collection.features[0].properties.name, "River corridor");
    assert.equal(polygon.note, "Connect habitats");
    annotations.beginPolygon(layer.id);
    assert.equal(annotations.textEditingPolygon, null);
    assert.equal(annotations.model.draft.layerId, layer.id);
    assert.equal(annotations.model.draft.isNew, true);
    assert.equal(layer.polygons[0], polygon);
    assert.equal(layer.polygons.length, 1);
});

test("Cancel preserves committed geometry and text; existing geometry edits skip text editing", async () => {
    const { annotations, layer, calls } = drawingController();
    annotations.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    annotations.finishPolygon();
    await annotations.save();
    const before = annotations.model.document();
    let writes = 0; annotations.storage.save = async () => { writes++; };
    annotations.endPolygonTextEditing();
    assert.deepEqual(calls.filter(call => call[0] === "editing").at(-1), ["editing", false]);
    assert.deepEqual(annotations.model.document(), before);
    assert.equal(writes, 0, "Cancel is not a second save");
    annotations.beginPolygon(layer.id, layer.polygons[0].id);
    annotations.model.draft.polygon.vertices[0] = [-1, 0];
    calls.length = 0;
    annotations.finishPolygon();
    assert.equal(annotations.textEditingPolygon, null);
    assert.equal(calls.some(call => call[0] === "complete"), false);
    assert.deepEqual(layer.polygons[0].vertices[0], [-1, 0]);
});

test("text edits stay outside saved/exported/shared data; Save writes once and Cancel writes nothing", async () => {
    const { annotations, layer } = drawingController();
    annotations.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    annotations.finishPolygon();
    await annotations.savePromise;
    const polygon = layer.polygons[0];
    const original = structuredClone(polygon);
    const writes = []; let shared = 0;
    annotations.storage.save = async document => writes.push(structuredClone(document));
    annotations.onCommittedChange = () => { shared++; };
    annotations.editor.hasUnsavedText = () => true;
    assert.equal(annotations.hasUnsavedChanges(), true, "warn before leaving with a private draft");
    await annotations.save(); // A visibility/style save must not leak text drafts.
    assert.equal(annotations.sharableLayers()[0].collection.features[0].properties.name, original.name);
    assert.deepEqual(polygon, original);
    writes.length = 0; shared = 0;
    annotations.savePolygonText("Corridor", "A complete note");
    await annotations.savePromise;
    assert.equal(writes.length, 1);
    assert.equal(shared, 1);
    assert.equal(polygon.name, "Corridor");
    assert.equal(polygon.note, "A complete note");
    assert.equal(annotations.hasUnsavedChanges(), false);
    annotations.editPolygonText(layer.id, polygon.id);
    annotations.endPolygonTextEditing();
    assert.equal(polygon.note, "A complete note");
    assert.equal(writes.length, 1, "Cancel must not persist or share");
});

test("switching polygon or shape keeps dirty text open; unchanged text can close without a write", () => {
    const { annotations, layer } = drawingController();
    annotations.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    annotations.finishPolygon();
    const active = annotations.textEditingPolygon;
    annotations.editor.hasUnsavedText = () => true;
    annotations.beginPolygon(layer.id);
    assert.match(annotations.editor.textError.textContent, /Save or cancel/);
    assert.equal(annotations.model.draft, null);
    assert.equal(annotations.textEditingPolygon, active);
    assert.throws(() => annotations.editPolygonText(layer.id, "another"), /Save or cancel/);
    assert.throws(() => annotations.deletePolygon(layer.id, active.polygonId), /Save or cancel/);
    assert.equal(layer.polygons.length, 1);
    annotations.editor.hasUnsavedText = () => false;
    annotations.beginPolygon(layer.id, active.polygonId);
    assert.equal(annotations.textEditingPolygon, null);
    assert.equal(annotations.model.draft.polygon.id, active.polygonId);
});

test("text saves respect ownership and length limits, preserving the draft on rejection", () => {
    const { annotations, layer } = drawingController();
    assert.throws(() => annotations.editPolygonText(layer.id, "peer-polygon"), /Only your own/);
    annotations.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    annotations.finishPolygon();
    const before = structuredClone(layer.polygons[0]);
    assert.throws(() => annotations.savePolygonText("x".repeat(161), ""), /160/);
    assert.throws(() => annotations.savePolygonText("Valid", "x".repeat(10001)), /10,000/);
    annotations.shared.set(layer.id, { canContribute: false });
    assert.throws(() => annotations.savePolygonText("Changed", ""), /Join this layer/);
    assert.deepEqual(layer.polygons[0], before);
    assert.ok(annotations.textEditingPolygon);
});

test("invalid and canceled drafts never open completion or add polygons", () => {
    const { annotations, layer, calls } = drawingController();
    annotations.beginPolygon(layer.id);
    annotations.model.addVertex([0, 0]);
    assert.throws(() => annotations.finishPolygon(), /at least 3 vertices/);
    assert.ok(annotations.model.draft);
    assert.equal(layer.polygons.length, 0);
    annotations.model.cancelPolygon(); annotations.updateEditor();
    assert.equal(calls.some(call => call[0] === "complete"), false);
});

test("completion text survives failed persistence and deletion dismisses stale completion", async () => {
    const { annotations, layer, calls } = drawingController();
    annotations.storage.save = async () => { throw new Error("Storage full"); };
    annotations.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    annotations.finishPolygon();
    annotations.savePolygonText("Keep this", "Unsaved notes");
    await annotations.save();
    assert.equal(annotations.dirty, true);
    assert.match(annotations.status.textContent, /Storage full/);
    assert.equal(layer.polygons[0].note, "Unsaved notes");
    annotations.storage.save = async () => {};
    await annotations.save();
    assert.equal(annotations.dirty, false);
    annotations.deletePolygon(layer.id, layer.polygons[0].id);
    assert.equal(annotations.textEditingPolygon, null);
    assert.ok(calls.includes("close"));
    annotations.savePolygonText("Late event", "Ignored");
    assert.equal(layer.polygons.length, 0);
});

test("contributor colors update rendering and legends without changing summary geometry or edit ownership", () => {
    const annotations = controller(); const layer = annotations.model.createLayer();
    annotations.model.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point)); annotations.model.savePolygon();
    const peer = exportAnnotationGeoJSON(layer); peer.features[0].id = "peer";
    peer.features[0].properties.contributorId = "other"; peer.features[0].properties.contributor = "Maria";
    annotations.shared = new Map(); annotations.controls = new Map([[layer.id, { setCollaboration() {} }]]);
    let redraws = 0; annotations.layers = new Map([[layer.id, { refresh() { redraws++; } }]]); annotations.mapLayers = { render() {} };
    const data = { collections: [peer], contributors: [{ id: "me", name: "Rich", own: true, color: "#FFBE0B" }, { id: "other", name: "Maria", color: "#FB5607" }] };
    annotations.updateSharedLayer(layer.id, structuredClone(data));
    data.contributors[1].color = "#FF006E";
    assert.equal(annotations.updateSharedLayer(layer.id, data), false, "color changes must not rerun summary calculations");
    assert.equal(redraws, 2);
    assert.deepEqual(annotations.displayLayer(layer).polygons.map(p => p.contributorColor), ["#FFBE0B", "#FF006E"]);
    assert.deepEqual(annotations.layerLegend(layer).entries.map(e => [e.label, e.symbol.fill]), [["Rich (you)", "#FFBE0B"], ["Maria", "#FF006E"]]);
    assert.equal(layer.polygons.length, 1); assert.throws(() => annotations.model.beginPolygon(layer.id, "peer"));
});

test("combined shared polygons are filterable summary inputs but never become editable or uploaded as mine", async () => {
    const annotations = controller();
    const layer = annotations.model.createLayer();
    annotations.model.beginPolygon(layer.id);
    [[0, 0], [2, 0], [1, 2]].forEach(point => annotations.model.addVertex(point));
    annotations.model.savePolygon();
    const peer = exportAnnotationGeoJSON(layer);
    peer.features[0].id = "peer-polygon";
    peer.features[0].properties = { name: "Maria's polygon", note: "River", contributor: "Maria" };
    let rendered = 0;
    annotations.shared = new Map();
    annotations.controls = new Map([[layer.id, { setCollaboration() {} }]]);
    annotations.layers = new Map([[layer.id, { refresh() { rendered++; } }]]);
    annotations.mapLayers = { render() {} };
    const data = { collections: [peer], contributors: [], status: "Saved" };
    assert.equal(annotations.updateSharedLayer(layer.id, data), true);
    assert.equal(annotations.updateSharedLayer(layer.id, data), false);
    assert.equal(rendered, 1, "status polling does not rebuild unchanged polygons");
    assert.equal(annotations.summaryTargets()[0].polygons.length, 2);
    assert.match(annotations.filterTarget(`local:annotation:${layer.id}`).status, /2 of 2/);
    assert.equal(layer.polygons.length, 1);
    assert.throws(() => annotations.model.beginPolygon(layer.id, "peer-polygon"));
    await annotations.save();
    assert.equal(annotations.sharableLayers()[0].collection.features.length, 1);
    layer.filter = "Maria";
    assert.match(annotations.filterTarget(`local:annotation:${layer.id}`).status, /1 of 2/);
});

test("rejoining restores own polygons with safe local identities without retaining supplied IDs", async () => {
    const annotations = controller();
    annotations.attachLayer = () => {};
    const source = { type: "FeatureCollection", name: "Shared", features: [{ type: "Feature", id: 'untrusted"id',
        properties: { name: "Mine", note: "Keep this" }, geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [1, 2], [0, 0]]] } }] };
    const id = await annotations.restoreSharedContribution("Shared", source);
    const restored = annotations.model.layer(id);
    assert.equal(restored.polygons[0].note, "Keep this");
    assert.notEqual(restored.polygons[0].id, source.features[0].id);
    assert.equal(annotations.sharableLayers()[0].collection.features.length, 1);
});

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
    assert.equal(annotations.importButton.disabled, false);
    const failed = controller();
    failed.loaded = false;
    failed.storage.load = async () => { throw new Error("Cannot open database"); };
    await failed.load();
    assert.equal(failed.panel.open, true);
    assert.equal(failed.loaded, false);
    assert.equal(failed.importButton.disabled, true);
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

test("restoring a shared contribution exposes it only after successful device saving", async () => {
    const annotations = controller();
    annotations.savedSharingLayers = [];
    annotations.attachLayer = () => {};
    const events = []; let release;
    annotations.onCommittedChange = () => events.push(["saved", annotations.sharableLayers().map(layer => layer.id)]);
    annotations.storage.save = () => new Promise(resolve => { release = resolve; });
    const collection = { type: "FeatureCollection", features: [] };
    const restoring = annotations.restoreSharedContribution("Shared", collection);
    assert.deepEqual(events, []);
    assert.deepEqual(annotations.sharableLayers(), []);
    release(); const id = await restoring;
    assert.deepEqual(events, [["saved", [id]]]);
    annotations.storage.save = async () => { throw new Error("Storage full"); };
    await assert.rejects(annotations.restoreSharedContribution("Unsaved", collection), /Storage full/);
    assert.deepEqual(annotations.sharableLayers().map(layer => layer.id), [id]);
    annotations.loaded = false;
    await assert.rejects(annotations.restoreSharedContribution("Unavailable", collection), /not available/);
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
