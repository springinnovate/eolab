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
  maximumProxyDimension: 127,
  maximumSourceBlockReads: 1024,
  maximumDecodedSourceBytes: 9663676416,
  maximumTransformedPositions: 80645,
  maximumPointsPerCell: 5,
  maximumPatchDimension: 128,
  maximumPatchCandidates: 9,
});

/** Exact coarse-grid values with a deterministic repeating color pattern. */
const COARSE_GRID_VALUES = Array.from(
  { length: 31 * 31 },
  (_, index) => [0, 50, 100, null, 25, 75][index % 6],
);

/** @type {Readonly<Object>} Full-extent center-per-cell numeric proxy. */
export const CENTER_SAMPLE_DETAIL_PREVIEW = Object.freeze({
  mode: "centerSample",
  scope: "rasterExtent",
  density: "coarse",
  policyVersion: "bounded-sampled-raster-v4",
  approximate: true,
  label: "Approximate full-extent proxy using each preview cell's center",
  rasterExtent: [-123, 48, -121, 50],
  imageBounds: [-122.9, 48.1, -121.1, 49.9],
  imageWidth: 31,
  imageHeight: 31,
  pixelValues: COARSE_GRID_VALUES,
  suggestedRange: { minimum: 0, midpoint: 50, maximum: 100 },
  limits: RASTER_DETAIL_PREVIEW_LIMITS,
  actual: {
    sampleGridWidth: 31,
    sampleGridHeight: 31,
    sourceBlockReadCount: 6,
    decodedSourceBytes: 12288,
    pointsPerCell: 1,
    candidateWindowCount: 0,
  },
});

/** @type {Readonly<Object>} Full-extent representative-per-cell proxy. */
export const REPRESENTATIVE_SAMPLE_DETAIL_PREVIEW = Object.freeze({
  ...CENTER_SAMPLE_DETAIL_PREVIEW,
  mode: "representativeSample",
  label: "Approximate full-extent proxy using representative cell samples",
  pixelValues: COARSE_GRID_VALUES.map((value) =>
    value === null ? null : Math.min(100, value + 5)
  ),
  actual: {
    ...CENTER_SAMPLE_DETAIL_PREVIEW.actual,
    pointsPerCell: 5,
  },
});

/** @type {Readonly<Object>} Representative bounded numeric detail patch. */
export const PATCH_DETAIL_PREVIEW = Object.freeze({
  ...CENTER_SAMPLE_DETAIL_PREVIEW,
  mode: "representativePatch",
  scope: "representativePatch",
  density: null,
  label: "Approximate representative detail patch",
  imageBounds: [-122.1, 48.9, -121.9, 49.1],
  imageWidth: 2,
  imageHeight: 2,
  pixelValues: [10, 20, null, 30],
  suggestedRange: { minimum: 10, midpoint: 20, maximum: 30 },
  limits: Object.freeze({
    ...RASTER_DETAIL_PREVIEW_LIMITS,
    maximumDecodedSourceBytes: 67108864,
  }),
  actual: {
    sampleGridWidth: 2,
    sampleGridHeight: 2,
    sourceBlockReadCount: 4,
    decodedSourceBytes: 65536,
    pointsPerCell: 0,
    candidateWindowCount: 3,
  },
});

/** @type {Readonly<Object>} Finer proxy for the current visible map area. */
export const CURRENT_VIEW_DETAIL_PREVIEW = Object.freeze({
  ...CENTER_SAMPLE_DETAIL_PREVIEW,
  scope: "currentView",
  label: "Approximate current-view sampled proxy using each map cell's center",
  imageBounds: [-122.5, 48.5, -121.5, 49.5],
  pixelValues: Array.from(
    { length: 31 * 31 },
    (_, index) => 10 + (index % 6) * 10,
  ),
});

/** @type {Readonly<Object>} Honest all-nodata full-extent numeric proxy. */
export const NODATA_DETAIL_PREVIEW = Object.freeze({
  ...CENTER_SAMPLE_DETAIL_PREVIEW,
  pixelValues: new Array(31 * 31).fill(null),
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
