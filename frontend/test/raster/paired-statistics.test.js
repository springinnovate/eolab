import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateRasterPairedHistogramPercentile,
  findRasterPairedHistogramCell,
  getHighestDensityPairedCell,
  normalizeRasterPairedSamplingArea,
  validateRasterPairedStatisticsForSelection,
  WHOLE_RASTER_OVERLAP_SAMPLING_AREA,
} from "../../src/raster/paired-statistics.js";

test("paired marginal percentiles estimate independent axes and reject invalid input", () => {
  const statistics = pairedStatistics();
  const estimate = (axis, percentile) => estimateRasterPairedHistogramPercentile(statistics, axis, percentile);
  assert.equal(estimate("x", 0), 0);
  assert.equal(estimate("y", 100), 32);
  assert.equal(estimate("x", 50), 3 + 6 / 7);
  assert.equal(estimate("y", 50), 2 + 6 / 7);
  assert.equal(estimate("x", 95), 20 + (12 * .95 - 7) / 5);
  for (const percentile of [-1, 101, NaN, Infinity]) {
    assert.throws(() => estimate("x", percentile), /between 0 and 100/);
  }
  assert.throws(() => estimate("z", 50), /Unknown paired axis/);
  statistics.xMinimum = statistics.xMaximum = 8;
  for (const percentile of [0, 5, 50, 95, 100]) assert.equal(estimate("x", percentile), 8);
});

function pairedStatistics() {
  const size = 32;
  const counts = Array.from({ length: size }, () => Array(size).fill(0));
  counts[2][3] = 7;
  counts[10][20] = 5;
  return {
    scope: "wholeOverlap",
    selectedBounds: null,
    referenceGrid: "x",
    resampling: "nearest",
    sourceWidth: 8,
    sourceHeight: 4,
    sourcePixelCount: 32,
    sampleWidth: 8,
    sampleHeight: 4,
    sampledCellCount: 32,
    pairedSampleCount: 12,
    samplingMethod: "exactReferenceGrid",
    approximate: false,
    xMinimum: 0,
    xMaximum: 32,
    yMinimum: 0,
    yMaximum: 32,
    histogram: {
      xEdges: Array.from({ length: size + 1 }, (_, index) => index),
      yEdges: Array.from({ length: size + 1 }, (_, index) => index),
      counts,
      xMarginalCounts: Array.from(
        { length: size },
        (_, index) => index === 3 ? 7 : index === 20 ? 5 : 0,
      ),
      yMarginalCounts: Array.from(
        { length: size },
        (_, index) => index === 2 ? 7 : index === 10 ? 5 : 0,
      ),
    },
  };
}

test("paired statistics validate Y-major matrix totals and provenance", () => {
  const statistics = pairedStatistics();
  assert.equal(
    validateRasterPairedStatisticsForSelection(
      statistics,
      WHOLE_RASTER_OVERLAP_SAMPLING_AREA,
    ),
    statistics,
  );
  assert.deepEqual(findRasterPairedHistogramCell(statistics, 3.5, 2.5), {
    xBin: 3,
    yBin: 2,
  });
  assert.deepEqual(getHighestDensityPairedCell(statistics), {
    xBin: 3,
    yBin: 2,
    count: 7,
  });
});

test("paired areas accept only whole overlap or canonical selected bounds", () => {
  assert.equal(
    normalizeRasterPairedSamplingArea({ kind: "wholeOverlap" }),
    WHOLE_RASTER_OVERLAP_SAMPLING_AREA,
  );
  assert.throws(
    () => normalizeRasterPairedSamplingArea({
      kind: "temporaryAoi",
      temporaryAoiId: "A".repeat(32),
    }),
    /invalid/,
  );
  assert.throws(
    () => validateRasterPairedStatisticsForSelection(
      { ...pairedStatistics(), pairedSampleCount: 13 },
      WHOLE_RASTER_OVERLAP_SAMPLING_AREA,
    ),
    /histogram totals/,
  );
});
