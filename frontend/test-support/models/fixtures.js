/** Contract fixtures for installed summary and clip models. */
export const model = {schema: "eolab.model/v1", id: "raster-summary", version: "1.0.0", definitionSha256: "a".repeat(64), title: "Raster summary",
    description: "Calculate a scalar expression over a raster and area.", inputs: {raster: {type: "catalog_raster", label: "Raster"}, area: {type: "summary_area", label: "Analysis area"}},
    parameters: {summary: {type: "summary_expression", label: "Summary formula", alias: "a", grammar: "eolab.scalar/v1", default: "sum(a)"}},
    outputs: {statistics: {source: "calculate.statistics", role: "result", presentation: "table", saveEligible: true}}};
export const raster = {collectionId: "eolab-mounted-geotiffs", itemId: "population", label: "Population", visible: true};
export const area = {kind: "selectedArea", selectedBounds: {west: 0, south: 0, east: 1, north: 1}};
export const invocation = {model: {...model, definition: model}, inputs: {raster: {collectionId: raster.collectionId, itemId: raster.itemId}, area}, parameters: {summary: "sum(a)"}, label: "Population total"};
export const selection = {collectionId: "eolab-mounted-vectors", itemId: "watersheds", assetKey: "data", layerName: "basins", sourceSignature: "b".repeat(64),
    filter: {enabled: true, match: "all", rules: [{field: "BASIN", operator: "eq", value: "North"}]}};
/** Create an independent run status.
 * @param {Object} [changes={}] Overridden state or identity.
 * @return {Object} Model run response.
 */
export function job(changes = {}) {
    return {jobId: "1".repeat(32), operation: "model.run.v1", model: {id: model.id, version: model.version, definitionSha256: model.definitionSha256, title: model.title},
        label: "Population total", status: "queued", createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z",
        expiresAt: null, metadataExpiresAt: null, progress: {phase: "preparing"}, result: null, error: null, ...changes};
}

/** Installed clip recipe shape, using the same raster input and a restricted area. */
export const clipModel = {...model, id: "raster-clip", title: "Raster clip", description: "Download a GeoTIFF within a chosen area.",
    inputs: {...model.inputs, area: {type: "clip_area", label: "Analysis area"}}, parameters: {},
    outputs: {raster: {source: "clip.raster", role: "result", presentation: "map", saveEligible: true}}};

/** A completed private GeoTIFF with native grid and download metadata. */
export const clipResult = {name: "raster", label: "Clipped raster", role: "result", presentation: "map", kind: "raster", mediaType: "image/tiff", filename: "population-clip.tif", bytes: 4096,
    sha256: "c".repeat(64), validPixels: 90, url: `/api/processing/jobs/${"1".repeat(32)}/result`,
    provenanceUrl: `/api/processing/jobs/${"1".repeat(32)}/provenance`,
    grid: {width: 10, height: 10, window: [0, 0, 10, 10], crs: "EPSG:4326", dtype: "int16", transform: [0.1, 0, 0, 0, -0.1, 1],
        nodata: null, nativeBlocks: 1, decodedBytes: 200, estimatedRawBytes: 300, reservedBytes: 1024}};

/** A completed summary output using the shared typed-file contract. */
export const statisticsResult = {name: "statistics", label: "Statistics", role: "result", presentation: "table", kind: "statistics",
    mediaType: "text/csv", filename: "statistics.csv", bytes: 128, sha256: "d".repeat(64), cacheHit: false,
    url: clipResult.url, provenanceUrl: clipResult.provenanceUrl,
    rows: [{label: "Total", expression: "sum(a)", state: "ok", value: "42", valueType: "integer", aggregates: []}]};
