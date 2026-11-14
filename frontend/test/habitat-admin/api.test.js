import assert from "node:assert/strict";
import test from "node:test";
import { HabitatAdminApi, HabitatAdminRequestError } from "../../src/habitat-admin/api.js";

const PREPARATIONS = "/api/admin/habitat/input-preparations";
const ID = "a".repeat(32), DIGEST = "b".repeat(64);
const selection = {collectionId: "eolab-mounted-vectors", itemId: "countries",
    assetKey: "data", layerName: "boundaries", filter: {enabled: true, match: "all", rules: []}};
const command = {requestId: "prepare-countries-2018", name: "Countries", selection, year: 2018};
const options = {defaultYear: 2018, minimumYear: 2015, maximumYear: 2019,
    grid: {crs: "EPSG:6933", pixelSize: [100, 100], origin: [0, 0], unit: "metre", approximate: false},
    datasets: [{label: "Source data", url: "https://example.org/data", roles: ["predictor"]}]};

/** Make a real JSON HTTP response for an endpoint contract.
 * @param {Object} value Response JSON.
 * @param {number} [status=200] HTTP status.
 * @param {Object} [headers={}] Additional response headers.
 * @return {Response} Native Node fetch response.
 */
function response(value, status = 200, headers = {}) {
    return new Response(JSON.stringify(value), {status, headers: {"Content-Type": "application/json", ...headers}});
}

/** Supply a complete wire-format job for HTTP boundary tests.
 * @param {Object} [changes={}] Explicit lifecycle differences.
 * @return {Object} Job response matching the merged administration API.
 */
function job(changes = {}) {
    return {jobId: ID, operation: "habitat.prepare-inputs.v1", status: "queued",
        createdAt: "2026-11-03T08:00:00Z", updatedAt: "2026-11-03T08:00:00Z",
        expiresAt: "2026-11-04T08:00:00Z", metadataExpiresAt: null,
        inputs: {name: command.name, selection, year: 2018, configurationSha256: DIGEST},
        progress: {phase: null, completed: null, total: null, unit: null, details: null}, error: null, result: null,
        ...changes};
}

/** Supply a ready report with only this job's protected download URLs.
 * @param {Object} [changes={}] Report fields replaced for a negative test.
 * @return {Object} Public JSON-report download metadata.
 */
function report(changes = {}) {
    return {url: `${PREPARATIONS}/${ID}/report`, provenanceUrl: `${PREPARATIONS}/${ID}/provenance`,
        filename: "habitat-input-preparation-report.json", bytes: 200, sha256: DIGEST,
        year: 2018, configurationSha256: DIGEST, tileCount: 6, requiredTileCount: 6, failedTileCount: 0, ...changes};
}

/** Supply a bulk-check receipt without individual area/year inputs.
 * @param {Object} [changes={}] Lifecycle or report fields for the scenario.
 * @return {Object} Durable server handoff receipt.
 */
function bulkJob(changes = {}) {
    return job({operation: "habitat.retry-missing-inputs.v1", inputs: {areaCount: 4}, ...changes});
}

/** Supply bulk-report metadata sharing the same protected download contract.
 * @param {Object} [changes={}] Count or download metadata overrides.
 * @return {Object} Published check counts and protected report URLs.
 */
function bulkReport(changes = {}) {
    return {url: `${PREPARATIONS}/${ID}/report`, provenanceUrl: `${PREPARATIONS}/${ID}/provenance`,
        filename: "habitat-missing-inputs-report.json", bytes: 300, sha256: DIGEST,
        areaCount: 4, queuedCount: 1, cachedCount: 1, activeCount: 1, failedCount: 1, ...changes};
}

/** Construct a Catalog Item whose footprint must not determine eligibility.
 * @param {string} id Catalog Item identity.
 * @param {Object} [changes={}] Source format or declared feature geometry differences.
 * @return {Object} STAC metadata including a bounding-box Polygon for every feature type.
 */
function item(id, {geometry = "Polygon", format = "geopackage", kind = "mounted"} = {}) {
    return {type: "Feature", collection: "eolab-mounted-vectors", id,
        geometry: {type: "Polygon", coordinates: []},
        properties: {title: `Layer ${id}`,
            "eolab:vector_source": {kind, format, asset_key: format === "shapefile" ? "shp" : "data", layer_name: id},
            "table:primary_geometry": "geometry",
            "table:columns": [{name: "geometry", type: geometry}, {name: "country", type: "str"}]},
        assets: {data: {href: "file:///private/catalog/location.gpkg"}}};
}

test("all admin commands use the fixed endpoints, exact request IDs and browser-managed authentication", async () => {
    const calls = [];
    const api = new HabitatAdminApi(async (url, init) => {
        calls.push({url, init});
        if (url.includes("earth-engine-options")) return response(options);
        if (url.endsWith("cache-inventory")) return response({configurations: []});
        if (url.endsWith("cache-coverage")) return response({configurationSha256: DIGEST,
            year: 2018, requiredTiles: 6, cachedTiles: 4, missingTiles: 2});
        if (url.includes("?")) return response({jobs: [job()], nextCursor: "next-page"});
        return response(job(), init.method === "POST" ? 202 : 200);
    });
    const abort = new AbortController();
    assert.deepEqual(await api.getOptions(abort.signal), options);
    assert.equal((await api.coverage(selection, 2018, abort.signal)).missingTiles, 2);
    await api.submit(command, abort.signal);
    assert.equal((await api.list({cursor: "older page+token", limit: 20, signal: abort.signal})).nextCursor, "next-page");
    await api.get(ID, abort.signal);
    await api.cancel(ID, abort.signal);
    await api.retry(ID, "retry-countries-2018", abort.signal);
    assert.deepEqual(await api.inventory(abort.signal), []);
    assert.deepEqual(calls.map(call => call.url), [
        "/api/processing/models/habitat-condition/earth-engine-options",
        "/api/admin/habitat/cache-coverage", PREPARATIONS,
        `${PREPARATIONS}?limit=20&cursor=older+page%2Btoken`, `${PREPARATIONS}/${ID}`,
        `${PREPARATIONS}/${ID}/cancel`, `${PREPARATIONS}/${ID}/retry`, "/api/admin/habitat/cache-inventory",
    ]);
    assert.deepEqual(JSON.parse(calls[2].init.body), command);
    assert.deepEqual(JSON.parse(calls[6].init.body), {requestId: "retry-countries-2018"});
    for (const {init} of calls) {
        assert.equal(init.credentials, "same-origin"); assert.equal(init.cache, "no-store");
        assert.equal(init.signal, abort.signal);
        assert.equal(init.headers.has("Authorization"), false);
        assert.equal(init.headers.has("Cookie"), false);
        assert.equal(init.headers.has("X-EOLab-Admin"), init.method === "POST");
        if (init.method === "POST") assert.equal(init.headers.get("X-EOLab-Admin"), "1");
    }
});

test("the browser HTTP transport retains its required global receiver", async () => {
    const api = new HabitatAdminApi(async function (url) {
        assert.equal(this, globalThis, "Browser fetch must be invoked with its global receiver");
        assert.equal(url, "/api/processing/models/habitat-condition/earth-engine-options");
        return response(options);
    });
    assert.deepEqual(await api.getOptions(), options);
});

test("bulk handoff sends one keepalive command and uses the ordinary authenticated lifecycle endpoints", async () => {
    const calls = [], receipt = bulkJob();
    const api = new HabitatAdminApi(async (url, init) => {
        calls.push({url, init});
        return response(url.includes("?") ? {jobs: [receipt, job({jobId: "c".repeat(32)})], nextCursor: null} : receipt, init.method === "POST" ? 202 : 200);
    });
    const signal = new AbortController().signal;
    assert.deepEqual(await api.retryAll("retry-all-saved-inputs", signal), receipt);
    assert.deepEqual(await api.get(ID, signal), receipt);
    assert.equal((await api.list({signal})).jobs.length, 2);
    assert.deepEqual(await api.cancel(ID, signal), receipt);
    assert.deepEqual(calls.map(call => call.url), [`${PREPARATIONS}/retry-all`, `${PREPARATIONS}/${ID}`, `${PREPARATIONS}?limit=50`, `${PREPARATIONS}/${ID}/cancel`]);
    assert.deepEqual(JSON.parse(calls[0].init.body), {requestId: "retry-all-saved-inputs"});
    assert.equal(calls[0].init.keepalive, true);
    for (const {init} of calls) {
        assert.equal(init.credentials, "same-origin"); assert.equal(init.cache, "no-store"); assert.equal(init.signal, signal);
        assert.equal(init.headers.has("X-EOLab-Admin"), init.method === "POST");
        assert.equal(init.headers.has("Authorization"), false);
    }
});

test("bulk receipts validate their own inputs, report counts and protected URLs", async () => {
    const ready = bulkJob({status: "ready", result: bulkReport()});
    assert.deepEqual((await new HabitatAdminApi(async () => response(ready)).get(ID)).result, bulkReport());
    for (const changes of [{inputs: {areaCount: -1}}, {inputs: {name: "Wrong inputs", year: 2018}},
        {progress: {phase: "preparing", completed: 0, total: 4, unit: "tiles"}},
        {result: bulkReport({areaCount: 5})}, {result: bulkReport({cachedCount: -1})},
        {result: bulkReport({url: "/somewhere-else/report"})}]) {
        const api = new HabitatAdminApi(async () => response({...ready, ...changes}));
        await assert.rejects(api.get(ID), error => error instanceof HabitatAdminRequestError && error.uncertain);
    }
    const expired = bulkJob({status: "expired", inputs: null, metadataExpiresAt: "2026-11-03T08:00:00Z"});
    assert.equal((await new HabitatAdminApi(async () => response(expired)).get(ID)).inputs, null);
    await assert.rejects(new HabitatAdminApi(async () => response(job())).retryAll("wrong-bulk-operation"), error => error instanceof HabitatAdminRequestError && error.uncertain);
});

test("bulk area-check progress crosses HTTP without becoming tile-download progress", async () => {
    const progress = {phase: "checking_habitat_areas", completed: 3, total: 8, unit: "areas", details: null};
    const snapshot = bulkJob({status: "running", inputs: {areaCount: 8}, progress});
    const api = new HabitatAdminApi(async url => response(url.includes("?") ? {jobs: [snapshot], nextCursor: null} : snapshot));
    assert.deepEqual((await api.get(ID)).progress, progress);
    assert.deepEqual((await api.list()).jobs[0].progress, progress);
    for (const changes of [{unit: "tiles"}, {phase: "fetching_habitat_tiles"}, {completed: null}, {total: null},
        {completed: -1}, {completed: 9}, {total: 2.5}, {details: {cachedTiles: 3}}]) {
        const invalid = new HabitatAdminApi(async () => response({...snapshot, progress: {...progress, ...changes}}));
        await assert.rejects(invalid.get(ID), HabitatAdminRequestError);
    }
    const individual = new HabitatAdminApi(async () => response(job({progress})));
    await assert.rejects(individual.get(ID), HabitatAdminRequestError);
    const empty = new HabitatAdminApi(async () => response(bulkJob({progress: {...progress, completed: 0, total: 0}})));
    assert.equal((await empty.get(ID)).progress.total, 0);
});

test("history selections normalize object key order before area grouping", async () => {
    const reordered = {filter: {rules: [], match: "all", enabled: true}, layerName: selection.layerName,
        assetKey: selection.assetKey, itemId: selection.itemId, collectionId: selection.collectionId};
    const original = job(), renamed = job({jobId: "c".repeat(32),
        inputs: {...original.inputs, name: "Renamed countries", selection: reordered}});
    const api = new HabitatAdminApi(async () => response({jobs: [original, renamed], nextCursor: null}));
    const {jobs} = await api.list();
    assert.equal(JSON.stringify(jobs[0].inputs.selection), JSON.stringify(jobs[1].inputs.selection));
    assert.notEqual(jobs[0].inputs.name, jobs[1].inputs.name);
});

test("bulk report failures are read on demand and validated against every outcome count", async () => {
    const metadata = bulkReport(), outcomes = [
        {name: "North", year: 2018, status: "queued", jobId: "c".repeat(32), detail: null},
        {name: "South", year: 2018, status: "cached", jobId: null, detail: null},
        {name: "East", year: 2018, status: "active", jobId: null, detail: null},
        {name: "West", year: 2018, status: "failed", jobId: null, detail: "Source unavailable."},
    ];
    const document = {...metadata, version: 1, outcomes}, calls = [];
    const api = new HabitatAdminApi(async (url, init) => { calls.push({url, init}); return response(document); });
    const signal = new AbortController().signal;
    assert.deepEqual(await api.retryAllFailures(metadata, signal), [{name: "West", year: 2018, detail: "Source unavailable."}]);
    assert.equal(calls[0].url, metadata.url); assert.equal(calls[0].init.signal, signal);
    for (const changes of [{version: 2}, {failedCount: 2}, {outcomes: outcomes.slice(1)},
        {outcomes: outcomes.map((row, index) => index === 0 ? {...row, jobId: null} : row)},
        {outcomes: outcomes.map((row, index) => index === 3 ? {...row, status: "cached", detail: null} : row)},
        {outcomes: outcomes.map((row, index) => index === 3 ? {...row, detail: null} : row)}]) {
        await assert.rejects(new HabitatAdminApi(async () => response({...document, ...changes})).retryAllFailures(metadata), error => error instanceof HabitatAdminRequestError);
    }
});

test("Catalog search uses Table polygon metadata and follows provider tokens without source paths or WMS", async () => {
    const calls = [];
    const next = {rel: "next", href: "/stac/search?token=provider-page", method: "POST", body: {token: "opaque-provider-token"}};
    const first = [item("countries"), item("points", {geometry: "Point"}),
        item("lines", {geometry: "LineString"}), item("json", {format: "geojson"}), item("remote", {kind: "remote"})];
    const api = new HabitatAdminApi(async (url, init) => {
        calls.push({url, init});
        return calls.length === 1
            ? response({features: first, numberMatched: 6, links: [next]}, 200, {"X-EOLab-Number-Matched-Estimated": "false"})
            : response({features: [item("basins", {geometry: "MultiPolygon", format: "shapefile"})], numberMatched: 6, links: []});
    });
    const page = await api.searchAreas("country");
    assert.equal(calls[0].url, "/stac/search");
    assert.deepEqual(JSON.parse(calls[0].init.body).collections, ["eolab-mounted-vectors"]);
    assert.equal(page.sources.length, 1);
    assert.deepEqual(page.sources[0], {key: JSON.stringify(["eolab-mounted-vectors", "countries"]), label: "Layer countries",
        fields: [{name: "country", type: "str"}], selection: {...selection, layerName: "countries"}});
    assert.equal(JSON.stringify(page.sources).includes("/private/"), false);
    const second = await api.searchAreas("country", page.next);
    assert.equal(second.sources[0].selection.assetKey, "shp");
    assert.equal(second.next, null);
    assert.deepEqual(JSON.parse(calls[1].init.body), next.body);
    assert.equal(calls[1].url, "http://localhost/stac/search?token=provider-page");
    for (const {url, init} of calls) {
        assert.equal(url.includes("vector-rendering"), false);
        assert.equal(url.includes("vector-sampling"), false);
        assert.equal(init.credentials, "same-origin"); assert.equal(init.cache, "no-store");
        assert.equal(init.headers.get("X-EOLab-Admin"), "1");
    }
});

for (const href of ["https://other.test/stac/search", "/api/admin/habitat/input-preparations", "javascript:alert(1)",
    "http://admin:password@localhost/stac/search"]) {
    test(`Catalog refuses continuation outside its credential-free proxy: ${href}`, async () => {
        const calls = [];
        const api = new HabitatAdminApi(async (url, init) => {
            calls.push({url, init});
            return response({features: [], numberMatched: 0, links: [{rel: "next", href}]}, 200,
                {"X-EOLab-Number-Matched-Estimated": "false"});
        });
        await assert.rejects(api.searchAreas(""), error => error instanceof HabitatAdminRequestError && error.uncertain);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "/stac/search");
    });
}

for (const [status, uncertain] of [[401, false], [409, false], [422, false], [500, true], [503, true]]) {
    test(`HTTP ${status} preserves command uncertainty=${uncertain}`, async () => {
        const api = new HabitatAdminApi(async () => response({detail: "Safe server explanation"}, status));
        await assert.rejects(api.submit(command), error => {
            assert.equal(error instanceof HabitatAdminRequestError, true);
            assert.equal(error.message, "Safe server explanation");
            assert.equal(error.status, status); assert.equal(error.uncertain, uncertain); return true;
        });
    });
}

test("network failures and malformed successful admissions remain recoverable", async () => {
    for (const transport of [async () => { throw new TypeError("Lost response"); },
        async () => new Response("invalid JSON", {status: 202}),
        async () => response({jobId: ID}, 202)]) {
        const api = new HabitatAdminApi(transport);
        await assert.rejects(api.submit(command), error => error instanceof HabitatAdminRequestError && error.uncertain);
    }
});

test("report links identify only the current protected job and retain expired-input states", async () => {
    const ready = new HabitatAdminApi(async () => response(job({status: "ready", result: report()})));
    assert.deepEqual((await ready.get(ID)).result, report());
    const expired = new HabitatAdminApi(async () => response(job({status: "expired", inputs: null,
        metadataExpiresAt: "2026-11-03T08:00:00Z"})));
    assert.equal((await expired.get(ID)).inputs, null);
    for (const changes of [{url: "https://other.test/report"}, {provenanceUrl: "/api/processing/jobs/other/provenance"},
        {failedTileCount: 1}, {requiredTileCount: -1}]) {
        const api = new HabitatAdminApi(async () => response(job({status: "ready", result: report(changes)})));
        await assert.rejects(api.get(ID), error => error instanceof HabitatAdminRequestError && error.uncertain && error.status === 200);
    }
    const wrong = new HabitatAdminApi(async () => response(job({jobId: "c".repeat(32)})));
    await assert.rejects(wrong.get(ID), error => error instanceof HabitatAdminRequestError && error.uncertain);
});

test("tile failure details are fetched on demand from the protected report and checked against its metadata", async () => {
    const metadata = report({tileCount: 0, requiredTileCount: 1, failedTileCount: 1});
    const failure = {column: 7, row: -5, stage: "download", code: "earth_engine_access_denied",
        detail: "Access to a source dataset was denied.", httpStatus: 403};
    const document = {...metadata, tileFailures: [{...failure, privatePath: "/ignored"}]};
    const calls = [], signal = new AbortController().signal;
    const api = new HabitatAdminApi(async (url, init) => {
        calls.push({url, init});
        return response(url === metadata.url ? document : job({status: "ready", result: metadata}));
    });
    const snapshot = await api.get(ID);
    assert.deepEqual(calls.map(call => call.url), [`${PREPARATIONS}/${ID}`]);
    assert.deepEqual(await api.failureLog(snapshot.result, signal), [failure]);
    assert.equal(calls[1].url, metadata.url);
    assert.equal(calls[1].init.credentials, "same-origin");
    assert.equal(calls[1].init.signal, signal);
    for (const changes of [{year: 2015}, {tileFailures: []}, {tileFailures: [{...failure, httpStatus: "403"}]}]) {
        const malformed = new HabitatAdminApi(async () => response({...document, ...changes}));
        await assert.rejects(malformed.failureLog(metadata), error => error instanceof HabitatAdminRequestError);
    }
});

test("invalid coverage and history payloads are rejected at their response boundaries", async () => {
    const coverage = new HabitatAdminApi(async () => response({configurationSha256: DIGEST, year: 2018,
        requiredTiles: 6, cachedTiles: 5, missingTiles: 2}));
    await assert.rejects(coverage.coverage(selection, 2018), error => error instanceof HabitatAdminRequestError && error.uncertain);
    const history = new HabitatAdminApi(async () => response({jobs: [job({operation: "model.run.v1"})], nextCursor: null}));
    await assert.rejects(history.list(), error => error instanceof HabitatAdminRequestError && error.uncertain);
    const sources = new HabitatAdminApi(async () => response({...options,
        datasets: [{label: "Unsafe", url: "javascript:alert(1)", roles: ["predictor"]}]}));
    await assert.rejects(sources.getOptions(), error => error instanceof HabitatAdminRequestError && error.uncertain);
});

test("caller cancellation aborts Catalog HTTP work and remains an AbortError", async () => {
    let requestSignal;
    const api = new HabitatAdminApi((_url, init) => new Promise((_resolve, reject) => {
        requestSignal = init.signal;
        init.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {once: true});
    }));
    const abort = new AbortController();
    const request = api.searchAreas("countries", null, abort.signal);
    abort.abort();
    await assert.rejects(request, error => error.name === "AbortError");
    assert.equal(requestSignal.aborted, true);
});

test("an aborted response body preserves cancellation instead of becoming an HTTP rejection", async () => {
    const api = new HabitatAdminApi(async () => ({ok: true, status: 200,
        json: async () => { throw new DOMException("Cancelled body", "AbortError"); }}));
    await assert.rejects(api.get(ID), error => error.name === "AbortError");
});


test("inventory validates known and unknown configuration rows and returns only path-free fields", async () => {
    const known = {configurationSha256: "a".repeat(64), year: 2018, cachedTiles: 12, storedBytes: 12345678};
    const unknown = {configurationSha256: "b".repeat(64), year: null, cachedTiles: 1, storedBytes: 1000};
    const api = new HabitatAdminApi(async () => response({configurations: [{...known, path: "/private/cache"}, unknown]}));
    assert.deepEqual(await api.inventory(), [known, unknown]);
    for (const configurations of [null, [known, known], [{...known, cachedTiles: -1}],
        [{...known, storedBytes: Number.MAX_SAFE_INTEGER + 1}], [{...known, year: "2018"}], [{...known, configurationSha256: "../private"}]]) {
        const invalid = new HabitatAdminApi(async () => response({configurations}));
        await assert.rejects(invalid.inventory(), error => error instanceof HabitatAdminRequestError && error.status === 200);
    }
});


test("download measurements cross the HTTP boundary as one consistent snapshot", async () => {
    const details = {cachedTiles: 68, downloadedTiles: 5, failedTiles: 1, downloadedBytes: 5e6,
        elapsedSeconds: 120, observedAt: "2026-11-13T20:00:00Z", lastDownloadAt: "2026-11-13T19:59:59Z"};
    const snapshot = job({progress: {phase: "fetching_habitat_tiles", completed: 73, total: 96, unit: "tiles", details}});
    const received = await new HabitatAdminApi(async () => response(snapshot)).get(ID);
    assert.deepEqual(received.progress.details, details);
    for (const changes of [{cachedTiles: 70}, {failedTiles: 24}, {downloadedBytes: -1},
        {elapsedSeconds: -1}, {observedAt: "yesterday"}, {lastDownloadAt: null}]) {
        const malformed = {...snapshot, progress: {...snapshot.progress, details: {...details, ...changes}}};
        await assert.rejects(new HabitatAdminApi(async () => response(malformed)).get(ID), HabitatAdminRequestError);
    }
});
