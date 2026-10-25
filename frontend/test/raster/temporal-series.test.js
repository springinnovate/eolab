import test from "node:test";
import assert from "node:assert/strict";
import { csvFormat, csvParse } from "d3";
import { RasterSeriesController } from "../../src/raster/series.js";
import { RasterSeriesCalculations } from "../../src/processing/raster-series-calculations.js";
import { CalculationRequests } from "../../src/processing/calculation-requests.js";
import { CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";

const DATASET = {key: "weather", collectionId: "eolab-temporal-datasets", itemId: "weather", label: "Weather"};
const AREA = {kind: "selectedArea", selectedBounds: {west: -64, south: -5, east: -62, north: -3}};
const ORDINARY = {key: "raster", label: "Raster", item: {collection: "catalog", id: "raster"}, visible: true};

/** Drain asynchronous request and observer callbacks without advancing browser timers.
 * @return {Promise<void>} Queued lifecycle callbacks have settled.
 */
const flush = async () => { for (let index = 0; index < 120; index++) await Promise.resolve(); };

/** Connect the real stack controller and execution lifecycle to a controlled server.
 * @return {Object} User actions, captured API requests and explicit server completion.
 */
function fixture() {
    const submitted = [], cancelled = [], downloads = [], discovery = [], server = new Map(), saved = new Map(), timers = new Map();
    let serial = 0;
    const clock = {setTimeout(callback, delay) { const id = ++serial; timers.set(id, {callback, delay}); return id; },
        clearTimeout(id) { timers.delete(id); }};
    const api = {
        async discoverModels() { discovery.push("models"); return [{id: "temporal-raster-stack", version: "1.0.0", definitionSha256: "a".repeat(64)}]; },
        async submitCalculation(submission) {
            submitted.push(submission);
            const job = {jobId: String(++serial).padStart(32, "0"), requestId: submission.requestId,
                operation: submission.kind === "temporal" ? "model.run.v1" : "raster.aggregate.v1", status: "running",
                progress: submission.kind === "temporal"
                    ? {phase: "summarizing", description: "Calculating each observation", completed: 0, total: 3, unit: "blocks"}
                    : {phase: "calculating", completedBlocks: 0, totalBlocks: 3}, result: null};
            server.set(job.jobId, job); return job;
        },
        async listJobs() { return [...server.values()]; },
        async getJob(id) { return server.get(id); },
        async readJobStatuses(ids) { return {jobs: ids.map(id => server.get(id)), unavailableJobIds: []}; },
        async cancelJob(id) { cancelled.push(id); const job = {...server.get(id), status: "cancelling"}; server.set(id, job); return job; },
        async readTemporalStackRows(job) { downloads.push(job.jobId); return job.csvResult; },
    };
    const storage = new CalculationSessionStorage({get length() { return saved.size; }, key: index => [...saved.keys()][index] ?? null,
        getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key)});
    const jobs = new ProcessingJobs(api, clock);
    const requests = new CalculationRequests({api, jobs, storage, requestId: () => "request-" + String(++serial).padStart(16, "0")});
    const calculations = new RasterSeriesCalculations({requests, api, clock});
    const view = {bind(actions) { this.actions = actions; }, render(state) { this.state = state; }, downloadCsv(csv) { this.csv = csv; }};
    const controller = new RasterSeriesController({view, areaStatistics: calculations, onClose() {}, onEditArea() {},
        async getTemporalItem(source) {
            discovery.push(source.itemId);
            return {collection: source.collectionId, id: source.itemId, properties: {title: "Weather", "cube:variables": {
                temperature: {description: "Temperature", unit: "K", "eolab:time_support": "instantaneous"},
            }}};
        },
        async loadTemporalTimes(item, variable, month = "2000-01") {
            discovery.push([item.id, variable, month]);
            return {months: ["2000-01"], month, times: ["2000-01-01T00:00:00Z", "2000-01-01T01:00:00Z", "2000-01-01T06:00:00Z"]};
        }});
    controller.updateAvailableRasters([ORDINARY], [DATASET]); controller.setArea(AREA, "Selected box");
    const tick = async () => { for (const [id, timer] of [...timers]) if (timer.delay === 0) { timers.delete(id); timer.callback(); } await flush(); };
    const finish = async (id, status, csvResult = null) => {
        server.set(id, {...server.get(id), status, csvResult, result: status === "ready" ? {kind: "timeSeries"} : null});
        await jobs.refresh(); await flush();
    };
    const close = () => { calculations.destroy(); requests.destroy(); jobs.destroy(); };
    return {controller, view, calculations, api, submitted, cancelled, downloads, discovery, server, tick, finish, close};
}

test("temporal stack explicitly samples one independent period and reuses completed values for presentation", async () => {
    const h = fixture();
    try {
        h.view.actions.onSourceMode("temporal");
        await h.controller.chooseTemporalDataset(DATASET.key);
        assert.equal(h.view.state.temporal.startTime, "", "availability does not select a period");
        h.view.actions.onUseTemporalMonth();
        h.controller.setPosition({longitude: -63, latitude: -4});
        h.view.actions.onAddFormula("pixel"); h.view.actions.onAddFormula("custom");
        h.view.actions.onEditFormula(3, {expression: "pixelValue(a) - mean(a)"});
        h.controller.updateSamplingForPanelVisibility(true); await h.tick();
        assert.equal(h.submitted.length, 0, "opening and editing do not run a temporal slice");
        h.view.actions.onCalculate(); await flush();
        assert.equal(h.submitted.length, 1);
        const request = h.submitted[0], job = [...h.server.values()][0];
        assert.equal(h.view.state.message, "Calculating each observation · 0 of 3 blocks");
        h.server.set(job.jobId, {...job, progress: {...job.progress, completed: 2}});
        await h.finish(job.jobId, "running");
        assert.equal(h.view.state.message, "Calculating each observation · 2 of 3 blocks");
        assert.deepEqual(request.source, {collectionId: DATASET.collectionId, itemId: DATASET.itemId, variable: "temperature",
            startTime: "2000-01-01T00:00:00.000Z", endTime: "2000-02-01T00:00:00.000Z"});
        assert.deepEqual(request.area, AREA);
        assert.deepEqual(request.pixelPoint, {longitude: -63, latitude: -4});
        assert.deepEqual(request.calculations.map(({expression}) => expression), ["mean(a)", "pixelValue(a)", "pixelValue(a) - mean(a)"]);
        const observations = [0, 1, 6].map(hour => ({time: `2000-01-01T${String(hour).padStart(2, "0")}:00:00+00:00`,
            rows: request.calculations.map((formula, index) => ({...formula, value: hour === 1 && index === 0 ? null : "298.1234567890123456",
                valueType: "float", unit: "", state: hour === 1 && index === 0 ? "no_valid_data" : "ok", aggregates: []}))}));
        const csv = csvFormat(observations.flatMap(observation => observation.rows.map(row => ({time_utc: observation.time,
            interval_start_utc: "", interval_end_utc: "", variable: request.source.variable, calculation: row.label,
            expression: row.expression, value: row.value, value_type: row.valueType, unit: row.unit, state: row.state,
            aggregates: JSON.stringify(row.aggregates)}))));
        await h.finish(job.jobId, "ready", {observations, csv});
        assert.deepEqual(h.view.state.statistics[0].rows.map(row => row.xValue), observations.map(row => Date.parse(row.time)));
        assert.equal(h.view.state.rows.length, 9);
        assert.equal(h.view.state.statistics[0].rows[1].state, "no_valid_data");
        assert.equal(h.view.state.statistics[0].rows[1].value, null);
        assert.equal(h.view.state.statistics[0].rows[0].rawValue, "298.1234567890123456");
        assert.match(h.view.state.statistics[0].rows[0].label, /UTC$/);
        assert.equal(csvParse(h.controller.exportCsv())[0].calculation, "Mean");
        const reads = h.discovery.length;
        h.view.actions.onChartType("scatter"); h.view.actions.onAddPlot();
        h.view.actions.onStatisticDisplay(1, {plotId: 2, visible: false});
        h.view.actions.onPlotScale(2, "log"); h.view.actions.onEditFormula(1, {label: "Average"});
        h.controller.updateAvailableRasters([{...ORDINARY, visible: false}], [{...DATASET, time: "2001-06-01T00:00:00Z"}]);
        h.view.actions.onDownload(); await h.tick();
        const exported = csvParse(h.view.csv), original = csvParse(csv);
        const names = {"stat-1": "Average", "stat-2": "Pixel value", "stat-3": "Custom"};
        assert.deepEqual(exported.columns, original.columns);
        assert.deepEqual([...exported], original.map(row => ({...row, calculation: names[row.calculation]})),
            "download uses the edited statistic names while preserving every other field, including exact decimal text");
        assert.equal(h.view.state.temporal.startTime, "2000-01-01T00:00");
        assert.equal(h.submitted.length, 1);
        assert.deepEqual(h.downloads, [job.jobId]);
        assert.equal(h.discovery.length, reads);
        await h.controller.loadTemporalDates(undefined, true);
        assert.deepEqual(h.view.state.rows, [], "explicit refresh releases the completed plot for a new calculation");
        await h.tick();
        assert.equal(h.submitted.length, 1, "refresh does not run calculations automatically");
        h.view.actions.onCalculate(); await flush();
        assert.equal(h.submitted.length, 2);
        assert.deepEqual(h.submitted[1].source, request.source, "the same logical interval can be recalculated after refresh");
        await h.finish([...h.server.values()][1].jobId, "ready", {observations, csv});
        h.view.actions.onAddFormula("sum");
        assert.deepEqual(h.view.state.rows, [], "new formulas cannot be joined to the old result rows");
        assert.equal(h.view.state.canDownload, false);
        h.view.actions.onEditFormula(1, {expression: "max(a)"});
        await h.tick();
        assert.equal(h.submitted.length, 2, "formula replacement waits for Calculate");
    } finally { h.close(); }
});

test("failed temporal downloads retry the completed job and discard a cancelled late CSV", async () => {
    const h = fixture();
    try {
        h.view.actions.onSourceMode("temporal"); await h.controller.chooseTemporalDataset(DATASET.key);
        h.view.actions.onUseTemporalMonth(); h.controller.updateSamplingForPanelVisibility(true);
        h.view.actions.onCalculate(); await flush();
        const job = [...h.server.values()][0];
        const result = {csv: "time_utc,calculation,value\n2000-01-01T00:00:00Z,stat-1,12\n",
            observations: [{time: "2000-01-01T00:00:00Z", rows: [{label: "stat-1", expression: "mean(a)",
                value: "12", valueType: "float", unit: "", state: "ok", aggregates: []}]}]};
        let attempts = 0, release, downloadSignal;
        const lateResponse = new Promise(resolve => { release = resolve; });
        h.api.readTemporalStackRows = async (_, signal) => {
            attempts++;
            if (attempts === 1) throw new Error("Download interrupted");
            if (attempts === 2) { downloadSignal = signal; return lateResponse; }
            return result;
        };
        await h.finish(job.jobId, "ready", result);
        assert.match(h.view.state.message, /Download interrupted/);
        h.view.actions.onCalculate(); await flush();
        assert.equal(attempts, 2);
        assert.equal(h.submitted.length, 1);
        h.view.actions.onCancel();
        assert.equal(downloadSignal.aborted, true);
        release(result); await flush();
        assert.deepEqual(h.view.state.rows, []);
        assert.equal(h.view.state.canDownload, false);
        h.view.actions.onCalculate(); await flush();
        assert.equal(attempts, 3);
        assert.equal(h.submitted.length, 1, "retrying a CSV never resubmits its calculation");
        assert.equal(h.view.state.rows[0].rawValue, "12");
        assert.deepEqual([...csvParse(h.controller.exportCsv())], [{time_utc: "2000-01-01T00:00:00Z", calculation: "Mean", value: "12"}]);
    } finally { h.close(); }
});

test("replacing or closing a temporal slice cancels work and waits for another explicit Calculate", async () => {
    const h = fixture();
    try {
        h.view.actions.onSourceMode("temporal"); await h.controller.chooseTemporalDataset(DATASET.key);
        h.view.actions.onUseTemporalMonth(); h.controller.updateSamplingForPanelVisibility(true);
        h.view.actions.onCalculate(); await flush();
        const first = [...h.server.values()][0];
        h.view.actions.onTemporalEdit({periodMode: "times", startTime: "2000-01-01T01:00", endTime: "2000-01-01T07:00"});
        await h.tick();
        assert.deepEqual(h.cancelled, [first.jobId]);
        assert.equal(h.submitted.length, 1);
        await h.finish(first.jobId, "cancelled");
        h.view.actions.onCalculate(); await flush();
        assert.equal(h.submitted.length, 2);
        assert.equal(h.submitted[1].source.startTime, "2000-01-01T01:00:00.000Z");
        const second = [...h.server.values()][1];
        h.controller.updateSamplingForPanelVisibility(false); await flush();
        assert.deepEqual(h.cancelled, [first.jobId, second.jobId]);
        await h.finish(second.jobId, "cancelled");
        h.controller.updateSamplingForPanelVisibility(true); await h.tick();
        assert.equal(h.submitted.length, 2);
        h.view.actions.onSourceMode("layers"); await h.tick();
        assert.equal(h.submitted.length, 3, "ordinary raster selection retains automatic calculation");
        assert.equal(h.submitted[2].source.itemId, "raster");
        assert.equal(h.submitted[2].kind, undefined);
    } finally { h.close(); }
});
