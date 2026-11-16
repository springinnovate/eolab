/** Same-site persistence and parcel identity checks for private planning tools. */

/**
 * @typedef {{id:string,definition:Object}} PlanningLayer
 * @typedef {{id:string,label:string}} PlanningIntervention
 * @typedef {{title:string,layers:PlanningLayer[],aoiLayerId:string,parcelLayerId:string,parcelIdField:string,interventions:PlanningIntervention[]}} PlanningDocument
 * @typedef {PlanningDocument & {id:string,revision:number,createdAt:string,updatedAt:string}} PlanningRecord
 * @typedef {{id:string,title:string,revision:number,createdAt:string,updatedAt:string}} PlanningSummary
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Report a Planning failure while retaining its HTTP status for conflict feedback. */
export class PlanningRequestError extends Error {
    /** @param {string} message User-facing explanation. @param {number} status HTTP status or zero for an invalid response. */
    constructor(message, status) { super(message); this.name = "PlanningRequestError"; this.status = status; }
}

/** Validate an opaque identifier before placing it in a URL.
 * @param {unknown} value Candidate UUID. @return {string} Accepted identifier.
 * @throws {PlanningRequestError} If the identifier is invalid.
 */
function planningId(value) {
    if (typeof value !== "string" || !UUID.test(value)) throw new PlanningRequestError("The planning tool identifier is invalid.", 0);
    return value;
}

/** Check metadata received across the API boundary.
 * @param {unknown} value Candidate record. @return {PlanningSummary} Record with usable identity and revision.
 * @throws {PlanningRequestError} If the response is malformed.
 */
function parseSummary(value) {
    if (!value || typeof value !== "object" || typeof value.title !== "string" || !value.title.trim() ||
        !Number.isSafeInteger(value.revision) || value.revision < 1 ||
        typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") {
        throw new PlanningRequestError("The planning tool response is invalid. Reload to try again.", 0);
    }
    planningId(value.id);
    return value;
}

/** Check Planning fields; portable definitions are validated by their owner on restoration.
 * @param {unknown} value Candidate complete record. @return {PlanningRecord} Detached server record.
 * @throws {PlanningRequestError} If its Planning structure is malformed.
 */
function parseRecord(value) {
    parseSummary(value);
    if (!Array.isArray(value.layers) || value.layers.length < 1 || value.layers.length > 2 ||
        !Array.isArray(value.interventions) || !value.interventions.length || typeof value.parcelIdField !== "string" || !value.parcelIdField) {
        throw new PlanningRequestError("The planning tool configuration is invalid.", 0);
    }
    const layerIds = value.layers.map(layer => {
        planningId(layer?.id);
        if (!layer.definition || typeof layer.definition !== "object") throw new PlanningRequestError("A saved layer definition is missing.", 0);
        return layer.id;
    });
    if (new Set(layerIds).size !== layerIds.length || !layerIds.includes(value.aoiLayerId) || !layerIds.includes(value.parcelLayerId)) {
        throw new PlanningRequestError("The saved area or parcel layer is unavailable.", 0);
    }
    const interventionIds = value.interventions.map(intervention => {
        planningId(intervention?.id);
        if (typeof intervention.label !== "string" || !intervention.label.trim()) throw new PlanningRequestError("A saved intervention name is missing.", 0);
        return intervention.id;
    });
    if (new Set(interventionIds).size !== interventionIds.length) throw new PlanningRequestError("The saved intervention identifiers are invalid.", 0);
    return structuredClone(value);
}

/** Read and save browser-owned planning tools without map dependencies. */
export class PlanningApiClient {
    /** @param {typeof fetch} [fetchImplementation=globalThis.fetch] Same-site HTTP transport. */
    constructor(fetchImplementation = globalThis.fetch.bind(globalThis)) { this.fetch = fetchImplementation; }

    /** List this browser's saved tools.
     * @param {AbortSignal} [signal] Cancel obsolete loading. @return {Promise<PlanningSummary[]>} Saved summaries.
     * @throws {PlanningRequestError|Error} If the response fails or is malformed.
     */
    async list(signal) {
        const value = await this.request("/api/planning/tools", "GET", undefined, signal);
        if (!Array.isArray(value)) throw new PlanningRequestError("The planning tool list is invalid.", 0);
        return value.map(parseSummary);
    }

    /** Load this browser's complete saved tool.
     * @param {string} id Tool UUID. @param {AbortSignal} [signal] Cancel obsolete loading.
     * @return {Promise<PlanningRecord>} Configuration and revision.
     * @throws {PlanningRequestError|Error} If unavailable, unauthorized or malformed.
     */
    async get(id, signal) {
        const value = parseRecord(await this.request(`/api/planning/tools/${planningId(id)}`, "GET", undefined, signal));
        if (value.id !== id) throw new PlanningRequestError("The server returned a different planning tool.", 0);
        return value;
    }

    /** Save a new tool; the server validates original parcel IDs.
     * @param {PlanningDocument} document Current layer settings and author choices.
     * @param {AbortSignal} [signal] Cancel response waiting. @return {Promise<PlanningRecord>} Saved tool.
     * @throws {PlanningRequestError|Error} If validation or persistence fails.
     */
    async create(document, signal) { return parseRecord(await this.request("/api/planning/tools", "POST", document, signal)); }

    /** Save against the opened revision, preserving concurrent changes.
     * @param {string} id Tool UUID. @param {number} expectedRevision Opened revision.
     * @param {PlanningDocument} document Current settings. @param {AbortSignal} [signal] Cancel waiting.
     * @return {Promise<PlanningRecord>} Saved configuration and new revision.
     * @throws {PlanningRequestError|Error} If the revision conflicts or saving fails.
     */
    async update(id, expectedRevision, document, signal) {
        const value = parseRecord(await this.request(`/api/planning/tools/${planningId(id)}`, "PUT", {...document, expectedRevision}, signal));
        if (value.id !== id) throw new PlanningRequestError("The server returned a different planning tool.", 0);
        return value;
    }

    /** Check original IDs across the source without changing its filter.
     * @param {{collectionId:string,itemId:string}} source Catalog identity. @param {string} idField Original ID field.
     * @param {AbortSignal} [signal] Cancel a superseded check.
     * @return {Promise<{idField:string,idType:"integer"|"string",featureCount:number,selection:Object}>} Complete validation.
     * @throws {PlanningRequestError|Error} If IDs or the response are invalid.
     */
    async validateIds(source, idField, signal) {
        const value = await this.request("/api/vector-sampling/parcels/validate-id", "POST",
            {collectionId: source.collectionId, itemId: source.itemId, idField}, signal);
        if (value?.idField !== idField || !["integer", "string"].includes(value.idType) ||
            !Number.isSafeInteger(value.featureCount) || value.featureCount < 0 ||
            value.selection?.collectionId !== source.collectionId || value.selection?.itemId !== source.itemId) {
            throw new PlanningRequestError("The parcel ID check returned an invalid result.", 0);
        }
        return value;
    }

    /** Send same-site JSON without converting cancellation into a domain error.
     * @param {string} url API endpoint. @param {string} method HTTP method.
     * @param {Object|undefined} body Optional JSON. @param {AbortSignal} [signal] Caller cancellation.
     * @return {Promise<unknown>} Decoded JSON. @throws {PlanningRequestError|Error} For request or response failures.
     */
    async request(url, method, body, signal) {
        const response = await this.fetch(url, {method, signal, credentials: "same-origin", cache: "no-store",
            ...(body === undefined ? {} : {headers: {"Content-Type": "application/json", "X-EOLab-Planning": "1"}, body: JSON.stringify(body)})});
        let value;
        try { value = await response.json(); }
        catch (error) {
            if (error.name === "AbortError") throw error;
            throw new PlanningRequestError("The planning service returned an unreadable response.", response.status);
        }
        if (!response.ok) {
            const details = Array.isArray(value?.detail) ? value.detail.map(detail => detail?.msg).filter(message => typeof message === "string") : [];
            const message = typeof value?.detail === "string" ? value.detail : details.join(" ") || "The planning request could not be completed.";
            throw new PlanningRequestError(message, response.status);
        }
        return value;
    }
}
