import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { MapLayerController } from "../../src/map-layers/controller.js";
import { createVectorMapLayerAdapter } from "../../src/vector/map-layer-adapter.js";

const UPLOAD = {
    kind: "upload", id: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d", name: "Wetlands",
    layer_name: "areas", geometry_type: "MultiPolygon", crs_wkt: "EPSG:4326",
    size_bytes: 98304, created_at: "2026-10-21T00:00:00Z",
    fields: { label: "str:80", count: "int", weight: "float" },
};
const STYLE = {
    geometryKind: "polygon", fillColor: "#2b83ba", fillOpacity: 0.7,
    strokeColor: "#000000", strokeOpacity: 1, strokeWidth: 0.75,
    pointSize: null, categorical: null, graduated: null, label: null,
};
const PUBLICATION = {
    layerName: `eolab:upload_${UPLOAD.id.replaceAll("-", "")}`,
    styleName: "vector-polygon", geometryKind: "polygon", bbox: [-2, 40, 2, 44], style: STYLE,
};
const CATEGORIES = {
    field: "label", fieldType: "str:80",
    values: [{ value: { kind: "string", value: "Café wetlands" }, count: 2 }],
    observedDistinctCount: 1, distinctCount: 1, scannedFeatureCount: 2, featureCount: 2,
    nullCount: 0, unsupportedValueCount: 0, complete: true, defaultLimit: 20, maximumLimit: 50,
};
const CLASSIFICATION = {
    field: "count", fieldType: "int", method: "percentile-interval", requestedClassCount: 5,
    actualClassCount: 2, classes: [{ minimum: null, maximum: 5, count: 1 },
        { minimum: 5, maximum: null, count: 1 }],
    observedMinimum: 1, observedMaximum: 7, numericValueCount: 2, scannedFeatureCount: 2,
    featureCount: 2, nullCount: 0, unsupportedValueCount: 0, complete: true,
    defaultClassCount: 5, minimumClassCount: 2, maximumClassCount: 9,
};

test("uploaded polygons use ordinary vector styling, filtering and local removal Undo", async t => {
    const requests = [], wmsLayers = [], fits = [], status = [];
    let waitForRestoredStyle = null, failFilter = false, restoreUploadedVector;
    t.mock.method(globalThis, "fetch", async (url, options) => {
        const body = JSON.parse(options.body);
        const action = url.slice(url.lastIndexOf("/") + 1);
        requests.push({ url, options, body, action });
        if (action === "styles" && body.style.fillColor === "#abcdef") await waitForRestoredStyle;
        if (action === "filters" && failFilter) return new Response(JSON.stringify({ detail: "Filter failed" }), { status: 503 });
        const replies = {
            layers: PUBLICATION,
            "numeric-classifications": CLASSIFICATION,
            styles: { styleName: "vector-style-0123456789abcdef01234567-aaaaaaaaaaaa", style: body.style },
            "category-summaries": CATEGORIES,
            filters: { layerName: `${PUBLICATION.layerName}_filtered`, filter: body.filter },
            "filter-counts": { matched: 1, total: 2, complete: true },
        };
        return new Response(JSON.stringify(replies[action]));
    });
    const map = {
        attached: new Set(), removeLayer(layer) { this.attached.delete(layer); },
        fitBounds(bounds, options) { fits.push({ bounds, options }); },
    };
    const leaflet = { tileLayer: { wms(url, options) {
        const layer = {
            url, options, once() {}, on() {}, setOpacity() {}, setZIndex() {},
            setParams(params) { Object.assign(this.options, params); },
            addTo(target) { target.attached.add(this); return this; },
        };
        wmsLayers.push(layer);
        return layer;
    } } };
    const adapter = createVectorMapLayerAdapter({
        leaflet, leafletMap: map, wmsUrl: "/wms", onTileError() {},
    });
    const controller = new MapLayerController({
        leafletMap: map,
        view: { bind() {}, render() {}, announceStatus() {}, setStatus(message) { status.push(message); } },
        restoreRemovedLayer: (snapshot, isCurrent) => restoreUploadedVector(snapshot, isCurrent),
    });
    const publication = await adapter.publish(UPLOAD);
    const key = `local:upload:${UPLOAD.id}`;
    const record = controller.addLocal({ key, label: adapter.label(UPLOAD), sourceName: UPLOAD.name,
        upload: UPLOAD, publication, canAddView: true }, adapter);
    adapter.added(record);
    assert.equal(record.entry.item, null);
    assert.equal(record.state.source, UPLOAD);
    assert.deepEqual(adapter.describeSource(record), { source: { uploadId: UPLOAD.id }, fields: [
        { name: "label", type: "str:80" }, { name: "count", type: "int" }, { name: "weight", type: "float" },
    ], geometryKind: "polygon", primaryGeometry: null });
    assert.equal(adapter.describeStyle(record).style.graduated.field, "count");
    assert.equal(adapter.describeStyle(record).style.label, null);
    assert.equal(adapter.snapshot(record).canInfo, false);
    assert.equal(adapter.snapshot(record).canFilter, true);
    assert.equal(wmsLayers[0].options.styles, publication.styleName);
    assert.deepEqual(fits[0].bounds, [[40, -2], [44, 2]]);
    assert.deepEqual(await adapter.summarizeCategories(record, "label"), CATEGORIES);

    const filter = { enabled: true, match: "all", rules: [{ field: "label", operator: "eq", value: "Café wetlands" }] };
    await adapter.applyFilterState(record, filter);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(adapter.describeFilter(record).status, "1 of 2 features match");
    assert.equal(wmsLayers[0].options.layers, `${PUBLICATION.layerName}_filtered`);
    const edited = { ...STYLE, fillColor: "#abcdef" };
    await adapter.applyStyle(record, edited);
    controller.renameLayer(key, "My wetlands");
    controller.setOpacity(key, 0.4);
    controller.setVisible(key, false);
    const main = readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
    const targetsSource = main.slice(main.indexOf("const getPolygonTargets ="), main.indexOf("models = new ModelsController({"));
    const getPolygonTargets = new Function("mapLayerController", "vectorMapLayerAdapter", `${targetsSource}; return getPolygonTargets;`)(controller, adapter);
    assert.deepEqual(getPolygonTargets(), [{ key, label: "My wetlands", item: { uploadId: UPLOAD.id },
        fields: adapter.describeSource(record).fields, filter }], "Hidden uploads remain selectable with their applied filter");
    // Exercise the composition callbacks with the real layer and vector owners.
    const callbacksSource = main.slice(main.indexOf("function getUploadedVectorKeys("),
        main.indexOf("if (!isSharedViewer) new UploadPolygonsDialog"));
    const callbacks = new Function(
        "mapLayerController", "vectorMapLayerAdapter", "getUpload",
        `${callbacksSource}; return {restoreUploadedVector, restoreSavedUpload, removeDeletedUpload, getUploadedVectorKeys};`
    )(controller, adapter, async id => { assert.equal(id, UPLOAD.id); return UPLOAD; });
    restoreUploadedVector = callbacks.restoreUploadedVector;
    const {restoreSavedUpload, removeDeletedUpload, getUploadedVectorKeys} = callbacks;

    const snapshot = controller.captureLayerSnapshot(key);
    assert.equal(snapshot.local.kind, "uploaded-vector");
    assert.equal(snapshot.item, null);
    assert.deepEqual(snapshot.local.upload, UPLOAD);
    assert.deepEqual(snapshot.local.publication.style, edited);
    const requestCount = requests.length;
    assert.equal(controller.removeWithUndo(key), true);
    assert.deepEqual(getPolygonTargets(), [], "Removed uploads leave the analysis choices");
    assert.equal(record.state.disposed, true);
    await controller.undoLayerRemoval();
    const restored = controller.getRecord(key);
    assert.equal(restored.entry.label, "My wetlands");
    assert.equal(restored.entry.opacity, 0.4);
    assert.equal(restored.entry.visible, false);
    assert.deepEqual(adapter.describeStyle(restored).style, edited);
    assert.deepEqual(adapter.describeFilter(restored), { filter, status: "1 of 2 features match" });
    assert.equal(adapter.renderDescriptor(restored).layerName, `${PUBLICATION.layerName}_filtered`);
    assert.equal(requests.length, requestCount, "Undo reuses the captured authorized display without re-uploading");
    assert.equal(status.at(-1), "Restored My wetlands.");
    adapter.zoom(restored);
    assert.deepEqual(fits[1], fits[0]);

    assert.deepEqual(requests.map(({ action }) => action), ["layers", "numeric-classifications", "styles",
        "category-summaries", "filters", "filter-counts", "styles"]);
    for (const { url, options, body, action } of requests) {
        assert.equal(url, `/api/vector-rendering/uploads/${UPLOAD.id}/${action}`);
        assert.equal(options.method, "POST");
        assert.equal(options.headers["X-EOLab-Uploads"], "1");
        assert.equal("collectionId" in body, false);
        assert.equal("itemId" in body, false);
        assert.equal("fields" in body, false, "metadata is not passed back as an authority");
    }
    assert.deepEqual(requests[0].body, {});
    assert.deepEqual(requests[1].body, { field: "count", method: "percentile-interval", classCount: 5 });
    assert.deepEqual(requests[3].body, { field: "label" });
    assert.deepEqual(requests[4].body, { filter });
    assert.deepEqual(requests[5].body, { filter });

    controller.removeKey(key);
    const savedStyle = { ...edited, graduated: { ...publication.style.graduated, rules: [
        { minimum: null, maximum: 123, color: "#ffffcc" },
        { minimum: 123, maximum: null, color: "#800026" },
    ] } };
    const saved = { uploadId: UPLOAD.id, customName: "Saved wetlands", visible: true, opacity: 0.4,
        style: { kind: "vector", definition: savedStyle }, filter };
    let releaseStyle;
    waitForRestoredStyle = new Promise(resolve => { releaseStyle = resolve; });
    const reopening = restoreSavedUpload(saved, () => true);
    await new Promise(resolve => setImmediate(resolve));
    const reopeningKey = getUploadedVectorKeys(UPLOAD.id)[0];
    assert.notEqual(reopeningKey, key);
    assert.equal(controller.getRecord(reopeningKey).entry.visible, false, "Restoration stays hidden until its appearance and filter are applied");
    releaseStyle();
    assert.equal(await reopening, reopeningKey);
    const reopened = controller.getRecord(reopeningKey);
    assert.equal(reopened.entry.label, "Saved wetlands");
    assert.equal(reopened.entry.opacity, 0.4);
    assert.equal(reopened.entry.visible, true);
    assert.deepEqual(adapter.describeStyle(reopened).style.graduated.rules, savedStyle.graduated.rules);
    assert.deepEqual(adapter.exportFilterState(reopened), filter);
    const secondKey = await controller.addAnotherView(reopeningKey);
    const second = controller.getRecord(secondKey);
    assert.notEqual(secondKey, reopeningKey);
    assert.deepEqual(adapter.exportFilterState(second), filter);
    assert.deepEqual(adapter.describeStyle(second).style, adapter.describeStyle(reopened).style);
    controller.renameLayer(secondKey, "Other wetlands");
    await adapter.applyStyle(second, {...savedStyle, fillColor: "#123456"});
    await adapter.applyFilterState(second, {enabled: false, match: "all", rules: []});
    assert.equal(reopened.entry.label, "Saved wetlands");
    assert.equal(adapter.describeStyle(reopened).style.fillColor, "#abcdef");
    assert.deepEqual(adapter.exportFilterState(reopened), filter);
    const thirdKey = await restoreSavedUpload({...saved, customName: "Third wetlands"}, () => true);
    assert.deepEqual(new Set(getUploadedVectorKeys(UPLOAD.id)), new Set([reopeningKey, secondKey, thirdKey]));
    controller.removeWithUndo(secondKey);
    removeDeletedUpload(UPLOAD.id);
    await controller.undoLayerRemoval();
    assert.deepEqual(getUploadedVectorKeys(UPLOAD.id), [], "Deleted uploads cannot be restored by map-removal Undo");

    failFilter = true;
    await assert.rejects(restoreSavedUpload(saved, () => true), /Filter failed/);
    assert.deepEqual(getUploadedVectorKeys(UPLOAD.id), [], "Filter failure leaves no unfiltered layer");
    failFilter = false;
    waitForRestoredStyle = new Promise(resolve => { releaseStyle = resolve; });
    const obsolete = restoreSavedUpload(saved, () => true);
    await new Promise(resolve => setImmediate(resolve));
    const obsoleteKey = getUploadedVectorKeys(UPLOAD.id)[0];
    controller.removeKey(obsoleteKey);
    const replacement = controller.addLocal({ key: obsoleteKey, label: UPLOAD.name, upload: UPLOAD,
        publication, visible: false }, adapter);
    releaseStyle();
    assert.equal(await obsolete, null);
    assert.equal(controller.getRecord(obsoleteKey), replacement);
    assert.equal(replacement.entry.visible, false, "Obsolete restoration cannot change a replacement layer");
});
