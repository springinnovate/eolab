import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RASTER_PERCENTILES,
  estimateRasterHistogramPercentile,
  rasterStatisticsMatchesSelection,
  validateRasterStatistics,
} from "../../src/raster/statistics.js";
import {
  CONSTANT_RASTER_STATISTICS,
  RASTER_STATISTICS,
  SELECTED_BOUNDS,
  SELECTED_RASTER_STATISTICS,
  TEMPORARY_AOI_ID,
  TEMPORARY_AOI_RASTER_STATISTICS,
} from "../../test-support/raster/fixtures.js";

test("raster statistics validate their fixed bounded response contract", () => {
  assert.equal(validateRasterStatistics(RASTER_STATISTICS), RASTER_STATISTICS);
  assert.deepEqual(
    validateRasterStatistics(SELECTED_RASTER_STATISTICS),
    SELECTED_RASTER_STATISTICS,
  );
  assert.equal(
    validateRasterStatistics(TEMPORARY_AOI_RASTER_STATISTICS),
    TEMPORARY_AOI_RASTER_STATISTICS,
  );

  assert.throws(
    () => validateRasterStatistics({
      ...RASTER_STATISTICS,
      sourcePixelCount: 1,
    }),
    /invalid sample counts/,
  );
  assert.throws(
    () => validateRasterStatistics({
      ...RASTER_STATISTICS,
      histogram: {
        ...RASTER_STATISTICS.histogram,
        counts: new Array(64).fill(1),
      },
    }),
    /invalid histogram counts/,
  );
  assert.throws(
    () => validateRasterStatistics({
      ...RASTER_STATISTICS,
      suggestedRange: { minimum: 1, midpoint: 1, maximum: 2 },
    }),
    /invalid suggested range/,
  );
  assert.throws(
    () => validateRasterStatistics({
      ...RASTER_STATISTICS,
      selectedBounds: SELECTED_BOUNDS,
    }),
    /invalid whole-raster scope/,
  );
  assert.throws(
    () => validateRasterStatistics({
      ...SELECTED_RASTER_STATISTICS,
      selectedBounds: { ...SELECTED_BOUNDS, west: 179, east: -179 },
    }),
    /invalid selected bounds/,
  );
  assert.throws(
    () => validateRasterStatistics({
      ...TEMPORARY_AOI_RASTER_STATISTICS,
      temporaryAoiId: "../../server-file",
    }),
    /invalid temporary-AOI scope/,
  );
});

test("raster statistics apply only to their current whole or selected scope", () => {
  const otherBounds = { ...SELECTED_BOUNDS, west: -120, east: -118 };

  assert.equal(rasterStatisticsMatchesSelection(RASTER_STATISTICS, null), true);
  assert.equal(
    rasterStatisticsMatchesSelection(RASTER_STATISTICS, SELECTED_BOUNDS),
    false,
  );
  assert.equal(
    rasterStatisticsMatchesSelection(SELECTED_RASTER_STATISTICS, SELECTED_BOUNDS),
    true,
  );
  assert.equal(
    rasterStatisticsMatchesSelection(SELECTED_RASTER_STATISTICS, otherBounds),
    false,
  );
  assert.equal(
    rasterStatisticsMatchesSelection(
      TEMPORARY_AOI_RASTER_STATISTICS,
      null,
      TEMPORARY_AOI_ID,
    ),
    true,
  );
  assert.equal(
    rasterStatisticsMatchesSelection(
      TEMPORARY_AOI_RASTER_STATISTICS,
      null,
      `X${TEMPORARY_AOI_ID.slice(1)}`,
    ),
    false,
  );
});

test("raster histogram percentiles remain monotonic across the sample", () => {
  assert.equal(DEFAULT_RASTER_PERCENTILES.lower, 5);
  assert.equal(estimateRasterHistogramPercentile(RASTER_STATISTICS, 5), -4);
  assert.equal(estimateRasterHistogramPercentile(RASTER_STATISTICS, 25), 0);
  assert.equal(estimateRasterHistogramPercentile(RASTER_STATISTICS, 95), 20);
  assert.equal(
    estimateRasterHistogramPercentile(CONSTANT_RASTER_STATISTICS, 25),
    7,
  );

  const estimates = Array.from(
    { length: 101 },
    (_, percentile) => estimateRasterHistogramPercentile(
      RASTER_STATISTICS,
      percentile,
    ),
  );
  assert.ok(estimates.slice(1).every(
    (estimate, index) => estimate >= estimates[index],
  ));
});
