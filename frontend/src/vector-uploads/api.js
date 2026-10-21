/** Store, reopen and delete this browser's original polygon GeoPackages. */

/**
 * @typedef {Object} VectorUpload
 * @property {string} id Opaque upload identifier.
 * @property {string} name User's display name for the layer.
 * @property {number} size_bytes Original file size.
 * @property {string} created_at Server creation timestamp.
 * @property {string} layer_name GeoPackage layer name.
 * @property {"Polygon"|"MultiPolygon"} geometry_type Admitted geometry type.
 * @property {string} crs_wkt Layer coordinate reference system.
 * @property {Object<string,string>} fields Attribute names and Fiona field types.
 */

/**
 * Store one GeoPackage and return its admitted layer metadata.
 * The server validates the original file; the browser supplies only its bytes and display name.
 * @param {File} file GeoPackage selected by the user.
 * @param {string} name Display name entered by the user.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] Same-origin HTTP transport.
 * @return {Promise<VectorUpload>} Upload metadata, without paths or browser credentials.
 * @throws {Error} If the upload fails or the server rejects the file.
 */
export async function uploadPolygons(file, name, fetchImplementation = globalThis.fetch) {
    return requestUploads(`?${new URLSearchParams({ name })}`, {
        method: "POST",
        headers: { "Content-Type": "application/geopackage+sqlite3", "X-EOLab-Uploads": "1" },
        body: file,
    }, fetchImplementation);
}

/**
 * List the polygon files stored for this browser, newest first.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] Same-origin HTTP transport.
 * @return {Promise<VectorUpload[]>} Owned upload metadata, including files removed from the map.
 * @throws {Error} If the server cannot list the uploads.
 */
export async function listUploads(fetchImplementation = globalThis.fetch) {
    return requestUploads("", { method: "GET" }, fetchImplementation);
}

/**
 * Get an upload's metadata using this browser's ownership cookie.
 * @param {string} uploadId Opaque upload identifier from a list or saved map.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] Same-origin HTTP transport.
 * @return {Promise<VectorUpload>} Authorized metadata for reopening the layer.
 * @throws {Error} If the upload was deleted, belongs to another browser, or cannot be read.
 */
export async function getUpload(uploadId, fetchImplementation = globalThis.fetch) {
    return requestUploads(`/${encodeURIComponent(uploadId)}`, { method: "GET" }, fetchImplementation);
}

/**
 * Delete this browser's uploaded file; accepted calculations retain their required input.
 * @param {string} uploadId Opaque identifier of the upload to delete.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] Same-origin HTTP transport.
 * @return {Promise<void>} Completion after the server withdraws the upload.
 * @throws {Error} If the upload is unavailable or deletion fails.
 */
export async function deleteUpload(uploadId, fetchImplementation = globalThis.fetch) {
    await requestUploads(`/${encodeURIComponent(uploadId)}`, {
        method: "DELETE", headers: { "X-EOLab-Uploads": "1" },
    }, fetchImplementation);
}

/**
 * Send an upload-storage request with the private cookie and report server failures.
 * @param {string} suffix Path or query after the upload API root.
 * @param {RequestInit} options Method, headers and optional file body.
 * @param {typeof fetch} fetchImplementation Same-origin HTTP transport.
 * @return {Promise<VectorUpload|VectorUpload[]|null>} Response metadata, or null after deletion.
 * @throws {Error} If transport, server operation or JSON decoding fails.
 */
async function requestUploads(suffix, options, fetchImplementation) {
    let response;
    try {
        response = await fetchImplementation(`/api/vector-uploads${suffix}`, {
            ...options,
            credentials: "same-origin",
            cache: "no-store",
        });
    } catch {
        throw new Error("Could not reach the server. Check your connection and try again.");
    }
    if (!response.ok) {
        if (response.status === 404 && options.method !== "POST") {
            throw new Error("This private upload is unavailable. It may have been deleted or belong to another browser. Open the map in the browser that uploaded the file, or upload it again.");
        }
        const detail = (await response.json().catch(() => null))?.detail;
        const message = typeof detail === "string" ? detail : Array.isArray(detail)
            ? detail.map(error => error.msg).join("; ")
            : response.status === 413
                ? "The server rejected this file because of its size. Choose a smaller file or ask the administrator about the server's upload limit."
                : `The upload request failed (${response.status}). Try again.`;
        throw new Error(message);
    }
    if (response.status === 204) return null;
    try {
        return await response.json();
    } catch {
        throw new Error("The server returned an unreadable upload response. Try again.");
    }
}
