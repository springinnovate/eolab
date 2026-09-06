/** Closed scalar contract shared by vector feature-analysis consumers. */

/**
 * @typedef {Object} VectorInspectionObservation
 * @property {string} sourceId Opaque retained-source identity from composition.
 * @property {string} layerLabel User-facing source layer or filename.
 * @property {string|number|null} featureId Bounded feature identity.
 * @property {{center:Readonly<number[]>,bounds:Readonly<number[]>|null}} focus
 * Geometry-neutral map center and optional WGS 84 feature bounds.
 * @property {Readonly<Record<string,string|number|boolean|null>>} properties
 * Scalar attributes returned by the existing feature inspection.
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
 * Validate one geometry-neutral selected-feature map target.
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

/**
 * Validate the closed inspection-observation boundary.
 *
 * @param {unknown} observations Candidate observations from composition.
 * @return {VectorInspectionObservation[]} Validated observations.
 * @throws {TypeError} If composition violates the observation contract.
 */
export function validateVectorInspectionObservations(observations) {
    if (!Array.isArray(observations)) {
        throw new TypeError("Vector inspection observations must be an array.");
    }
    for (const observation of observations) {
        if (
            typeof observation?.sourceId !== "string" ||
            observation.sourceId.length === 0 ||
            typeof observation?.layerLabel !== "string" ||
            observation.layerLabel.length === 0 ||
            !(
                observation.featureId === null ||
                typeof observation.featureId === "string" ||
                typeof observation.featureId === "number"
            ) ||
            observation.properties === null ||
            typeof observation.properties !== "object" ||
            Array.isArray(observation.properties)
        ) {
            throw new TypeError("Invalid vector inspection observation.");
        }
        validateVectorFeatureFocus(observation.focus);
        for (const value of Object.values(observation.properties)) {
            if (!(
                value === null ||
                typeof value === "string" ||
                typeof value === "boolean" ||
                typeof value === "number"
            )) {
                throw new TypeError(
                    "Vector inspection properties must contain JSON scalars."
                );
            }
        }
    }
    return observations;
}
