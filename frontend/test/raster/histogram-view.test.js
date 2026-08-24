import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const bars = chart.children.filter(
    (child) => child.classNames.includes("raster-histogram-bar"),
  );
  const tooltip = chart.children.find(
    (child) => child.classNames.includes("raster-histogram-tooltip"),
  );
  assert.equal(bars.length, 64);
  assert.ok(bars.every(
    (bar) => bar.tagName === "rect" &&
      bar.classNames.includes("raster-histogram-bar") &&
      bar.children.length === 0 &&
      bar.attributes.get("aria-label").includes("Bin midpoint") &&
      bar.attributes.get("aria-label").includes("1.56% of the valid sample") &&
      /^#[0-9a-f]{6}$/.test(bar.style.fill),
  ));
  assert.equal(tooltip.tagName, "g");
  assert.equal(tooltip.hasAttribute("hidden"), true);
  assert.deepEqual(
    tooltip.children.map((child) => child.tagName),
    ["rect", "text"],
  );

  bars[0].dispatchEvent(new Event("pointerenter"));
  assert.equal(bars[0].classList.contains("is-hovered"), true);
  assert.equal(tooltip.hasAttribute("hidden"), false);
  assert.equal(tooltip.attributes.get("transform"), "translate(4 4)");
  assert.match(tooltip.children[1].textContent, /-1\.000e\+1–-9\.375e\+0/);
  assert.match(tooltip.children[1].textContent, /125 pixels · 1\.56%/);

  bars[63].dispatchEvent(new Event("pointerenter"));
  assert.equal(bars[0].classList.contains("is-hovered"), false);
  assert.equal(bars[63].classList.contains("is-hovered"), true);
  assert.equal(tooltip.attributes.get("transform"), "translate(336 4)");
  bars[0].dispatchEvent(new Event("pointerleave"));
  assert.equal(tooltip.hasAttribute("hidden"), false);
  bars[63].dispatchEvent(new Event("pointerleave"));
  assert.equal(bars[63].classList.contains("is-hovered"), false);
  assert.equal(tooltip.hasAttribute("hidden"), true);

  clearRasterHistogramChart(chart);
  assert.equal(chart.hasAttribute("hidden"), true);
  assert.equal(chart.children.length, 0);
});

test("raster histogram hover styles emphasize only the active bar", () => {
  const stylesheet = readFileSync(
    new URL("../../src/style.css", import.meta.url),
    "utf8",
  );

  assert.match(
    stylesheet,
    /\.raster-histogram-bar\.is-hovered\s*\{[^}]*opacity:\s*1[^}]*stroke:/s,
  );
  assert.match(
    stylesheet,
    /\.raster-histogram-tooltip\[hidden\]\s*\{[^}]*display:\s*none/s,
  );
  assert.match(
    stylesheet,
    /\.raster-histogram-tooltip\s*\{[^}]*pointer-events:\s*none/s,
  );
});
