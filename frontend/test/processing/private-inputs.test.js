import test from "node:test";
import assert from "node:assert/strict";
import { ProcessingApiClient } from "../../src/processing/api.js";

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
