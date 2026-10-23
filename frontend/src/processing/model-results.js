/** Validate scientific output types independently of model recipes and operations. */

/** Check up to five formula results, their numeric values and pixel counts.
 * @param {Object[]} rows Calculation rows returned by the Processing API.
 * @return {void}
 * @throws {Error} If rows, calculation states, numeric values or pixel counts are invalid.
 */
export function validateCalculationRows(rows) {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5 || rows.some(row =>
        typeof row.label !== "string" || typeof row.expression !== "string" ||
        !["ok", "no_matches", "no_valid_data", "invalid_arithmetic", "overflow"].includes(row.state) ||
        !(row.value === null || typeof row.value === "string" &&
            (row.valueType === "integer" ? /^-?\d+$/.test(row.value) : row.valueType === "float" && Number.isFinite(Number(row.value)))) ||
        !Array.isArray(row.aggregates) || row.aggregates.some(aggregate =>
            typeof aggregate.function !== "string" ||
            ![aggregate.validPixels, aggregate.matchedPixels, aggregate.invalidArithmeticPixels]
                .every(value => Number.isSafeInteger(value) && value >= 0)))) {
        throw new Error("Processing returned an invalid calculation result table.");
    }
}

/** Check a raster result's grid, valid pixels and saved temporal coverage.
 * Temporal coverage describes the observations used by a period map; ordinary
 * raster results omit it.
 * @param {Object} result Raster output from the Processing API.
 * @return {void}
 * @throws {Error} If the grid, validity count or temporal coverage is invalid.
 */
function validateRasterResult(result) {
    const grid = result.grid;
    if (!grid || ![grid.width, grid.height].every(value => Number.isSafeInteger(value) && value > 0) ||
        typeof grid.crs !== "string" || !grid.crs || typeof grid.dtype !== "string" || !grid.dtype ||
        !Array.isArray(grid.transform) || grid.transform.length !== 6 || !grid.transform.every(Number.isFinite) ||
        !Number.isSafeInteger(result.validPixels) || result.validPixels < 0 || result.validPixels > grid.width * grid.height ||
        result.rows !== undefined) throw new Error("Processing returned invalid raster result details.");
    const coverage = result.temporalCoverage;
    if (coverage !== undefined && (!coverage || typeof coverage.unit !== "string" ||
        !Number.isSafeInteger(coverage.observationCount) || coverage.observationCount < 1 ||
        !["firstObservation", "lastObservation"].every(key =>
            typeof coverage[key] === "string" && Number.isFinite(Date.parse(coverage[key]))))) {
        throw new Error("Processing returned invalid temporal coverage.");
    }
}

/** Check formula results and whether the server reused a cached calculation.
 * @param {Object} result Statistics output from the Processing API.
 * @return {void}
 * @throws {Error} If rows or cache metadata are invalid.
 */
function validateStatisticsResult(result) {
    validateCalculationRows(result.rows);
    if (result.cacheHit != null && typeof result.cacheHit !== "boolean")
        throw new Error("Processing returned invalid cache metadata.");
}

const RESULT_TYPES = new Map([
    ["raster", {mediaType: "image/tiff", presentation: "map", validate: validateRasterResult}],
    ["statistics", {mediaType: "text/csv", presentation: "table", validate: validateStatisticsResult}],
]);

/** Check a model result's file metadata and its raster or statistics contents.
 * The API client checks session-specific download URLs before calling this function.
 * @param {Object} result API output, including its saved YAML name and label.
 * @return {void}
 * @throws {Error} If the type, file metadata or scientific values are invalid.
 */
export function validateModelResult(result) {
    const resultType = RESULT_TYPES.get(result.kind);
    if (!resultType) throw new Error("Processing returned an unsupported model result type.");
    if (result.mediaType !== resultType.mediaType || result.presentation !== resultType.presentation || result.role !== "result" ||
        typeof result.name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(result.name) ||
        typeof result.label !== "string" || !result.label || result.label.length > 80 ||
        typeof result.filename !== "string" || !result.filename ||
        !Number.isSafeInteger(result.bytes) || result.bytes <= 0 || !/^[a-f0-9]{64}$/.test(result.sha256))
        throw new Error("Processing returned invalid model result details.");
    resultType.validate(result);
}
