/** Read and save linked drawing sources independently of map presentation. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Preserve HTTP status when a linked drawing cannot be read or saved. */
export class DrawingSourceError extends Error {
    /** @param {string} message Actionable explanation. @param {number} status HTTP status, or zero for a malformed response. */
    constructor(message, status) { super(message); this.name = "DrawingSourceError"; this.status = status; }
}

/** Validate a server drawing reference before using it in an endpoint.
 * @param {unknown} identifier Candidate UUID. @return {string} Accepted reference.
 * @throws {DrawingSourceError} If the reference is malformed.
 */
function drawingId(identifier) {
    if (typeof identifier !== "string" || !UUID.test(identifier)) throw new DrawingSourceError("The saved drawing reference is invalid.", 0);
    return identifier;
}

/** Check server metadata; the annotation owner validates geometry before restoring it.
 * @param {unknown} value Decoded response. @return {Object} Detached drawing record.
 * @throws {DrawingSourceError} If identity, revision or collection metadata is malformed.
 */
function readDrawing(value) {
    drawingId(value?.id);
    if (!Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.canEdit !== "boolean"
        || value.collection?.type !== "FeatureCollection" || !Array.isArray(value.collection.features)
        || typeof value.collection.name !== "string" || !value.collection.name.trim()) {
        throw new DrawingSourceError("The drawing service returned an invalid drawing.", 0);
    }
    return structuredClone(value);
}

/** Use the existing browser identity for private drawing writes and link-based reads. */
export class DrawingSourceApi {
    /** @param {typeof fetch} [fetchImplementation=globalThis.fetch] Same-origin HTTP transport. */
    constructor(fetchImplementation = globalThis.fetch.bind(globalThis)) { this.fetch = fetchImplementation; }

    /** Create one reusable source, retrying safely with its original device-layer identity.
     * @param {string} localLayerId Stable device-layer ID. @param {Object} collection All committed polygons with original Feature IDs.
     * @return {Promise<Object>} Saved source and browser edit permission.
     * @throws {DrawingSourceError|Error} If creation conflicts or storage is unavailable.
     */
    async create(localLayerId, collection) { return readDrawing(await this.request("/api/drawings", "POST", {localLayerId, collection})); }

    /** Read current polygons and this browser's edit permission from an opaque link.
     * @param {string} id Source UUID. @return {Promise<Object>} Current source.
     * @throws {DrawingSourceError|Error} If the source is unavailable or its response is malformed.
     */
    async get(id) {
        const record = readDrawing(await this.request(`/api/drawings/${drawingId(id)}`, "GET"));
        if (record.id !== id) throw new DrawingSourceError("The server returned a different drawing.", 0);
        return record;
    }

    /** Save changed polygons only against the last acknowledged source revision.
     * @param {string} id Source UUID. @param {number} expectedRevision Last acknowledged source revision.
     * @param {Object} collection All committed polygons, with stable original IDs.
     * @return {Promise<Object>} Saved source and incremented revision.
     * @throws {DrawingSourceError|Error} If ownership, revision or persistence prevents saving.
     */
    async update(id, expectedRevision, collection) {
        const record = readDrawing(await this.request(`/api/drawings/${drawingId(id)}`, "PUT", {expectedRevision, collection}));
        if (record.id !== id) throw new DrawingSourceError("The server returned a different drawing.", 0);
        return record;
    }

    /** Send private same-site JSON and retain conflict errors for the existing retry UI.
     * @param {string} url Source endpoint. @param {string} method HTTP method. @param {Object} [body] Optional mutation body.
     * @return {Promise<unknown>} Decoded response. @throws {DrawingSourceError|Error} If HTTP or decoding fails.
     */
    async request(url, method, body) {
        const response = await this.fetch(url, {method, credentials: "same-origin", cache: "no-store",
            ...(body === undefined ? {} : {headers: {"Content-Type": "application/json", "X-EOLab-Drawings": "1"}, body: JSON.stringify(body)})});
        let value;
        try { value = await response.json(); }
        catch { throw new DrawingSourceError("The drawing service returned an unreadable response. Try again.", response.status); }
        if (!response.ok) {
            const details = Array.isArray(value?.detail) ? value.detail.map(part => part?.msg).filter(part => typeof part === "string") : [];
            throw new DrawingSourceError(typeof value?.detail === "string" ? value.detail : details.join(" ") || "The drawing could not be saved. Try again.", response.status);
        }
        return value;
    }
}
