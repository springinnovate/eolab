import assert from "node:assert/strict";
import test from "node:test";
import { normalizeVectorFilter, vectorFilterStatus, vectorFilterSummary } from "../../src/vector/filter.js";
import { VectorFilterControls } from "../../src/vector/filter-controls.js";
import { createVectorMapLayerAdapter } from "../../src/vector/map-layer-adapter.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

const fields = [{ name: "year", type: "int" }, { name: "name", type: "str" }];
const filter = (value = 2020, enabled = true) => ({ enabled, match: "all", rules: [{ field: "year", operator: "gt", value }] });
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("rule validation keeps numeric and text types explicit and excludes expressions", () => {
    assert.deepEqual(normalizeVectorFilter(filter(), fields), filter());
    for (const value of ["2020", true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => normalizeVectorFilter(filter(value), fields));
    }
    assert.throws(() => normalizeVectorFilter({ ...filter(), expression: "year > 2020" }, fields));
    assert.throws(() => normalizeVectorFilter({ ...filter(), rules: [{ field: "absent", operator: "eq", value: 0 }] }, fields));
    assert.match(vectorFilterSummary(filter(2020, false)), /^Disabled:/);
    assert.equal(vectorFilterStatus({ filter: filter(), filterCounting: true }), "Filter active · Counting…");
    assert.equal(vectorFilterStatus({ filter: filter(), filterCount: { matched: 0, total: 100, complete: true } }), "0 of 100 features match");
    assert.equal(vectorFilterStatus({ filter: filter(), filterCounting: false }), "Filter active · Count unavailable");
});

test("filter editor debounces valid drafts and leaves applied rules visible during invalid edits", async () => {
    const doc = new FakeRasterControlDocument();
    let current = filter(), pending = null;
    const applied = [], canceled = [];
    const controls = new VectorFilterControls({ documentContext: doc,
        getTarget: () => ({ fields, filter: current, label: "Earthquakes", status: "5 of 100 features match",
            cancelPending: () => canceled.push(true),
            apply: async (candidate) => { applied.push(candidate); current = candidate; return candidate; } }),
        inspection: { showFilter() {}, hideFilter() {} },
        setTimer: (handler, delay) => { assert.equal(delay, 450); pending = handler; return 1; },
        clearTimer: () => { pending = null; },
    });
    controls.open("quakes");
    const input = controls.rules.children[0].children[2];
    input.value = "2021"; input.dispatchEvent(new Event("input"));
    input.value = "2022"; input.dispatchEvent(new Event("input"));
    assert.equal(applied.length, 0);
    const run = pending; pending = null; run(); await flush();
    assert.deepEqual(applied, [filter(2022)]);
    input.value = ""; input.dispatchEvent(new Event("input"));
    assert.equal(pending, null);
    assert.match(controls.status.textContent, /previous applied filter remains/);
    assert.match(controls.applied.textContent, /2022/);
    controls.clear.dispatchEvent(new Event("click")); await flush();
    assert.equal(current.rules.length, 0);
    assert.ok(canceled.length >= 3);
    controls.destroy();
});

test("filter enable toggle preserves rules and closing applies pending valid edits", async () => {
    const doc = new FakeRasterControlDocument();
    let current = filter();
    const controls = new VectorFilterControls({ documentContext: doc,
        getTarget: () => ({ fields, filter: current, label: "Earthquakes", status: "",
            cancelPending() {}, apply: async (candidate) => { current = candidate; return candidate; } }),
        inspection: { showFilter() {}, hideFilter() {} },
        setTimer: () => 1, clearTimer() {},
    });
    controls.open("quakes");
    controls.enabled.checked = false;
    controls.enabled.dispatchEvent(new Event("change"));
    controls.close(); await flush();
    assert.deepEqual(current, filter(2020, false));
    controls.open("quakes");
    assert.equal(controls.enabled.checked, false);
    assert.equal(controls.rules.children.length, 1);
    controls.destroy();
});

test("default debounce timers retain the browser global receiver", () => {
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
    let scheduled = 0, cleared = 0;
    globalThis.setTimeout = function () { assert.equal(this, globalThis); scheduled++; return 123; };
    globalThis.clearTimeout = function () { assert.equal(this, globalThis); cleared++; };
    try {
        const doc = new FakeRasterControlDocument();
        const controls = new VectorFilterControls({ documentContext: doc,
            getTarget: () => ({ fields, filter: filter(), label: "Earthquakes", status: "", cancelPending() {} }),
            inspection: { showFilter() {}, hideFilter() {} },
        });
        controls.open("quakes");
        const input = controls.rules.children[0].children[2];
        input.value = "2024"; input.dispatchEvent(new Event("input"));
        controls.destroy();
        assert.equal(scheduled, 1); assert.equal(cleared, 1);
    } finally {
        globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
    }
});

test("adapter ignores out-of-order filter replies, preserves styles, and cancels removed-layer counts", async () => {
    const requests = [], counts = [], changes = [];
    const item = { collection: "vectors", id: "quakes", properties: { "table:columns": fields } };
    const publication = { layerName: "eolab:quakes", styleName: "vector-point", style: {
        geometryKind: "point", fillColor: "#112233", fillOpacity: 1, strokeColor: "#000000",
        strokeOpacity: 1, strokeWidth: 1, pointSize: 9, categorical: null, graduated: null, label: null,
    } };
    const adapter = createVectorMapLayerAdapter({ leaflet: {}, leafletMap: {}, wmsUrl: "/wms", onTileError() {},
        filter: (_item, candidate, signal) => new Promise((resolve) => requests.push({ candidate, signal, resolve })),
        countFilter: (_item, candidate, signal) => new Promise((resolve) => counts.push({ candidate, signal, resolve })),
        onFilterChange: () => changes.push(true),
    });
    const record = { publication, entry: { item }, state: adapter.createState({ item, publication }) };
    const beforeStyle = structuredClone(record.state.style);
    const a = adapter.applyFilterState(record, filter(2020));
    const b = adapter.applyFilterState(record, filter(2021));
    assert.ok(requests[0].signal.aborted);
    requests[1].resolve({ layerName: "eolab:filtered-b", filter: filter(2021) }); await b;
    requests[0].resolve({ layerName: "eolab:filtered-a", filter: filter(2020) });
    assert.equal(await a, null);
    assert.equal(record.publication.layerName, "eolab:filtered-b");
    assert.deepEqual(record.state.style, beforeStyle);
    assert.equal(Object.hasOwn(adapter.exportSavedState(record), "filter"), false);
    assert.deepEqual(adapter.exportFilterState(record), filter(2021));
    assert.equal(adapter.snapshot(record).filterActive, true);
    assert.equal(counts.length, 1);
    adapter.removed(record);
    assert.ok(counts[0].signal.aborted);
    counts[0].resolve({ matched: 5, total: 100, complete: true }); await flush();
    assert.equal(record.state.filterCount, null);
    assert.equal(changes.length, 1);
});

test("analysis filters submit only the explicitly applied complete draft and expose cancellation", async () => {
    const doc = new FakeRasterControlDocument(), applied = [], completed = [];
    let resolve, cancellations = 0;
    const controls = new VectorFilterControls({ documentContext: doc,
        getTarget: () => ({ fields, filter: filter(), label: "Countries", status: "",
            cancelPending() { throw Error("Analysis must not cancel rendering"); },
            apply() { throw Error("Analysis must not require rendering authorization"); } }),
        inspection: { showFilter() {}, hideFilter() {} },
        setTimer() { throw Error("An analysis draft must not auto-apply"); }, clearTimer() {},
    });
    const action = { apply: candidate => { applied.push(candidate); return new Promise(done => { resolve = done; }); },
        complete: area => completed.push(area), cancel: () => { cancellations++; resolve(null); } };
    controls.open("countries", action);
    assert.equal(controls.applyButton.textContent, "Use filtered features & calculate");
    const input = controls.rules.children[0].children[2];
    input.value = "2024"; input.dispatchEvent(new Event("input"));
    assert.equal(applied.length, 0);
    controls.applyButton.dispatchEvent(new Event("click"));
    assert.deepEqual(applied, [filter(2024)]);
    assert.equal(controls.cancelButton.hidden, false);
    controls.cancelButton.dispatchEvent(new Event("click")); await flush();
    assert.equal(cancellations, 1); assert.equal(completed.length, 0);
    input.value = ""; input.dispatchEvent(new Event("input"));
    assert.equal(controls.applyButton.disabled, true);
    controls.close(); assert.equal(applied.length, 1);
    controls.open("countries", action);
    const next = controls.rules.children[0].children[2];
    next.value = "2025"; next.dispatchEvent(new Event("input"));
    controls.applyButton.dispatchEvent(new Event("click"));
    resolve({ id: "new-area" }); await flush();
    assert.deepEqual(completed, [{ id: "new-area" }]); assert.equal(controls.key, null);
    controls.open("countries"); assert.equal(controls.applyButton.textContent, "Apply filter");
    controls.open("countries", action);
    controls.applyButton.dispatchEvent(new Event("click"));
    controls.destroy();
    await flush();
    assert.equal(cancellations, 2); assert.equal(completed.length, 1);
});
