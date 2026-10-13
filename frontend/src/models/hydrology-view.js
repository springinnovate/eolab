/** Display hydrology reports retained by historical model runs. */

/** Describe the sources and registration evidence saved by a historical run.
 * @param {Object} snapshot Hydrology report captured before model-configured sources.
 * @return {Array<[string,string]>} Dataset and topology details.
 */
export function hydrologyDetails(snapshot) {
    const definition = snapshot.definition, topology = definition.topology;
    /** Describe a saved catalog source without reopening it.
     * @param {Object} source Catalog reference.
     * @return {string} Catalog collection and item identity.
     */
    const sourceLabel = source => `${source.collectionId} / ${source.itemId}`;
    return [
        ["Dataset", `${definition.title} · version ${definition.version}`],
        ["Description", definition.description],
        ["Elevation raster", sourceLabel(definition.dem)],
        ["Watershed layer", sourceLabel(definition.watersheds)],
        ["Watershed ID field", topology.idField],
        ["Next downstream ID field", topology.downstreamField],
        ["Stop when", `${topology.terminal.field} equals ${topology.terminal.equalsField ?? JSON.stringify(topology.terminal.value)}`],
        ...(topology.terminalIdField ? [["Terminal watershed ID field", topology.terminalIdField]] : []),
        ["Terrain version", definition.terrain.datasetVersion],
        ["Terrain preparation", definition.terrain.conditioning],
        [snapshot.validation.validator === "eolab.hydrology-registration/v1" ? "Registered" : "Validated",
            new Date(snapshot.validation.validatedAt).toLocaleString()],
    ];
}
