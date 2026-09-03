/** Closed scalar contract shared by vector feature-analysis consumers. */

/**
 * @typedef {Object} VectorInspectionObservation
 * @property {string} sourceId Opaque retained-source identity from composition.
 * @property {string} layerLabel User-facing source layer or filename.
 * @property {string|number|null} featureId Bounded feature identity.
 * @property {Readonly<Record<string,string|number|boolean|null>>} properties
 * Scalar attributes returned by the existing feature inspection.
 */

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
