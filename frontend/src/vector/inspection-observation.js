/** Describe immutable inspected observations and validate map navigation targets. */

/** @typedef {"inspection"|"labels"} VectorInspectionChange A new inspection or selection, or a display-name edit to the same observations. */

/**
 * Immutable scalar-only record constructed by the feature inspector and passed
 * through composition to chart consumers. Consumers trust this producer contract.
 * @typedef {Object} VectorInspectionObservation
 * @property {string} sourceId Layer identifier supplied by the application.
 * @property {string} layerLabel User-facing source layer or filename.
 * @property {string|number|null} featureId Source feature identifier, or null if absent.
 * @property {{center:Readonly<number[]>,bounds:Readonly<number[]>|null}|null} focus
 * Feature center and optional WGS 84 bounds; full geometry is not included.
 * Without bounds the center preserves click context and must not be used for zoom.
 * Attribute-only Lasso selections have null focus; no point is invented for a feature.
 * @property {Readonly<Record<string,string|number|bigint|boolean|null>>} properties
 * Scalar feature attributes. Integers outside the safe Number range retain their exact value as bigint.
 */

/**
 * Check whether an inspected reading can be plotted as a number.
 * @param {unknown} value Original scalar reading.
 * @return {boolean} Whether the reading is a finite number or exact integer.
 */
export function isNumericFeatureValue(value) {
    return typeof value === "bigint" || Number.isFinite(value);
}

/**
 * Bounded observations and presentation state from one vector inspection.
 * @typedef {Object} VectorInspectionSample
 * @property {"loading"|"ready"|"empty"|"invalidated"|"interrupted"} state
 * An interrupted inspection retains only observations received before dismissal.
 * @property {ReadonlyArray<VectorInspectionObservation>} observations Features in inspector order.
 * @property {string} message User-facing inspection status.
 * @property {number} failedLayers Inspected layers that returned an error.
 * @property {Readonly<{lng:number,lat:number}>|null} position
 * Map point associated with the observations, or null for Lasso or after invalidation.
 */

/**
 * A rename preserves each feature's position in the active selection. Restoring a
 * nonempty history entry also supplies its active feature's zero-based position.
 * Ordinary inspection results replace the selection without either hint.
 * @typedef {VectorInspectionChange|{kind:"restore",featureIndex:number}} VectorInspectionUpdate
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
            bounds[0] <= bounds[2] && bounds[1] <= bounds[3]
        )
    ) {
        throw new TypeError("Invalid vector feature focus target.");
    }
    return focus;
}
