import assert from "node:assert/strict";
import test from "node:test";

import {
  BIVARIATE_RASTER_PALETTES,
  BivariateRasterMode,
  blendAdditiveRgb,
  createBivariateColormap,
  getBivariateAxisStyles,
  getBivariateDensityWeight,
  getBivariateHistogramCellColor,
} from "../../src/raster/bivariate.js";

const STYLE = Object.freeze({
  minimum: 0,
  midpoint: 50,
  maximum: 100,
  minimumColor: "#111111",
  midpointColor: "#777777",
  maximumColor: "#eeeeee",
});

test("coordinated ramps override alpha without mutating ordinary styles", () => {
  const ordinary = { ...STYLE, minimumOpacity: 0, midpointOpacity: 0.25, maximumOpacity: 0.5 };
  const { xStyle, yStyle } = getBivariateAxisStyles("orangeBlue", ordinary, ordinary);
  for (const style of [xStyle, yStyle]) {
    assert.deepEqual([style.minimumOpacity, style.midpointOpacity, style.maximumOpacity], [1, 1, 1]);
  }
  assert.deepEqual([ordinary.minimumOpacity, ordinary.midpointOpacity, ordinary.maximumOpacity], [0, 0.25, 0.5]);
});

test("bivariate palettes preserve the eight ESOS-C definitions", () => {
  assert.deepEqual(BIVARIATE_RASTER_PALETTES, {
    orangeBlue: {
      label: "Orange / Blue",
      baseRamp: ["#000000", "#ff8000", "#ffcc00"],
      lightenerColor: "#00ffff",
      strength: 1,
    },
    grayWhite: {
      label: "Gray / White",
      baseRamp: ["#222222", "#777777", "#dddddd"],
      lightenerColor: "#ffffff",
      strength: 1,
    },
    tealMagenta: {
      label: "Teal / Magenta",
      baseRamp: ["#003333", "#00b3b3", "#00ffff"],
      lightenerColor: "#ff66cc",
      strength: 0.9,
    },
    greenPurple: {
      label: "Green / Purple",
      baseRamp: ["#003300", "#66aa55", "#ccff99"],
      lightenerColor: "#aa55ff",
      strength: 1,
    },
    redCyan: {
      label: "Red / Cyan",
      baseRamp: ["#220000", "#cc3333", "#ff6666"],
      lightenerColor: "#00ffff",
      strength: 0.8,
    },
    indigoGold: {
      label: "Indigo / Gold",
      baseRamp: ["#1a0033", "#4b33cc", "#ccbb33"],
      lightenerColor: "#ffef99",
      strength: 1,
    },
    brownSky: {
      label: "Brown / Sky",
      baseRamp: ["#332211", "#996633", "#ffcc66"],
      lightenerColor: "#66ccff",
      strength: 1,
    },
    steelRose: {
      label: "Steel / Rose",
      baseRamp: ["#111827", "#3b82f6", "#93c5fd"],
      lightenerColor: "#f472b6",
      strength: 1,
    },
  });
});

test("axis ramps and additive colors derive from one ESOS-C surface", () => {
  const palette = BIVARIATE_RASTER_PALETTES.orangeBlue;
  const color = createBivariateColormap(palette);
  const { xStyle, yStyle } = getBivariateAxisStyles(
    "orangeBlue",
    STYLE,
    STYLE,
  );

  assert.deepEqual(
    [xStyle.minimumColor, xStyle.midpointColor, xStyle.maximumColor],
    [color(0, 0), color(0.5, 0), color(1, 0)],
  );
  assert.deepEqual(
    [yStyle.minimumColor, yStyle.midpointColor, yStyle.maximumColor],
    [color(0, 0), color(0, 0.5), color(0, 1)],
  );
  assert.equal(blendAdditiveRgb("#ff8000", "#00ffff"), "#ffffff");
});

test("histogram density uses ESOS-C log smoothstep gamma and HSL anchors", () => {
  assert.equal(getBivariateDensityWeight(0, 100), 0);
  assert.equal(getBivariateDensityWeight(100, 100), 1);
  assert.ok(getBivariateDensityWeight(1, 100) > 0);
  assert.ok(getBivariateDensityWeight(1, 100) < 1);
  assert.match(
    getBivariateHistogramCellColor("#80a0c0", 0.5),
    /^rgb\(\d+,\d+,\d+\)$/,
  );
});

test("bivariate mode requires exactly two roles and swaps deterministically", () => {
  const mode = new BivariateRasterMode();
  assert.throws(() => mode.enter(["only-one"]), /exactly two/);
  mode.enter(["top", "bottom"]);
  assert.equal(mode.contains("top"), true);
  assert.deepEqual([mode.xKey, mode.yKey], ["top", "bottom"]);
  mode.swap();
  assert.deepEqual([mode.xKey, mode.yKey], ["bottom", "top"]);
  mode.setPalette("steelRose");
  assert.equal(mode.paletteName, "steelRose");
  assert.throws(() => mode.setPalette("invented"), /Unknown bivariate/);
  mode.leave();
  assert.equal(mode.active, false);
});
