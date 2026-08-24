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

/** @type {Readonly<Object>} Fixed public bounds for sampled raster previews. */
export const RASTER_DETAIL_PREVIEW_LIMITS = Object.freeze({
  maximumSampleGridDimension: 127,
  maximumExactDetailDimension: 512,
  maximumSourceBlockReads: 16129,
  maximumDecodedSourceBytes: 9663676416,
  maximumTransformedPositions: 16129,
  maximumPointsPerCell: 1,
});

/** Exact fixed-grid values with a deterministic repeating color pattern. */
const FIXED_GRID_VALUES = Array.from(
  { length: 127 * 127 },
  (_, index) => [0, 50, 100, null, 25, 75][index % 6],
);

/** @type {Readonly<Object>} Full-extent center-per-cell numeric sample grid. */
export const CENTER_SAMPLE_DETAIL_PREVIEW = Object.freeze({
  scope: "rasterExtent",
  rendering: "sampleGrid",
  policyVersion: "bounded-adaptive-raster-v8",
  approximate: true,
  label: "Approximate full-extent sample grid using each preview cell's center",
  rasterExtent: [-123, 48, -121, 50],
  imageBounds: [-122.9, 48.1, -121.1, 49.9],
  imageWidth: 127,
  imageHeight: 127,
  pixelValues: FIXED_GRID_VALUES,
  suggestedRange: { minimum: 0, midpoint: 50, maximum: 100 },
  limits: RASTER_DETAIL_PREVIEW_LIMITS,
  actual: {
    sampleGridWidth: 127,
    sampleGridHeight: 127,
    sourceBlockReadCount: 6,
    decodedSourceBytes: 12288,
    pointsPerCell: 1,
  },
});

/** @type {Readonly<Object>} Finer sample grid for the current visible map area. */
export const CURRENT_VIEW_DETAIL_PREVIEW = Object.freeze({
  ...CENTER_SAMPLE_DETAIL_PREVIEW,
  scope: "currentView",
  label: "Approximate current-view sample grid using each map cell's center",
  imageBounds: [-122.5, 48.5, -121.5, 49.5],
  pixelValues: Array.from(
    { length: 127 * 127 },
    (_, index) => 10 + (index % 6) * 10,
  ),
});

/** @type {Readonly<Object>} Exact native detail for a safely close map view. */
export const EXACT_CURRENT_VIEW_DETAIL_PREVIEW = Object.freeze({
  ...CURRENT_VIEW_DETAIL_PREVIEW,
  rendering: "exactSourceWindow",
  label: "Exact bounded current-view source detail; not a whole-raster rendering",
  imageWidth: 4,
  imageHeight: 3,
  pixelValues: [10, 20, 30, 40, 20, 30, null, 50, 30, 40, 50, 60],
  limits: Object.freeze({
    ...RASTER_DETAIL_PREVIEW_LIMITS,
    maximumSourceBlockReads: 1024,
    maximumDecodedSourceBytes: 67108864,
  }),
  actual: {
    sampleGridWidth: 4,
    sampleGridHeight: 3,
    sourceBlockReadCount: 2,
    decodedSourceBytes: 40960,
    pointsPerCell: 0,
    sourceWindow: {
      columnOffset: 400,
      rowOffset: 250,
      width: 4,
      height: 3,
    },
  },
});

/** @type {Readonly<Object>} Honest all-nodata full-extent numeric sample grid. */
export const NODATA_DETAIL_PREVIEW = Object.freeze({
  ...CENTER_SAMPLE_DETAIL_PREVIEW,
  pixelValues: new Array(127 * 127).fill(null),
  suggestedRange: null,
});

/** @type {Readonly<Object>} Representative validated whole-raster statistics. */
export const RASTER_STATISTICS = Object.freeze({
  band: 1,
  scope: "wholeRaster",
  selectedBounds: null,
  sourceWidth: 1024,
  sourceHeight: 512,
  sourcePixelCount: 524288,
  sampleWidth: 127,
  sampleHeight: 63,
  sampledPixelCount: 8001,
  validSampleCount: 8000,
  samplingMethod: "sampleGrid",
  estimated: true,
  sampleMinimum: -10,
  sampleMaximum: 30,
  percentiles: { p05: -4, p50: 3, p95: 20 },
  histogram: {
    counts: new Array(64).fill(125),
    edges: Array.from({ length: 65 }, (_, index) => -10 + index * 0.625),
  },
  suggestedRange: { minimum: -4, midpoint: 3, maximum: 20 },
});

/** @type {Readonly<Object>} Representative exact bounded statistics. */
export const EXACT_RASTER_STATISTICS = Object.freeze({
  ...RASTER_STATISTICS,
  sourceWidth: 64,
  sourceHeight: 32,
  sourcePixelCount: 2048,
  sampleWidth: 64,
  sampleHeight: 32,
  sampledPixelCount: 2048,
  validSampleCount: 2048,
  samplingMethod: "exactSourceWindow",
  estimated: false,
  histogram: {
    ...RASTER_STATISTICS.histogram,
    counts: new Array(64).fill(32),
  },
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

/** @type {string} Representative opaque ready temporary-AOI identity. */
export const TEMPORARY_AOI_ID = "temporaryAoiIdentity012345678901";

/** @type {Readonly<Object>} Representative temporary-AOI statistics. */
export const TEMPORARY_AOI_RASTER_STATISTICS = Object.freeze({
  ...RASTER_STATISTICS,
  scope: "temporaryAoi",
  selectedBounds: null,
  temporaryAoiId: TEMPORARY_AOI_ID,
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
