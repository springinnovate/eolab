/** Path-free raster identities shared by map presentation, analysis and Processing. */
import { getCatalogItemKey } from "./catalog-item-identity.js";

/**
 * Original raster identity and metadata supplied to shared controls.
 * Capabilities describe supported operations; each server request still authorizes
 * the source and checks its lifetime, validity and resource limits independently.
 * @typedef {Object} RasterDescriptor
 * @property {{collectionId:string,itemId:string}|{kind:"runArtifact",jobId:string,artifactId:string}} source Path-free original identity.
 * @property {string} version Immutable source checksum.
 * @property {string} label Readable file name.
 * @property {number[]} bbox Original extent in WGS84 west/south/east/north order.
 * @property {{id:string,label:string}} [group] Originating run identity and display name.
 * @property {{pixels:boolean,statistics:boolean,calculations:boolean,modelInput:boolean}} capabilities Format support, independent of display state.
 */

/** Copy a source identity from a raster descriptor, catalog Item or API reference.
 * @param {Object} value Source-bearing presentation or identity.
 * @return {Readonly<Object>} Validated catalog or owned run-file reference.
 * @throws {TypeError} If the source identity is missing or malformed.
 */
export function rasterSourceReference(value) {
    const source = value?.source ?? value?.item ?? value;
    if (source?.kind === "runArtifact") {
        if (![source.jobId, source.artifactId].every(id => typeof id === "string" && /^[a-f0-9]{32}$/.test(id))) {
            throw new TypeError("Choose an available raster result.");
        }
        return Object.freeze({kind: "runArtifact", jobId: source.jobId, artifactId: source.artifactId});
    }
    const collectionId = source?.collectionId ?? source?.collection;
    const itemId = source?.itemId ?? source?.id;
    if (![collectionId, itemId].every(id => typeof id === "string" && id.length > 0 && id.length <= 512)) {
        throw new TypeError("Choose a raster.");
    }
    return Object.freeze({collectionId, itemId});
}

/** Identify a raster independently of its display, style or calculation.
 * @param {Object} value Source-bearing presentation or identity.
 * @return {string} Stable key, preserving existing catalog and run-layer keys.
 * @throws {TypeError} If the source identity is invalid.
 */
export function rasterSourceKey(value) {
    const source = rasterSourceReference(value);
    return source.kind === "runArtifact" ? `local:artifact:${source.jobId}:${source.artifactId}` :
        getCatalogItemKey({collection: source.collectionId, id: source.itemId});
}

/** Capture a raster input and its readable label without display state or paths.
 * @param {Object} value Raster descriptor, source or catalog Item.
 * @param {string} label Name shown in the calling tool.
 * @return {Readonly<Object>} Immutable labeled source.
 * @throws {TypeError} If identity or label is invalid.
 */
export function labeledRasterSource(value, label) {
    if (typeof label !== "string" || !label.trim() || label.length > 512) throw new TypeError("Choose a named raster.");
    return Object.freeze({...rasterSourceReference(value), label});
}
