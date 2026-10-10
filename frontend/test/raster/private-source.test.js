import test from "node:test";
import assert from "node:assert/strict";
import { rasterSourceKey, rasterSourceReference, labeledRasterSource } from "../../src/raster-source.js";
import { sampleRasterPixel, loadRasterStatistics, loadRasterPairedStatistics } from "../../src/raster/analysis-api.js";
import { readRasterMapWindow, describeRasterSource } from "../../src/raster/window-api.js";
import { rasterWindowImage, createRasterWindowLayer } from "../../src/raster/window-layer.js";
import { calculationIntent, CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { PendingSubmissionStorage } from "../../src/processing/pending-submission.js";
import { RasterSeriesCalculations } from "../../src/processing/raster-series-calculations.js";
import { RASTER_STATISTICS } from "../../test-support/raster/fixtures.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";

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

test("viewport responses require the requested original source, checksum, dimensions and bounds", async () => {
    const window = {bounds: area.selectedBounds, width: 2, height: 1};
    const valid = {source, version: raster.version, bounds: [0,0,1,1], width: 2, height: 1, values: [0,null]};
    const fetcher = value => async () => new Response(JSON.stringify(value));
    assert.deepEqual(await readRasterMapWindow(raster, window, undefined, fetcher(valid)), valid);
    for (const change of [{version: "d".repeat(64)}, {source: {...source, jobId: "e".repeat(32)}}, {width: 3}, {bounds: [1,0,2,1]}, {values: [1]}]) {
        await assert.rejects(readRasterMapWindow(raster, window, undefined, fetcher({...valid, ...change})), /invalid/);
    }
    await assert.rejects(describeRasterSource(source, undefined, fetcher({source, version: raster.version, width: 1})), /invalid/);
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

test("categorical transparency changes only display alpha, retaining valid zero and numeric input", () => {
    let painted;
    const documentContext = {createElement: () => ({getContext: () => ({createImageData: () => ({data: new Uint8ClampedArray(12)}), putImageData: image => {painted = image.data;}}), toDataURL: () => "image"})};
    const data = {width: 3, height: 1, values: [0,41,null]};
    const appearance = {mode: "categorical", continuous: {definition: DEFAULT_RASTER_STYLE},
        categorical: {categories: [{value:0,color:"#123456",opacity:0}, {value:41,color:"#228822",opacity:1}], unmapped: {color:"#000000",opacity:1}}};
    rasterWindowImage(data, appearance, documentContext);
    assert.equal(painted[3], 0); assert.equal(painted[7], 255); assert.equal(painted[11], 0);
    assert.deepEqual(data.values, [0,41,null]);
});

/** Compose the viewport adapter with controllable map events and HTTP completion.
 * @return {Object} Map, renderer and recorded request/paint boundaries.
 */
function windowFixture() {
    const events = new Map(), layers = new Set(), reads = [], images = [], status = [];
    const pane = {style: {}, remove() { this.removed = true; }};
    const map = {extent: [0,0,1,1], _panes: {},
        createPane(name) { this._panes[name] = pane; return pane; },
        getBounds() { const [w,s,e,n]=this.extent; return {getWest:()=>w,getSouth:()=>s,getEast:()=>e,getNorth:()=>n}; },
        project: p => ({x:p.lng*1024,y:p.lat*1024}),
        on(names, callback) { for (const name of names.split(" ")) events.set(name, callback); },
        off(names) { for (const name of names.split(" ")) events.delete(name); },
        addLayer(layer) { layers.add(layer); layer.onAdd?.(); },
        removeLayer(layer) { if (layers.delete(layer)) layer.onRemove?.(); }};
    const leaflet = {latLng: (lat,lng) => ({lat,lng}), Layer: {extend(methods) {
        return class {constructor() {Object.assign(this, methods);} addTo(map) {map.addLayer(this);return this;} fire() {return this;}};
    }}, imageOverlay: image => ({addTo(map) {map.addLayer(this); images.push(image);return this;},setUrl(image) {images.push(image);}})};
    let painted;
    const documentContext = {createElement: () => ({getContext: () => ({createImageData: (w,h) => ({data:new Uint8ClampedArray(w*h*4)}),putImageData: image => {painted=image.data;}}),toDataURL:()=>Array.from(painted)})};
    const appearance = {mode:"continuous",continuous:{definition:DEFAULT_RASTER_STYLE}};
    const read = (source, window, signal) => new Promise((resolve,reject)=>reads.push({source,window,signal,resolve,reject}));
    const layer = createRasterWindowLayer(leaflet,map,{...raster,key:rasterSourceKey(raster)},appearance,value=>status.push(value),read,documentContext);
    const complete = (read,value) => read.resolve({bounds:[read.window.bounds.west,read.window.bounds.south,read.window.bounds.east,read.window.bounds.north],
        width:read.window.width,height:read.window.height,values:new Array(read.window.width*read.window.height).fill(value)});
    return {map,events,layers,reads,images,status,pane,layer,complete,appearance};
}

test("viewport moves cancel obsolete reads; late responses cannot replace current display or recoloring", async () => {
    const h=windowFixture();h.layer.addTo(h.map);
    assert.equal(h.reads[0].window.width,512);
    h.events.get("movestart")();h.map.extent=[0,0,.1,.1];const refreshed=h.events.get("moveend")();
    assert.equal(h.reads[0].signal.aborted,true);assert.equal(h.reads[1].window.width,103);
    h.complete(h.reads[1],41);await refreshed;
    const current=h.images.at(-1);h.complete(h.reads[0],0);await Promise.resolve();await Promise.resolve();
    assert.equal(h.images.length,1);h.layer.setAppearance(h.appearance);assert.deepEqual(h.images.at(-1),current);
    h.layer.setOpacity(.35);h.layer.setZIndex(220);assert.equal(h.pane.style.opacity,"0.35");assert.equal(h.pane.style.zIndex,"220");
    h.layer.redraw();const pending=h.reads.at(-1);h.map.removeLayer(h.layer);assert.equal(pending.signal.aborted,true);
    h.complete(pending,0);await Promise.resolve();assert.equal(h.layers.size,0);
    h.layer.release();assert.equal(h.pane.removed,true);assert.equal(Object.keys(h.map._panes).length,0);assert.equal(h.events.size,0);
});

test("failed viewport delivery reports a recoverable display error and a new move clears it", async () => {
    const h=windowFixture();h.layer.addTo(h.map);
    h.reads[0].reject(new Error("Result expired"));await Promise.resolve();await Promise.resolve();
    assert.match(h.status.at(-1),/Result expired.*Move or zoom/);
    const refreshed=h.events.get("moveend")();h.complete(h.reads[1],0);await refreshed;
    assert.equal(h.status.at(-1),null);h.layer.release();
});
