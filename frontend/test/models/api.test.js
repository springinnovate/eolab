import test from "node:test";
import assert from "node:assert/strict";
import { ProcessingApiClient } from "../../src/processing/api.js";
import { model, invocation, job, clipModel, clipResult, statisticsResult } from "../../test-support/models/fixtures.js";

/** Compose the transport over recorded same-origin HTTP replies.
 * @param {Function} reply Return the requested response body.
 * @return {Object} Client and recorded HTTP requests.
 */
function fixture(reply) {
    const calls = [];
    const api = new ProcessingApiClient(async (url, options) => {
        calls.push({url, options});
        return new Response(JSON.stringify(url.endsWith("/jobs") ? {jobs: []} : reply(url, options)), {headers: {"Content-Type": "application/json"}});
    }, null);
    return {api, calls};
}

test("discovery, pagination and saved inputs establish a same-origin session", async () => {
    const h = fixture(url => url.endsWith("/models") ? {models: [model]} : url.endsWith("/invocation") ? invocation : {jobs: [job()], nextCursor: null});
    assert.equal((await h.api.discoverModels())[0].id, model.id);
    await h.api.listModelRuns("a+b/="); await h.api.readModelInvocation(job().jobId);
    assert.match(h.calls[2].url, /cursor=a%2Bb%2F%3D/);
    for (const {options} of h.calls) { assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store"); }
    assert.equal(h.calls.filter(call => call.url.endsWith("/jobs")).length, 1);
});

test("submission uses the immutable request key and normal Processing mutation header", async () => {
    const h = fixture(() => job()); const body = {requestId: "x".repeat(32), model: invocation.model, inputs: invocation.inputs};
    await h.api.submitModelRun(body);
    assert.equal(h.calls[1].url, "/api/processing/model-runs");
    assert.equal(h.calls[1].options.headers["X-EOLab-Processing"], "1");
    assert.deepEqual(JSON.parse(h.calls[1].options.body), body);
});

test("model results use the existing numeric-row and download safety validation", async () => {
    const result = {...statisticsResult, url: `/api/processing/jobs/${job().jobId}/result`, provenanceUrl: `/api/processing/jobs/${job().jobId}/provenance`, rows: [{label: "Sum", expression: "sum(a)", state: "ok", value: "not-a-number", valueType: "float", aggregates: []}]};
    const h = fixture(() => job({status: "ready", expiresAt: "2099-01-01T00:00:00Z", result}));
    await assert.rejects(h.api.getJob(job().jobId), /invalid calculation result/);
    result.url = "https://untrusted.invalid/result";
    await assert.rejects(h.api.getJob(job().jobId), /download address/);
});

test("malformed model definitions and inconsistent progress are rejected", async () => {
    const h = fixture(() => ({models: [{...model, id: "../other"}]}));
    await assert.rejects(h.api.discoverModels(), /model identity/);
    const broken = fixture(() => job({progress: {completed: 4, total: 2}}));
    await assert.rejects(broken.api.getJob(job().jobId), /model run details/);
});


test("raster model results validate native grids, file metadata and owned download links", async () => {
    const result = structuredClone(clipResult);
    const h = fixture(() => job({model: clipModel, status: "ready", expiresAt: "2099-01-01T00:00:00Z", result}));
    assert.equal((await h.api.getJob(job().jobId)).result.kind, "raster");
    for (const change of [{kind: "unknown"}, {mediaType: "text/html"}, {bytes: -1}, {sha256: "bad"}, {validPixels: 101}, {rows: []},
        {grid: {...clipResult.grid, width: 0}}, {url: "https://other.invalid/result"}]) {
        Object.assign(result, structuredClone(clipResult), change);
        await assert.rejects(h.api.getJob(job().jobId));
        delete result.rows;
    }
});

test("unknown recipe identities and output names use shared result validation", async () => {
    for (const output of [clipResult, statisticsResult]) {
        const result = {...output, name: "habitat_result", label: "Habitat output"};
        const h = fixture(() => job({model: {...model, id: "custom-habitat-recipe"}, status: "ready", expiresAt: "2099-01-01T00:00:00Z", result}));
        assert.deepEqual((await h.api.getJob(job().jobId)).result, result);
    }
});
