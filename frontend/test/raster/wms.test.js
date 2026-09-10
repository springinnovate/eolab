import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRasterStyleEnvironment,
} from "../../src/raster/wms.js";
import {
  DEFAULT_RASTER_STYLE,
  deriveRasterStyleFromStatistics,
} from "../../src/raster/style.js";
import {
  CONSTANT_RASTER_STATISTICS,
} from "../../test-support/raster/fixtures.js";

test("raster style builds the dynamic SLD environment contract", () => {
  assert.equal(
    buildRasterStyleEnvironment(DEFAULT_RASTER_STYLE),
    "min:0;med:50;max:100;cmin:#2b83ba;cmed:#ffffbf;" +
      "cmax:#d7191c;amin:1;amed:1;amax:1",
  );
});

test("raster style environment rejects invalid thresholds, colors, and alpha", () => {
  assert.throws(
    () => buildRasterStyleEnvironment({
      ...DEFAULT_RASTER_STYLE,
      minimum: NaN,
    }),
    /finite numbers/,
  );
  assert.throws(
    () => buildRasterStyleEnvironment({
      ...DEFAULT_RASTER_STYLE,
      midpoint: 100,
    }),
    /Minimum must be less/,
  );
  assert.throws(
    () => buildRasterStyleEnvironment({
      ...DEFAULT_RASTER_STYLE,
      maximumColor: "red",
    }),
    /six-digit hex/,
  );
});

test("WMS sends independent stop opacities, defaulting legacy styles to opaque", () => {
  const style = { ...DEFAULT_RASTER_STYLE, minimumOpacity: 0, midpointOpacity: 0.25 };
  assert.match(buildRasterStyleEnvironment(style), /;amin:0;amed:0.25;amax:1$/);
  delete style.minimumOpacity;
  delete style.midpointOpacity;
  delete style.maximumOpacity;
  assert.match(buildRasterStyleEnvironment(style), /;amin:1;amed:1;amax:1$/);
  assert.throws(() => buildRasterStyleEnvironment({ ...style, maximumOpacity: Infinity }), /opacity/);
});

test("constant raster suggestions build valid WMS environments", () => {
  assert.doesNotThrow(() => buildRasterStyleEnvironment(
    deriveRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      CONSTANT_RASTER_STATISTICS,
    ),
  ));
  assert.doesNotThrow(() => buildRasterStyleEnvironment(
    deriveRasterStyleFromStatistics(
      DEFAULT_RASTER_STYLE,
      CONSTANT_RASTER_STATISTICS,
      { lower: 10, middle: 50, upper: 90 },
    ),
  ));
});
