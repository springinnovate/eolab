import test from "node:test";
import assert from "node:assert/strict";
import { rasterSourceKey, rasterSourceReference, labeledRasterSource } from "../../src/raster-source.js";
import { sampleRasterPixel, loadRasterStatistics, loadRasterPairedStatistics } from "../../src/raster/analysis-api.js";
import { describeRasterSource } from "../../src/raster/source-api.js";
import { publishRasterSource } from "../../src/raster/api.js";
import { calculationIntent, CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { PendingSubmissionStorage } from "../../src/processing/pending-submission.js";
import { RasterSeriesCalculations } from "../../src/processing/raster-series-calculations.js";
import { RASTER_STATISTICS } from "../../test-support/raster/fixtures.js";

const source = {kind: "runArtifact", jobId: "a".repeat(32), artifactId: "b".repeat(32)};
const raster = {source, label: "Coverage", version: "c".repeat(64), bbox: [0,0,1,1]};
const area = {kind: "selectedArea", selectedBounds: {west: 0, south: 0, east: 1, north: 1}};

test("source identity is independent of display fields and cannot become a file path", () => {
    assert.deepEqual(rasterSourceReference({...raster, preview: [99], path: "/private/file.tif"}), source);
    assert.equal(rasterSourceKey(raster), `local:artifact:${source.jobId}:${source.artifactId}`);
    assert.equal(rasterSourceKey({collectionId: "a", itemId: "b"}), '["a","b"]');
    assert.throws(() => rasterSourceReference({...source, artifactId: "/private/file.tif"}));
    assert.throws(() => rasterSourceReference({source: {url: "/download/file"}}));
});

test("pixel and distribution clients send original references, including mixed-source comparisons", async () => {
    const requests = [];
    const fetcher = async (url, options) => {
        requests.push({url, ...options, body: JSON.parse(options.body)});
        return new Response(JSON.stringify(url.endsWith("/pixels") ? {inBounds: true, value: 0} : RASTER_STATISTICS));
    };
    const signal = new AbortController().signal;
    assert.equal((await sampleRasterPixel(raster, {longitude: .5, latitude: .5}, signal, fetcher)).value, 0);
    await loadRasterStatistics(raster, {kind: "wholeRaster"}, signal, fetcher);
    // The deliberate wrong result validates that transport still reaches the paired response boundary.
    await assert.rejects(loadRasterPairedStatistics(raster, {collection: "catalog", id: "raster"}, {kind: "wholeOverlap"}, signal, fetcher));
    assert.deepEqual(requests[0].body.source, source); assert.deepEqual(requests[1].body.source, source);
    assert.deepEqual(requests[2].body.xRaster, source); assert.deepEqual(requests[2].body.yRaster, {collectionId: "catalog", itemId: "raster"});
    for (const request of requests) {
        assert.equal(request.headers["X-EOLab-Processing"], "1"); assert.equal(request.cache, "no-store");
        assert.equal(request.credentials, "same-origin"); assert.equal(request.signal, signal);
        assert.doesNotMatch(JSON.stringify(request.body), /preview|version|bbox|label/);
    }
});

test("temporary raster publication uses the ordinary rendering endpoint and path-free source identity", async () => {
    const requests = [], signal = new AbortController().signal;
    const publication = {layerName: `eolab:model_${source.jobId}_${source.artifactId}`, bbox: raster.bbox};
    const result = await publishRasterSource(raster, async (url, options) => {
        requests.push({url, options}); return new Response(JSON.stringify(publication));
    }, signal);
    assert.deepEqual(result, publication);
    assert.equal(requests[0].url, "/api/rendering/layers");
    assert.deepEqual(JSON.parse(requests[0].options.body), {source});
    assert.equal(requests[0].options.signal, signal);
    assert.equal(requests[0].options.credentials, "same-origin");
    assert.equal(requests[0].options.headers["X-EOLab-Processing"], "1");
});

test("source metadata requires matching identity, version, dimensions and capabilities", async () => {
    const valid = {source, version: raster.version, bounds: raster.bbox, width: 2, height: 1, bands: 1,
        capabilities: {pixels: {supported:true}, statistics: {supported:true}}};
    const fetcher = value => async () => new Response(JSON.stringify(value));
    assert.deepEqual(await describeRasterSource(source, undefined, fetcher(valid)), valid);
    for (const change of [{version: "invalid"}, {source: {...source, jobId: "e".repeat(32)}}, {width: 0}, {bounds: [1]}, {capabilities: {}}]) {
        await assert.rejects(describeRasterSource(source, undefined, fetcher({...valid, ...change})), /invalid/);
    }
});

test("ordinary calculation, stack and clip recovery retain private identities without display data", () => {
    const labeled = labeledRasterSource(raster, "Coverage");
    const intent = calculationIntent({source: labeled, area, calculations: [{label: "Total", expression: "sum(a)"}]});
    assert.deepEqual(intent.source, {...source, label: "Coverage"});
    const data = new Map(); const storage = {getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key,value), removeItem: key => data.delete(key)};
    const clip = new PendingSubmissionStorage(storage);
    clip.write({source: labeled, area, requestId: "a".repeat(32), label: "Clip"}); assert.deepEqual(clip.read().source, labeled);
    const recovery = new CalculationSessionStorage(storage);
    recovery.write({intent, jobId: "d".repeat(32), pending: null, cancelRequested: false, context: {automatic: true}});
    assert.deepEqual(recovery.read().intent, intent);
    const stack = new RasterSeriesCalculations({requests: {}});
    stack.updateCalculationInputs([{key: rasterSourceKey(raster), ...raster}], area, "Sampling area", [{id:1,label:"Total",expression:"sum(a)"}]);
    assert.deepEqual(stack.getRasterReference(stack.sources[0]), labeled);
});
