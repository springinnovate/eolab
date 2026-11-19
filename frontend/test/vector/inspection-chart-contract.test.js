import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { vectorInspectionObservation } from "../../src/vector/feature-inspector.js";
import { VectorFeatureProfileController } from "../../src/vector/feature-profile.js";
import { VectorTimeSeriesController } from "../../src/vector/time-series.js";

/**
 * Execute the production vector composition with real chart consumers.
 * The inspector boundary exposes its callbacks so tests can deliver its immutable
 * results without starting map/network work. Like browser-startup.test.js, this
 * evaluates existing initialization code rather than copying the callbacks.
 * @return {{inspector:Object,profile:VectorFeatureProfileController,
 * series:VectorTimeSeriesController,documentContext:FakeRasterControlDocument,
 * status:Object,zooms:Object[],selectionDirections:string[]}} Composed consumers and their presentation outputs.
 */
function composition() {
  const source = readFileSync(new URL("../../src/main.js", import.meta.url), "utf8");
  const start = source.search(/const\s+vectorTimeSeries\s*=\s*new\s+VectorTimeSeriesController\s*\(/);
  const end = source.indexOf("function exploreMap(", start);
  const documentContext = new FakeRasterControlDocument();
  const events = new EventTarget();
  documentContext.addEventListener = events.addEventListener.bind(events);
  documentContext.removeEventListener = events.removeEventListener.bind(events);
  const status = {};
  const zooms = [];
  const selectionDirections = [];
  const vectorMapLayerAdapter = {
    describeSource: record => ({
      selection: {
        collectionId: "eolab-mounted-vectors", itemId: record.itemId, assetKey: "data", layerName: record.itemId,
      },
      numericFields: [{ name: "R1999" }, { name: "R2000" }],
    }),
  };
  const records = ["habitat", "watersheds"].map(itemId => ({
    itemId, entry: { key: "catalog|" + itemId }, adapter: vectorMapLayerAdapter,
  }));
  const dependencies = {
    vectorMapLayerAdapter,
    mapLayerController: { getRecord: key => records.find(record => record.entry.key === key) },
    VectorTimeSeriesController: function (options) {
      return new VectorTimeSeriesController({...options, documentContext});
    },
    VectorFeatureProfileController: function (options) {
      return new VectorFeatureProfileController({...options, documentContext});
    },
    VectorFeatureInspectorController: function (options) {
      return {...options, navigateSelection: direction => selectionDirections.push(direction)};
    },
    mapInspection: {
      setVectorTimeSeriesIdentity() {},
      setVectorFeatureProfileIdentity() {},
      showVectorFeatureProfile() {},
      showVectorTimeSeries() {},
      hideVectorFeatureProfile() {},
      hideVectorTimeSeries() {},
      setClickResult(kind, result) { status[kind] = result; },
      setFeatureResultCount(count, options) { status.count = {count, ...options}; },
    },
    zoomInspectedVectorFeature: focus => { zooms.push(focus); return true; },
    L: {},
    leafletMap: {},
    appGlobalConfiguration: {wmsUrl: "/wms"},
  };
  const controllers = new Function(...Object.keys(dependencies),
    `let vectorFeatureInspector;\n${source.slice(start, end)}\n` +
    "return {inspector: vectorFeatureInspector, profile: vectorFeatureProfile, series: vectorTimeSeries};"
  )(...Object.values(dependencies));
  return {...controllers, documentContext, status, zooms, selectionDirections};
}

/**
 * Construct an observation through the inspector's actual source-data boundary.
 * @param {number} id Source feature identity and contrasting numeric value.
 * @param {string} [layer="habitat"] Original layer identity.
 * @return {import("../../src/vector/inspection-observation.js").VectorInspectionObservation}
 * Immutable observation suitable for both chart consumers.
 */
function observation(id, layer = "habitat") {
  return vectorInspectionObservation({
    feature: {
      id: `habitat.${id}`,
      geometry: null,
      bbox: [20, 10, 20, 10],
      properties: { R1999: id, R2000: id + 1, nested: { ignored: true } },
    },
    target: { sourceId: "catalog|" + layer, label: layer[0].toUpperCase() + layer.slice(1) },
    inspectionPosition: { lng: 21, lat: 11 },
  });
}

test("inspection composition delivers distinct observations to both chart consumers", t => {
  const {inspector, profile, series, documentContext, status, zooms} = composition();
  t.after(() => { profile.destroy(); series.destroy(); });
  const observations = Object.freeze([observation(1), observation(9)]);
  inspector.onSampleChange(Object.freeze({
    state: "ready", message: "Ready", observations,
  }));
  inspector.onCurrentObservationChange(observations[1], {
    position: 2, total: 2, canPrevious: true, canNext: false,
  });

  assert.equal(profile.currentObservation, observations[1]);
  assert.equal(documentContext.querySelector("#vector-feature-profile-position").textContent, "2 of 2 features");
  assert.equal(documentContext.querySelector("#previous-vector-feature-profile").disabled, false);
  assert.equal(documentContext.querySelector("#next-vector-feature-profile").disabled, true);
  assert.equal(series.observations[0], observations[0]);
  assert.equal(series.observations[1], observations[1]);
  assert.deepEqual(documentContext.querySelector("#vector-feature-profile-table-body")
    .children.map(row => [row.children[0].children[0].textContent, ...row.children.slice(1).map(cell => cell.textContent)]),
    [["R1999", "1999", "9"], ["R2000", "2000", "10"]]);
  assert.deepEqual(documentContext.querySelector("#vector-time-series-table-body")
    .children.map(row => [row.children[0].textContent, row.children[0].children[0].textContent, row.children[1].children[0].textContent]),
    [["Habitat", "Habitat · habitat.1", "1"], ["Habitat", "Habitat · habitat.9", "9"]]);
  assert.deepEqual(status.feature, {state: "ready", message: "2 features returned across 1 layer · Ready"});
  assert.deepEqual(status.count, {count: 2, loading: false});
  documentContext.querySelector("#zoom-vector-feature-profile-feature").dispatchEvent(new Event("click"));
  assert.deepEqual(zooms, [{ center: [20, 10], bounds: [20, 10, 20, 10] }]);
  assert.deepEqual(observations[1].properties, { R1999: 9, R2000: 10 });
  assert.equal(Object.isFrozen(observations[1].properties), true);
});

test("a new inspection replaces the prior chart and communicates partial results", t => {
  const {inspector, profile, series, documentContext, status} = composition();
  t.after(() => { profile.destroy(); series.destroy(); });
  inspector.onSampleChange({state: "ready", message: "Ready", observations: [observation(1)]});
  inspector.onSampleChange({state: "loading", message: "Reading features", observations: []});
  assert.equal(documentContext.querySelector("#vector-time-series-table-body").children.length, 0);
  assert.equal(documentContext.querySelector("#vector-time-series-status").textContent, "Reading features");
  assert.deepEqual(status.count, {count: 0, loading: true});
  assert.equal(status.feature.state, "loading");

  inspector.onSampleChange({state: "ready", message: "Partial results", observations: [observation(9)], failedLayers: 1});
  assert.deepEqual(documentContext.querySelector("#vector-time-series-table-body")
    .children.map(row => [row.children[0].children[0].textContent, row.children[1].children[0].textContent]), [["Habitat · habitat.9", "9"]]);
  assert.deepEqual(status.feature, {state: "error", message: "1 feature returned across 1 layer · 1 layer unavailable"});
  assert.deepEqual(status.count, {count: 1, loading: false});

  inspector.onSampleChange({state: "invalidated", message: "Source removed", observations: []});
  assert.equal(series.observations.length, 0);
  assert.equal(documentContext.querySelector("#vector-time-series-table-body").children.length, 0);
  assert.deepEqual(status.feature, {state: "invalidated", message: "Source removed"});
});

test("comparison history controls request the adjacent selection through composition", t => {
  const {inspector, profile, series, documentContext, status, selectionDirections} = composition();
  t.after(() => { profile.destroy(); series.destroy(); });
  const previous = documentContext.querySelector("#vector-time-series-previous-selection");
  const next = documentContext.querySelector("#vector-time-series-next-selection");
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, true);

  inspector.onSampleChange({state: "empty", message: "No features", observations: []});
  inspector.onSelectionNavigationChange({canPrevious: true, canNext: false});
  previous.dispatchEvent(new Event("click"));
  assert.deepEqual(selectionDirections, ["previous"]);

  const position = {lng: 21, lat: 11};
  inspector.onSampleChange({state: "ready", message: "Ready", observations: [observation(1), observation(9)], position});
  inspector.onSelectionNavigationChange({canPrevious: false, canNext: true});
  assert.deepEqual(status.feature.position, position);
  assert.deepEqual(documentContext.querySelector("#vector-time-series-table-body")
    .children.map(row => row.children[1].children[0].textContent), ["1", "9"]);
  next.dispatchEvent(new Event("click"));
  assert.deepEqual(selectionDirections, ["previous", "next"]);
});

test("feature plot benchmarks follow the original layer and ignore obsolete results", async t => {
  const {inspector, profile, series, documentContext} = composition();
  t.after(() => { profile.destroy(); series.destroy(); });
  const requests = [];
  t.mock.method(globalThis, "fetch", (url, options) => new Promise(resolve => {
    requests.push({url, ...JSON.parse(options.body), signal: options.signal, resolve});
  }));
  const control = suffix => documentContext.querySelector("#vector-feature-profile-" + suffix);
  inspector.onCurrentObservationChange(observation(1));
  inspector.onFeatureProfileRequested();
  assert.equal(requests.length, 0);
  assert.equal(control("statistics").hidden, true);

  control("statistics-button").dispatchEvent(new Event("click"));
  control("statistics-mean").checked = true;
  control("statistics-mean").dispatchEvent(new Event("change"));
  assert.equal(control("statistics-status").textContent, "Reading whole-layer statistics…");
  assert.deepEqual(requests[0].fields, ["R1999", "R2000"]);
  assert.deepEqual(requests[0].source, {
    collectionId: "eolab-mounted-vectors", itemId: "habitat", assetKey: "data", layerName: "habitat", filter: {},
  });

  inspector.onCurrentObservationChange(observation(9, "watersheds"));
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].source.itemId, "watersheds");
  const summary = (field, mean) => ({field, count: 4, mean, minimum: 0, maximum: 80});
  requests[1].resolve(Response.json([summary("R1999", 40), summary("R2000", 50)]));
  await nextTurn();
  const statistics = control("statistics-results");
  assert.deepEqual(statistics.querySelectorAll("dd").map(cell => cell.textContent), ["40", "50"]);
  requests[0].resolve(Response.json([summary("R1999", 20), summary("R2000", 25)]));
  await nextTurn();
  assert.deepEqual(statistics.querySelectorAll("dd").map(cell => cell.textContent), ["40", "50"]);

  control("statistics-maximum").checked = true;
  control("statistics-maximum").dispatchEvent(new Event("change"));
  control("statistics-mean").checked = false;
  control("statistics-mean").dispatchEvent(new Event("change"));
  control("statistics-done").dispatchEvent(new Event("click"));
  assert.equal(documentContext.activeElement, control("statistics-button"));
  assert.deepEqual(statistics.querySelectorAll("dt").map(cell => cell.textContent), ["Maximum", "Maximum"]);
  assert.deepEqual(statistics.querySelectorAll("dd").map(cell => cell.textContent), ["80", "80"]);
  assert.equal(requests.length, 2);
  assert.equal(control("table-body").children[0].children[2].textContent, "9");
});

test("comparison displays each layer's chosen benchmarks alongside exact feature values", async t => {
  const {inspector, profile, series, documentContext} = composition();
  t.after(() => { profile.destroy(); series.destroy(); });
  const requests = t.mock.method(globalThis, "fetch", async (url, options) => {
    const {source, fields} = JSON.parse(options.body);
    assert.equal(url, "/api/vector-sampling/layer-statistics");
    assert.deepEqual(fields, ["R1999"]);
    const minimum = source.itemId === "habitat" ? -12 : 0;
    return Response.json([{field: "R1999", count: 20, minimum, mean: 50, maximum: 100}]);
  });
  inspector.onSampleChange({
    state: "ready", message: "Ready",
    observations: [observation(1), observation(3), observation(9, "watersheds")],
  });
  inspector.onTimeSeriesRequested();
  const control = suffix => documentContext.querySelector("#vector-time-series-" + suffix);
  control("statistics-minimum").checked = true;
  control("statistics-minimum").dispatchEvent(new Event("change"));
  await nextTurn();
  assert.equal(requests.mock.callCount(), 2);
  const groups = control("statistics-results").children;
  assert.deepEqual(groups.map(group => [group.children[0].textContent, group.querySelector("dd").textContent]),
    [["Habitat", "-12"], ["Watersheds", "0"]]);
  control("values-button").dispatchEvent(new Event("click"));
  assert.equal(control("statistics").hidden, false);
  assert.equal(control("values").hidden, false);
  assert.deepEqual(control("table-body").children.map(row => row.children[1].children[0].textContent), ["1", "3", "9"]);
  control("statistics-minimum").checked = false;
  control("statistics-minimum").dispatchEvent(new Event("change"));
  assert.equal(control("statistics").hidden, true);
});
