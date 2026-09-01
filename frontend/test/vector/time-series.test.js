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
      layerLabel: "risk-10.shp",
      featureId: "risk.10a",
      properties: Object.freeze({ year: 2010, score: 8, group: "east" }),
    }),
    Object.freeze({
      layerLabel: "risk-2.shp",
      featureId: "risk.2a",
      properties: Object.freeze({ year: 2002, score: 3, group: "west" }),
    }),
    Object.freeze({
      layerLabel: "risk-2.shp",
      featureId: "risk.2b",
      properties: Object.freeze({ year: 2002, score: 5, group: "west" }),
    }),
    Object.freeze({
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
  documentContext.querySelector("#vector-time-series-chart").hidden = true;
  documentContext.querySelector("#vector-time-series-table").hidden = true;
  const visibility = [];
  const controller = new VectorTimeSeriesController({
    documentContext,
    onVisibilityChange: (visible, moveFocus) => {
      visibility.push({ visible, moveFocus });
      documentContext.querySelector("#vector-time-series").hidden = !visible;
    },
  });
  return { controller, documentContext, visibility };
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
    ascending.points.map((point) => [point.layerLabel, point.yValue]),
    [
      ["risk-2.shp", 3],
      ["risk-2.shp", 5],
      ["risk-10.shp", 8],
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
  assert.equal(chart.hidden, false);
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
    h.documentContext.querySelector("#vector-time-series-chart").hidden,
    true,
  );
  assert.equal(
    h.documentContext.querySelector("#vector-time-series-status").textContent,
    "Visible vector layers changed. Click the map to sample again.",
  );
  assert.equal(h.controller.settings.yField, "score");
});
