import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {MapLayerController} from "../../src/map-layers/controller.js";
import {ModelOutputLayers, artifactLayerKey} from "../../src/model-output-preview/controller.js";
import {createVectorMapLayerAdapter} from "../../src/vector/map-layer-adapter.js";
import {fileManifest, job} from "../../test-support/models/fixtures.js";

test("generated vectors retain ordinary styling, filters and run ownership across additional views and Undo", async () => {
    const artifacts = fileManifest(), file = artifacts.files[0];
    Object.assign(file, {name: "vector", mediaType: "application/geopackage+sqlite3", filename: "summary.gpkg"});
    const run = job({status: "ready", artifacts, expiresAt: artifacts.expiresAt,
        result: {name: "vector", summaryField: "sum_total_es"}});
    const metadata = {kind: "runArtifact", jobId: run.jobId, artifactId: file.artifactId, layerName: "summary",
        fields: {state_code: "int", sum_total_es: "float"}, featureCount: 2, bbox: [-2, 40, 2, 44], geometryKind: "polygon"};
    const style = {geometryKind: "polygon", fillColor: "#2b83ba", fillOpacity: 1, strokeColor: "#000000",
        strokeOpacity: 1, strokeWidth: 1, pointSize: null, categorical: null, graduated: null, label: null};
    const classifiedFields = [], inspected = [], map = {removeLayer() {}, fitBounds() {}};
    const adapter = createVectorMapLayerAdapter({
        leaflet: {tileLayer: {wms: (_url, options) => ({options, once() {}, on() {}, setOpacity() {}, setZIndex() {},
            addTo() { return this; }, setParams(params) { Object.assign(this.options, params); }})}},
        leafletMap: map, wmsUrl: "/wms", onTileError() {},
        publish: async () => ({layerName: "eolab:summary", styleName: "vector-polygon", bbox: metadata.bbox,
            geometryKind: "polygon", style}),
        classify: async (_source, field, method, requestedClassCount) => {
            classifiedFields.push(field);
            return {field, fieldType: "float", method, requestedClassCount, actualClassCount: 2,
                classes: [{minimum: null, maximum: 5, count: 1}, {minimum: 5, maximum: null, count: 1}],
                observedMinimum: 1, observedMaximum: 7, numericValueCount: 2, scannedFeatureCount: 2, featureCount: 2,
                nullCount: 0, unsupportedValueCount: 0, complete: true, defaultClassCount: 5, minimumClassCount: 2, maximumClassCount: 9};
        },
        style: async (_source, definition) => ({styleName: "sum-style", style: definition}),
        filter: async (_source, predicate) => ({layerName: "eolab:summary_filtered", filter: predicate}),
        countFilter: async () => ({matched: 1, total: 2, complete: true}),
    });
    let outputs;
    const layers = new MapLayerController({leafletMap: map,
        view: {bind() {}, render() {}, announceStatus() {}, setStatus() {}},
        restoreRemovedLayer: (snapshot, isCurrent) => outputs.restore(snapshot, isCurrent)});
    const main = readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
    const composition = main.slice(main.indexOf("async function addGeneratedVector("), main.indexOf("/** Restore an upload view"));
    const addVector = new Function("vectorMapLayerAdapter", "mapLayerController", "onRenderingWorkspaceRequested",
        `${composition}; return addGeneratedVector;`)(adapter, layers, () => {});
    outputs = new ModelOutputLayers({api: {getJob: async () => run}, clock: {setTimeout() {}, clearTimeout() {}},
        describeVector: async () => metadata, addVector,
        removeLayer: key => layers.removeKey(key), updateLayer: (key, presentation) => layers.updateLocalPresentation(key, presentation),
        refreshLayers: () => layers.render(), openRun: id => inspected.push(id), onChange() {},
        read: async () => { throw Error("Generated vectors must not use the preview reader"); }});
    await outputs.show(run, file);
    const key = artifactLayerKey(run.jobId, file.artifactId), record = layers.getRecord(key);
    assert.equal(record.adapter, adapter);
    assert.equal(record.entry.group.id, run.jobId);
    assert.equal(adapter.describeStyle(record).style.graduated.field, "sum_total_es");
    assert.deepEqual(classifiedFields, ["sum_total_es"]);
    const predicate = {enabled: true, match: "all", rules: [{field: "sum_total_es", operator: "gt", value: 3}]};
    await adapter.applyFilterState(record, predicate);
    const edited = {...adapter.describeStyle(record).style, strokeWidth: 3};
    await adapter.applyStyle(record, edited);
    layers.renameLayer(key, "My state totals");
    layers.setVisible(key, false);
    const copyKey = await layers.addAnotherView(key), copy = layers.getRecord(copyKey);
    assert.equal(copy.entry.group.id, run.jobId);
    assert.equal(copy.entry.label, "My state totals");
    assert.equal(copy.entry.visible, false);
    assert.deepEqual(adapter.describeSource(copy).source, {kind: "runArtifact", jobId: run.jobId, artifactId: file.artifactId});
    assert.deepEqual(adapter.describeStyle(copy).style, edited);
    assert.deepEqual(adapter.exportFilterState(copy), predicate);
    assert.equal(adapter.describeSource(copy).selection, null);
    adapter.info(copy);
    assert.deepEqual(inspected, [run.jobId]);
    layers.removeWithUndo(copyKey);
    await layers.undoLayerRemoval();
    const restored = layers.getRecord(copyKey);
    assert.deepEqual(adapter.describeStyle(restored).style, edited);
    assert.deepEqual(adapter.exportFilterState(restored), predicate);
    assert.equal(restored.entry.group.id, run.jobId);
    outputs.updateRun({...run, status: "deleted", updatedAt: "2099-01-02T00:00:00Z"});
    assert.equal(layers.retainedRecords.length, 0);
    assert.equal(outputs.layers.size, 0);
});
