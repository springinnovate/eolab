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

test("calculated fields stay view-owned and available to analysis when map refresh fails", async () => {
    const h = createFixture();
    const original = h.record.state.source;
    const other = {...h.record, state: h.adapter.createState({item: original, publication: h.record.publication})};
    const definition = {version: 1, name: "scaled_year", expression: "'year' * 2", numericText: false};
    const result = {calculatedFields: [definition], fields: {...Object.fromEntries(FIELDS.map(field => [field.name, field.type])), scaled_year: "float"}};
    const installation = h.adapter.installCalculatedFields(h.record, result);
    assert.equal(h.adapter.renderingAvailable(h.record), false, "stale tiles are suppressed immediately");
    assert.deepEqual(h.adapter.describeSource(h.record).selection.calculatedFields, [definition]);
    assert.ok(h.adapter.describeSource(h.record).numericFields.some(field => field.name === "scaled_year"));
    assert.equal(original.calculatedFields, undefined);
    assert.deepEqual(h.adapter.exportCalculatedFields(other), []);
    h.requests.at(-1).reject(new Error("GeoServer unavailable"));
    assert.match(await installation, /Fields saved.*could not refresh/);
    assert.equal(h.adapter.renderingAvailable(h.record), false);
    assert.match(h.adapter.snapshot(h.record).error, /Fields saved/);
    assert.deepEqual(h.adapter.exportCalculatedFields(h.record), [definition]);
    const retry = h.adapter.retryCalculatedFieldRendering(h.record);
    h.requests.at(-1).resolve({layerName: "eolab:calculated"});
    assert.equal(await retry, null);
    assert.equal(h.adapter.renderingAvailable(h.record), true);
    assert.deepEqual(h.adapter.renderDescriptor(h.record).calculatedFields, [definition]);
    assert.deepEqual(h.record.publication.calculatedFields, [definition]);
});

test("map refresh can be retried after deleting the last calculated field", async () => {
    const h = createFixture();
    const definition = {version: 1, name: "scaled_year", expression: "'year' * 2", numericText: false};
    const fields = Object.fromEntries(FIELDS.map(field => [field.name, field.type]));
    const installation = h.adapter.installCalculatedFields(h.record,
        {calculatedFields: [definition], fields: {...fields, scaled_year: "float"}});
    h.requests.at(-1).resolve({layerName: "eolab:calculated"});
    await installation;
    const deletion = h.adapter.installCalculatedFields(h.record, {calculatedFields: [], fields});
    h.requests.at(-1).reject(new Error("GeoServer unavailable"));
    await deletion;
    const source = h.record.state.source;
    const countRequests = h.counts.length;
    assert.match(h.adapter.getCalculatedFieldDisplayWarning(h.record), /Retry map refresh/);
    assert.deepEqual(h.adapter.exportCalculatedFields(h.record), []);

    const retry = h.adapter.retryCalculatedFieldRendering(h.record);
    assert.equal(h.adapter.getCalculatedFieldDisplayWarning(h.record), null);
    assert.equal(h.adapter.renderingAvailable(h.record), false);
    h.requests.at(-1).resolve({layerName: "eolab:original"});
    assert.equal(await retry, null);
    assert.equal(h.record.state.source, source, "retry keeps the accepted source and definitions");
    assert.equal(h.counts.length, countRequests, "display retry does not recount features");
    assert.equal(h.adapter.renderingAvailable(h.record), true);
    assert.equal(h.adapter.getCalculatedFieldDisplayWarning(h.record), null);
    assert.equal(h.adapter.renderDescriptor(h.record).calculatedFields, undefined);
    assert.deepEqual(h.record.publication.calculatedFields, []);
});

test("an aborted older display retry cannot overwrite a newer successful retry", async () => {
    const h = createFixture();
    const abort = new AbortController();
    const oldRetry = h.adapter.retryCalculatedFieldRendering(h.record, abort.signal);
    const oldRequest = h.requests.at(-1);
    abort.abort();
    const currentRetry = h.adapter.retryCalculatedFieldRendering(h.record);
    h.requests.at(-1).resolve({layerName: "eolab:current"});
    await currentRetry;
    oldRequest.reject(new DOMException("Cancelled", "AbortError"));
    await oldRetry;
    assert.equal(h.adapter.renderingAvailable(h.record), true);
    assert.equal(h.adapter.getCalculatedFieldDisplayWarning(h.record), null);
    assert.equal(h.record.publication.layerName, "eolab:current");
    h.adapter.removed(h.record);
    const requests = h.requests.length;
    assert.throws(() => h.adapter.retryCalculatedFieldRendering(h.record), /removed/);
    assert.equal(h.requests.length, requests);
});

test("a pending style cannot restore a reference to a deleted calculated field", async () => {
    let holdStyle = false;
    let finishStyle;
    const h = createFixture({style: async (_source, candidate) => {
        if (holdStyle) return new Promise(resolve => { finishStyle = () => resolve({styleName: "obsolete", style: candidate}); });
        return {styleName: "current", style: candidate};
    }});
    h.adapter.createLayer(h.record, () => {});
    const definition = {version: 1, name: "scaled_year", expression: "'year' * 2", numericText: false};
    const fields = Object.fromEntries(FIELDS.map(field => [field.name, field.type]));
    const installation = h.adapter.installCalculatedFields(h.record,
        {calculatedFields: [definition], fields: {...fields, scaled_year: "float"}});
    h.requests.at(-1).resolve({layerName: "eolab:calculated"});
    await installation;
    const candidate = {...h.adapter.describeStyle(h.record).style, categorical: {
        field: definition.name, limit: 2,
        rules: [{value: {kind: "number", value: 4000}, color: "#00ff00", label: null, opacity: 1}],
        otherColor: "#ffffff", missingColor: null,
    }};
    holdStyle = true;
    const oldStyle = h.adapter.applyStyle(h.record, candidate);
    holdStyle = false;
    const deletion = h.adapter.installCalculatedFields(h.record, {calculatedFields: [], fields});
    finishStyle();
    await assert.rejects(oldStyle, /layer changed.*Reopen Style/);
    h.requests.at(-1).resolve({layerName: "eolab:original"});
    await deletion;
    assert.equal(h.adapter.describeStyle(h.record).style.categorical, null);
    assert.equal(h.record.publication.styleName, "current");
    assert.deepEqual(h.adapter.exportCalculatedFields(h.record), []);
});

test("cancelled installation leaves previous calculated fields unchanged", async () => {
    const h = createFixture();
    const abort = new AbortController(); abort.abort();
    assert.throws(() => h.adapter.installCalculatedFields(h.record, {calculatedFields: [], fields: {}}, abort.signal), {name: "AbortError"});
    assert.deepEqual(h.adapter.exportCalculatedFields(h.record), []);
    assert.equal(h.adapter.describeSource(h.record).fields.length, FIELDS.length);
    assert.deepEqual(h.requests, []);
});

test("calculated field deletion preserves layers that still use the field", async t => {
    const definition = {version: 1, name: "scaled_year", expression: "'year' * 2", numericText: false};
    const fields = Object.fromEntries(FIELDS.map(field => [field.name, field.type]));
    const filter = {enabled: true, match: "all", rules: [{field: definition.name, operator: "gt", value: 4000}]};
    const uses = [
        {name: "active filter", filter, error: /filter rules/},
        {name: "disabled filter", filter: {...filter, enabled: false}, error: /filter rules/},
        {name: "label", style: {label: {field: definition.name, fontFamily: "SansSerif", fontSize: 12,
            fontWeight: "normal", fontColor: "#111111", haloColor: "#ffffff", haloWidth: 1,
            placement: "center", minimumZoom: 0}}, error: /label field/},
        {name: "category style", style: {categorical: {field: definition.name, limit: 2,
            rules: [{value: {kind: "number", value: 4000}, color: "#00ff00", label: null, opacity: 1}],
            otherColor: "#ffffff", missingColor: null}}, error: /category field/},
        {name: "numeric style", style: {graduated: {field: definition.name, method: "equal-interval",
            classCount: 2, palette: "blues", rules: [
                {minimum: null, maximum: 4000, color: "#0000ff"},
                {minimum: 4000, maximum: null, color: "#ffffff"}], missingColor: null}}, error: /numeric field/},
    ];
    for (const usage of uses) {
        await t.test(usage.name, async () => {
            const h = createFixture();
            h.adapter.createLayer(h.record, () => {});
            const installation = h.adapter.installCalculatedFields(h.record,
                {calculatedFields: [definition], fields: {...fields, scaled_year: "float"}});
            h.requests.at(-1).resolve({layerName: "eolab:calculated"});
            await installation;
            if (usage.filter) await applyFilter(h, usage.filter);
            if (usage.style) await h.adapter.applyStyle(h.record, {...h.adapter.describeStyle(h.record).style, ...usage.style});

            const pendingFilter = h.adapter.applyFilterState(h.record, yearFilter(2024));
            const pendingRequest = h.requests.at(-1);
            const state = {...h.record.state}, publication = h.record.publication;
            const calls = [...h.calls], notifications = [...h.notifications];
            assert.match(h.adapter.getCalculatedFieldRemovalError(h.record, definition.name), usage.error);
            assert.throws(() => h.adapter.installCalculatedFields(h.record, {calculatedFields: [], fields}), usage.error);
            assert.deepEqual(h.record.state, state);
            assert.equal(h.record.publication, publication);
            assert.equal(pendingRequest.signal.aborted, false, "rejected deletion does not cancel a pending filter");
            for (const count of h.counts) assert.equal(count.signal.aborted, false);
            assert.deepEqual(h.calls, calls);
            assert.deepEqual(h.notifications, notifications);
            assert.deepEqual(h.adapter.exportCalculatedFields(h.record), [definition]);
            assert.equal(h.adapter.renderingAvailable(h.record), true);

            h.adapter.cancelPendingFilter(h.record);
            pendingRequest.reject(new DOMException("Cancelled", "AbortError"));
            await pendingFilter;
        });
    }
});

test("unused calculated fields can be removed while a field in use is updated", async () => {
    const h = createFixture();
    const originalSource = h.record.state.source;
    const scaled = {version: 1, name: "scaled_year", expression: "'year' * 2", numericText: false};
    const offset = {...scaled, name: "offset_year", expression: "'year' + 1"};
    const fields = Object.fromEntries(FIELDS.map(field => [field.name, field.type]));
    const installation = h.adapter.installCalculatedFields(h.record,
        {calculatedFields: [scaled, offset], fields: {...fields, scaled_year: "float", offset_year: "float"}});
    h.requests.at(-1).resolve({layerName: "eolab:calculated"});
    await installation;
    const filter = {enabled: false, match: "all", rules: [{field: scaled.name, operator: "gt", value: 4000}]};
    await applyFilter(h, filter);
    assert.equal(h.adapter.getCalculatedFieldRemovalError(h.record, offset.name), null);

    const updated = {...scaled, expression: "'year' * 3"};
    const removal = h.adapter.installCalculatedFields(h.record,
        {calculatedFields: [updated], fields: {...fields, scaled_year: "float"}});
    h.requests.at(-1).resolve({layerName: "eolab:updated"});
    assert.equal(await removal, null);
    assert.deepEqual(h.adapter.exportCalculatedFields(h.record), [updated]);
    assert.deepEqual(h.adapter.describeFilter(h.record).filter, filter);
    assert.equal(h.adapter.describeSource(h.record).fields.some(field => field.name === offset.name), false);
    assert.equal(h.adapter.renderingAvailable(h.record), true);
    assert.equal(originalSource.calculatedFields, undefined);
});

/**
 * Create a vector with controlled API replies and no attached map layer.
 * @param {Object} [options] Source and publication variants.
 * @param {"point"|"line"|"polygon"} [options.geometryKind="polygon"] Geometry class.
 * @param {Object} [options.properties] Catalog field and geometry metadata.
 * @param {(record:Object)=>void} [options.onFilterChange] Optional synchronous composition callback.
 * @param {(source:Object,candidate:Object)=>Promise<Object>} [options.style] Optional controlled style transport.
 * @return {{adapter:Object,record:Object,requests:Object[],counts:Object[],calls:string[],updates:Object[],notifications:Object[]}}
 * Adapter, retained record, pending requests, and observed external work.
 */
function createFixture({ geometryKind = "polygon", properties = {
    "table:primary_geometry": "geometry",
    "eolab:vector_source": { asset_key: "data", layer_name: "parcels" },
    "table:columns": [{ name: "geometry", type: "geometry" }, ...FIELDS],
}, onFilterChange = () => {}, style = async (_source, candidate) => ({styleName: "changed-style", style: candidate}) } = {}) {
    const calls = [], requests = [], counts = [], updates = [], notifications = [];
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
            return { once: () => {}, on() {}, setParams: parameters => updates.push(parameters) };
        } } },
        leafletMap: {}, wmsUrl: "/wms", onTileError: () => {},
        publish: async () => { calls.push("publish"); return publication; },
        style: async (_item, candidate) => {
            calls.push("apply style");
            return style(_item, candidate);
        },
        summarize: async () => { calls.push("summarize"); return {}; },
        classify: async () => { calls.push("classify"); return {}; },
        filter: (_item, candidate, signal) => {
            calls.push("apply filter");
            return new Promise((resolve, reject) => requests.push({ candidate, signal, resolve, reject }));
        },
        countFilter: (_item, candidate, signal) => {
            calls.push("count filter");
            return new Promise((resolve, reject) => counts.push({ candidate, signal, resolve, reject }));
        },
        onFilterChange: record => {
            notifications.push({filter: structuredClone(record.state.filter),
                count: structuredClone(record.state.filterCount), layerName: record.publication.layerName});
            onFilterChange(record);
        },
    });
    const record = { entry: { key: "vectors:parcels", label: "Parcels", item }, publication,
        state: adapter.createState({ item, publication }) };
    return { adapter, record, requests, counts, calls, updates, notifications };
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
        assert.deepEqual(source, { source: { collectionId: "vectors", itemId: "parcels" }, origin: "catalog",
            selection: { collectionId: "vectors", itemId: "parcels", assetKey: "data", layerName: "parcels" },
            fields: FIELDS, scalarFields: FIELDS, numericFields: [FIELDS[0]], geometryKind, primaryGeometry: "geometry" });
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
        source: { collectionId: "vectors", itemId: "parcels" }, origin: "catalog",
        selection: null, fields: [], scalarFields: [], numericFields: [], geometryKind: "polygon", primaryGeometry: null,
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

test("checked rules and counts are accepted before rendering without recounting or changing another view", async () => {
    const {adapter, record, requests, counts, notifications, updates} = createFixture();
    adapter.createLayer(record, () => {});
    const other = {...record, entry: {...record.entry, key: "second-view"},
        state: adapter.createState({item: record.entry.item, publication: record.publication})};
    const candidate = yearFilter(2024), count = {matched: 3, total: 10, complete: true};
    const pending = adapter.applyCheckedFilter(record, candidate, count);
    assert.deepEqual(adapter.describeFilter(record), {filter: yearFilter(2024), status: "3 of 10 features match"});
    assert.deepEqual(notifications, [{filter: candidate, count, layerName: "eolab:parcels"}]);
    assert.equal(record.publication.layerName, "eolab:parcels");
    assert.equal(adapter.exportFilterState(other).rules.length, 0);
    candidate.rules[0].value = 2030; count.matched = 0;
    assert.deepEqual(adapter.exportFilterState(record), yearFilter(2024));
    assert.equal(record.state.filterCount.matched, 3);
    requests[0].resolve({layerName: "eolab:checked", filter: yearFilter(2024)});
    assert.deepEqual(await pending, yearFilter(2024));
    assert.equal(notifications.length, 2);
    assert.equal(notifications[1].layerName, "eolab:checked");
    assert.deepEqual(updates, [{layers: "eolab:checked"}]);
    assert.equal(counts.length, 0);
});

test("checked selection survives rendering failure while failed or cancelled map edits keep it unchanged", async () => {
    const {adapter, record, requests, counts} = createFixture();
    const checked = adapter.applyCheckedFilter(record, yearFilter(2024), {matched: 3, total: 10, complete: true});
    requests[0].reject(new Error("Publication unavailable"));
    await assert.rejects(checked, /Publication unavailable/);
    const accepted = adapter.describeFilter(record);
    assert.deepEqual(accepted, {filter: yearFilter(2024), status: "3 of 10 features match"});
    const failed = adapter.applyFilterState(record, yearFilter(2025));
    requests[1].reject(new Error("Invalid publication"));
    await assert.rejects(failed, /Invalid publication/);
    assert.deepEqual(adapter.describeFilter(record), accepted);
    const cancelled = adapter.applyFilterState(record, yearFilter(2026));
    adapter.cancelPendingFilter(record);
    requests[2].reject(new DOMException("Cancelled", "AbortError"));
    assert.equal(await cancelled, null);
    assert.deepEqual(adapter.describeFilter(record), accepted);
    assert.equal(record.publication.layerName, "eolab:parcels");
    assert.equal(counts.length, 0);
});

test("checked commits replace pending map edits and counts, and later map edits replace checked rendering", async () => {
    const fixture = createFixture();
    const {adapter, record, requests, counts} = fixture;
    await applyFilter(fixture, yearFilter(2020));
    const obsoleteMap = adapter.applyFilterState(record, yearFilter(2021));
    const checked = adapter.applyCheckedFilter(record, yearFilter(2022), {matched: 4, total: 10, complete: true});
    assert.equal(requests[1].signal.aborted, true);
    assert.equal(counts[0].signal.aborted, true);
    requests[1].reject(new Error("Obsolete map error"));
    counts[0].resolve({matched: 9, total: 10, complete: true});
    assert.equal(await obsoleteMap, null);
    await flush();
    assert.equal(adapter.describeFilter(record).status, "4 of 10 features match");
    const newerMap = adapter.applyFilterState(record, yearFilter(2023));
    assert.equal(requests[2].signal.aborted, false);
    requests[3].resolve({layerName: "eolab:newer-map", filter: yearFilter(2023)});
    await newerMap;
    assert.equal(requests[2].signal.aborted, true);
    requests[2].resolve({layerName: "eolab:obsolete-checked", filter: yearFilter(2022)});
    assert.equal(await checked, null);
    counts[1].resolve({matched: 2, total: 10, complete: true});
    await flush();
    assert.equal(record.publication.layerName, "eolab:newer-map");
    assert.deepEqual(adapter.describeFilter(record), {filter: yearFilter(2023), status: "2 of 10 features match"});
    const removed = adapter.applyCheckedFilter(record, yearFilter(2024), {matched: 1, total: 10, complete: true});
    adapter.removed(record);
    assert.equal(requests[4].signal.aborted, true);
    requests[4].reject(new Error("Removed view"));
    assert.equal(await removed, null);
    assert.equal(record.publication.layerName, "eolab:newer-map");
});

test("synchronous filter notifications cannot start stale counts or rendering after a replacement", async () => {
    let replacement, fixture;
    fixture = createFixture({onFilterChange: record => {
        if (record.state.filter.rules[0]?.value === 2020) {
            replacement = fixture.adapter.applyCheckedFilter(record, yearFilter(2022), {matched: 4, total: 10, complete: true});
        }
    }});
    const {adapter, record, requests, counts} = fixture;
    const first = adapter.applyFilterState(record, yearFilter(2020));
    requests[0].resolve({layerName: "eolab:first", filter: yearFilter(2020)});
    assert.equal(await first, null);
    assert.equal(counts.length, 0);
    requests[1].resolve({layerName: "eolab:replacement", filter: yearFilter(2022)});
    await replacement;
    const superseded = adapter.applyCheckedFilter(record, yearFilter(2020), {matched: 6, total: 10, complete: true});
    assert.equal(await superseded, null);
    assert.equal(requests.length, 3, "Only the synchronously accepted replacement requests rendering");
    requests[2].resolve({layerName: "eolab:replacement", filter: yearFilter(2022)});
    await replacement;
    assert.deepEqual(adapter.describeFilter(record), {filter: yearFilter(2022), status: "4 of 10 features match"});
});

test("invalid editor drafts and failed replacement requests leave accepted-filter rendering underway", async () => {
    const {adapter, record, requests, counts} = createFixture();
    const checked = adapter.applyCheckedFilter(record, yearFilter(2024), {matched: 3, total: 10, complete: true});
    const controls = new VectorFilterControls({
        documentContext: new FakeRasterControlDocument(),
        inspection: {showFilter() {}, hideFilter() {}, updateLayerEditorName() {}},
        getTarget: () => ({label: record.entry.label, fields: adapter.describeSource(record).fields,
            ...adapter.describeFilter(record), apply: candidate => adapter.applyFilterState(record, candidate),
            cancelPending: () => adapter.cancelPendingFilter(record)}),
    });
    controls.open(record.entry.key);
    const input = controls.rules.children[0].children[2];
    input.value = "not-a-number"; input.dispatchEvent(new Event("input"));
    assert.equal(requests[0].signal.aborted, false);
    controls.close();
    const replacement = adapter.applyFilterState(record, yearFilter(2025));
    assert.equal(requests[0].signal.aborted, false);
    requests[1].reject(new Error("Replacement failed"));
    await assert.rejects(replacement, /Replacement failed/);
    requests[0].resolve({layerName: "eolab:accepted-2024", filter: yearFilter(2024)});
    assert.deepEqual(await checked, yearFilter(2024));
    assert.equal(record.publication.layerName, "eolab:accepted-2024");
    assert.deepEqual(adapter.describeFilter(record), {filter: yearFilter(2024), status: "3 of 10 features match"});
    assert.equal(requests.length, 2);
    assert.equal(counts.length, 0);
    controls.destroy();
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
    assert.deepEqual(updates, [{ styles: "changed-style", vector_style: JSON.stringify(candidate) }]);
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
