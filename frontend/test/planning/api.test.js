import assert from "node:assert/strict";
import test from "node:test";
import {PlanningApiClient, PlanningRequestError} from "../../src/planning/api.js";

const TOOL_ID = "10000000-0000-4000-8000-000000000001";
const LAYER_ID = "20000000-0000-4000-8000-000000000001";
const INTERVENTION_ID = "30000000-0000-4000-8000-000000000001";
const document = {title: "Local restoration", layers: [{id: LAYER_ID, definition: {catalogItem: {collection: "local", id: "parcels"}, isCustom: true}}],
    aoiLayerId: LAYER_ID, parcelLayerId: LAYER_ID, parcelIdField: "parcel_id", interventions: [{id: INTERVENTION_ID, label: "Reforestation"}]};
const record = {...document, id: TOOL_ID, revision: 2, createdAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:00:00Z"};

test("planning CRUD uses private same-site requests and updates the expected revision", async () => {
    const calls = [];
    const api = new PlanningApiClient(async (url, options) => { calls.push({url, options}); return Response.json(options.method === "GET" && !url.endsWith(TOOL_ID) ? [record] : record); });
    const signal = new AbortController().signal;
    assert.equal((await api.list(signal))[0].id, TOOL_ID); assert.deepEqual(await api.get(TOOL_ID), record);
    assert.deepEqual(await api.create(document), record); assert.deepEqual(await api.update(TOOL_ID, 1, document), record);
    for (const {options} of calls) { assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store"); }
    assert.equal(calls[0].options.signal, signal); assert.equal(calls[2].options.headers["X-EOLab-Planning"], "1");
    assert.deepEqual(JSON.parse(calls[2].options.body), document);
    assert.deepEqual(JSON.parse(calls[3].options.body), {...document, expectedRevision: 1});
});

test("ID check sends source identity and field only, independent of calculated fields and filters", async () => {
    let submitted;
    const source = {collectionId: "local", itemId: "parcels", calculatedFields: [{name: "Computed"}], filter: {enabled: true}};
    const api = new PlanningApiClient(async (url, options) => {
        assert.equal(url, "/api/vector-sampling/parcels/validate-id"); submitted = JSON.parse(options.body);
        return Response.json({idField: "parcel_id", idType: "integer", featureCount: 42, selection: {collectionId: "local", itemId: "parcels"}});
    });
    assert.equal((await api.validateIds(source, "parcel_id")).featureCount, 42);
    assert.deepEqual(submitted, {collectionId: "local", itemId: "parcels", idField: "parcel_id"});
});

test("revision conflict retains status and server message", async () => {
    const api = new PlanningApiClient(async () => Response.json({detail: "Open the newer saved version."}, {status: 409}));
    await assert.rejects(api.update(TOOL_ID, 1, document), error => error instanceof PlanningRequestError && error.status === 409 && /newer saved/.test(error.message));
});

test("form validation reports the server's actionable explanation", async () => {
    const api = new PlanningApiClient(async () => Response.json({detail: [{loc: ["body"], msg: "Intervention identifiers and names must be unique"}]}, {status: 422}));
    await assert.rejects(api.create(document), error => error.status === 422 && /names must be unique/.test(error.message));
});

test("rejects malformed or mismatched records before restoring map state", async () => {
    for (const value of [{...record, revision: 0}, {...record, parcelLayerId: TOOL_ID}, {...record, id: LAYER_ID}]) {
        const api = new PlanningApiClient(async () => Response.json(value));
        await assert.rejects(api.get(TOOL_ID), PlanningRequestError);
    }
    let fetched = false;
    const api = new PlanningApiClient(async () => { fetched = true; });
    await assert.rejects(api.get("../../other"), PlanningRequestError); assert.equal(fetched, false);
});

test("response body cancellation remains cancellation", async () => {
    const aborted = new DOMException("Aborted", "AbortError");
    const api = new PlanningApiClient(async () => ({json: async () => { throw aborted; }}));
    await assert.rejects(api.list(), error => error === aborted);
});

test("default browser fetch preserves its Window receiver", async () => {
    const original = globalThis.fetch;
    try {
        globalThis.fetch = function () { assert.equal(this, globalThis); return Promise.resolve(Response.json([])); };
        assert.deepEqual(await new PlanningApiClient().list(), []);
    } finally { globalThis.fetch = original; }
});
