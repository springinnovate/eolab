/** Read prepared-dataset metadata retained by historical model runs. */

/** Read the dataset identity captured by a historical model run.
 * @param {Object} snapshot Validated prepared hydrology report.
 * @return {{presetId:string,version:string,effectiveSha256:string}} Saved dataset reference.
 */
export function hydrologyReference(snapshot) {
    return {presetId: snapshot.definition.id, version: snapshot.definition.version, effectiveSha256: snapshot.effectiveSha256};
}

/** Identify the dataset revision recorded in saved run metadata.
 * @param {Object} reference Prepared hydrology reference.
 * @return {string} Stable saved dataset identity.
 */
export function hydrologyKey(reference) {
    return JSON.stringify([reference.presetId, reference.version, reference.effectiveSha256]);
}

/** Validate a dataset reference at the HTTP boundary.
 * @param {Object} reference Candidate reference.
 * @return {Object} Checked reference.
 * @throws {Error} If a configuration identity is malformed.
 */
export function validateHydrologyReference(reference) {
    if (!reference || ![reference.presetId, reference.version, reference.effectiveSha256].every(value => typeof value === "string") ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(reference.presetId) ||
        !/^\d+\.\d+\.\d+$/.test(reference.version) || reference.version.length > 32 ||
        !/^[a-f0-9]{64}$/.test(reference.effectiveSha256)) throw new Error("Invalid prepared hydrology identity.");
    return reference;
}

/** Check historical hydrology metadata before displaying a saved run.
 * @param {Object} snapshot Prepared report returned by the server.
 * @return {Object} Report safe to display.
 * @throws {Error} If required display fields or the dataset identity are malformed.
 */
export function validatePreparedHydrology(snapshot) {
    const definition = snapshot?.definition, topology = definition?.topology, terminal = topology?.terminal;
    /** Check a required text field at this metadata boundary.
     * @param {unknown} value Metadata value.
     * @return {boolean} Whether the value contains displayable text.
     */
    const isNonemptyString = value => typeof value === "string" && value.length > 0;
    if (!definition || ![definition.title, definition.description, definition.terrain?.datasetVersion,
        definition.terrain?.conditioning, topology?.idField, topology?.downstreamField, terminal?.field].every(isNonemptyString) ||
        ![definition.dem, definition.watersheds].every(source => source && isNonemptyString(source.collectionId) && isNonemptyString(source.itemId)) ||
        !(isNonemptyString(terminal.equalsField) || ["string", "number", "boolean"].includes(typeof terminal.value)) ||
        !Number.isFinite(Date.parse(snapshot.validation?.validatedAt)))
        throw new Error("Invalid prepared hydrology details.");
    validateHydrologyReference(hydrologyReference(snapshot));
    return snapshot;
}
