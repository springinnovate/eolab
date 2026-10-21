/** Upload original polygon GeoPackages using this browser's private server storage. */

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
    let response;
    try {
        response = await fetchImplementation(`/api/vector-uploads?${new URLSearchParams({ name })}`, {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Content-Type": "application/geopackage+sqlite3", "X-EOLab-Uploads": "1" },
            body: file,
        });
    } catch {
        throw new Error("Could not reach the server. Check your connection and try again.");
    }
    if (!response.ok) {
        const detail = (await response.json().catch(() => null))?.detail;
        const message = typeof detail === "string" ? detail : Array.isArray(detail)
            ? detail.map(error => error.msg).join("; ")
            : response.status === 413
                ? "The server rejected this file because of its size. Choose a smaller file or ask the administrator about the server's upload limit."
                : `The upload failed (${response.status}). Try again.`;
        throw new Error(message);
    }
    try {
        return await response.json();
    } catch {
        throw new Error("The server returned an unreadable upload response. Try again.");
    }
}
