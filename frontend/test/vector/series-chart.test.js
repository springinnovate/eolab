import assert from "node:assert/strict";
import test from "node:test";

import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { renderOrdinalSeriesChart } from "../../src/vector/series-chart.js";

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

test("equal numeric observations share a safe centered coordinate", () => {
  const positions = renderedXCoordinates([
    { xValue: 7, xLabel: "7", yValue: 1 },
    { xValue: 7, xLabel: "7", yValue: 2 },
  ], "numeric");
  assert.deepEqual(positions, [364, 364]);
});
