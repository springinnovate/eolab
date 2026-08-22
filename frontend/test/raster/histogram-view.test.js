import assert from "node:assert/strict";
import test from "node:test";

import {
  clearRasterHistogramChart,
  renderRasterHistogramChart,
} from "../../src/raster/histogram-view.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";
import {
  FAKE_SVG_DOCUMENT,
  FakeSvgElement,
} from "../../test-support/raster/fakes.js";
import { RASTER_STATISTICS } from "../../test-support/raster/fixtures.js";

test("raster histogram rendering displays all 64 SVG bars", () => {
  const chart = new FakeSvgElement("svg");
  chart.setAttribute("hidden", "");

  renderRasterHistogramChart(
    chart,
    RASTER_STATISTICS,
    DEFAULT_RASTER_STYLE,
    FAKE_SVG_DOCUMENT,
  );

  assert.equal(chart.hasAttribute("hidden"), false);
  assert.equal(chart.children[0].tagName, "title");
  assert.equal(chart.children.slice(1).length, 64);
  assert.ok(chart.children.slice(1).every(
    (bar) => bar.tagName === "rect" &&
      bar.classNames.includes("raster-histogram-bar") &&
      bar.children[0].tagName === "title" &&
      bar.children[0].textContent.includes("Bin midpoint") &&
      bar.children[0].textContent.includes("1.56% of the valid sample") &&
      /^#[0-9a-f]{6}$/.test(bar.style.fill),
  ));

  clearRasterHistogramChart(chart);
  assert.equal(chart.hasAttribute("hidden"), true);
  assert.equal(chart.children.length, 0);
});
