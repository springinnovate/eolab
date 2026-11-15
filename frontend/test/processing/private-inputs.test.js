import test from "node:test";
import assert from "node:assert/strict";
import { ProcessingApiClient } from "../../src/processing/api.js";

test("clip and calculation submissions preserve an uploaded raster's independent ownership identity", async () => {
    const sent = [];
    const api = new ProcessingApiClient(async (url, options) => {
        const body = options.body ? JSON.parse(options.body) : null;
        if (body) sent.push({url, body, headers: options.headers});
        const job = {jobId: "c".repeat(32), operation: url.endsWith("/raster-clips") ? "raster.clip.v1" : "raster.aggregate.v1", status: "queued", progress: {}};
        return new Response(JSON.stringify(url.endsWith("/jobs") ? {jobs: []} : url.endsWith("/batch") ? {items: [{index: 0, job}]} : job));
    });
    const reference = {kind: "uploadedRaster", uploadId: "75bdc2b7-dcc1-420a-b9b1-ed9db35e789d"};
    const source = {...reference, label: "My mask", path: "/private/mask.tif"};
    const area = {kind: "selectedArea", selectedBounds: {west: 0, south: 0, east: 1, north: 1}};
    await api.submitClip({source, area, requestId: "upload-clip"});
    await api.submitCalculation({source, area, requestId: "upload-summary", calculations: [{label: "Total", expression: "sum(a)"}]});
    assert.deepEqual(sent[0].body.source, reference);
    assert.deepEqual(sent[1].body.items[0].sources, {a: reference});
    assert.ok(sent.every(request => request.headers["X-EOLab-Processing"] === "1"));
    assert.doesNotMatch(JSON.stringify(sent), /private\/|path|My mask/);
});

test("existing clip and calculation clients submit opaque private references without preview or path data", async () => {
    const sent = [];
    const api = new ProcessingApiClient(async (url, options) => {
        const body = options.body ? JSON.parse(options.body) : null;
        if (body) sent.push({url, body});
        const job = {jobId: "c".repeat(32), operation: url.endsWith("/raster-clips") ? "raster.clip.v1" : "raster.aggregate.v1", status: "queued", progress: {}};
        return new Response(JSON.stringify(url.endsWith("/jobs") ? {jobs: []} : url.endsWith("/batch") ? {items: [{index: 0, job}]} : job));
    });
    const reference = {kind: "runArtifact", jobId: "a".repeat(32), artifactId: "b".repeat(32)};
    const source = {...reference, label: "Previous result", path: "/private/result.tif", preview: {values: [12]}};
    const area = {kind: "selectedArea", selectedBounds: {west: 0, south: 0, east: 1, north: 1}};
    await api.submitClip({source, area, requestId: "private-clip-request"});
    await api.submitCalculation({source, area, requestId: "private-summary-request", calculations: [{label: "Total", expression: "sum(a)"}]});
    assert.deepEqual(sent[0].body.source, reference);
    assert.deepEqual(sent[1].body.items[0].sources, {a: reference});
    assert.doesNotMatch(JSON.stringify(sent), /preview|\/private\/|Previous result/);
    await assert.rejects(api.submitClip({source: {...source, jobId: "not-an-id"}, area, requestId: "invalid-private-request"}));
});
