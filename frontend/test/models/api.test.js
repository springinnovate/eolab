import test from "node:test";
import assert from "node:assert/strict";
import { ProcessingApiClient } from "../../src/processing/api.js";
import { model, invocation, job, clipModel, clipResult, statisticsResult, fileManifest } from "../../test-support/models/fixtures.js";

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

test("renewal uses the owned run endpoint and validates the returned job", async () => {
    const h = fixture(() => job());
    await h.api.renewModelRun(job().jobId);
    assert.equal(h.calls[1].url, `/api/processing/jobs/${job().jobId}/renew`);
    assert.equal(h.calls[1].options.method, "POST");
    assert.equal(h.calls[1].options.headers["X-EOLab-Processing"], "1");
    const broken = fixture(() => job({expiresAt: "invalid"}));
    await assert.rejects(broken.api.renewModelRun(job().jobId), /invalid/);
});

test("model deletion requests Undo and scopes restoration and dismissal to that exact deletion", async () => {
    const deletionUndo = {deletionId: "d".repeat(32), expiresAt: "2099-01-01T00:00:00Z"};
    const deleted = job({status: "deleted", deletionUndo}), h = fixture(() => deleted);
    assert.deepEqual(await h.api.deleteModelRun(deleted.jobId), deleted);
    await h.api.undoModelDeletion(deleted.jobId, deletionUndo.deletionId);
    await h.api.dismissModelDeletion(deleted.jobId, deletionUndo.deletionId);
    assert.equal(h.calls[1].url, `/api/processing/jobs/${deleted.jobId}?undo=true`);
    assert.equal(h.calls[1].options.method, "DELETE");
    for (const [index, action] of [[2, "undo"], [3, "dismiss"]]) {
        assert.equal(h.calls[index].url, `/api/processing/jobs/${deleted.jobId}/deletion/${action}`);
        assert.deepEqual(JSON.parse(h.calls[index].options.body), {deletionId: deletionUndo.deletionId});
        assert.equal(h.calls[index].options.headers["X-EOLab-Processing"], "1");
    }
    for (const change of [{status: "ready"}, {deletionUndo: {...deletionUndo, expiresAt: "bad"}},
        {deletionUndo: {...deletionUndo, deletionId: "../other"}}]) {
        const broken = fixture(() => ({...deleted, ...change}));
        await assert.rejects(broken.api.deleteModelRun(deleted.jobId));
    }
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

test("multiple run files require scoped URLs, unique IDs and valid availability", async () => {
    let artifacts = fileManifest();
    const h = fixture(() => job({status: "ready", expiresAt: artifacts.expiresAt, result: clipResult, artifacts}));
    assert.deepEqual((await h.api.getJob(job().jobId)).artifacts, artifacts);
    for (const damage of [
        value => { value.files[0].url = "https://elsewhere.invalid/file"; },
        value => { value.files[0].url = value.files[0].url.replace(value.jobId, "f".repeat(32)); },
        value => { value.files.push({...value.files[0]}); },
        value => { value.files[0].bytes = -1; },
        value => { value.files[0].sha256 = "bad"; },
        value => { value.files[0].filename = "../other"; },
        value => { value.availability = "pending"; },
        value => { value.totalBytes = 1; },
    ]) {
        artifacts = fileManifest(); damage(artifacts);
        await assert.rejects(h.api.getJob(job().jobId));
    }
});

test("more than 64 distinct run files are accepted and the last file is still validated", async () => {
    const artifacts = fileManifest(), source = artifacts.files[0];
    artifacts.files = Array.from({length: 65}, (_, index) => {
        const artifactId = index.toString(16).padStart(32, "0"), name = `intermediate_${index}`;
        return {...source, artifactId, name, filename: `${name}.tif`, role: "intermediate",
            label: `Intermediate ${index + 1}`,
            url: `/api/processing/jobs/${artifacts.jobId}/artifacts/${artifactId}`};
    });
    artifacts.totalBytes = artifacts.files.reduce((total, file) => total + file.bytes, artifacts.totalBytes);
    const h = fixture(() => job({status: "ready", expiresAt: artifacts.expiresAt, result: statisticsResult, artifacts}));
    assert.deepEqual((await h.api.getJob(job().jobId)).artifacts, artifacts);
    const lastFile = artifacts.files.at(-1);
    for (const change of [{url: lastFile.url.replace(artifacts.jobId, "f".repeat(32))}, {sha256: "bad"}]) {
        artifacts.files[artifacts.files.length - 1] = {...lastFile, ...change};
        await assert.rejects(h.api.getJob(job().jobId), /result file details|result file download address/);
    }
});
