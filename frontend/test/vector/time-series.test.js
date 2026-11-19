import assert from "node:assert/strict";
import test from "node:test";

import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import {
  buildVectorFeatureComparison,
  summarizeVectorTimeSeriesFields,
  VECTOR_TIME_SERIES_LAYER_LABEL,
  vectorTimeSeriesPresentation,
  VectorTimeSeriesController,
} from "../../src/vector/time-series.js";

/**
 * Return one immutable geometry-neutral feature focus for controller tests.
 *
 * @param {number} longitude WGS 84 longitude.
 * @param {number} latitude WGS 84 latitude.
 * @param {number[]|null} [bounds=null] Optional WGS 84 feature bounds.
 * @return {Readonly<Object>} Test focus contract.
 */
function focus(longitude, latitude, bounds = null) {
  return Object.freeze({
    center: Object.freeze([longitude, latitude]),
    bounds: bounds === null ? null : Object.freeze(bounds),
  });
}

function observations() {
  return [
    Object.freeze({
      sourceId: "catalog|risk-10",
      layerLabel: "risk-10.shp",
      featureId: "risk.10a",
      focus: focus(10, 1, [9, 0, 11, 2]),
      properties: Object.freeze({ year: 2010, score: 8, group: "east" }),
    }),
    Object.freeze({
      sourceId: "catalog|risk-2",
      layerLabel: "risk-2.shp",
      featureId: "risk.2a",
      focus: focus(2, 1),
      properties: Object.freeze({ year: 2002, score: 3, group: "west" }),
    }),
    Object.freeze({
      sourceId: "catalog|risk-2",
      layerLabel: "risk-2.shp",
      featureId: "risk.2b",
      focus: focus(3, 1),
      properties: Object.freeze({ year: 2002, score: 5, group: "west" }),
    }),
    Object.freeze({
      sourceId: "catalog|risk-11",
      layerLabel: "risk-11.shp",
      featureId: "risk.11a",
      focus: focus(11, 1),
      properties: Object.freeze({ year: null, score: "missing", group: "north" }),
    }),
  ];
}

function fixture() {
  const documentContext = new FakeRasterControlDocument();
  const events = new EventTarget();
  documentContext.addEventListener = events.addEventListener.bind(events);
  documentContext.removeEventListener = events.removeEventListener.bind(events);
  documentContext.dispatchEvent = events.dispatchEvent.bind(events);
  documentContext.querySelector("#vector-time-series").hidden = true;
  documentContext.querySelector("#vector-time-series-chart").setAttribute(
    "hidden",
    "",
  );
  documentContext.querySelector("#vector-time-series-table").hidden = true;
  const visibility = [];
  const presentations = [];
  const zoomRequests = [];
  const controller = new VectorTimeSeriesController({
    documentContext,
    onVisibilityChange: (visible, moveFocus) => {
      visibility.push({ visible, moveFocus });
      documentContext.querySelector("#vector-time-series").hidden = !visible;
    },
    onPresentationChange: (identity) => presentations.push(identity),
    onNavigateSelection() {},
    onFeatureZoom: (featureFocus) => {
      zoomRequests.push(featureFocus);
      return true;
    },
  });
  return {
    controller,
    documentContext,
    visibility,
    presentations,
    zoomRequests,
  };
}

test("field summaries expose heterogeneous coverage without coercion", () => {
  assert.deepEqual(summarizeVectorTimeSeriesFields(observations()), {
    xFields: [
      { name: "group", count: 4, total: 4 },
      { name: "score", count: 4, total: 4 },
      { name: "year", count: 3, total: 4 },
    ],
    numericFields: [
      { name: "score", count: 3, total: 4 },
      { name: "year", count: 3, total: 4 },
    ],
  });
});

test("two measurements share positions, retain exact cells, and zoom to the chosen original feature", () => {
  const {controller, documentContext:doc, zoomRequests} = fixture();
  const sample = observations().slice(0,3).map((o,index) => ({
    ...o, featureId:"same-id", properties:{
      year:[2018,2018,2025][index], runoff_mm:[0,null,42.654321987][index], temp_c:[8.2,9.1,"missing"][index],
    },
  }));
  controller.setSample({state:"ready",message:"Ready",observations:sample});
  checkField(doc,"temp_c",true);
  const first=doc.querySelector("#vector-time-series-chart");
  const second=doc.querySelector("#vector-time-series-extra-charts").children[0].children[1];
  const bars=chart=>chart.querySelectorAll(".series-chart-bar");
  assert.deepEqual(controller.settings.yFields,["runoff_mm","temp_c"]);
  assert.equal(bars(first).length,2);
  assert.equal(bars(second).length,2);
  assert.equal(bars(first)[0].getAttribute("x"),bars(second)[0].getAttribute("x"));
  assert.notEqual(bars(second)[0].getAttribute("x"),bars(second)[1].getAttribute("x"));
  bars(second)[1].dispatchEvent(new Event("click"));
  const zoom=doc.querySelector("#zoom-vector-time-series-feature");
  zoom.dispatchEvent(new Event("click"));
  assert.equal(zoomRequests.at(-1),sample[1].focus);
  doc.querySelector("#vector-time-series-values-button").dispatchEvent(new Event("click"));
  assert.equal(doc.querySelector("#vector-time-series-plots").hidden,true);
  const rows=doc.querySelector("#vector-time-series-table-body").children;
  assert.deepEqual(rows.map(row=>row.children.slice(1).map(cell=>cell.children[0].textContent)),
    [["0","8.2"],["No value","9.1"],["42.654321987","No value"]]);
  rows[2].children[1].children[0].dispatchEvent(new Event("click"));
  assert.equal(rows[2].getAttribute("aria-current"),"true");
  assert.equal(rows[2].children[1].children[0].getAttribute("aria-pressed"),"true");
  zoom.dispatchEvent(new Event("click"));
  assert.equal(zoomRequests.at(-1),sample[2].focus);
  controller.setSample({state:"ready",message:"New click",observations:[{...sample[0],properties:{year:2031,runoff_mm:3,temp_c:8}}]});
  assert.equal(zoom.hidden,true);
  assert.equal(doc.querySelector("#vector-time-series-values").hidden,false);
  assert.deepEqual(doc.querySelector("#vector-time-series-table-head").children.map(cell=>cell.textContent),["year","runoff_mm","temp_c"]);
  controller.destroy();
});

/**
 * Check a measurement through the visible field chooser.
 * @param {FakeRasterControlDocument} doc Test document.
 * @param {string} name Numeric field name.
 * @param {boolean} checked New selection state.
 * @return {void}
 */
function checkField(doc, name, checked) {
  const input = doc.querySelector("#vector-time-series-field-list").children
    .map(row => row.children[0]).find(box => box.value === name);
  input.checked = checked;
  input.dispatchEvent(new Event("change"));
}

test("every returned feature has a table row and retains its own plotted position", () => {
  const sample = observations();
  const ascending = buildVectorFeatureComparison(sample, {
    xField: VECTOR_TIME_SERIES_LAYER_LABEL, yFields: ["score"], direction: "ascending",
  });
  assert.deepEqual(ascending.plots[0].points.map(p => [p.observation.sourceId, p.observation.layerLabel, p.yValue]), [
    ["catalog|risk-2","risk-2.shp",3], ["catalog|risk-2","risk-2.shp",5],
    ["catalog|risk-10","risk-10.shp",8], ["catalog|risk-11","risk-11.shp",null],
  ]);
  const descending = buildVectorFeatureComparison(sample, {xField:"year",yFields:["score"],direction:"descending"});
  assert.deepEqual(descending.plots[0].points.map(p => [p.xValue,p.yValue]), [[2010,8],[2002,3],[2002,5]]);
  assert.equal(descending.rows.at(-1).observation.featureId, "risk.11a");
  assert.equal(descending.rows.at(-1).xValue, null);
});

test("mixed scalar X values sort naturally, keep tied features, and retain a missing measurement", () => {
  for (const values of [
    [-10,-2,"-5"],[-10,"-5",-2],[-2,-10,"-5"],[-2,"-5",-10],["-5",-10,-2],["-5",-2,-10],
  ]) {
    const sample = values.map((x,i) => ({...observations()[0],featureId:i,properties:{x,y:1}}));
    sample.push({...sample[0],featureId:"missing",properties:{x:"omitted",y:null}});
    for (const direction of ["ascending","descending"]) {
      const {rows,plots,xScale} = buildVectorFeatureComparison(sample,{xField:"x",yFields:["y"],direction});
      assert.equal(xScale,"ordinal");
      assert.deepEqual(plots[0].points.filter(p => p.yValue !== null).map(p => p.xValue),
        direction === "ascending" ? [-2,"-5",-10] : [-10,"-5",-2]);
      assert.equal(rows.length,4);
      assert.equal(plots[0].finiteCount,3);
    }
  }
  const sample = [2,"2",false,true].map((x,featureId) => ({...observations()[0],featureId,properties:{x,y:1}}));
  for (const direction of ["ascending","descending"]) {
    const {rows} = buildVectorFeatureComparison(sample,{xField:"x",yFields:["y"],direction});
    const equal = rows.filter(r=>r.xLabel==="2");
    assert.deepEqual(equal.map(r=>r.observation.featureId),[0,1]);
    assert.deepEqual(equal.map(r=>r.xValue),[2,"2"]);
    assert.deepEqual(rows.filter(r=>typeof r.xValue==="boolean").map(r=>r.xLabel),
      direction==="ascending"?["False","True"]:["True","False"]);
  }
});

test("mixed scalar points and table rows are displayed in the same natural order", () => {
  const h=fixture(), doc=h.documentContext;
  h.controller.setSample({state:"ready",message:"Ready",observations:[-10,-2,"-5"].map((x,featureId)=>
    ({...observations()[0],featureId,properties:{x,y:1}}))});
  const x=doc.querySelector("#vector-time-series-x");
  x.value="x"; x.dispatchEvent(new Event("change"));
  checkField(doc,"x",false); checkField(doc,"y",true);
  assert.deepEqual(doc.querySelector("#vector-time-series-table-body").children.map(row=>row.children[0].textContent),["-2","-5","-10"]);
  assert.deepEqual(h.controller.pointElements.map(entry=>entry.point.xValue),[-2,"-5",-10]);
});

test("series presentation identifies a measure and all inspected source layers", () => {
  assert.deepEqual(vectorTimeSeriesPresentation(observations(),["score"]),{
    label:"score · 4 features", title:"score · 4 features · risk-10.shp, risk-2.shp, risk-11.shp",
    heading:"Features at map click", context:"risk-10.shp, risk-2.shp, risk-11.shp",
  });
  assert.equal(vectorTimeSeriesPresentation([],["score"]),null);
});

test("comparison controls retain unavailable fields and expose the original rows on a new click", () => {
  const h=fixture(), doc=h.documentContext;
  h.controller.setSample({state:"ready",observations:observations(),message:"4 features found."});
  h.controller.open();
  const chart=doc.querySelector("#vector-time-series-chart");
  assert.equal(chart.getAttribute("hidden"),null);
  assert.match(chart.getAttribute("aria-label"),/score by Filename or layer/);
  assert.equal(doc.querySelector("#vector-time-series-table-body").children.length,4);
  assert.match(doc.querySelector("#vector-time-series-first").children.at(-1).textContent,/1 feature lacks/);
  const x=doc.querySelector("#vector-time-series-x"), order=doc.querySelector("#vector-time-series-direction");
  x.value="year"; x.dispatchEvent(new Event("change"));
  checkField(doc,"score",false); checkField(doc,"year",true);
  order.value="descending"; order.dispatchEvent(new Event("change"));
  doc.querySelector("#vector-time-series-values-button").dispatchEvent(new Event("click"));
  h.controller.setSample({state:"ready",observations:[{...observations()[0],layerLabel:"later.shp",properties:{other:4}}],message:"1 feature found."});
  assert.equal(x.value,"year");
  assert.deepEqual(h.controller.settings.yFields,["year"]);
  assert.equal(order.value,"descending");
  assert.equal(doc.querySelector("#vector-time-series-values").hidden,false);
  assert.equal(doc.querySelector("#vector-time-series-table-body").children[0].children[1].children[0].textContent,"No value");
  assert.equal(doc.querySelector("#vector-time-series-first").children.at(-1).textContent,"No numeric readings with the selected X field.");
  assert.equal(doc.querySelector("#vector-time-series-heading").textContent,"later.shp");
  assert.deepEqual(h.visibility,[{visible:true,moveFocus:false}]);
});

test("categorical and numeric X fields use their expected spacing", () => {
  const h = fixture();
  h.controller.setSample({
    state: "ready",
    observations: observations(),
    message: "Ready",
  });
  const chart = h.documentContext.querySelector("#vector-time-series-chart");
  const chartType = h.documentContext.querySelector("#vector-time-series-chart-type");
  chartType.value = "scatter";
  chartType.dispatchEvent(new Event("change"));
  const positions = () => chart.children
    .filter((element) =>
      element.getAttribute("class") === "series-chart-point"
    )
    .map((element) => Number(element.getAttribute("cx")));

  const [first, second, third] = positions();
  assert.ok(first < second && second < third);
  assert.ok(Math.abs((third - second) - (second - first)) < 1e-9);

  const x = h.documentContext.querySelector("#vector-time-series-x");
  x.value = "year";
  x.dispatchEvent(new Event("change"));
  assert.deepEqual(positions(), [72, 72, 656]);
});

test("loading and invalidation retain settings without a stale chart", () => {
  const h = fixture();
  h.controller.setSample({
    state: "ready",
    observations: observations(),
    message: "Ready",
  });
  h.controller.setSample({
    state: "invalidated",
    observations: [],
    message: "Visible vector layers changed. Click the map to sample again.",
  });
  assert.equal(
    h.documentContext.querySelector("#vector-time-series-chart").getAttribute(
      "hidden",
    ),
    "",
  );
  assert.equal(
    h.documentContext.querySelector("#vector-time-series-status").textContent,
    "Visible vector layers changed. Click the map to sample again.",
  );
  assert.deepEqual(h.controller.settings.yFields, ["score"]);
});

test("scatter and bar modes redraw the same sampled points without a connecting line", () => {
  const h = fixture();
  h.controller.setSample({
    state: "ready",
    observations: observations(),
    message: "Ready",
  });
  const chart = h.documentContext.querySelector("#vector-time-series-chart");
  const initialType = h.documentContext.querySelector("#vector-time-series-chart-type");
  assert.equal(initialType.value, "bar");
  initialType.value = "line";
  initialType.dispatchEvent(new Event("change"));
  assert.equal(chart.querySelectorAll(".series-chart-line").length, 1);

  const chartType = h.documentContext.querySelector(
    "#vector-time-series-chart-type"
  );
  chartType.value = "scatter";
  chartType.dispatchEvent(new Event("change"));
  assert.equal(h.controller.settings.chartType, "scatter");
  h.controller.setSample({
    state: "ready",
    observations: observations(),
    message: "Ready again",
  });
  assert.equal(chartType.value, "scatter");
  assert.equal(
    chart.children.filter((element) =>
      element.getAttribute("class") === "series-chart-line"
    ).length,
    0,
  );
  assert.match(chart.getAttribute("aria-label"), /score by Filename or layer/);
  chartType.value = "bar";
  chartType.dispatchEvent(new Event("change"));
  assert.match(chart.getAttribute("aria-label"), /score by Filename or layer/);
  const bars = chart.querySelectorAll(".series-chart-bar");
  assert.equal(bars.length, h.controller.pointElements.length);
  assert.ok(bars.length > 0);
  bars[0].dispatchEvent(new Event("click"));
  assert.equal(bars[0].getAttribute("aria-pressed"), "true");
  assert.equal(h.documentContext.querySelector("#vector-time-series-selection").hidden, false);
});

test("chart points identify observations and request selected-feature zoom", () => {
  const h = fixture();
  h.controller.setSample({
    state: "ready",
    observations: observations(),
    message: "Ready",
  });
  const chart = h.documentContext.querySelector("#vector-time-series-chart");
  const points = chart.querySelectorAll(".series-chart-point");
  points[0].dispatchEvent(new Event("click"));
  assert.equal(points[0].getAttribute("aria-pressed"), "true");
  assert.equal(
    h.documentContext.querySelector("#vector-time-series-selection").hidden,
    false,
  );
  assert.match(
    h.documentContext.querySelector("#vector-time-series-selection-text")
      .textContent,
    /risk-2\.shp · risk\.2a/,
  );
  const zoom = h.documentContext.querySelector(
    "#zoom-vector-time-series-feature",
  );
  zoom
    .dispatchEvent(new Event("click"));
  assert.deepEqual(h.zoomRequests, [focus(2, 1)]);

  const keyboardSelection = new Event("keydown", { cancelable: true });
  Object.defineProperty(keyboardSelection, "key", { value: "Enter" });
  points[2].dispatchEvent(keyboardSelection);
  assert.equal(keyboardSelection.defaultPrevented, true);
  assert.match(
    h.documentContext.querySelector("#vector-time-series-selection-text")
      .textContent,
    /risk-10\.shp/,
  );
  zoom.dispatchEvent(new Event("click"));
  assert.deepEqual(h.zoomRequests.at(-1), focus(10, 1, [9, 0, 11, 2]));
});

test("a new inspection sample clears the selected series point", () => {
  const h = fixture();
  h.controller.setSample({
    state: "ready",
    observations: observations(),
    message: "Ready",
  });
  const point = h.documentContext.querySelector("#vector-time-series-chart").querySelector(".series-chart-point");
  point.dispatchEvent(new Event("click"));
  h.controller.setSample({
    state: "empty",
    observations: [],
    message: "No features found.",
  });
  assert.equal(
    h.documentContext.querySelector("#vector-time-series-selection").hidden,
    true,
  );
  assert.equal(
    h.documentContext.querySelector("#zoom-vector-time-series-feature").disabled,
    true,
  );
});
