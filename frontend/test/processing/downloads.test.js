import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DownloadsController } from "../../src/processing/downloads-controller.js";
import { DownloadsView, describeJobProgress, describeClipCrs } from "../../src/processing/downloads-view.js";
import { ProcessingApiClient, ProcessingRequestError, processingDownloadUrl } from "../../src/processing/api.js";
import { PendingSubmissionStorage } from "../../src/processing/pending-submission.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

const source = { collectionId: "rasters", itemId: "human-footprint", label: "Human footprint" };
const box = { kind: "selectedArea", selectedBounds: { west: 77, south: 22, east: 78, north: 23 } };
const id = "a".repeat(32);
const plan = { planId: id, expiresAt: "2099-01-01T00:00:00Z", area: { kind: "bounds", bounds: [77,22,78,23] },
    grid: { transform: [1000, 0, 0, 0, -1000, 0], width: 100, height: 120, crs: "EPSG:3857", dtype: "float32", estimatedRawBytes: 60000 } };
const job = { jobId: id, operation: "raster.clip.v1", status: "queued", source, area: plan.area, grid: plan.grid, progress: {}, result: null };

/** Create isolated controller adapters with real pending storage. @param {Object} overrides API overrides. @return {Object} Fixture. */
function fixture(overrides = {}) {
    const data = new Map();
    const storage = new PendingSubmissionStorage({ getItem: key => data.get(key), setItem: (key,value) => data.set(key,value), removeItem: key => data.delete(key) });
    const requests = [];
    const api = { listJobs: async () => [], planClip: async (s,a) => { requests.push([s,a]); return structuredClone(plan); },
        submitClip: async value => { requests.push(value); return structuredClone(job); },
        cancelJob: async value => requests.push(["cancel",value]), deleteJob: async value => requests.push(["delete",value]), ...overrides };
    let context = { sources: [structuredClone(source)], area: structuredClone(box) };
    const view = { bind(handlers) { this.handlers = handlers; }, render(state) { this.state = state; }, unbind() {} };
    const timers = [];
    const options = { api, view, storage, getContext: () => context, onOpen() {}, onClose() {}, onEditArea() {},
        clock: { setTimeout(callback, delay) { timers.push([callback,delay]); return timers.length; }, clearTimeout() {} }, requestId: () => "request-1234567890" };
    const controller = new DownloadsController(options);
    return { controller, api, view, storage, requests, timers, options, data, get context() { return context; }, setContext(value) { context = value; } };
}

test("review freezes the selected source and box independently of later map changes", async () => {
    const h = fixture(); h.controller.open();
    h.context.area.selectedBounds.west = 60;
    h.context.sources[0].label = "Changed";
    await h.controller.review();
    assert.equal(h.requests[0][1].selectedBounds.west, 77);
    assert.equal(h.requests[0][0].label, "Human footprint");
    assert.ok(Object.isFrozen(h.requests[0][1].selectedBounds));
    await h.controller.submit();
    h.controller.open(source, { ...box, selectedBounds: { west: 1, south: 2, east: 3, north: 4 } });
    assert.deepEqual(h.view.state.jobs[0].area.bounds, [77,22,78,23]);
});

test("whole-raster selection cannot silently become an uploaded AOI or whole export", async () => {
    const h = fixture(); h.setContext({ sources: [source], area: { kind: "wholeRaster" } });
    h.controller.setTemporaryAoi({ id, filename: "aoi.gpkg", selectedDataset: "area" });
    h.controller.open(); await h.controller.review();
    assert.equal(h.requests.length, 0); assert.equal(h.view.state.area, null);
    h.controller.selectArea("uploaded"); await h.controller.review();
    assert.deepEqual(h.requests[0][1], { kind: "temporaryAoi", temporaryAoiId: id });
});

test("removing an AOI invalidates an unsubmitted review and preserves an accepted job", async () => {
    const h = fixture(); h.controller.setTemporaryAoi({ id }); h.controller.open(); h.controller.selectArea("uploaded");
    await h.controller.review(); h.controller.setTemporaryAoi(null);
    assert.equal(h.view.state.plan, null); assert.equal(h.view.state.area, null);
    h.controller.open(source, box); await h.controller.review(); await h.controller.submit();
    h.controller.setTemporaryAoi(null); assert.equal(h.view.state.jobs.length, 1);
});

test("late planning results cannot replace a newer selection", async () => {
    let resolve; let signal;
    const h = fixture({ planClip: (_s,_a,s) => { signal=s; return new Promise(r => { resolve=r; }); } });
    h.controller.open(); const pending = h.controller.review();
    h.controller.selectSource(0); assert.ok(signal.aborted);
    resolve(plan); await pending; assert.equal(h.view.state.plan, null);
});

test("uncertain submission survives reload and retries the original plan/key", async () => {
    const h = fixture({ submitClip: async value => { h.requests.push(value); throw new Error("Network disconnected"); } });
    h.controller.open(); await h.controller.review(); await h.controller.submit();
    const saved = h.storage.read(); assert.equal(saved.planId, id);
    h.controller.open(source, null); assert.deepEqual(h.storage.read(), saved);
    const recovered = new DownloadsController({ ...h.options, api: { ...h.api, listJobs: async () => [job], submitClip: async value => { h.requests.push(value); return job; } } });
    await recovered.start();
    assert.deepEqual(h.requests.at(-1), h.requests.at(-2));
    assert.equal(h.storage.read(), null); assert.equal(h.view.state.jobs.length, 1);
});

test("definitive capacity rejection releases intent; server error retains it", async () => {
    const h = fixture({ submitClip: async () => { throw new ProcessingRequestError("Storage busy", 429, "storage_full"); } });
    h.controller.open(); await h.controller.review(); await h.controller.submit();
    assert.equal(h.storage.read(), null); assert.equal(h.view.state.plan, null);
    assert.match(h.view.state.message, /Storage busy/);
    h.api.submitClip = async () => { throw new ProcessingRequestError("Restarting", 503); };
    await h.controller.review(); await h.controller.submit();
    assert.ok(h.storage.read());
});

test("expired estimates and unavailable recovery storage never dispatch a job", async () => {
    const h = fixture(); h.controller.open(); await h.controller.review();
    h.view.state.plan.expiresAt = "2000-01-01T00:00:00Z";
    await h.controller.submit(); assert.equal(h.requests.length, 1);
    h.controller.storage = new PendingSubmissionStorage(null);
    await h.controller.review(); await h.controller.submit(); assert.equal(h.requests.length, 2);
    assert.match(h.view.state.message, /recovery/);
});

test("polling recovers owned jobs without any map layers and lifecycle buttons call the API", async () => {
    const h = fixture({ listJobs: async () => [job] });
    h.setContext({ sources: [], area: null }); await h.controller.start();
    assert.equal(h.view.state.jobs.length, 1); assert.equal(h.timers.at(-1)[1], 2000);
    await h.controller.jobAction(id,"cancel"); await h.controller.jobAction(id,"delete");
    assert.deepEqual(h.requests, [["cancel",id],["delete",id]]);
});

test("clip Downloads ignores calculation jobs in shared processing history", async () => {
    const calculation = { ...job, jobId: "b".repeat(32), operation: "raster.aggregate.v1",
        area: { kind: "wholeRaster", bounds: null }, source: undefined };
    const h = fixture({ listJobs: async () => [calculation, job] });
    await h.controller.start();
    assert.deepEqual(h.view.state.jobs, [job]);
    assert.equal(h.view.state.jobMessage, "");
});

test("an older job listing cannot erase a newly accepted clip", async () => {
    let finishList;
    const h = fixture({ listJobs: () => new Promise(resolve => { finishList = resolve; }) });
    const listing = h.controller.refresh();
    h.controller.open(); await h.controller.review(); await h.controller.submit();
    finishList([]); await listing;
    assert.equal(h.view.state.jobs[0].jobId, id);
    assert.equal(h.timers.at(-1)[1], 2000);
});

test("session cookie is established before planning and only catalog identity/explicit area is sent", async () => {
    const requests=[];
    const api = new ProcessingApiClient(async (url,options) => {
        requests.push([url,options]); return new Response(JSON.stringify(url.endsWith("/jobs") ? { jobs: [] } : plan));
    });
    await Promise.all([api.planClip({ ...source, path: "private" }, box), api.listJobs()]);
    assert.equal(requests[0][0], "/api/processing/jobs");
    const sent = requests.find(([url]) => url.endsWith("/plan"))[1];
    assert.deepEqual(JSON.parse(sent.body), { collectionId: source.collectionId, itemId: source.itemId, selectedBounds: box.selectedBounds });
    assert.equal(sent.headers["X-EOLab-Processing"], "1"); assert.equal(sent.credentials, "same-origin");
    await assert.rejects(api.planClip(source,{ kind:"wholeRaster" }), /Select a box/);
});

test("API preserves actionable no-overlap and capacity errors", async () => {
    const api = new ProcessingApiClient(async () => new Response(JSON.stringify({ detail: { code: "no_overlap", message: "Area does not overlap the raster" } }),{ status:422 }));
    await assert.rejects(api.listJobs(), error => error.code === "no_overlap" && error.status === 422);
    assert.equal(api.session, null);
});

test("download navigation is limited to direct owned artifact endpoints", () => {
    assert.equal(processingDownloadUrl(`/api/processing/jobs/${id}/result`,id,"result"), `/api/processing/jobs/${id}/result`);
    for (const bad of ["https://other.org/file", "javascript:alert(1)", `/api/processing/jobs/${"b".repeat(32)}/result`]) {
        assert.throws(() => processingDownloadUrl(bad,id,"result"));
    }
});

test("DOM review and job cards show grid, real progress, direct links and independent actions", async () => {
    const h = fixture();
    const doc = new FakeRasterControlDocument(); const view = new DownloadsView(doc);
    const actions=[]; view.bind({ onOpen() {}, onClose() {}, onSource() {}, onArea() {}, onReview() {}, onCreate() {}, onRetrySubmission() {}, onRefresh() {}, onEditArea() {}, onCancel: id => actions.push(id), onDelete: id => actions.push(id) });
    h.controller.open(); await h.controller.review();
    view.render(h.view.state);
    const text = element => element.textContent + element.children.map(text).join(" ");
    assert.match(text(doc.querySelector("#downloads-plan")), /100 × 120 pixels/);
    assert.match(text(doc.querySelector("#downloads-plan")), /EPSG:3857/);
    h.view.state.jobs = [{ ...job, status:"ready", expiresAt: plan.expiresAt,
        result: { url:`/api/processing/jobs/${id}/result`, provenanceUrl:`/api/processing/jobs/${id}/provenance`, bytes:100, filename:"clip.tif" } }];
    view.render(h.view.state);
    const card = doc.querySelector("#downloads-jobs").children[0];
    const link = card.children.find(child => child.textContent === "Download COG");
    assert.equal(link.href, `/api/processing/jobs/${id}/result`);
    card.children.at(-1).dispatchEvent(new Event("click")); assert.deepEqual(actions,[id]);
    assert.match(doc.querySelector("#open-downloads").textContent,/1 ready/);
    assert.equal(describeJobProgress({ ...job, status:"running", progress:{phase:"clipping",completedBlocks:3,totalBlocks:10} }),"Clipping · 3 of 10 source blocks");
    assert.match(describeJobProgress({ ...job, status:"running", progress:{phase:"creating_cog"} }),/Preparing download/);
    view.unbind();
});

test("pending recovery ignores corrupt and oversized browser data", () => {
    for (const value of ["bad JSON", "x".repeat(3000), JSON.stringify({planId:"bad", requestId:"valid-request-1234",label:"raster"})]) {
        assert.equal(new PendingSubmissionStorage({ getItem: () => value }).read(),null);
    }
});

test("native CRS presentation uses the root authority, not the embedded geographic datum", () => {
    assert.equal(describeClipCrs('PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]],AUTHORITY["EPSG","3857"]]'), "WGS 84 / Pseudo-Mercator (EPSG:3857)");
    assert.equal(describeClipCrs('PROJCRS["Custom grid",ID["EPSG",32643]]'), "Custom grid (EPSG:32643)");
    assert.equal(describeClipCrs('PROJCS["Custom grid",GEOGCS["WGS 84",AUTHORITY["EPSG","4326"]],UNIT["metre",1]]'), "Custom grid");
    assert.equal(describeClipCrs("EPSG:4326"), "EPSG:4326");
});

test("Downloads and sampling share only neutral selection values; peers never import Processing", () => {
    const root = new URL("../../src/",import.meta.url);
    for (const directory of ["raster", "map-layers", "temporary-aoi"]) {
        for (const file of readdirSync(new URL(`${directory}/`,root)).filter(name=>name.endsWith(".js"))) {
            const source = readFileSync(new URL(`${directory}/${file}`,root),"utf8");
            assert.doesNotMatch(source,/from\s+["'][^"']*processing\//);
        }
    }
    for (const file of readdirSync(new URL("processing/",root))) {
        const source = readFileSync(new URL(`processing/${file}`,root),"utf8");
        assert.doesNotMatch(source,/from\s+["'][^"']*(?:raster\/|map-layers\/|temporary-aoi\/|map-inspection)/);
        assert.doesNotMatch(source,/\.blob\(|createObjectURL/);
    }
    assert.doesNotMatch(readFileSync(new URL("selected-area.js",root),"utf8"),/\bimport\b|\bfetch\b|\bdocument\b/);
});
