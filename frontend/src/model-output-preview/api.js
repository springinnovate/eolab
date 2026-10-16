/** Fetch and validate GeoJSON map previews of this browser session's model outputs. */

const MAX_BYTES = 8 * 1024 * 1024;

/** Check a GeoJSON preview's file identity, extent and vector coordinates.
 * @param {Object} value Untrusted preview response.
 * @param {string} jobId Requested run identity.
 * @param {Object} file Validated GeoJSON manifest file.
 * @return {Object} Checked vector display data.
 * @throws {Error} If format, identity, checksum, geometry or coordinate limits differ.
 */
export function validateArtifactPreview(value, jobId, file) {
    /** Report malformed preview data without exposing server paths.
     * @return {never}
     * @throws {Error} Always, with the preview validation message.
     */
    const rejectInvalidPreview = () => { throw new Error("The server returned an invalid map preview."); };
    if (value?.jobId !== jobId || value.artifactId !== file.artifactId || value.sha256 !== file.sha256 ||
        !Array.isArray(value.bounds) || value.bounds.length !== 4 || !value.bounds.every(Number.isFinite)) rejectInvalidPreview();
    const [west, south, east, north] = value.bounds;
    if (west < -180 || east > 180 || south < -85.051129 || north > 85.051129 || west > east || south > north) rejectInvalidPreview();
    if (value.kind === "vector" && file.mediaType === "application/geo+json") {
        const geometryCoordinateLayouts = {Point: [0, "point"], MultiPoint: [1, "point"], LineString: [1, "line"],
            MultiLineString: [2, "line"], Polygon: [2, "polygon"], MultiPolygon: [3, "polygon"]};
        let coordinateCount = 0;
        /** Check every coordinate against the preview extent and 100,000-position limit.
         * @param {unknown} coordinates Candidate array.
         * @param {number} remainingArrayDepth Array levels before a coordinate tuple.
         * @return {void}
         * @throws {Error} If coordinates are malformed, outside the extent or over the limit.
         */
        function validatePreviewCoordinates(coordinates, remainingArrayDepth) {
            if (!Array.isArray(coordinates) || !coordinates.length) rejectInvalidPreview();
            if (remainingArrayDepth) { for (const child of coordinates) validatePreviewCoordinates(child, remainingArrayDepth - 1); return; }
            if (![2, 3].includes(coordinates.length) || !coordinates.every(Number.isFinite) || ++coordinateCount > 100000 ||
                coordinates[0] < west || coordinates[0] > east || coordinates[1] < south || coordinates[1] > north) rejectInvalidPreview();
        }
        const features = value.geojson?.features;
        if (value.geojson?.type !== "FeatureCollection" || !Array.isArray(features) || !features.length || features.length > 5000) rejectInvalidPreview();
        for (const feature of features) {
            const coordinateLayout = geometryCoordinateLayouts[feature?.geometry?.type];
            if (feature?.type !== "Feature" || !coordinateLayout || coordinateLayout[1] !== value.geometryKind) rejectInvalidPreview();
            validatePreviewCoordinates(feature.geometry.coordinates, coordinateLayout[0]);
        }
    } else rejectInvalidPreview();
    return value;
}

/** Fetch one private GeoJSON display without putting its response in the browser HTTP cache.
 * @param {string} jobId Opaque run identity.
 * @param {Object} file GeoJSON manifest identity, MIME type and checksum.
 * @param {AbortSignal} [signal] Cancellation when the display request is superseded.
 * @param {typeof fetch} [fetcher=globalThis.fetch] HTTP transport.
 * @return {Promise<Object>} Bounded validated vector display data.
 * @throws {Error} If format, access, transport, size or the display contract fails.
 */
export async function readArtifactPreview(jobId, file, signal, fetcher = globalThis.fetch) {
    if (![jobId, file.artifactId].every(id => /^[a-f0-9]{32}$/.test(id)) || file.mediaType !== "application/geo+json") {
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
