import assert from "node:assert/strict";
import test from "node:test";

import {
  applyRasterColorPalette,
  buildRasterLegend,
  DEFAULT_RASTER_STYLE,
  deriveInitialRasterStyleFromStatistics,
  deriveRasterStyleFromStatistics,
  getRasterStyleColor,
  getRasterStyleOpacity,
  validateRasterStyle,
} from "../../src/raster/style.js";
import { DEFAULT_RASTER_PERCENTILES } from "../../src/raster/statistics.js";
import {
  RASTER_STATISTICS,
  SELECTED_RASTER_STATISTICS,
  TINY_RASTER_STATISTICS,
} from "../../test-support/raster/fixtures.js";

test("raster palettes preserve thresholds and drive the numeric legend", () => {
  const style = applyRasterColorPalette(
    { ...DEFAULT_RASTER_STYLE, midpoint: 25 },
    "viridis",
  );

  assert.deepEqual(style, {
    ...DEFAULT_RASTER_STYLE,
    minimum: 0,
    midpoint: 25,
    maximum: 100,
    minimumColor: "#440154",
    midpointColor: "#21918c",
    maximumColor: "#fde725",
  });
  assert.deepEqual(buildRasterLegend(style), {
    midpointPosition: 25,
    gradient:
      "linear-gradient(90deg, #440154 0%, #21918c 25%, #fde725 100%)",
    description:
      "Color ramp: 0 at #440154, 25 at #21918c, and 100 at #fde725.",
  });
});

test("per-color opacity interpolates at actual thresholds and clamps endpoints", () => {
  const style = { ...DEFAULT_RASTER_STYLE, midpoint: 20,
    minimumOpacity: 0, midpointOpacity: 0.4, maximumOpacity: 1 };
  assert.deepEqual([-10, 0, 10, 20, 60, 100, 150].map(value =>
    getRasterStyleOpacity(style, value)), [0, 0, 0.2, 0.4, 0.7, 1, 1]);
  const legacy = { ...style };
  for (const stop of ["minimum", "midpoint", "maximum"]) delete legacy[`${stop}Opacity`];
  assert.equal(getRasterStyleOpacity(legacy, 10), 1);
  assert.equal(validateRasterStyle(legacy), legacy);
  for (const value of [-0.1, 1.1, NaN, Infinity, -Infinity, "0.5", null]) {
    for (const stop of ["minimum", "midpoint", "maximum"]) {
      assert.throws(() => validateRasterStyle({ ...style, [`${stop}Opacity`]: value }),
        error => error.fieldGroup === "opacities");
    }
  }
});

test("palette and histogram-range edits preserve alpha and legends expose it", () => {
  const style = { ...DEFAULT_RASTER_STYLE,
    minimumOpacity: 0, midpointOpacity: 0.5, maximumOpacity: 1 };
  for (const result of [applyRasterColorPalette(style, "viridis"),
    deriveRasterStyleFromStatistics(style, RASTER_STATISTICS)]) {
    assert.deepEqual([result.minimumOpacity, result.midpointOpacity, result.maximumOpacity], [0, 0.5, 1]);
  }
  const legend = buildRasterLegend(style);
  assert.match(legend.gradient, /#2b83ba00 0%/);
  assert.match(legend.gradient, /#ffffbf80 50%/);
  assert.match(legend.gradient, /#d7191cff 100%/);
  assert.match(legend.description, /0%, 50%, 100%/);
  // Histogram colors remain readable even for transparent map values.
  assert.equal(getRasterStyleColor(style, 0), DEFAULT_RASTER_STYLE.minimumColor);
});

test("raster palettes reject names outside their fixed contract", () => {
  assert.throws(
    () => applyRasterColorPalette(DEFAULT_RASTER_STYLE, "constructor"),
    /Unknown raster palette/,
  );
});

test("raster histogram percentiles drive strict canonical styles", () => {
  assert.deepEqual(
    deriveRasterStyleFromStatistics(DEFAULT_RASTER_STYLE, RASTER_STATISTICS),
    {
      ...DEFAULT_RASTER_STYLE,
      minimum: -4,
      midpoint: 3,
      maximum: 20,
    },
  );
  assert.deepEqual(
    deriveRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      RASTER_STATISTICS,
      { lower: 0, middle: 25, upper: 100 },
    ),
    {
      ...DEFAULT_RASTER_STYLE,
      minimum: -10,
      midpoint: 0,
      maximum: 30,
    },
  );
  assert.throws(
    () => deriveRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      RASTER_STATISTICS,
      { lower: 50, middle: 50, upper: 95 },
    ),
    /in increasing order/,
  );
});

test("tiny raster suggestions preserve strict style ordering", () => {
  assert.deepEqual(
    deriveRasterStyleFromStatistics(DEFAULT_RASTER_STYLE, TINY_RASTER_STATISTICS),
    {
      ...DEFAULT_RASTER_STYLE,
      minimum: -0.0000001,
      midpoint: 0,
      maximum: 0.0000001,
    },
  );
});

test("late statistics never replace a manually edited style", () => {
  assert.deepEqual(
    deriveInitialRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      RASTER_STATISTICS,
      true,
    ),
    null,
  );
  assert.equal(
    deriveInitialRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      RASTER_STATISTICS,
      false,
    ).minimum,
    -4,
  );
});

test("histogram colors follow the committed three-stop raster ramp", () => {
  assert.equal(getRasterStyleColor(DEFAULT_RASTER_STYLE, -1), "#2b83ba");
  assert.equal(getRasterStyleColor(DEFAULT_RASTER_STYLE, 0), "#2b83ba");
  assert.equal(getRasterStyleColor(DEFAULT_RASTER_STYLE, 50), "#ffffbf");
  assert.equal(getRasterStyleColor(DEFAULT_RASTER_STYLE, 100), "#d7191c");
  assert.equal(getRasterStyleColor(DEFAULT_RASTER_STYLE, 101), "#d7191c");
  assert.equal(getRasterStyleColor(DEFAULT_RASTER_STYLE, 25), "#95c1bd");
});

test("selected histogram percentiles provide a rescaling range", () => {
  const selectedStatistics = {
    ...SELECTED_RASTER_STATISTICS,
    percentiles: { p05: 0.002, p50: 0.015, p95: 0.4 },
    suggestedRange: { minimum: 0.002, midpoint: 0.015, maximum: 0.4 },
  };

  assert.deepEqual(
    deriveRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      selectedStatistics,
      DEFAULT_RASTER_PERCENTILES,
    ),
    {
      ...DEFAULT_RASTER_STYLE,
      minimum: 0.002,
      midpoint: 0.015,
      maximum: 0.4,
    },
  );
});
