import assert from "node:assert/strict";
import test from "node:test";

import { createVectorMapLayerAdapter } from "../../src/vector/map-layer-adapter.js";
import { VectorFilterControls } from "../../src/vector/filter-controls.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

const FIELDS = [
    { name: "year", type: "int" },
    { name: "name", type: "str" },
    { name: "protected", type: "bool" },
];

/**
 * Create a vector with controlled API replies and no attached map layer.
 * @param {Object} [options] Source and publication variants.
 * @param {"point"|"line"|"polygon"} [options.geometryKind="polygon"] Geometry class.
 * @param {Object} [options.properties] Catalog field and geometry metadata.
 * @return {{adapter:Object,record:Object,requests:Object[],counts:Object[],calls:string[],updates:Object[]}}
 * Adapter, retained record, pending requests, and observed external work.
 */
function createFixture({ geometryKind = "polygon", properties = {
    "table:primary_geometry": "geometry",
    "table:columns": [{ name: "geometry", type: "geometry" }, ...FIELDS],
} } = {}) {
    const calls = [], requests = [], counts = [], updates = [];
    const item = { collection: "vectors", id: "parcels", properties };
    const publication = {
        layerName: "eolab:parcels", styleName: "initial-style", bbox: [-1, -1, 1, 1],
        geometryKind, defaultStyleNotice: "Choose a field to color these features.",
        style: {
            geometryKind, fillColor: geometryKind === "line" ? null : "#112233",
            fillOpacity: geometryKind === "line" ? null : 1,
            strokeColor: "#000000", strokeOpacity: 1, strokeWidth: 1,
            pointSize: geometryKind === "point" ? 9 : null,
            categorical: null, graduated: null, label: null,
        },
    };
    const adapter = createVectorMapLayerAdapter({
        leaflet: { tileLayer: { wms: () => {
            calls.push("create WMS layer");
            return { once: () => {}, setParams: parameters => updates.push(parameters) };
        } } },
        leafletMap: {}, wmsUrl: "/wms", onTileError: () => {},
        publish: async () => { calls.push("publish"); return publication; },
        style: async (_item, candidate) => {
            calls.push("apply style");
            return { styleName: "changed-style", style: candidate };
        },
        summarize: async () => { calls.push("summarize"); return {}; },
        classify: async () => { calls.push("classify"); return {}; },
        filter: (_item, candidate, signal) => {
            calls.push("apply filter");
            return new Promise(resolve => requests.push({ candidate, signal, resolve }));
        },
        countFilter: (_item, candidate, signal) => {
            calls.push("count filter");
            return new Promise((resolve, reject) => counts.push({ candidate, signal, resolve, reject }));
        },
    });
    const record = { entry: { key: "vectors:parcels", label: "Parcels", item }, publication,
        state: adapter.createState({ item, publication }) };
    return { adapter, record, requests, counts, calls, updates };
}

/**
 * Build typed rules suitable for the source's year field.
 * @param {number} value Minimum year, excluded from the matching range.
 * @return {Object} Complete enabled filter.
 */
function yearFilter(value) {
    return { enabled: true, match: "all", rules: [{ field: "year", operator: "gt", value }] };
}

/**
 * Apply a filter using its actual adapter command and controlled service reply.
 * @param {Object} fixture Adapter fixture with a pending filter-request queue.
 * @param {Object} candidate Complete portable filter.
 * @return {Promise<Object|null>} Applied filter or null for an obsolete request.
 */
async function applyFilter(fixture, candidate) {
    const pending = fixture.adapter.applyFilterState(fixture.record, candidate);
    fixture.requests.at(-1).resolve({ layerName: "eolab:filtered", filter: candidate });
    return pending;
}

/** Wait for the independent count completion and its final callback. @return {Promise<void>} */
function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

test("source descriptions expose usable immutable fields for each geometry without publishing", () => {
    for (const geometryKind of ["point", "line", "polygon"]) {
        const { adapter, record, calls } = createFixture({ geometryKind });
        const source = adapter.describeSource(record);
        assert.deepEqual(source, { source: { collectionId: "vectors", itemId: "parcels" }, fields: FIELDS, geometryKind, primaryGeometry: "geometry" });
        assert.ok(Object.isFrozen(source.source));
        assert.ok(Object.isFrozen(source.fields));
        assert.ok(source.fields.every(Object.isFrozen));
        assert.throws(() => { source.fields[0].name = "changed"; }, TypeError);
        assert.deepEqual(adapter.describeSource(record).fields, FIELDS);
        assert.deepEqual(adapter.describeFilter(record), {
            filter: { enabled: true, match: "all", rules: [] }, status: "",
        });
        assert.equal(adapter.describeStyle(record).style.geometryKind, geometryKind);
        assert.deepEqual(calls, []);
    }
});

test("source descriptions preserve missing geometry metadata and empty field choices", () => {
    const { adapter, record, calls } = createFixture({ properties: {} });
    assert.deepEqual(adapter.describeSource(record), {
        source: { collectionId: "vectors", itemId: "parcels" },
        fields: [], geometryKind: "polygon", primaryGeometry: null,
    });
    assert.deepEqual(calls, []);
});

test("filter descriptions follow applied rules and independent count success or failure", async () => {
    const fixture = createFixture();
    const { adapter, record, counts, calls } = fixture;
    await applyFilter(fixture, yearFilter(2020));
    const counting = adapter.describeFilter(record);
    assert.deepEqual(counting, { filter: yearFilter(2020), status: "Filter active · Counting…" });
    assert.deepEqual(calls, ["apply filter", "count filter"]);

    counts[0].resolve({ complete: true, matched: 7, total: 10 });
    await flush();
    assert.equal(adapter.describeFilter(record).status, "7 of 10 features match");
    assert.equal(counting.status, "Filter active · Counting…");

    await applyFilter(fixture, yearFilter(2024));
    assert.deepEqual(adapter.describeFilter(record).filter, yearFilter(2024));
    counts[1].reject(Object.assign(new Error("Queue is full"), { category: "filter_count_queue_full" }));
    await flush();
    assert.deepEqual(adapter.describeFilter(record), {
        filter: yearFilter(2024),
        status: "Filter active · Count queue full; apply filter again to retry",
    });
    assert.deepEqual(calls, ["apply filter", "count filter", "apply filter", "count filter"]);
});

test("detached filter descriptions retain disabled typed rules without exposing applied state", async () => {
    const fixture = createFixture();
    const candidate = { enabled: false, match: "any", rules: [
        { field: "year", operator: "gt", value: 2020 },
        { field: "name", operator: "eq", value: "2020" },
        { field: "protected", operator: "eq", value: false },
    ] };
    await applyFilter(fixture, candidate);
    const description = fixture.adapter.describeFilter(fixture.record);
    assert.deepEqual(description, { filter: candidate, status: "Filter disabled" });
    description.filter.enabled = true;
    description.filter.rules[0].value = 2030;
    description.filter.rules.push({ field: "name", operator: "missing", value: null });
    assert.deepEqual(fixture.adapter.exportFilterState(fixture.record), candidate);
    assert.deepEqual(fixture.adapter.describeFilter(fixture.record), { filter: candidate, status: "Filter disabled" });
    assert.deepEqual(fixture.calls, ["apply filter"]);
    assert.equal(fixture.counts.length, 0);
});

test("style descriptions are detached and refresh after the existing style command", async () => {
    const { adapter, record, calls, updates } = createFixture();
    const initial = adapter.describeStyle(record);
    assert.equal(initial.notice, "Choose a field to color these features.");
    initial.style.fillColor = "#abcdef";
    assert.equal(adapter.describeStyle(record).style.fillColor, "#112233");
    assert.deepEqual(calls, []);

    adapter.createLayer(record, () => {});
    const candidate = { ...adapter.describeStyle(record).style, fillColor: "#abcdef",
        categorical: { field: "name", limit: 2, rules: [
            { value: { kind: "string", value: "Forest" }, color: "#00ff00", label: null, opacity: 1 },
        ], otherColor: "#ffffff", missingColor: null } };
    await adapter.applyStyle(record, candidate);
    const changed = adapter.describeStyle(record);
    assert.deepEqual(changed, { style: candidate, notice: "" });
    changed.style.categorical.rules[0].value.value = "Other";
    changed.style.categorical.rules[0].color = "#ff0000";
    assert.deepEqual(adapter.describeStyle(record), { style: candidate, notice: "" });
    assert.deepEqual(updates, [{ styles: "changed-style" }]);
    assert.deepEqual(calls, ["create WMS layer", "apply style"]);
});

test("filter controls edit detached descriptions while cancellation stays in the adapter", async () => {
    const fixture = createFixture();
    const { adapter, record, requests, counts } = fixture;
    await applyFilter(fixture, yearFilter(2020));
    counts[0].resolve({ complete: true, matched: 7, total: 10 });
    await flush();
    let pending = null;
    const controls = new VectorFilterControls({
        documentContext: new FakeRasterControlDocument(),
        inspection: { showFilter: () => {}, hideFilter: () => {}, updateLayerEditorName: () => {} },
        getTarget: () => ({ key: record.entry.key, label: record.entry.label,
            fields: adapter.describeSource(record).fields, ...adapter.describeFilter(record),
            apply: candidate => adapter.applyFilterState(record, candidate),
            cancelPending: () => adapter.cancelPendingFilter(record) }),
        setTimer: handler => { pending = handler; return 1; },
        clearTimer: () => { pending = null; },
    });
    controls.open(record.entry.key);
    const obsolete = adapter.applyFilterState(record, yearFilter(2021));
    const input = controls.rules.children[0].children[2];
    input.value = "2022";
    input.dispatchEvent(new Event("input"));
    assert.ok(requests[1].signal.aborted);
    assert.deepEqual(adapter.describeFilter(record).filter, yearFilter(2020));
    requests[1].resolve({ layerName: "eolab:obsolete", filter: yearFilter(2021) });
    assert.equal(await obsolete, null);

    const applyDraft = pending;
    pending = null;
    applyDraft();
    requests[2].resolve({ layerName: "eolab:current", filter: yearFilter(2022) });
    await flush();
    assert.deepEqual(adapter.describeFilter(record).filter, yearFilter(2022));
    assert.match(controls.applied.textContent, /2022/);
    counts[1].resolve({ complete: true, matched: 3, total: 10 });
    await flush();
    controls.refresh();
    assert.equal(controls.count.textContent, "3 of 10 features match");
    controls.destroy();
});
