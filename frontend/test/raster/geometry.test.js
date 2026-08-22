import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRasterSampleWindowBounds,
  DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
  isCanonicalWgs84Position,
  validateRasterSampleWindowSize,
  validateRasterSelectedBounds,
} from "../../src/raster/geometry.js";

test("canonical WGS 84 positions stay inside the single map world", () => {
  assert.equal(
    isCanonicalWgs84Position({ longitude: -180, latitude: -90 }),
    true,
  );
  assert.equal(
    isCanonicalWgs84Position({ longitude: 180, latitude: 90 }),
    true,
  );
  assert.equal(
    isCanonicalWgs84Position({ longitude: 180.001, latitude: 0 }),
    false,
  );
  assert.equal(
    isCanonicalWgs84Position({ longitude: 0, latitude: -90.001 }),
    false,
  );
  assert.equal(
    isCanonicalWgs84Position({ longitude: Number.NaN, latitude: 0 }),
    false,
  );
  assert.equal(isCanonicalWgs84Position(null), false);
});

test("sample windows use ground distance instead of projected map metres", () => {
  const equatorial = buildRasterSampleWindowBounds(
    { longitude: 0, latitude: 0 },
    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
  );
  const highLatitude = buildRasterSampleWindowBounds(
    { longitude: 0, latitude: 60 },
    DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM,
  );

  assert.ok(Math.abs(equatorial.south + 0.8993) < 0.01);
  assert.ok(Math.abs(equatorial.north - 0.8993) < 0.01);
  assert.ok(Math.abs(equatorial.west + 0.8994) < 0.01);
  assert.ok(Math.abs(equatorial.east - 0.8994) < 0.01);
  assert.ok(highLatitude.east - highLatitude.west > 3.5);
  assert.equal(validateRasterSelectedBounds(equatorial), equatorial);
});

test("sample window contract rejects invalid sizes and unsupported crossings", () => {
  assert.equal(validateRasterSampleWindowSize(1), 1);
  assert.equal(validateRasterSampleWindowSize(300), 300);
  assert.throws(() => validateRasterSampleWindowSize(0), /between 1 and 300/);
  assert.throws(() => validateRasterSampleWindowSize(1.5), /between 1 and 300/);
  assert.throws(
    () => buildRasterSampleWindowBounds(
      { longitude: 179.5, latitude: 0 },
      200,
    ),
    /pole or date line/,
  );
  assert.throws(
    () => buildRasterSampleWindowBounds(
      { longitude: 0, latitude: 89.5 },
      200,
    ),
    /pole or date line/,
  );
});
