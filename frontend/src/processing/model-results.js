/** Validate scientific output types independently of model recipes and operations. */

/** Validate the bounded typed table consumed by inline results. @param {Object[]} rows API values. @return {void} */
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

/** Check a downloadable raster's file properties, without execution-plan metadata.
 * @param {Object} result Raster output from the Processing API.
 * @return {void}
 * @throws {Error} If dimensions, georeferencing or validity counts are invalid.
 */
function validateRasterResult(result) {
    const grid = result.grid;
    if (!grid || ![grid.width, grid.height].every(value => Number.isSafeInteger(value) && value > 0) ||
        typeof grid.crs !== "string" || !grid.crs || typeof grid.dtype !== "string" || !grid.dtype ||
        !Array.isArray(grid.transform) || grid.transform.length !== 6 || !grid.transform.every(Number.isFinite) ||
        !Number.isSafeInteger(result.validPixels) || result.validPixels < 0 || result.validPixels > grid.width * grid.height ||
        result.rows !== undefined) throw new Error("Processing returned invalid raster result details.");
}

/** Check a statistics output against the existing scalar result contract.
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

/** Validate recipe-named file metadata and delegate to its scientific result type.
 * Owned download URLs are checked by the API client before this function is called.
 * @param {Object} result API output, including its saved YAML name and label.
 * @return {void}
 * @throws {Error} If the type, file metadata or scientific values are invalid.
 */
export function validateModelResult(result) {
    const type = RESULT_TYPES.get(result.kind);
    if (!type) throw new Error("Processing returned an unsupported model result type.");
    if (result.mediaType !== type.mediaType || result.presentation !== type.presentation || result.role !== "result" ||
        typeof result.name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(result.name) ||
        typeof result.label !== "string" || !result.label || result.label.length > 80 ||
        typeof result.filename !== "string" || !result.filename ||
        !Number.isSafeInteger(result.bytes) || result.bytes <= 0 || !/^[a-f0-9]{64}$/.test(result.sha256))
        throw new Error("Processing returned invalid model result details.");
    type.validate(result);
}
