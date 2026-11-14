/** Describe immutable inspected observations and validate map navigation targets. */

/**
 * Immutable scalar-only record constructed by the feature inspector and passed
 * through composition to chart consumers. Consumers trust this producer contract.
 * @typedef {Object} VectorInspectionObservation
 * @property {string} sourceId Layer identifier supplied by the application.
 * @property {string} layerLabel User-facing source layer or filename.
 * @property {string|number|null} featureId Source feature identifier, or null if absent.
 * @property {{center:Readonly<number[]>,bounds:Readonly<number[]>|null}} focus
 * Map center and optional WGS 84 feature bounds; full geometry is not included.
 * @property {Readonly<Record<string,string|number|boolean|null>>} properties
 * Feature attributes limited to strings, numbers, booleans and null.
 */

/**
 * Test whether a value is a finite WGS 84 longitude/latitude pair.
 *
 * @param {unknown} position Candidate coordinate pair.
 * @return {boolean} Whether the position is valid.
 */
function isValidVectorFeaturePosition(position) {
    return Array.isArray(position) && position.length === 2 &&
        Number.isFinite(position[0]) && position[0] >= -180 &&
        position[0] <= 180 && Number.isFinite(position[1]) &&
        position[1] >= -90 && position[1] <= 90;
}

/**
 * Check the center and optional bounding box used to zoom to an inspected feature.
 *
 * @param {unknown} focus Candidate focus target.
 * @return {Object} Valid center and optional bounds.
 * @throws {TypeError} If coordinates are malformed or outside WGS 84.
 */
export function validateVectorFeatureFocus(focus) {
    const bounds = focus?.bounds;
    if (
        !isValidVectorFeaturePosition(focus?.center) ||
        !(
            bounds === null ||
            Array.isArray(bounds) && bounds.length === 4 &&
            bounds.every(Number.isFinite) &&
            bounds[0] >= -180 && bounds[2] <= 180 &&
            bounds[1] >= -90 && bounds[3] <= 90 &&
            bounds[0] <= bounds[2] && bounds[1] <= bounds[3] &&
            bounds[2] - bounds[0] <= 180
        )
    ) {
        throw new TypeError("Invalid vector feature focus target.");
    }
    return focus;
}
