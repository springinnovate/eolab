import assert from "node:assert/strict";
import test from "node:test";

import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { renderOrdinalSeriesChart } from "../../src/charts/series-chart.js";
import { vectorInspectionObservation } from "../../src/vector/feature-inspector.js";
import { VectorTimeSeriesController } from "../../src/vector/time-series.js";

/**
 * Read a rendered bar's horizontal interval and vertical dimensions.
 * @param {Object} bar Rendered SVG rectangle.
 * @return {{left:number,right:number,y:number,height:number,width:number}} Screen-space geometry.
 */
function rectangle(bar) {
  const left = Number(bar.getAttribute("x"));
  const width = Number(bar.getAttribute("width"));
  return { left, right: left + width, width,
    y: Number(bar.getAttribute("y")), height: Number(bar.getAttribute("height")) };
}

/**
 * Require each bar to have its own horizontal pointer target.
 * @param {Object[]} bars Rendered rectangles, in any order.
 * @return {void}
 */
function assertSeparateBars(bars) {
  const intervals = bars.map(rectangle).sort((left, right) => left.left - right.left);
  for (const [index, interval] of intervals.entries()) {
    assert.ok(interval.width > 0 && interval.height > 0);
    if (index > 0) assert.ok(interval.left > intervals[index - 1].right,
      "each observation must have a distinct, unobscured horizontal interval");
  }
}

/**
 * Feed inspected features through the real observation producer and chart controller.
 * @param {{id:string,x:number|string,y:number}[]} rows Original feature values.
 * @return {Object} Rendered chart, controls, source observations and selected-feature navigation.
 */
function acrossFeatures(rows) {
  const documentContext = new FakeRasterControlDocument();
  const events = new EventTarget();
  documentContext.addEventListener = events.addEventListener.bind(events);
  documentContext.removeEventListener = events.removeEventListener.bind(events);
  const zooms = [];
  const observations = rows.map((row, index) => vectorInspectionObservation({
    target: { sourceId: "catalog:measurements", label: "Measurements" },
    feature: { id: row.id, properties: { visit: row.x, score: row.y }, bbox: [index, 0, index + 1, 1] },
    inspectionPosition: { lng: 0, lat: 0 },
  }));
  const controller = new VectorTimeSeriesController({ documentContext,
    onVisibilityChange() {}, onPresentationChange() {},
    onFeatureZoom: focus => { zooms.push(focus); return true; },
    onNavigateSelection() {},
  });
  controller.setSample({ state: "ready", observations, message: "" });
  controller.open();
  for (const [id, value] of [["x", "visit"], ["chart-type", "bar"]]) {
    const control = documentContext.querySelector(`#vector-time-series-${id}`);
    control.value = value;
    control.dispatchEvent(new Event("change"));
  }
  return { documentContext, controller, observations, zooms,
    chart: documentContext.querySelector("#vector-time-series-chart") };
}

for (const values of [[2, 8], [-2, -9], [-4, 6], [0, 8]]) {
  test(`duplicate numeric bars preserve separate targets, values and identities for ${values}`, () => {
    for (const order of [values, [...values].reverse()]) {
      const rows = [
        { id: "first", x: 2020, y: order[0] },
        { id: "second", x: 2020, y: order[1] },
        { id: "later", x: 2025, y: -3 },
      ];
      const f = acrossFeatures(rows);
      const bars = f.chart.querySelectorAll(".series-chart-bar");
      assert.equal(bars.length, 3);
      assertSeparateBars(bars);
      assert.equal(rectangle(bars[0]).width, 27, "duplicate observations split the existing group");
      assert.equal(rectangle(bars[2]).width, 54, "a unique observation keeps its original width");
      assert.equal(f.documentContext.querySelector("#vector-time-series-status").textContent, "");
      for (const [index, bar] of bars.entries()) {
        assert.match(bar.getAttribute("aria-label"), new RegExp(`Measurements · ${rows[index].id}`));
        const event = new Event("keydown", { cancelable: true });
        Object.defineProperty(event, "key", { value: "Enter" });
        bar.dispatchEvent(event);
        const selection = f.documentContext.querySelector("#vector-time-series-selection-text").textContent;
        assert.ok(selection.includes(`Measurements · ${rows[index].id}`));
        assert.ok(selection.includes(`score = ${rows[index].y}`));
        f.documentContext.querySelector("#zoom-vector-time-series-feature").dispatchEvent(new Event("click"));
        assert.deepEqual(f.zooms.at(-1), f.observations[index].focus);
      }
      const table = f.documentContext.querySelector("#vector-time-series-table-body");
      f.documentContext.querySelector("#vector-time-series-values-button").dispatchEvent(new Event("click"));
      assert.deepEqual(table.children.map(row => row.children.at(-1).children[0].textContent), rows.map(row => String(row.y)));
      f.controller.destroy();
    }
  });
}

/**
 * Render the shared chart contract without controller-specific settings.
 * @param {Object} options Chart inputs overriding the numeric-bar defaults.
 * @return {Object} Render result, SVG and DOM.
 */
function sharedChart(options) {
  const documentContext = new FakeRasterControlDocument();
  const chart = documentContext.querySelector("#vector-time-series-chart");
  const rendered = renderOrdinalSeriesChart({ documentContext, chart,
    chartType: "bar", xScale: "numeric", xAxisLabel: "Visit", yAxisLabel: "Score",
    ariaLabel: "Measurements", pointAccessibleLabel: point => `${point.xLabel}: ${point.yValue}`,
    pointTooltip: point => `${point.xLabel}: ${point.yValue}`, ...options });
  return { ...rendered, chart, documentContext };
}

/**
 * Build aligned series with explicit missing observations.
 * @param {number[]} positions Numeric coordinates in observation order.
 * @param {(number|null)[]} values Measurement at each coordinate.
 * @return {Object[]} Aligned chart points.
 */
function points(positions, values) {
  return positions.map((xValue, index) => ({ xValue, xLabel: String(xValue), yValue: values[index] }));
}

test("duplicate slots preserve multiseries alignment and missing values on either numeric axis direction", () => {
  for (const xReverse of [false, true]) {
    const result = sharedChart({ xReverse, series: [
      { id: "a", label: "A", points: points([4, 4, 8], [2, null, 7]) },
      { id: "b", label: "B", points: points([4, 4, 8], [null, 9, -3]) },
    ] });
    const bars = result.pointElements.map(item => item.circle);
    assertSeparateBars(bars);
    const [firstA, lastA, secondB, lastB] = bars.map(rectangle);
    assert.equal(firstA.width, 13.5);
    assert.equal(secondB.width, 13.5);
    assert.equal(secondB.left - firstA.left, 45, "missing A/B values reserve their existing aligned positions");
    assert.equal(lastA.width, 27);
    assert.equal(lastB.left - lastA.left, 30);
  }
});

test("all-equal and tightly spaced numeric coordinates retain distinct groups and exact data", () => {
  for (const positions of [[7, 7, 7], [0, 0, 0.01, 0.04], [1735689600000, 1735689600000, 1735776000000]]) {
    const observations = points(positions, positions.map((_, index) => index + 1));
    const result = sharedChart({ points: observations });
    assertSeparateBars(result.pointElements.map(item => item.circle));
    assert.deepEqual(result.pointElements.map(item => item.point), observations);
    if (positions[2] !== positions[0]) {
      const centers = result.pointElements.map(({ circle }) => Number(circle.getAttribute("cx")));
      assert.equal(centers[0], centers[1], "group position still represents the actual numeric coordinate");
      if (positions.length === 4) assert.ok(Math.abs((centers[3] - centers[2]) / (centers[2] - centers[1]) - 3) < 1e-12);
    }
  }
});

test("categorical dates stay separate, while equal-X line and scatter markers retain numeric alignment", () => {
  const f = acrossFeatures([
    { id: "a", x: "2025-01-01", y: 2 }, { id: "b", x: "2025-01-01", y: 8 },
    { id: "c", x: "2025-02-01", y: -3 },
  ]);
  const bars = f.chart.querySelectorAll(".series-chart-bar");
  assertSeparateBars(bars);
  assert.deepEqual(bars.map(bar => rectangle(bar).width), [54, 54, 54]);
  f.controller.destroy();
  for (const chartType of ["line", "scatter"]) {
    const result = sharedChart({ chartType, points: points([4, 4, 8], [2, 8, -3]) });
    assert.deepEqual(result.pointElements.map(({ circle }) => Number(circle.getAttribute("cx"))), [72, 72, 656]);
  }
});
