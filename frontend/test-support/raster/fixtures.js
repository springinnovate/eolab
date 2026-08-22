/** @type {Readonly<Object>} Mounted GeoTIFF Item shared by frontend tests. */
export const MOUNTED_GEOTIFF_ITEM = Object.freeze({
  collection: "eolab-mounted-geotiffs",
  id: "geotiff-0123456789abcdef01234567",
  assets: {
    data: {
      href: "file:///scan-source/folder/annual%20temperature.tif",
    },
  },
});

/** @type {Readonly<Object>} Representative validated whole-raster statistics. */
export const RASTER_STATISTICS = Object.freeze({
  band: 1,
  scope: "wholeRaster",
  selectedBounds: null,
  sourceWidth: 1024,
  sourceHeight: 512,
  sourcePixelCount: 524288,
  sampleWidth: 512,
  sampleHeight: 256,
  sampledPixelCount: 131072,
  validSampleCount: 128000,
  estimated: true,
  sampleMinimum: -10,
  sampleMaximum: 30,
  percentiles: { p05: -4, p50: 3, p95: 20 },
  histogram: {
    counts: [2000, ...new Array(63).fill(2000)],
    edges: Array.from({ length: 65 }, (_, index) => -10 + index * 0.625),
  },
  suggestedRange: { minimum: -4, midpoint: 3, maximum: 20 },
});

/** @type {Readonly<Object>} Representative canonical selected-area bounds. */
export const SELECTED_BOUNDS = Object.freeze({
  west: -123,
  south: 48,
  east: -121,
  north: 50,
});

/** @type {Readonly<Object>} Statistics associated with SELECTED_BOUNDS. */
export const SELECTED_RASTER_STATISTICS = Object.freeze({
  ...RASTER_STATISTICS,
  scope: "selectedArea",
  selectedBounds: SELECTED_BOUNDS,
});

/** @type {Readonly<Object>} Constant-value raster statistics. */
export const CONSTANT_RASTER_STATISTICS = Object.freeze({
  ...RASTER_STATISTICS,
  sampleMinimum: 7,
  sampleMaximum: 7,
  percentiles: { p05: 7, p50: 7, p95: 7 },
  suggestedRange: { minimum: 6.999993, midpoint: 7, maximum: 7.000007 },
});

/** @type {Readonly<Object>} Very-small-value raster statistics. */
export const TINY_RASTER_STATISTICS = Object.freeze({
  ...RASTER_STATISTICS,
  sampleMinimum: -0.0000002,
  sampleMaximum: 0.0000003,
  percentiles: { p05: -0.0000001, p50: 0, p95: 0.0000001 },
  suggestedRange: {
    minimum: -0.0000001,
    midpoint: 0,
    maximum: 0.0000001,
  },
});
