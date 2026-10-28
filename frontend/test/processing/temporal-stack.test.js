import test from "node:test";
import assert from "node:assert/strict";
import { csvFormatRows } from "d3";
import { ProcessingApiClient } from "../../src/processing/api.js";
import { CalculationRequests } from "../../src/processing/calculation-requests.js";
import { CalculationSessionStorage, calculationIntent } from "../../src/processing/calculation-session.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { RasterSeriesCalculations } from "../../src/processing/raster-series-calculations.js";
import { model, job, area, selection, timeSeriesResult } from "../../test-support/models/fixtures.js";

const stackModel = {...model, id: "temporal-raster-stack"};
const source = {collectionId: "weather", itemId: "observations", variable: "temperature",
    startTime: "2000-01-01T00:00:00Z", endTime: "2000-02-01T00:00:00Z"};

/** Capture a point-and-area temporal request through the production input boundary.
 * @param {Object} [selectedArea=area] Calculation area.
 * @return {Readonly<Object>} Recoverable temporal intent.
 */
function intent(selectedArea = area) {
    return calculationIntent({kind: "temporal", model: stackModel, source, area: selectedArea,
        calculations: [{label: "stat-1", expression: "pixelValue(a) - mean(a)"}],
        pixelPoint: {longitude: 0.5, latitude: 0.5}, utcOffsetMinutes: -420});
}

test("temporal calculations submit one model request with ordinary area identities and the original retry key", async () => {
    for (const selectedArea of [area, {kind: "catalogSelection", catalogSelection: selection},
        {kind: "polygonArea", polygonArea: {id: "b".repeat(32), sha256: "c".repeat(64)}}]) {
        const calls = [];
        const api = new ProcessingApiClient(async (url, options) => {
            calls.push({url, options});
            return new Response(JSON.stringify(url.endsWith("/jobs") ? {jobs: []} : job({model: stackModel})),
                {headers: {"Content-Type": "application/json"}});
        }, null);
        const captured = intent(selectedArea);
        await api.submitCalculation({...captured, requestId: "request-" + "1".repeat(24)});
        const submitted = calls.filter(({options}) => options.method === "POST");
        assert.equal(submitted.length, 1);
        assert.equal(submitted[0].url, "/api/processing/model-runs");
        const request = JSON.parse(submitted[0].options.body);
        assert.deepEqual(request, {requestId: "request-" + "1".repeat(24), model: captured.model,
            label: "Temporal raster stack", utcOffsetMinutes: -420, parameters: {}, inputs: {
                source, area: selectedArea.kind === "catalogSelection" ? {kind: "catalogSelection", selection}
                    : selectedArea.kind === "polygonArea" ? {kind: "polygonArea", reference: selectedArea.polygonArea} : area,
                metrics: {calculations: captured.calculations, pixelPoint: captured.pixelPoint},
            }});
        assert.equal(submitted[0].options.credentials, "same-origin");
        assert.equal(submitted[0].options.headers["X-EOLab-Processing"], "1");
    }
});

test("owned temporal CSV keeps exact values, UTC gaps, formula text and error states", async () => {
    const formulas = [{label: "stat-1", expression: "-mean(a)"}, {label: "stat-2", expression: "sum(a) / count(a)"}];
    const csv = csvFormatRows([
        ["time_utc", "interval_start_utc", "interval_end_utc", "variable", "calculation", "expression", "value", "value_type", "unit", "state", "aggregates"],
        ["2000-01-01T00:00:00+00:00", "", "", "temperature", "stat-1", "'-mean(a)", "-123.4567890123456789", "float", "", "ok", "[]"],
        ["2000-01-01T00:00:00+00:00", "", "", "temperature", "stat-2", formulas[1].expression, "", "float", "", "invalid_arithmetic", "[]"],
        ["2000-01-03T00:00:00+00:00", "", "", "temperature", "stat-1", "'-mean(a)", "", "float", "", "no_valid_data", "[]"],
        ["2000-01-03T00:00:00+00:00", "", "", "temperature", "stat-2", formulas[1].expression, "", "float", "", "no_valid_data", "[]"],
    ]) + "\r\n";
    const calls = [];
    const api = new ProcessingApiClient(async (url, options) => {
        calls.push({url, options}); return new Response(csv, {headers: {"Content-Type": "text/csv"}});
    }, null);
    const completed = job({model: stackModel, status: "ready", result: {...timeSeriesResult, calculations: formulas}});
    const abort = new AbortController();
    const result = await api.readTemporalStackRows(completed, abort.signal);
    assert.equal(result.csv, csv);
    assert.deepEqual(result.observations.map(value => value.time), ["2000-01-01T00:00:00+00:00", "2000-01-03T00:00:00+00:00"]);
    assert.equal(result.observations[0].rows[0].value, "-123.4567890123456789");
    assert.equal(result.observations[0].rows[0].expression, "-mean(a)");
    assert.equal(result.observations[0].rows[1].state, "invalid_arithmetic");
    assert.equal(result.observations[1].rows[0].value, null);
    assert.equal(result.observations[1].rows[0].state, "no_valid_data");
    assert.equal(calls[0].url, completed.result.url);
    assert.equal(calls[0].options.credentials, "same-origin");
    assert.equal(calls[0].options.signal, abort.signal);
    const expired = new ProcessingApiClient(async () => new Response("", {status: 404}), null);
    await assert.rejects(expired.readTemporalStackRows(completed), /unavailable or has expired/);
});

test("reload recovers a lost temporal model response with the same request and continues that job", async () => {
    const saved = new Map(), submissions = [], cancelled = [];
    const storage = {get length() {return saved.size;}, key: index => [...saved.keys()][index],
        getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)};
    let accepted = null, loseResponse = true;
    const api = new ProcessingApiClient(async (url, options) => {
        let response;
        if (url.endsWith("/model-runs")) {
            submissions.push(JSON.parse(options.body));
            accepted ??= job({model: stackModel, status: "running"});
            if (loseResponse) {loseResponse = false; throw new TypeError("Response lost after admission");}
            response = accepted;
        } else if (url.endsWith("/cancel")) {
            cancelled.push(url); accepted = job({model: stackModel, status: "cancelled"}); response = accepted;
        } else if (url.endsWith("/status")) response = {jobs: accepted ? [accepted] : [], unavailableJobIds: []};
        else response = {jobs: accepted ? [accepted] : []};
        return new Response(JSON.stringify(response), {headers: {"Content-Type": "application/json"}});
    }, null);
    const clock = {setTimeout: () => 1, clearTimeout: () => {}};
    const jobs = new ProcessingJobs(api, clock);
    const requests = new CalculationRequests({api, jobs, storage: new CalculationSessionStorage(storage),
        requestId: () => "request-" + "2".repeat(24)});
    const client = requests.createClient("raster-series:0", () => {});
    client.submit({...intent(), calculations: [{label: "stat-1", expression: "mean(a)"}]},
        {automatic: false, presentation: {key: "temporal", names: ["Mean"]}});
    for (let tick = 0; tick < 80; tick++) await Promise.resolve();
    assert.equal(client.snapshot.recoverable, true);
    requests.destroy(); jobs.destroy();
    const reloadedJobs = new ProcessingJobs(api, clock);
    const reloadedRequests = new CalculationRequests({api, jobs: reloadedJobs, storage: new CalculationSessionStorage(storage)});
    const reloaded = new RasterSeriesCalculations({requests: reloadedRequests, api, clock});
    await reloaded.start();
    for (let tick = 0; tick < 80; tick++) await Promise.resolve();
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions[1], submissions[0]);
    assert.equal(cancelled.length, 0);
    assert.equal(accepted.status, "running");
    assert.equal(saved.size, 1);
    reloaded.destroy(); reloadedRequests.destroy(); reloadedJobs.destroy();
});
