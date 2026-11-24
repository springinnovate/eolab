/** Store, reopen and delete this browser's polygon and raster uploads. */

/**
 * @typedef {Object} VectorUpload
 * @property {string} id Opaque upload identifier.
 * @property {string} name User's display name for the layer.
 * @property {number} size_bytes Stored GeoPackage size after any GeoJSON conversion.
 * @property {string} created_at Server creation timestamp.
 * @property {string} expires_at Fixed server expiry, seven days after admission.
 * @property {"vector"} kind Uploaded file type.
 * @property {string} layer_name GeoPackage layer name.
 * @property {"Polygon"|"MultiPolygon"} geometry_type Admitted geometry type.
 * @property {string} crs_wkt Layer coordinate reference system.
 * @property {Object<string,string>} fields Attribute names and Fiona field types.
 */

/**
 * A stored file listed by the shared upload manager, without its source schema.
 * @typedef {Object} UploadSummary
 * @property {string} id Opaque upload identifier.
 * @property {"vector"|"raster"} kind Uploaded file type.
 * @property {string} name User's display name.
 * @property {number} size_bytes Stored file size.
 * @property {string} created_at Server admission timestamp.
 * @property {string} expires_at Fixed server expiry timestamp.
 */

/**
 * This browser's files and authoritative shared storage allowance.
 * @typedef {Object} UploadStorageSummary
 * @property {UploadSummary[]} uploads Available uploaded files, including files removed from the map.
 * @property {number} used_files Files using slots, including pending and retained files.
 * @property {number} max_files Shared file allowance across polygons and rasters.
 * @property {number} retained_files Deleted or expired files still needed by calculations.
 * @property {number} used_bytes Stored bytes charged to this browser.
 * @property {number} max_bytes This browser's storage allowance.
 * @property {number} max_file_bytes Maximum bytes in one uploaded file.
 */

/**
 * Return this browser's files and shared polygon/raster upload allowance.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] Same-origin HTTP transport.
 * @return {Promise<UploadStorageSummary>} Current files, usage and server limits.
 * @throws {Error} If the server cannot return the upload summary.
 */
export async function getUploadStorageSummary(fetchImplementation = globalThis.fetch) {
    return requestUploads("", {method: "GET"}, fetchImplementation, "/api/uploads");
}

/**
 * Store polygon GeoPackage or GeoJSON and return its admitted layer metadata.
 * The server validates and prepares the file; the browser supplies its bytes and display name.
 * @param {File} file GeoPackage or GeoJSON selected by the user.
 * @param {string} name Display name entered by the user.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] Same-origin HTTP transport.
 * @return {Promise<VectorUpload>} Upload metadata, without paths or browser credentials.
 * @throws {Error} If the upload fails or the server rejects the file.
 */
export async function uploadPolygons(file, name, fetchImplementation = globalThis.fetch) {
    return requestUploads(`?${new URLSearchParams({ name })}`, {
        method: "POST",
        headers: { "Content-Type": /\.(geojson|json)$/i.test(file.name) ? "application/geo+json" : "application/geopackage+sqlite3", "X-EOLab-Uploads": "1" },
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

/** Store one binary Byte GeoTIFF mask using the shared file allowance.
 * Values of 1 identify reference sites, 0 excludes cells, and NoData is ignored.
 * @param {File} file User-selected single-band GeoTIFF.
 * @param {string} name User's display name.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] Same-origin transport.
 * @return {Promise<UploadSummary>} Admitted raster metadata.
 * @throws {Error} If admission, storage or transport fails.
 */
export async function uploadRasterMask(file, name, fetchImplementation = globalThis.fetch) {
    return requestUploads(`?${new URLSearchParams({name})}`, {method: "POST",
        headers: {"Content-Type": "image/tiff", "X-EOLab-Uploads": "1"}, body: file}, fetchImplementation, "/api/raster-uploads");
}

/** Return one owned raster's metadata without exposing its server path.
 * @param {string} uploadId Opaque uploaded raster identifier.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] Same-origin transport.
 * @return {Promise<UploadSummary>} Available raster metadata.
 * @throws {Error} If unavailable or the request fails.
 */
export async function getRasterUpload(uploadId, fetchImplementation = globalThis.fetch) {
    return requestUploads(`/${encodeURIComponent(uploadId)}`, {method: "GET"}, fetchImplementation, "/api/raster-uploads");
}

/** Delete one owned raster while accepted calculations retain their input.
 * @param {string} uploadId Opaque uploaded raster identifier.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] Same-origin transport.
 * @return {Promise<void>} Completion when the file is no longer available for new use.
 * @throws {Error} If deletion or transport fails.
 */
export async function deleteRasterUpload(uploadId, fetchImplementation = globalThis.fetch) {
    await requestUploads(`/${encodeURIComponent(uploadId)}`, {method: "DELETE",
        headers: {"X-EOLab-Uploads": "1"}}, fetchImplementation, "/api/raster-uploads");
}

/** Choose the file admission endpoint from the user's selected extension.
 * Server inspection remains authoritative for format, contents and storage limits.
 * @param {File} file User-selected GeoPackage, GeoJSON or GeoTIFF.
 * @param {string} name User's display name.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] Same-origin transport.
 * @return {Promise<UploadSummary|VectorUpload>} Admitted file metadata.
 * @throws {Error} If the file type is unsupported or admission fails.
 */
export async function uploadFile(file, name, fetchImplementation = globalThis.fetch) {
    if (/\.(gpkg|geojson|json)$/i.test(file.name)) return uploadPolygons(file, name, fetchImplementation);
    if (/\.tiff?$/i.test(file.name)) return uploadRasterMask(file, name, fetchImplementation);
    throw new Error("Choose a polygon GeoPackage (.gpkg), GeoJSON (.geojson or .json), or raster mask GeoTIFF (.tif or .tiff).");
}

/** Delete a manager row through the endpoint that owns its original file.
 * @param {UploadSummary} upload Available file from the server summary.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] Same-origin transport.
 * @return {Promise<void>} Completion when deletion succeeds.
 * @throws {Error} If deletion or transport fails.
 */
export async function deleteUploadedFile(upload, fetchImplementation = globalThis.fetch) {
    return upload.kind === "raster" ? deleteRasterUpload(upload.id, fetchImplementation) : deleteUpload(upload.id, fetchImplementation);
}

/**
 * Send an upload-storage request with the private cookie and report server failures.
 * @param {string} suffix Path or query after the upload API root.
 * @param {RequestInit} options Method, headers and optional file body.
 * @param {typeof fetch} fetchImplementation Same-origin HTTP transport.
 * @param {string} [root="/api/vector-uploads"] Upload endpoint owned by this client.
 * @return {Promise<VectorUpload|VectorUpload[]|UploadSummary|UploadStorageSummary|null>} Response metadata, or null after deletion.
 * @throws {Error} If transport, server operation or JSON decoding fails.
 */
async function requestUploads(suffix, options, fetchImplementation, root = "/api/vector-uploads") {
    let response;
    try {
        response = await fetchImplementation(`${root}${suffix}`, {
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
