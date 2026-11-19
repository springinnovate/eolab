import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
 * status:Object,mapActions:({highlight:number}|{zoom:import("../../src/vector/inspection-observation.js").VectorInspectionObservation["focus"]})[],
 * selectionDirections:("previous"|"next")[]}}
 * Composed consumers and their presentation outputs.
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
  const mapActions = [];
  const selectionDirections = [];
  const comparison = documentContext.querySelector("#vector-time-series");
  comparison.hidden = true;
  const dependencies = {
    VectorTimeSeriesController: function (options) {
      return new VectorTimeSeriesController({...options, documentContext});
    },
    VectorFeatureProfileController: function (options) {
      return new VectorFeatureProfileController({...options, documentContext});
    },
    VectorFeatureInspectorController: function (options) {
      return {
        ...options,
        showResult: index => mapActions.push({highlight: index}),
        navigateSelection: direction => selectionDirections.push(direction),
      };
    },
    mapInspection: {
      setVectorTimeSeriesIdentity() {},
      setVectorFeatureProfileIdentity() {},
      hideVectorFeatureProfile() {},
      showVectorTimeSeries() { comparison.hidden = false; },
      hideVectorTimeSeries() { comparison.hidden = true; },
      setClickResult(kind, result) { status[kind] = result; },
      setFeatureResultCount(count, options) { status.count = {count, ...options}; },
    },
    zoomInspectedVectorFeature: focus => { mapActions.push({zoom: focus}); return true; },
    L: {},
    leafletMap: {},
    appGlobalConfiguration: {wmsUrl: "/wms"},
  };
  const controllers = new Function(...Object.keys(dependencies),
    `let vectorFeatureInspector;\n${source.slice(start, end)}\n` +
    "return {inspector: vectorFeatureInspector, profile: vectorFeatureProfile, series: vectorTimeSeries};"
  )(...Object.values(dependencies));
  return {...controllers, documentContext, status, mapActions, selectionDirections};
}

/**
 * Construct an observation through the inspector's actual source-data boundary.
 * @param {number} id Source feature identity and contrasting numeric value.
 * @return {import("../../src/vector/inspection-observation.js").VectorInspectionObservation}
 * Immutable observation suitable for both chart consumers.
 */
function observation(id) {
  return vectorInspectionObservation({
    feature: {
      id: `habitat.${id}`,
      geometry: null,
      bbox: [20, 10, 20, 10],
      properties: { R1999: id, R2000: id + 1, nested: { ignored: true } },
    },
    target: { sourceId: "catalog|habitat", label: "Habitat" },
    inspectionPosition: { lng: 21, lat: 11 },
  });
}

test("inspection composition delivers distinct observations to both chart consumers", t => {
  const {inspector, profile, series, documentContext, status, mapActions} = composition();
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
  assert.deepEqual(mapActions, [{zoom: { center: [20, 10], bounds: [20, 10, 20, 10] }}]);
  assert.deepEqual(observations[1].properties, { R1999: 9, R2000: 10 });
  assert.equal(Object.isFrozen(observations[1].properties), true);

  series.open();
  const chart = documentContext.querySelector("#vector-time-series-chart");
  chart.querySelectorAll(".series-chart-point")[0].dispatchEvent(new Event("click"));
  assert.deepEqual(mapActions.slice(1), [{highlight: 0}, {zoom: observations[0].focus}]);
  assert.equal(documentContext.querySelector("#vector-time-series").hidden, false);
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
  const {inspector, profile, series, documentContext, status, mapActions, selectionDirections} = composition();
  t.after(() => { profile.destroy(); series.destroy(); });
  series.open();
  const previous = documentContext.querySelector("#vector-time-series-previous-selection");
  const next = documentContext.querySelector("#vector-time-series-next-selection");
  assert.equal(previous.disabled, true);
  assert.equal(next.disabled, true);

  inspector.onSampleChange({state: "empty", message: "No features", observations: []});
  inspector.onSelectionNavigationChange({canPrevious: true, canNext: false});
  previous.dispatchEvent(new Event("click"));
  assert.deepEqual(selectionDirections, ["previous"]);

  const position = {lng: 21, lat: 11};
  const restoredObservations = [observation(1), observation(9)];
  inspector.onSampleChange({state: "ready", message: "Ready", observations: restoredObservations, position});
  inspector.onSelectionNavigationChange({canPrevious: false, canNext: true});
  assert.deepEqual(status.feature.position, position);
  assert.deepEqual(documentContext.querySelector("#vector-time-series-table-body")
    .children.map(row => row.children[1].children[0].textContent), ["1", "9"]);
  const chart = documentContext.querySelector("#vector-time-series-chart");
  chart.querySelectorAll(".series-chart-point")[1].dispatchEvent(new Event("click"));
  assert.deepEqual(mapActions, [{highlight: 1}, {zoom: restoredObservations[1].focus}]);
  assert.equal(mapActions[1].zoom, restoredObservations[1].focus);
  assert.equal(documentContext.querySelector("#vector-time-series").hidden, false);
  next.dispatchEvent(new Event("click"));
  assert.deepEqual(selectionDirections, ["previous", "next"]);
});
