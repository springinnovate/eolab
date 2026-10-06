/** Numeric contracts for bounded area-weighted categorical statistics. */

/**
 * Canonicalize codes at the browser request boundary.
 * @param {number[]} values Distinct safe-integer category codes.
 * @return {number[]} Sorted copy for requests and cache identity.
 * @throws {TypeError} If codes violate the bounded request contract.
 */
export function normalizeCategoryValues(values) {
    if (!Array.isArray(values) || values.length < 1 || values.length > 256 ||
        !values.every(Number.isSafeInteger) || new Set(values).size !== values.length) {
        throw new TypeError("Categories require 1–256 distinct safe-integer codes.");
    }
    return [...values].sort((a, b) => a - b);
}

/**
 * Validate optional numeric category areas at the API response boundary.
 * @param {Object} distribution Untrusted category-area response.
 * @return {Object} Validated response, retaining its numeric provenance.
 * @throws {Error} If codes, areas, or provenance violate the contract.
 */
export function validateCategoricalDistribution(distribution) {
    const invalid = () => new Error("Raster statistics returned invalid categorical ground areas.");
    if (distribution === null || typeof distribution !== "object") throw invalid();
    let codes;
    try { codes = normalizeCategoryValues(distribution.categoryValues); }
    catch { throw invalid(); }
    const areas = distribution.areasHectares;
    const totals = [distribution.unmappedAreaHectares, distribution.validAreaHectares,
        distribution.nodataAreaHectares];
    if (!codes.every((code, index) => code === distribution.categoryValues[index]) ||
        !Array.isArray(areas) || areas.length !== codes.length ||
        ![...areas, ...totals].every((value) => Number.isFinite(value) && value >= 0) ||
        distribution.validAreaHectares <= 0 || distribution.areaEstimated !== true ||
        distribution.areaMethod !== "sample-cell-equal-area-v1" ||
        distribution.selectionSubdivisions !== 4 ||
        Math.abs(areas.reduce((sum, area) => sum + area, distribution.unmappedAreaHectares) -
            distribution.validAreaHectares) > Math.max(1e-9, distribution.validAreaHectares * 1e-9)) {
        throw invalid();
    }
    return distribution;
}

/**
 * Match trusted statistics to a committed code set independently of appearance.
 * @param {Object|null} statistics Boundary-validated numeric statistics.
 * @param {number[]|null} codes Committed codes, or null for continuous mode.
 * @return {boolean} Whether the numeric result belongs to this classification.
 */
export function rasterStatisticsMatchCategories(statistics, codes) {
    if (!statistics) return false;
    const distribution = statistics.categoricalDistribution;
    if (codes === null) return distribution == null;
    const canonical = [...codes].sort((a, b) => a - b);
    return Array.isArray(distribution?.categoryValues) &&
        canonical.length === distribution.categoryValues.length &&
        canonical.every((code, index) => code === distribution.categoryValues[index]);
}
