/** Capture raster identities selected in Data tools. */
import { rasterSourceReference } from "../raster-source.js";

/** Identify a raster or vector choice without using its label or map visibility.
 * @param {Object} source Catalog identity, uploaded vector or raster identity, or owned run-file reference.
 * @return {string} Composite identity for a choice list.
 */
export function modelSourceKey(source) {
    return JSON.stringify(source.kind === "runArtifact" ? [source.kind, source.jobId, source.artifactId]
        : source.kind === "uploadedRaster" ? [source.kind, source.uploadId]
        : source.uploadId ? ["upload", source.uploadId] : [source.collectionId, source.itemId]);
}

/** Capture an available raster choice using the ordinary path-free source contract.
 * @param {Object|null} raster Selected map raster, uploaded raster or owned run result.
 * @param {Object[]} sources Current source choices in this model setup.
 * @param {string} [type="raster"] Input type; catalog_raster and mask_source exclude run results.
 * @return {Object} Path-free original raster identity.
 * @throws {Error} If the source is absent, expired or ineligible for this input.
 */
export function captureModelRaster(raster, sources, type = "raster") {
    const startingMask = type === "mask_source";
    if (!raster || !sources.some(source => modelSourceKey(source) === modelSourceKey(raster)))
        throw new Error(startingMask ? "Choose a starting raster from Map contents." : "Choose a raster from Map contents or a completed run.");
    if ((type === "catalog_raster" || startingMask) && raster.kind === "runArtifact")
        throw new Error(startingMask ? "Choose a starting raster from Map contents." : "This recipe requires a raster from Map contents.");
    if (raster.available === false || raster.kind === "runArtifact" && Date.parse(raster.expiresAt) <= Date.now())
        throw new Error("This raster is no longer available. Choose another input.");
    return rasterSourceReference(raster);
}
