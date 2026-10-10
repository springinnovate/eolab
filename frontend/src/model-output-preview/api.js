/** Read bounded, owner-authorized display copies of immutable run files. */

export const PREVIEW_MEDIA_TYPES = new Set(["image/tiff", "application/geo+json"]);
const MAX_BYTES = 8 * 1024 * 1024;

/** Validate display data before it reaches Leaflet or a canvas.
 * @param {Object} value Untrusted preview response.
 * @param {string} jobId Requested run identity.
 * @param {Object} file Validated manifest file.
 * @return {Object} Checked display data.
 * @throws {Error} If identity, checksum, dimensions or coordinate limits differ.
 */
export function validateArtifactPreview(value, jobId, file) {
    /** Reject malformed display data with a path-free explanation. @return {never} */
    const invalid = () => { throw new Error("The server returned an invalid map preview."); };
    if (value?.jobId !== jobId || value.artifactId !== file.artifactId || value.sha256 !== file.sha256 ||
        !Array.isArray(value.bounds) || value.bounds.length !== 4 || !value.bounds.every(Number.isFinite)) invalid();
    const [west, south, east, north] = value.bounds;
    if (west < -180 || east > 180 || south < -85.051129 || north > 85.051129 || west > east || south > north) invalid();
    if (value.kind === "raster" && file.mediaType === "image/tiff") {
        if (![value.width, value.height].every(n => Number.isInteger(n) && n > 0 && n <= 512) ||
            west === east || south === north || !Array.isArray(value.values) || value.values.length !== value.width * value.height ||
            value.values.some(n => n !== null && !Number.isFinite(n))) invalid();
    } else if (value.kind === "vector" && file.mediaType === "application/geo+json") {
        const kinds = {Point: [0, "point"], MultiPoint: [1, "point"], LineString: [1, "line"],
            MultiLineString: [2, "line"], Polygon: [2, "polygon"], MultiPolygon: [3, "polygon"]};
        let count = 0;
        /** Check one geometry's nested coordinate arrays.
         * @param {unknown} coordinates Candidate array.
         * @param {number} depth Required nesting.
         * @return {void}
         * @throws {Error} If coordinates or total work exceed the display contract.
         */
        function check(coordinates, depth) {
            if (!Array.isArray(coordinates) || !coordinates.length) invalid();
            if (depth) { for (const child of coordinates) check(child, depth - 1); return; }
            if (![2, 3].includes(coordinates.length) || !coordinates.every(Number.isFinite) || ++count > 100000 ||
                coordinates[0] < west || coordinates[0] > east || coordinates[1] < south || coordinates[1] > north) invalid();
        }
        const features = value.geojson?.features;
        if (value.geojson?.type !== "FeatureCollection" || !Array.isArray(features) || !features.length || features.length > 5000) invalid();
        for (const feature of features) {
            const layout = kinds[feature?.geometry?.type];
            if (feature?.type !== "Feature" || !layout || layout[1] !== value.geometryKind) invalid();
            check(feature.geometry.coordinates, layout[0]);
        }
    } else invalid();
    return value;
}

/** Fetch one private display copy without putting its response in the browser HTTP cache.
 * @param {string} jobId Opaque run identity.
 * @param {Object} file Manifest identity, MIME type and checksum.
 * @param {AbortSignal} signal Cancellation when the display request is superseded.
 * @param {typeof fetch} [fetcher=globalThis.fetch] HTTP transport.
 * @return {Promise<Object>} Bounded validated display data.
 * @throws {Error} If access, transport, size or the display contract fails.
 */
export async function readArtifactPreview(jobId, file, signal, fetcher = globalThis.fetch) {
    if (![jobId, file.artifactId].every(id => /^[a-f0-9]{32}$/.test(id)) || !PREVIEW_MEDIA_TYPES.has(file.mediaType)) {
        throw new Error("This file has no supported map preview.");
    }
    const response = await fetcher(`/api/processing/jobs/${jobId}/artifacts/${file.artifactId}/preview`,
        {credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45000)])});
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    try {
        while (true) {
            const {value, done} = await reader.read(); if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_BYTES + 1024) throw new Error("The map preview is too large. Download the file instead.");
            chunks.push(value);
        }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const combined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
    const data = JSON.parse(new TextDecoder().decode(combined));
    if (!response.ok) throw Object.assign(new Error(data.detail?.message ?? data.detail ?? "The preview could not be loaded."), {status: response.status});
    return validateArtifactPreview(data, jobId, file);
}
