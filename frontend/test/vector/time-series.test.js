import assert from "node:assert/strict";
import test from "node:test";

import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import {
  buildVectorTimeSeriesSeries,
  summarizeVectorTimeSeriesFields,
  VECTOR_TIME_SERIES_LAYER_LABEL,
  VectorTimeSeriesController,
} from "../../src/vector/time-series.js";

function observations() {
  return [
    Object.freeze({
      sourceId: "catalog|risk-10",
      layerLabel: "risk-10.shp",
      featureId: "risk.10a",
      properties: Object.freeze({ year: 2010, score: 8, group: "east" }),
    }),
    Object.freeze({
      sourceId: "catalog|risk-2",
      layerLabel: "risk-2.shp",
      featureId: "risk.2a",
      properties: Object.freeze({ year: 2002, score: 3, group: "west" }),
    }),
    Object.freeze({
      sourceId: "catalog|risk-2",
      layerLabel: "risk-2.shp",
      featureId: "risk.2b",
      properties: Object.freeze({ year: 2002, score: 5, group: "west" }),
    }),
    Object.freeze({
      sourceId: "catalog|risk-11",
      layerLabel: "risk-11.shp",
      featureId: "risk.11a",
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
  const zoomRequests = [];
  const controller = new VectorTimeSeriesController({
    documentContext,
    onVisibilityChange: (visible, moveFocus) => {
      visibility.push({ visible, moveFocus });
      documentContext.querySelector("#vector-time-series").hidden = !visible;
    },
    onSourceLayerZoom: (sourceId) => {
      zoomRequests.push(sourceId);
      return true;
    },
  });
  return { controller, documentContext, visibility, zoomRequests };
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
test("every inspection result is a distinct naturally ordered point", () => {
  const ascending = buildVectorTimeSeriesSeries(observations(), {
    xField: VECTOR_TIME_SERIES_LAYER_LABEL,
    yField: "score",
    direction: "ascending",
  });
  assert.deepEqual(
    ascending.points.map((point) => [
      point.sourceId,
      point.layerLabel,
      point.yValue,
    ]),
    [
      ["catalog|risk-2", "risk-2.shp", 3],
      ["catalog|risk-2", "risk-2.shp", 5],
      ["catalog|risk-10", "risk-10.shp", 8],
    ],
  );
  assert.equal(ascending.omitted, 1);
  const descending = buildVectorTimeSeriesSeries(observations(), {
    xField: "year",
    yField: "score",
    direction: "descending",
  });
  assert.deepEqual(
    descending.points.map((point) => [point.xValue, point.yValue]),
    [[2010, 8], [2002, 3], [2002, 5]],
  );
});

test("controller renders axes and table while retaining controls across samples", () => {
  const h = fixture();
  h.controller.setSample({
    state: "ready",
    observations: observations(),
    message: "4 features found.",
  });
  h.controller.open();
  const chart = h.documentContext.querySelector("#vector-time-series-chart");
  const table = h.documentContext.querySelector("#vector-time-series-table");
  assert.equal(chart.getAttribute("hidden"), null);
  assert.equal(chart.getAttribute("viewBox"), "0 0 680 360");
  assert.match(chart.getAttribute("aria-label"), /score by filename or layer/);
  assert.equal(table.hidden, false);
  assert.equal(
    h.documentContext.querySelector("#vector-time-series-table-body").children.length,
    3,
  );
  assert.equal(
    h.documentContext.querySelector("#vector-time-series-status").textContent,
    "3 of 4 inspection results plotted. 1 omitted because a selected field was missing or the Y value was not numeric.",
  );

  const x = h.documentContext.querySelector("#vector-time-series-x");
  const y = h.documentContext.querySelector("#vector-time-series-y");
  const direction = h.documentContext.querySelector(
    "#vector-time-series-direction"
  );
  x.value = "year";
  y.value = "year";
  direction.value = "descending";
  direction.dispatchEvent(new Event("change"));
  h.controller.setSample({
    state: "ready",
    observations: [Object.freeze({
      sourceId: "catalog|later",
      layerLabel: "later.shp",
      featureId: "later.1",
      properties: Object.freeze({ other: 4 }),
    })],
    message: "1 feature found.",
  });
  assert.equal(x.value, "year");
  assert.equal(y.value, "year");
  assert.equal(direction.value, "descending");
  assert.match(
    h.documentContext.querySelector("#vector-time-series-status").textContent,
    /No inspection result has both year and a finite year value/,
  );
  assert.deepEqual(h.visibility, [{ visible: true, moveFocus: false }]);
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
  assert.equal(h.controller.settings.yField, "score");
});

test("scatter mode preserves points and omits the connecting line", () => {
  const h = fixture();
  h.controller.setSample({
    state: "ready",
    observations: observations(),
    message: "Ready",
  });
  const chart = h.documentContext.querySelector("#vector-time-series-chart");
  assert.equal(
    chart.children.filter((element) =>
      element.getAttribute("class") === "vector-time-series-line"
    ).length,
    1,
  );

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
      element.getAttribute("class") === "vector-time-series-line"
    ).length,
    0,
  );
  assert.match(chart.getAttribute("aria-label"), /Vector series scatter chart/);
});

test("chart points identify observations and request source-layer zoom", () => {
  const h = fixture();
  h.controller.setSample({
    state: "ready",
    observations: observations(),
    message: "Ready",
  });
  const chart = h.documentContext.querySelector("#vector-time-series-chart");
  const points = chart.children.filter((element) =>
    element.getAttribute("class") === "vector-time-series-point"
  );
  points[0].dispatchEvent(new Event("click"));
  assert.equal(points[0].getAttribute("aria-pressed"), "true");
  assert.equal(
    h.documentContext.querySelector("#vector-time-series-selection").hidden,
    false,
  );
  assert.match(
    h.documentContext.querySelector("#vector-time-series-selection-text")
      .textContent,
    /Source layer: risk-2\.shp · Feature: risk\.2a/,
  );
  h.documentContext.querySelector("#zoom-vector-time-series-source")
    .dispatchEvent(new Event("click"));
  assert.deepEqual(h.zoomRequests, ["catalog|risk-2"]);

  const keyboardSelection = new Event("keydown", { cancelable: true });
  Object.defineProperty(keyboardSelection, "key", { value: "Enter" });
  points[2].dispatchEvent(keyboardSelection);
  assert.equal(keyboardSelection.defaultPrevented, true);
  assert.match(
    h.documentContext.querySelector("#vector-time-series-selection-text")
      .textContent,
    /risk-10\.shp/,
  );
});

test("a new inspection sample clears the selected series point", () => {
  const h = fixture();
  h.controller.setSample({
    state: "ready",
    observations: observations(),
    message: "Ready",
  });
  const point = h.documentContext.querySelector("#vector-time-series-chart")
    .children.find((element) =>
      element.getAttribute("class") === "vector-time-series-point"
    );
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
    h.documentContext.querySelector("#zoom-vector-time-series-source").disabled,
    true,
  );
});
