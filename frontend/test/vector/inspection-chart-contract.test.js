import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { vectorInspectionObservation, VectorFeatureInspectorController } from "../../src/vector/feature-inspector.js";
import { VectorFeatureProfileController } from "../../src/vector/feature-profile.js";
import { VectorTimeSeriesController } from "../../src/vector/time-series.js";

/**
 * Execute the production vector composition with real chart consumers.
 * The inspector boundary exposes its callbacks so tests can deliver its immutable
 * results without starting map/network work. Like browser-startup.test.js, this
 * evaluates existing initialization code rather than copying the callbacks.
 * @param {typeof fetch|null} [fetchImplementation=null] Use the real selection owner when supplied.
 * @return {{inspector:Object,profile:VectorFeatureProfileController,
 * series:VectorTimeSeriesController,documentContext:FakeRasterControlDocument,
 * records:Array<{entry:{label:string}}>,status:Object,mapActions:({highlight:number}|{zoom:import("../../src/vector/inspection-observation.js").VectorInspectionObservation["focus"]})[],
 * selectionDirections:("previous"|"next")[]}}
 * Composed consumers and their presentation outputs.
 */
function composition(fetchImplementation = null) {
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
  const vectorMapLayerAdapter = {
    exportFilterState: () => ({}),
    describeSource: record => ({
      selection: {
        collectionId: "eolab-mounted-vectors", itemId: record.itemId, assetKey: "data", layerName: record.itemId,
      },
      fields: ["name", "x", "y", "R1999", "R2000"].map(name => ({name})),
      numericFields: ["x", "y", "R1999", "R2000"].map(name => ({name})),
    }),
  };
  const records = ["habitat", "watersheds"].map(itemId => ({
    itemId, entry: { key: "catalog|" + itemId, label: itemId, visible: false }, adapter: vectorMapLayerAdapter,
  }));
  const dependencies = {
    savedMapViewController: {scheduleRemember() {status.remembered = true;}},
    vectorMapLayerAdapter,
    mapLayerController: { retainedRecords: records, getRecord: key => records.find(record => record.entry.key === key) },
    mapInteractionTools: {setSelectionDisplay: display => {status.display = display;}},
    VectorTimeSeriesController: function (options) {
      return new VectorTimeSeriesController({...options, documentContext});
    },
    VectorFeatureProfileController: function (options) {
      return new VectorFeatureProfileController({...options, documentContext});
    },
    VectorFeatureInspectorController: function (options) {
      if (fetchImplementation) return new VectorFeatureInspectorController({...options, documentContext, fetchImplementation});
      return {
        ...options,
        showResult: index => mapActions.push({highlight: index}),
        navigateSelection: direction => selectionDirections.push(direction),
      };
    },
    mapInspection: {
      subscribeActiveTool(listener) { status.showTool = listener; listener(null); },
      showFeatureInspector() { documentContext.querySelector("#vector-feature-inspector").hidden = false; },
      hideFeatureInspector() { documentContext.querySelector("#vector-feature-inspector").hidden = true; },
      setVectorTimeSeriesIdentity() {},
      setVectorFeatureProfileIdentity() {},
      showVectorFeatureProfile() {},
      hideVectorFeatureProfile() {},
      showVectorTimeSeries() { comparison.hidden = false; },
      hideVectorTimeSeries() { comparison.hidden = true; },
      setClickResult(kind, result) { status[kind] = result; },
      setFeatureResultCount(count, options) { status.count = {count, ...options}; },
    },
    zoomInspectedVectorFeature: focus => { if (focus === null) return false; mapActions.push({zoom: focus}); return true; },
    L: {},
    leafletMap: {getContainer: () => documentContext.querySelector("#map"), removeLayer() {}},
    appGlobalConfiguration: {wmsUrl: "/wms"},
  };
  const controllers = new Function(...Object.keys(dependencies),
    `let vectorFeatureInspector;\n${source.slice(start, end)}\n` +
    "return {inspector: vectorFeatureInspector, profile: vectorFeatureProfile, series: vectorTimeSeries};"
  )(...Object.values(dependencies));
  return {...controllers, records, documentContext, status, mapActions, selectionDirections};
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
  inspector.onFeatureProfileRequested();
  documentContext.querySelector("#vector-feature-profile-values-button").dispatchEvent(new Event("click"));
  assert.deepEqual(documentContext.querySelector("#vector-feature-profile-table-body")
    .children.map(row => [row.children[0].children[0].textContent, ...row.children.slice(1).map(cell => cell.textContent)]),
    [["R1999", "1999", "9"], ["R2000", "2000", "10"]]);
  documentContext.querySelector("#zoom-vector-feature-profile-feature").dispatchEvent(new Event("click"));
  inspector.onTimeSeriesRequested();
  documentContext.querySelector("#vector-time-series-values-button").dispatchEvent(new Event("click"));
  assert.deepEqual(documentContext.querySelector("#vector-time-series-table-body")
    .children.map(row => [row.children[0].textContent, row.children[0].children[0].textContent, row.children[1].children[0].textContent]),
    [["Habitat", "Habitat · habitat.1", "1"], ["Habitat", "Habitat · habitat.9", "9"]]);
  assert.deepEqual(status.feature, {state: "ready", message: "2 features returned across 1 layer · Ready", position: null});
  assert.deepEqual(status.count, {count: 2, loading: false});
  assert.deepEqual(mapActions, [{zoom: { center: [20, 10], bounds: [20, 10, 20, 10] }}]);
  assert.deepEqual(observations[1].properties, { R1999: 9, R2000: 10 });
  assert.equal(Object.isFrozen(observations[1].properties), true);

  documentContext.querySelector("#vector-time-series-plot-button").dispatchEvent(new Event("click"));
  const chart = documentContext.querySelector("#vector-time-series-chart");
  chart.querySelectorAll(".series-chart-point")[0].dispatchEvent(new Event("click"));
  assert.deepEqual(mapActions.slice(1), [{highlight: 0}, {zoom: observations[0].focus}]);
  assert.equal(documentContext.querySelector("#vector-time-series").hidden, false);
});

test("a new inspection replaces the prior chart and communicates partial results", t => {
  const {inspector, profile, series, documentContext, status} = composition();
  t.after(() => { profile.destroy(); series.destroy(); });
  series.open();
  documentContext.querySelector("#vector-time-series-values-button").dispatchEvent(new Event("click"));
  inspector.onSampleChange({state: "ready", message: "Ready", observations: [observation(1)]});
  inspector.onSampleChange({state: "loading", message: "Reading features", observations: []});
  assert.equal(documentContext.querySelector("#vector-time-series-table-body").children.length, 0);
  assert.equal(documentContext.querySelector("#vector-time-series-status").textContent, "Reading features");
  assert.deepEqual(status.count, {count: 0, loading: true});
  assert.equal(status.feature.state, "loading");

  inspector.onSampleChange({state: "ready", message: "Partial results", observations: [observation(9)], failedLayers: 1});
  assert.deepEqual(documentContext.querySelector("#vector-time-series-table-body")
    .children.map(row => [row.children[0].children[0].textContent, row.children[1].children[0].textContent]), [["Habitat · habitat.9", "9"]]);
  assert.deepEqual(status.feature, {state: "error", message: "1 feature returned across 1 layer · 1 layer unavailable", position: null});
  assert.deepEqual(status.count, {count: 1, loading: false});

  inspector.onSampleChange({state: "invalidated", message: "Source removed", observations: []});
  assert.equal(series.observations.length, 0);
  assert.equal(documentContext.querySelector("#vector-time-series-table-body").children.length, 0);
  assert.deepEqual(status.feature, {state: "invalidated", message: "Source removed", position: null});
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
  documentContext.querySelector("#vector-time-series-values-button").dispatchEvent(new Event("click"));
  assert.deepEqual(documentContext.querySelector("#vector-time-series-table-body")
    .children.map(row => row.children[1].children[0].textContent), ["1", "9"]);
  documentContext.querySelector("#vector-time-series-plot-button").dispatchEvent(new Event("click"));
  const chart = documentContext.querySelector("#vector-time-series-chart");
  chart.querySelectorAll(".series-chart-point")[1].dispatchEvent(new Event("click"));
  assert.deepEqual(mapActions, [{highlight: 1}, {zoom: restoredObservations[1].focus}]);
  assert.equal(mapActions[1].zoom, restoredObservations[1].focus);
  assert.equal(documentContext.querySelector("#vector-time-series").hidden, false);
  next.dispatchEvent(new Event("click"));
  assert.deepEqual(selectionDirections, ["previous", "next"]);
});

test("Lasso attributes feed real scatterplots and remain available after closing Features", async t => {
  const rows = [
    {id: "-7", properties: {name: "First CO2", x: 1.25, y: 4}},
    {id: "2147483648", properties: {name: "Second CO2", x: 2.5, y: null}},
    {id: "9007199254740993", properties: {name: "Café", x: -3, y: 0.5}},
  ];
  const {inspector, profile, series, documentContext: doc, status, mapActions} = composition(async (url, options) => {
    const request = JSON.parse(options.body);
    if (url.endsWith("/lasso")) return Response.json({matched: 3, featureIds: rows.map(row => row.id), geometry: null});
    assert.equal(url, "/api/vector-sampling/features");
    assert.deepEqual(request.featureIds, rows.map(row => row.id));
    return Response.json({selection: request.selection, features: rows});
  });
  t.after(() => {inspector.destroy(); profile.destroy(); series.destroy();});
  inspector.setPickingEnabled(false);
  await inspector.inspectLasso(inspector.getSelectionTargets()[0],
    {type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]]}, new AbortController().signal);
  assert.equal(status.feature.state, "ready");
  assert.equal(status.feature.position, null);
  assert.equal(status.display.geometry, null);
  const chart = doc.querySelector("#vector-time-series-chart");
  assert.equal(chart.querySelectorAll(".series-chart-point").length, 0, "A Lasso does not draw a closed comparison");
  assert.equal(doc.querySelector("#vector-time-series-table-body").children.length, 0);
  assert.equal(doc.querySelector("#vector-time-series-feature-list").children.length, 0);
  assert.equal(doc.querySelector("#vector-feature-profile-feature-list").children.length, 0);
  assert.equal(doc.querySelector("#vector-feature-field-display").hidden, false,
    "A hidden source still supplies editable field display settings");
  const fieldImport = doc.querySelector("#import-vector-field-formats");
  fieldImport.files = [new Blob(["field,display_name,format,decimals,unit,currency\nx,Area,number,1,ha,\n"])];
  fieldImport.dispatchEvent(new Event("change"));
  await nextTurn();
  doc.querySelector("#apply-vector-field-formats").dispatchEvent(new Event("click"));
  assert.equal(status.remembered, true);
  assert.ok(doc.querySelector("#vector-feature-attributes").children.some(element => element.textContent === "Area"));
  const formattedArea = new Intl.NumberFormat(undefined, {minimumFractionDigits: 1, maximumFractionDigits: 1}).format(1.25) + " ha";
  assert.ok(doc.querySelector("#vector-feature-attributes").children.some(element => element.textContent === formattedArea));
  doc.querySelector("#open-vector-time-series").dispatchEvent(new Event("click"));
  series.settings = {xField: "x", yFields: ["y"], direction: "ascending", chartType: "scatter"};
  series.render();
  const marks = chart.querySelectorAll(".series-chart-point");
  assert.equal(marks.length, 2, "The missing Y stays absent from the scatterplot");
  assert.deepEqual(series.observations.map(observation => observation.properties.x), [1.25, 2.5, -3],
    "Inspector formatting preserves the original values used by plots");
  assert.ok(Number(marks[0].getAttribute("cx")) < Number(marks[1].getAttribute("cx")), "Numeric X positions follow -3 then 1.25");
  assert.ok(Number(marks[0].getAttribute("cy")) > Number(marks[1].getAttribute("cy")), "Numeric Y positions follow 0.5 then 4");
  assert.match(marks[0].getAttribute("aria-label"), /9007199254740993/);
  assert.match(marks[1].getAttribute("aria-label"), /-7/);
  assert.equal(doc.querySelector("#vector-time-series-table-body").children.length, 0);
  doc.querySelector("#vector-time-series-values-button").dispatchEvent(new Event("click"));
  assert.equal(doc.querySelector("#vector-time-series-table-body").children.length, 3, "Values retain the feature with missing Y");
  status.showTool("feature");
  assert.equal(doc.querySelector("#vector-time-series-table-body").children.length, 0);
  status.showTool("time-series");
  assert.equal(doc.querySelector("#vector-time-series-table-body").children.length, 3);
  doc.querySelector("#vector-time-series-plot-button").dispatchEvent(new Event("click"));
  doc.querySelector("#close-vector-inspector").dispatchEvent(new Event("click"));
  assert.equal(inspector.results.length, 3);
  chart.querySelectorAll(".series-chart-point")[0].dispatchEvent(new Event("click"));
  assert.equal(profile.currentObservation.featureId, rows[2].id);
  assert.deepEqual(mapActions, [], "Attribute-only observations must not invent a zoom point");
  doc.querySelector("#vector-time-series-one").dispatchEvent(new Event("click"));
  assert.deepEqual(profile.currentObservation.properties, rows[2].properties);
  assert.equal(doc.querySelector("#zoom-vector-feature-profile-feature").disabled, true);
  doc.querySelector("#clear-vector-selection").dispatchEvent(new Event("click"));
  assert.equal(profile.currentObservation, null);
  assert.equal(series.observations.length, 0);
  assert.equal(status.display, null);
});

for (const action of ["rename", "restore"]) {
  test(`Compare keeps the correct feature on its sorted page after a layer ${action}`, async t => {
    let rows = Array.from({length:1002}, (_, i) => ({id:String(i + 1), properties:{x:1002 - i, y:i + 10}}));
    const {inspector, profile, series, records, documentContext:doc} = composition(async (url, options) =>
      Response.json(url.endsWith("/lasso") ? {matched:rows.length, featureIds:rows.map(row => row.id), geometry:null} :
        {selection:JSON.parse(options.body).selection, features:rows}));
    t.after(() => {inspector.destroy(); profile.destroy(); series.destroy();});
    const lasso = () => inspector.inspectLasso(inspector.getSelectionTargets()[0],
      {type:"Polygon", coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}, new AbortController().signal);
    const control = name => doc.querySelector("#vector-time-series-" + name);
    await lasso();
    series.open();
    series.settings = {xField:"x", yFields:["y"], direction:"ascending", chartType:"scatter"};
    series.render();
    const range = control("row-range");
    range.value = "1000";
    range.dispatchEvent(new Event("change"));
    if (action === "rename") {
      control("values-button").dispatchEvent(new Event("click"));
      control("table-body").children[0].children[1].children[0].dispatchEvent(new Event("click"));
      assert.equal(profile.currentObservation.featureId, "1", "The selected table cell is local to Compare");
      records[0].entry.label = "Renamed watershed";
      inspector.syncVisibleLayers();
      assert.equal(range.value, "1000");
      assert.match(control("selection-text").textContent, /Renamed watershed · 2 · 1001 · y = 11/);
      assert.equal(control("table-body").children[0].getAttribute("aria-current"), "true");
    } else {
      control("chart").querySelectorAll(".series-chart-point")[0].dispatchEvent(new Event("click"));
      assert.equal(profile.currentObservation.featureId, "2");
      rows = rows.slice(2);
      await lasso();
      assert.equal(range.value, "0", "A replacement starts on the first page");
      assert.equal(control("selection").hidden, true);
      inspector.navigateSelection("previous");
      assert.equal(profile.currentObservation.featureId, "2");
      assert.equal(range.value, "1000");
      const mark = control("chart").querySelectorAll(".series-chart-point")[0];
      assert.equal(mark.getAttribute("aria-pressed"), "true");
      assert.match(control("selection-text").textContent, /habitat · 2$/);
    }
  });
}

for (const plotName of ["Compare features", "One feature"]) {
  test(`${plotName} rendering errors preserve the completed Lasso selection in Features and history`, async t => {
    const rows = [{id:"19", properties:{x:3}}, {id:"23", properties:{x:8}}];
    let matches = rows;
    const {inspector, profile, series, documentContext:doc, status} = composition(async (url, options) =>
      Response.json(url.endsWith("/lasso") ? {matched:matches.length, featureIds:matches.map(row => row.id), geometry:null} :
        {selection:JSON.parse(options.body).selection, features:matches}));
    t.after(() => {inspector.destroy(); profile.destroy(); series.destroy();});
    const renderProfile = profile.render.bind(profile);
    const plot = plotName === "Compare features" ? t.mock.method(series, "setSample", sample => {
      if (sample.state === "ready") throw new Error("The comparison could not draw.");
    }) : t.mock.method(profile, "render", () => {
      if (profile.currentObservation !== null) throw new Error("One feature could not draw.");
      renderProfile();
    });
    const lasso = () => inspector.inspectLasso(inspector.getSelectionTargets()[0],
      {type:"Polygon", coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}, new AbortController().signal);
    await assert.rejects(lasso(), /could not draw/);
    assert.deepEqual(inspector.results.map(result => result.feature.id), ["19","23"]);
    assert.equal(inspector.lastSample.state, "ready");
    assert.deepEqual(status.count, {count:2, loading:false});
    assert.equal(status.display.count, 2);
    assert.ok(doc.querySelector("#vector-feature-attributes").children.some(cell => cell.textContent === "3"));
    plot.mock.restore();
    matches = [];
    await lasso();
    inspector.navigateSelection("previous");
    assert.deepEqual(series.observations.map(feature => feature.featureId), ["19","23"]);
  });
}

test("oversized JSON integers keep exact Values and explain unavailable absolute plots", async t => {
  const base = 10n ** 400n;
  const rows = [0n, 2n].map((offset, index) => ({id:String(index + 1), properties:{
    huge:{integer:String(base + offset)}, x:index + 1, ordinary:index ? -0.75 : 0.25,
    opposite:{integer:String(index ? -base : base)}, mixed:index ? 0.5 : {integer:String(base)},
    zFar:index ? {integer:String(15n * 10n ** 307n)} : 0,
  }}));
  const {inspector, profile, series, documentContext:doc} = composition(async (url, options) =>
    Response.json(url.endsWith("/lasso") ? {matched:2, featureIds:["1","2"], geometry:null} :
      {selection:JSON.parse(options.body).selection, features:rows}));
  t.after(() => {inspector.destroy(); profile.destroy(); series.destroy();});
  await inspector.inspectLasso(inspector.getSelectionTargets()[0],
    {type:"Polygon", coordinates:[[[0,0],[3,0],[3,1],[0,0]]]}, new AbortController().signal);
  const profileChart = doc.querySelector("#vector-feature-profile-chart");
  const comparisonChart = doc.querySelector("#vector-time-series-chart");
  const unavailable = /too large.*plot.*Values/i;
  /** Check that a visible numeric abbreviation retains both ends of its reading.
   * @param {SVGElement} label Painted label.
   * @param {string} exact Original numeric text.
   * @return {void}
   */
  function assertAbbreviatedValue(label, exact) {
    assert.ok(label.textContent.length <= 28, "A long reading must fit a compact chart");
    assert.match(label.textContent, /…/, "An omitted middle must be explicit");
    assert.ok(label.textContent.startsWith(exact.slice(0, 10)));
    assert.ok(label.textContent.endsWith(exact.slice(-10)));
  }
  inspector.onFeatureProfileRequested();
  const settings = profile.settingsBySource.get(profile.currentObservation.sourceId);
  settings.selectedFields = ["huge", "ordinary"];
  for (const chartType of ["bar", "stacked", "scatter", "line"]) {
    settings.chartType = chartType;
    profile.render();
    assert.equal(profileChart.querySelectorAll(".series-chart-point").length, 0,
      "An unsupported field must not silently disappear from a mixed profile");
    assert.match(doc.querySelector("#vector-feature-profile-status").textContent, unavailable);
  }
  doc.querySelector("#vector-feature-profile-values-button").dispatchEvent(new Event("click"));
  const profileValue = doc.querySelector("#vector-feature-profile-table-body").children.find(row =>
    row.children[0].children[0].textContent === "huge").children.at(-1).textContent;
  assert.equal(profileValue, rows[0].properties.huge.integer);
  settings.selectedFields = ["huge"];
  settings.chartType = "scatter";
  doc.querySelector("#vector-feature-profile-plot-button").dispatchEvent(new Event("click"));
  profile.render();
  assertAbbreviatedValue(profileChart.querySelector(".vector-plot-value"), rows[0].properties.huge.integer);
  assert.ok(profileChart.querySelector(".series-chart-point").getAttribute("aria-label").includes(rows[0].properties.huge.integer));
  assert.ok(profileChart.querySelector(".series-chart-point").querySelector("title").textContent.includes(rows[0].properties.huge.integer));

  assert.doesNotThrow(() => inspector.onTimeSeriesRequested(), "The default comparison must explain its unavailable plot");
  assert.equal(comparisonChart.querySelectorAll(".series-chart-point").length, 0);
  assert.match(series.firstPlot.querySelector("p").textContent, unavailable);
  series.settings = {xField:"x", yFields:["huge", "ordinary"], direction:"ascending", chartType:"bar"};
  series.render();
  assert.equal(comparisonChart.querySelectorAll(".series-chart-point").length, 0);
  assert.equal(series.extraPlots.querySelectorAll(".series-chart-point").length, 2,
    "A separately plotted ordinary field remains usable");
  series.settings.chartType = "stacked";
  series.render();
  assert.equal(comparisonChart.querySelectorAll(".series-chart-point").length, 0);
  assert.match(doc.querySelector("#vector-time-series-status").textContent, unavailable);
  doc.querySelector("#vector-time-series-values-button").dispatchEvent(new Event("click"));
  const values = doc.querySelector("#vector-time-series-table-body").children;
  assert.deepEqual(values.map(row => row.children[1].children[0].textContent), rows.map(row => row.properties.huge.integer));
  values[1].children[1].children[0].dispatchEvent(new Event("click"));
  doc.querySelector("#vector-time-series-one").dispatchEvent(new Event("click"));
  assert.equal(profile.currentObservation.featureId, "2", "Exact Values still select their original feature");

  inspector.onTimeSeriesRequested();
  series.settings.yFields = ["huge"];
  series.settings.chartType = "scatter";
  doc.querySelector("#vector-time-series-plot-button").dispatchEvent(new Event("click"));
  series.plotPanel.width = 242;
  for (const chartType of ["scatter", "line"]) {
    series.settings.chartType = chartType;
    series.render();
    const origin = comparisonChart.querySelectorAll(".series-chart-axis-title").find(label => label.textContent.startsWith("100000"));
    assertAbbreviatedValue(origin, String(base));
    assert.equal(origin.querySelector("title").textContent, String(base));
    assert.ok(comparisonChart.getAttribute("aria-label").includes(String(base)), "The complete relative reference stays accessible");
    assertAbbreviatedValue(comparisonChart.querySelector(".vector-plot-value"), String(base + 2n));
    const marks = comparisonChart.querySelectorAll(".series-chart-point");
    assert.equal(marks.length, 2, "Finite relative distances remain plottable");
    marks.forEach((mark, index) => {
      assert.ok(mark.getAttribute("aria-label").includes(rows[index].properties.huge.integer));
      assert.ok(mark.querySelector("title").textContent.includes(rows[index].properties.huge.integer));
    });
    assert.ok(Number(marks[0].getAttribute("cy")) > Number(marks[1].getAttribute("cy")));
    assert.ok(marks.every(mark => ["cx", "cy"].every(axis => Number.isFinite(Number(mark.getAttribute(axis))))));
    assert.equal(doc.querySelector("#vector-time-series-status").textContent, "");
  }
  series.settings = {xField:"zFar", yFields:["ordinary"], direction:"ascending", chartType:"bar"};
  series.render();
  assert.equal(comparisonChart.querySelectorAll(".series-chart-point").length, 0,
    "Bar spacing must not turn finite exact X coordinates into an infinite domain");
  assert.match(series.firstPlot.querySelector("p").textContent, unavailable);
  series.settings = {xField:"x", yFields:["zFar"], direction:"ascending", chartType:"bar"};
  series.render();
  const largeBars = comparisonChart.querySelectorAll(".series-chart-point");
  assert.equal(largeBars.length, 2, "A finite absolute Y range remains supported");
  assertAbbreviatedValue(comparisonChart.querySelector(".vector-plot-value"), rows[1].properties.zFar.integer);
  assert.ok(largeBars[1].getAttribute("aria-label").includes(rows[1].properties.zFar.integer));
  assert.ok(largeBars[1].querySelector("title").textContent.includes(rows[1].properties.zFar.integer));
  assert.ok(largeBars.every(mark => ["x", "y", "width", "height"].every(attribute =>
    Number.isFinite(Number(mark.getAttribute(attribute))))));
  for (const field of ["opposite", "mixed"]) {
    for (const axis of ["x", "y"]) {
      series.settings = {xField:axis === "x" ? field : "x", yFields:[axis === "y" ? field : "ordinary"],
        direction:"ascending", chartType:"scatter"};
      series.render();
      assert.equal(comparisonChart.querySelectorAll(".series-chart-point").length, 0,
        "An overflowing relative coordinate must not produce an invalid SVG mark");
      assert.match(series.firstPlot.querySelector("p").textContent, unavailable);
    }
  }
});

test("wide parcel attributes keep their exact values and numeric spacing in both plots", async t => {
  const base = 9007199254740992n;
  const minimumInt64 = -(2n ** 63n);
  const rows = [4n, 0n, 1n].map((offset, id) => ({id:String(id), properties:{
    x:{integer:String(base + offset)}, y:{integer:String(-base - 4n + offset)}, code:"9007199254740993",
    signedCode:{integer:String(minimumInt64 + offset)},
  }}));
  const {inspector, profile, series, documentContext:doc} = composition(async (url, options) =>
    Response.json(url.endsWith("/lasso") ? {matched:3, featureIds:rows.map(row => row.id), geometry:null} :
      {selection:JSON.parse(options.body).selection, features:rows}));
  t.after(() => {inspector.destroy(); profile.destroy(); series.destroy();});
  await inspector.inspectLasso(inspector.getSelectionTargets()[0],
    {type:"Polygon", coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}, new AbortController().signal);
  assert.ok(doc.querySelector("#vector-feature-attributes").children.some(cell => cell.textContent === "9007199254740996"));
  const openProfile = doc.querySelector("#open-vector-feature-profile");
  assert.equal(openProfile.disabled, false, "Wide integers alone enable One feature");
  openProfile.dispatchEvent(new Event("click"));
  const profileSettings = profile.settingsBySource.get(profile.currentObservation.sourceId);
  profileSettings.selectedFields = ["y"];
  for (const shape of ["scatter", "stacked"]) {
    profileSettings.chartType = shape;
    profile.render();
    const mark = doc.querySelector("#vector-feature-profile-chart").querySelectorAll(".series-chart-point")[0];
    assert.ok(mark.getAttribute("aria-label").includes("-9007199254740992"));
  }
  doc.querySelector("#open-vector-time-series").dispatchEvent(new Event("click"));
  series.settings = {xField:"x", yFields:["y"], direction:"ascending", chartType:"scatter"};
  series.render();
  const marks = doc.querySelector("#vector-time-series-chart").querySelectorAll(".series-chart-point");
  assert.equal(marks.length, 3);
  assert.equal(series.observations[2].properties.code, "9007199254740993", "Numeric-looking text keeps its source type");
  const labels = marks.map(mark => mark.getAttribute("aria-label"));
  assert.ok(labels[1].includes("9007199254740993") && labels[1].includes("-9007199254740995"));
  for (const axis of ["cx", "cy"]) {
    const [a,b,c] = marks.map(mark => Number(mark.getAttribute(axis)));
    assert.ok(Math.abs((c-b)/(b-a) - 3) < 1e-9, axis + " must preserve one-unit and three-unit distances");
  }
  doc.querySelector("#vector-time-series-values-button").dispatchEvent(new Event("click"));
  const table = doc.querySelector("#vector-time-series-table-body").children;
  assert.deepEqual(table.map(row => row.children[1].children[0].textContent),
    ["-9007199254740996","-9007199254740995","-9007199254740992"]);
  doc.querySelector("#vector-time-series-plot-button").dispatchEvent(new Event("click"));
  series.plotPanel.width = 242; // Chart width in the 320-pixel dock.
  series.settings.xField = "signedCode";
  series.settings.yFields = ["signedCode"];
  series.render();
  const compact = doc.querySelector("#vector-time-series-chart");
  const ticks = compact.querySelector(".series-chart-x-axis").querySelectorAll("text");
  assert.deepEqual(ticks.map(tick => tick.textContent), [0n, 1n, 4n].map(offset => String(minimumInt64 + offset)));
  assert.ok(Number(compact.querySelector(".series-chart-point").getAttribute("cx")) >= 100,
    "The leftmost rotated integer tick needs room for its sign and all 19 digits");
  const captions = compact.querySelectorAll(".series-chart-axis-title");
  const origin = captions.find(label => label.textContent === String(minimumInt64));
  assert.ok(origin, "The complete reference number has a line of its own");
  assert.ok(Number(origin.getAttribute("x")) < 10, "The reference uses the full chart width");
  assert.ok(Number(origin.getAttribute("y")) > Number(captions.find(label =>
    label.textContent === "Value relative to").getAttribute("y")));
  const peakLabel = compact.querySelector(".vector-plot-value");
  assert.ok(Number(peakLabel.getAttribute("y")) - Number(origin.getAttribute("y")) >= 16,
    "The topmost point's reading must leave one full text line below the reference number");
  series.settings.chartType = "stacked";
  series.render();
  assert.equal(doc.querySelector("#vector-time-series-chart").querySelectorAll(".series-chart-point").length, 3);
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
  control("values-button").dispatchEvent(new Event("click"));
  assert.equal(control("table-body").children[0].children[2].textContent, "9");
});

test("comparison displays each layer's chosen benchmarks alongside exact feature values", async t => {
  const {inspector, profile, series, documentContext, mapActions} = composition();
  t.after(() => { profile.destroy(); series.destroy(); });
  const requests = t.mock.method(globalThis, "fetch", async (url, options) => {
    const {source, fields} = JSON.parse(options.body);
    assert.equal(url, "/api/vector-sampling/layer-statistics");
    assert.deepEqual(fields, ["R1999"]);
    const minimum = source.itemId === "habitat" ? -12 : 0;
    return Response.json([{field: "R1999", count: 20, minimum, mean: 50, maximum: 100}]);
  });
  const observations = [observation(1), observation(3), observation(9, "watersheds")];
  inspector.onSampleChange({
    state: "ready", message: "Ready",
    observations,
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
  control("chart-type").value = "stacked";
  control("chart-type").dispatchEvent(new Event("change"));
  const watershedsBar = control("chart").querySelectorAll(".series-chart-bar")
    .find(mark => mark.getAttribute("aria-label").startsWith("Watersheds ·"));
  watershedsBar.dispatchEvent(new Event("click"));
  assert.deepEqual(mapActions, [{highlight: 2}, {zoom: observations[2].focus}]);
  assert.equal(mapActions[1].zoom, observations[2].focus);
  assert.equal(control("statistics").hidden, false);
  assert.equal(documentContext.querySelector("#vector-time-series").hidden, false);
  control("values-button").dispatchEvent(new Event("click"));
  assert.equal(control("statistics").hidden, false);
  assert.equal(control("values").hidden, false);
  assert.deepEqual(control("table-body").children.map(row => row.children[1].children[0].textContent), ["1", "3", "9"]);
  control("statistics-minimum").checked = false;
  control("statistics-minimum").dispatchEvent(new Event("change"));
  assert.equal(control("statistics").hidden, true);
});
