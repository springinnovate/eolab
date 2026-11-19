import assert from "node:assert/strict";
import test from "node:test";

import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { renderOrdinalSeriesChart, renderStackedSeriesChart } from "../../src/charts/series-chart.js";

/**
 * Render points through the production SVG chart contract.
 *
 * @param {Object[]} points Chart points.
 * @param {"ordinal"|"numeric"} xScale Horizontal scale mode.
 * @return {number[]} Rendered circle X coordinates.
 */
function renderedXCoordinates(points, xScale) {
  const documentContext = new FakeRasterControlDocument();
  const chart = documentContext.querySelector("#vector-time-series-chart");
  renderOrdinalSeriesChart({
    documentContext,
    chart,
    points,
    chartType: "scatter",
    xScale,
    xAxisLabel: "Feature",
    yAxisLabel: "Value",
    ariaLabel: "Test chart",
    pointAccessibleLabel: (point) => point.xLabel,
    pointTooltip: (point) => point.xLabel,
  });
  return chart.children
    .filter((element) =>
      element.getAttribute("class") === "series-chart-point"
    )
    .map((element) => Number(element.getAttribute("cx")));
}

test("ordinal observations span the chart even when labels repeat", () => {
  const positions = renderedXCoordinates([
    { xLabel: "same layer", yValue: 1 },
    { xLabel: "same layer", yValue: 2 },
    { xLabel: "same layer", yValue: 3 },
  ], "ordinal");
  assert.deepEqual(positions, [72, 364, 656]);
});

test("compact plots reserve axis space for the displayed tick labels", () => {
  const axisPositions = [];
  for (const [label, fitXAxisLabels] of [["01", false], ["01", true], ["Long observation label", true]]) {
    const documentContext = new FakeRasterControlDocument();
    const chart = documentContext.querySelector("#vector-time-series-chart");
    const points = [{xLabel: label, yValue: 12}, {xLabel: "02", yValue: 28}];
    const rendered = renderOrdinalSeriesChart({
      documentContext, chart, points, fitXAxisLabels, width: 320, height: 218,
      chartType: "scatter", xAxisLabel: "Observation", yAxisLabel: "Value",
      ariaLabel: "Observations", pointAccessibleLabel: point => point.xLabel,
      pointTooltip: point => point.xLabel,
    });
    assert.deepEqual(rendered.yDomain, [12, 28]);
    const axis = chart.querySelector(".series-chart-x-axis");
    axisPositions.push(Number(axis.getAttribute("transform").match(/translate\(0 ([-\d.]+)\)/)[1]));
  }
  const [standard, shortLabels, longLabels] = axisPositions;
  assert.ok(shortLabels > standard, "short ticks leave more space for data in the dock");
  assert.ok(shortLabels > longLabels, "long ticks have room below the plotting area");
});

test("equal numeric observations share a safe centered coordinate", () => {
  const positions = renderedXCoordinates([
    { xValue: 7, xLabel: "7", yValue: 1 },
    { xValue: 7, xLabel: "7", yValue: 2 },
  ], "numeric");
  assert.deepEqual(positions, [364, 364]);
});

test("large numeric series retain complete domains for scatter and bar charts", () => {
  const points = Array.from({length: 200000}, (_, index) => ({
    xValue: index, xLabel: String(index), yValue: index % 17 - 8,
  }));
  for (const chartType of ["scatter", "bar"]) {
    const documentContext = new FakeRasterControlDocument();
    const chart = documentContext.querySelector("#vector-time-series-chart");
    const rendered = renderOrdinalSeriesChart({
      documentContext, chart, points, chartType, xScale: "numeric", xBounds: [0, 0.5],
      xAxisLabel: "Time", yAxisLabel: "Value", ariaLabel: "Large series",
      pointAccessibleLabel: point => point.xLabel, pointTooltip: point => point.xLabel,
    });
    assert.deepEqual(rendered.xDomain, [0, 0.5]);
    assert.deepEqual(rendered.yDomain, [-8, 8], "all observations contribute to the automatic Y domain");
    assert.equal(rendered.pointElements.length, 1, "custom bounds display only the first observation");
    if (chartType === "bar") {
      const barWidth = Number(rendered.pointElements[0].circle.getAttribute("width"));
      assert.ok(Number.isFinite(barWidth) && barWidth > 0);
    }
  }
});

test("horizontal stacks show signed field lengths and distinguish zero from missing", () => {
  const documentContext = new FakeRasterControlDocument();
  const chart = documentContext.querySelector("#vector-time-series-chart");
  const legend = documentContext.createElement("ul");
  const series = [
    ["Forest", [2.5, 1.5, 0, null]],
    ["Grassland", [5, null, null, null]],
    ["Wetland", [-3, -8, 0, null]],
  ].map(([field, values]) => ({
    id: field, label: field, points: values.map(yValue => ({yValue})),
  }));
  const selections = [];
  const {pointElements} = renderStackedSeriesChart({
    documentContext, chart, legend, series, rowLabels: ["Same", "Same", "Zero", "Unknown"],
    valueAxisLabel: "Area (ha)", ariaLabel: "Stacked area",
    describePoint: (point, field) => `${field}: ${point.yValue} ha`,
    onPointSelect: (point, field) => selections.push([point.yValue, field]),
  });
  const [forest, grassland, wetland, nextForest, nextWetland] = pointElements.map(item => item.circle);
  const zero = Number(chart.querySelector(".series-chart-zero").getAttribute("x1"));
  const readX = element => Number(element.getAttribute("x"));
  const width = element => Number(element.getAttribute("width"));
  assert.equal(readX(forest), zero);
  assert.equal(readX(grassland), zero + width(forest));
  assert.ok(Math.abs(width(grassland) - 2 * width(forest)) < 1e-8);
  assert.ok(Math.abs(readX(wetland) + width(wetland) - zero) < 1e-8);
  assert.ok(readX(nextWetland) < readX(wetland));
  assert.equal(forest.getAttribute("y"), grassland.getAttribute("y"));
  assert.notEqual(forest.getAttribute("y"), nextForest.getAttribute("y"));
  assert.equal(forest.getAttribute("style"), nextForest.getAttribute("style"));
  assert.equal(forest.getAttribute("style"), legend.children[0].getAttribute("style"));
  assert.deepEqual(chart.querySelectorAll(".series-chart-empty-stack").map(label => label.textContent),
    ["0", "No values"]);
  const enter = Object.assign(new Event("keydown", {cancelable: true}), {key: "Enter"});
  wetland.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(selections, [[-3, "Wetland"]]);
});

test("very large stacked readings keep finite SVG positions and label their scale", () => {
  const documentContext = new FakeRasterControlDocument();
  const chart = documentContext.querySelector("#vector-time-series-chart");
  const {pointElements} = renderStackedSeriesChart({
    documentContext, chart, legend: documentContext.createElement("ul"),
    series: ["First", "Second"].map(label => ({id: label, label, points: [{yValue: Number.MAX_VALUE}]})),
    rowLabels: ["Feature"], valueAxisLabel: "Value", ariaLabel: "Large readings",
    describePoint: point => String(point.yValue), onPointSelect: () => {},
  });
  assert.equal(pointElements.length, 2);
  for (const {circle} of pointElements) {
    assert.ok(Number.isFinite(Number(circle.getAttribute("x"))));
    assert.ok(Number(circle.getAttribute("width")) > 0);
    assert.equal(circle.getAttribute("aria-label"), String(Number.MAX_VALUE));
  }
  assert.equal(chart.querySelector(".series-chart-axis-title").textContent, "Value (×10^308)");
});
