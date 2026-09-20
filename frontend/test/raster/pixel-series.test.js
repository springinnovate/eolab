import test from "node:test";
import assert from "node:assert/strict";
import { RasterPixelSeriesController } from "../../src/raster/pixel-series.js";
import { sampleCatalogRasterPixel } from "../../src/raster/analysis-api.js";

/** @param {string} key Raster identity. @param {boolean} [visible=true] Default selection. @return {Object} Catalog source. */
function source(key, visible = true) {
    return { key, label: `Raster ${key}`, visible, item: { collection: "catalog", id: key, bbox: [-180, -85, -179.99, 85] } };
}
/** @return {Promise<void>} Allow all settled pixel reads to publish their snapshots. */
const settle = () => new Promise(resolve => setImmediate(resolve));
/** @return {Object} Controller with pending request handles and an observed view. */
function fixture() {
    const requests = [];
    const view = { bind(actions) { this.actions = actions; }, render(state) { this.state = state; }, downloadCsv(csv) { this.csv = csv; } };
    const controller = new RasterPixelSeriesController({
        view, onClose: () => controller.updateSamplingForPanelVisibility(false),
        samplePoint: (item, position, signal) => new Promise((resolve, reject) => requests.push({ item, position, signal, resolve, reject })),
    });
    return { controller, view, requests };
}

test("opening uses the retained click, preserves raster order and reports progressive results", async () => {
    const { controller, view, requests } = fixture();
    controller.updateAvailableRasters([source("2000"), source("2010"), source("2020")]);
    controller.updateSamplingForPanelVisibility(true);
    assert.match(view.state.message, /Click the map/);
    assert.equal(requests.length, 0);
    controller.updateSamplingForPanelVisibility(false);
    controller.setPosition({ longitude: 78, latitude: 22 });
    assert.equal(requests.length, 0);
    controller.updateSamplingForPanelVisibility(true);
    assert.equal(requests.length, 2);
    requests[1].resolve({ inBounds: true, value: 2 });
    await settle();
    assert.equal(requests.length, 3);
    assert.match(view.state.message, /1 of 3/);
    assert.deepEqual(view.state.rows.map(row => row.state), ["loading", "value", "loading"]);
    requests[0].resolve({ inBounds: true, value: 1 });
    requests[2].resolve({ inBounds: true, value: 3 });
    await settle();
    assert.deepEqual(view.state.rows.map(row => row.value), [1, 2, 3]);
    assert.equal(view.state.canDownload, true);
});

test("ordering, labels, chart style and reopening a completed plot do not reread pixels", async () => {
    const { controller, view, requests } = fixture();
    controller.updateAvailableRasters([source("10"), source("2"), source("hidden", false)]);
    controller.setPosition({ longitude: 1, latitude: 2 });
    controller.updateSamplingForPanelVisibility(true);
    requests[0].resolve({ inBounds: true, value: 10 });
    requests[1].resolve({ inBounds: true, value: 2 });
    await settle();
    view.actions.onOrder("name", "forward");
    assert.deepEqual(view.state.rows.map(row => row.value), [2, 10]);
    view.actions.onChartType("scatter");
    controller.updateAvailableRasters([source("2"), { ...source("10"), label: "Ten" }, source("hidden", false)]);
    controller.updateSamplingForPanelVisibility(false);
    controller.updateSamplingForPanelVisibility(true);
    assert.equal(requests.length, 2);
    assert.equal(view.state.chartType, "scatter");
    assert.equal(view.state.sources.find(row => row.key === "hidden").selected, false);
});

test("new clicks cancel queued work, retain a visibly separate old plot, and reject old replies", async () => {
    const { controller, view, requests } = fixture();
    controller.updateAvailableRasters([source("a"), source("b"), source("c")]);
    controller.setPosition({ longitude: 1, latitude: 2 });
    controller.updateSamplingForPanelVisibility(true);
    requests[0].resolve({ inBounds: true, value: 1 });
    requests[1].resolve({ inBounds: true, value: 2 });
    await settle();
    requests[2].resolve({ inBounds: true, value: 3 });
    await settle();
    controller.setPosition({ longitude: 3, latitude: 4 });
    assert.deepEqual(view.state.previousRows.map(row => row.value), [1, 2, 3]);
    assert.equal(view.state.canDownload, false);
    controller.setPosition({ longitude: 5, latitude: 6 });
    assert.equal(requests[3].signal.aborted, true);
    requests[3].resolve({ inBounds: true, value: 999 });
    requests[4].resolve({ inBounds: true, value: 999 });
    await settle();
    assert.equal(requests.length, 7, "cancelled queue must not start its third raster");
    assert.ok(view.state.rows.every(row => row.value === null));
    requests[5].resolve({ inBounds: true, value: 5 });
    await settle();
    assert.equal(view.state.previousRows, null);
    assert.equal(view.state.rows[0].value, 5);
    assert.equal(requests[7].position.longitude, 5);
    controller.updateSamplingForPanelVisibility(false);
    assert.equal(requests[7].signal.aborted, true);
    requests[6].resolve({ inBounds: true, value: 999 });
    requests[7].resolve({ inBounds: true, value: 999 });
    await settle();
    assert.equal(view.state.canDownload, false);
});

test("source removal cancels older work and hidden rasters may be explicitly selected", async () => {
    const { controller, view, requests } = fixture();
    controller.updateAvailableRasters([source("a"), source("b", false)]);
    controller.setPosition({ longitude: 1, latitude: 2 });
    controller.updateSamplingForPanelVisibility(true);
    controller.updateAvailableRasters([source("b", false)]);
    assert.equal(requests[0].signal.aborted, true);
    assert.match(view.state.message, /Select rasters/);
    view.actions.onSelect("b", true);
    assert.equal(requests[1].item.id, "b");
    requests[0].resolve({ inBounds: true, value: 99 });
    requests[1].resolve({ inBounds: true, value: 7 });
    await settle();
    assert.deepEqual(view.state.rows.map(row => row.value), [7]);
});

test("oversized stacks are explained and never silently truncated or submitted", () => {
    const { controller, view, requests } = fixture();
    controller.updateAvailableRasters(Array.from({ length: 51 }, (_, i) => source(String(i))));
    controller.setPosition({ longitude: 1, latitude: 2 });
    controller.updateSamplingForPanelVisibility(true);
    assert.match(view.state.message, /up to 50.*51 are selected/);
    assert.equal(requests.length, 0);
    view.actions.onSelect("50", false);
    assert.equal(requests.length, 2);
    controller.updateSamplingForPanelVisibility(false);
});

test("the pixel API decides coverage; nodata, failures and outside keep distinct positions", async () => {
    const view = { bind() {}, render(state) { this.state = state; } };
    const bodies = [];
    const controller = new RasterPixelSeriesController({
        view, onClose() {},
        samplePoint: (item, position, signal) => sampleCatalogRasterPixel(item, position, signal, async (_url, request) => {
            const body = JSON.parse(request.body); bodies.push(body);
            if (body.itemId === "error") return new Response("unavailable", { status: 503 });
            return Response.json({ inBounds: body.itemId !== "outside", value: body.itemId === "value" ? 0 : null });
        }),
    });
    controller.updateAvailableRasters(["value", "nodata", "outside", "error"].map(key => source(key)));
    controller.setPosition({ longitude: 78, latitude: 22 });
    controller.updateSamplingForPanelVisibility(true);
    await settle();
    assert.equal(bodies.length, 4, "incorrect catalog bbox must not block backend requests");
    assert.ok(bodies.every(body => body.longitude === 78 && body.collectionId === "catalog"));
    assert.deepEqual(view.state.rows.map(row => row.state), ["value", "nodata", "outside", "error"]);
    assert.deepEqual(view.state.rows.map(row => row.value), [0, null, null, null]);
    const csv = controller.exportCsv();
    assert.match(csv, /"Raster value","catalog","value","78","22","0","value"/);
    assert.match(csv, /"outside","78","22","","outside"/);
});

test("CSV preserves labels, source identity and full precision while escaping spreadsheet text", async () => {
    const { controller, requests } = fixture();
    controller.updateAvailableRasters([{ ...source("a"), label: '=SUM(1,2) "test"' }]);
    controller.setPosition({ longitude: -122.25, latitude: 37.75 });
    controller.updateSamplingForPanelVisibility(true);
    requests[0].resolve({ inBounds: true, value: -1.234567890123 });
    await settle();
    const csv = controller.exportCsv();
    assert.ok(csv.includes('"\'=SUM(1,2) ""test"""'));
    assert.ok(csv.includes('"-122.25","37.75","-1.234567890123"'));
});


test("clicks outside the canonical world clear pending pixels without throwing through map inspection", async () => {
    const { controller, view, requests } = fixture();
    controller.updateAvailableRasters([source("a")]);
    controller.setPosition({ longitude: 1, latitude: 2 });
    controller.updateSamplingForPanelVisibility(true);
    controller.setPosition({ longitude: 200, latitude: 2 });
    assert.equal(requests[0].signal.aborted, true);
    requests[0].resolve({ inBounds: true, value: 99 });
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(view.state.position, null);
    assert.equal(view.state.canDownload, false);
    assert.match(view.state.message, /Click the map/);
    controller.setPosition({ longitude: 3, latitude: 2 });
    assert.equal(requests.length, 2);
});

test("Retry replaces a completed plot with a muted previous plot", async () => {
    const { controller, view, requests } = fixture();
    controller.updateAvailableRasters([source("a")]);
    controller.setPosition({ longitude: 1, latitude: 2 });
    controller.updateSamplingForPanelVisibility(true);
    requests[0].resolve({ inBounds: true, value: 42 });
    await settle();
    view.actions.onRetry();
    assert.equal(view.state.busy, true);
    assert.equal(view.state.canDownload, false);
    assert.equal(view.state.previousRows[0].value, 42);
    requests[1].resolve({ inBounds: true, value: 42 });
    await settle();
    assert.equal(view.state.previousRows, null);
    assert.equal(view.state.canDownload, true);
});
