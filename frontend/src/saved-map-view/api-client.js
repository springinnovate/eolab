/** Same-site publication, retrieval and administrator updates of named maps. */
import { parseSavedMapView, MAX_SAVED_MAP_VIEW_BYTES } from "./model.js";

export const MAP_LINK_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Suggest a readable URL name while leaving the creator free to edit it.
 * @param {string} title Creator's map title.
 * @return {string} Lowercase ASCII URL name, possibly empty.
 */
export function suggestMapLinkName(title) {
    return title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80).replace(/-$/, "");
}

/**
 * Identify a named-map route without allowing a malformed name to become authoring mode.
 * @param {string} pathname Current URL path.
 * @return {string|null} Candidate link name (validated before fetching), or null outside /maps/.
 */
export function namedMapSlugFromPath(pathname) {
    return pathname.startsWith("/maps/") ? pathname.slice(6).replace(/\/$/, "") : null;
}

/**
 * Identify the authenticated editor route without accepting a query-string mode switch.
 * @param {string} pathname Current URL path.
 * @return {string|null} Map URL name, or null outside the admin editor.
 */
export function editableMapSlugFromPath(pathname) {
    return /^\/admin-eolab\/maps\/([^/]+)\/edit\/?$/.exec(pathname)?.[1] ?? null;
}

/**
 * Validate publication labels at the browser/API boundary.
 * @param {Object} fields Title, optional subtitle and URL name.
 * @return {{title:string,subtitle:string,slug:string}} Trimmed metadata.
 * @throws {Error} If a label is absent, too long or not a valid link name.
 */
export function validateMapPublication(fields) {
    const { title, subtitle = "", slug } = fields;
    if (typeof title !== "string" || !title.trim() || title.trim().length > 160) {
        throw new Error("Map title must contain 1–160 characters.");
    }
    if (typeof subtitle !== "string" || subtitle.trim().length > 240) {
        throw new Error("Map subtitle must be 240 characters or fewer.");
    }
    validateLinkName(slug);
    return { title: title.trim(), subtitle: subtitle.trim(), slug };
}

/**
 * Reject ambiguous URL names before constructing an API path.
 * @param {unknown} slug Candidate link name.
 * @return {void}
 * @throws {Error} If it contains unsupported characters or exceeds 80 characters.
 */
function validateLinkName(slug) {
    if (typeof slug !== "string" || slug.length > 80 || !MAP_LINK_NAME_PATTERN.test(slug)) {
        throw new Error("Link name must use 1–80 lowercase letters, numbers and single hyphens.");
    }
}

/** Read and create maps without contacting their catalog or annotation sources. */
export class SavedMapApiClient {
    /**
     * Configure the existing same-site API transport.
     * @param {typeof fetch} [fetchImplementation] HTTP request implementation.
     */
    constructor(fetchImplementation = globalThis.fetch) {
        this.fetch = (url, options) => fetchImplementation(url, options);
    }

    /**
     * Save a new named map; a taken name never overwrites another map.
     * @param {Object} candidate Publication labels and captured view.
     * @return {Promise<Object>} Validated stored record.
     * @throws {Error} For invalid input, duplicate name, capacity or transport failure.
     */
    async create(candidate) {
        const fields = validateMapPublication(candidate);
        const view = parseSavedMapView(JSON.stringify(candidate.view));
        return this.#request("", { method: "POST", headers: { "Content-Type": "application/json", "X-EOLab-Saved-Maps": "1" },
            body: JSON.stringify({ ...fields, view }) }, fields.slug);
    }

    /**
     * Retrieve a named map from this site without changing it.
     * @param {string} slug Exact URL name.
     * @return {Promise<Object>} Validated saved title, subtitle and view.
     * @throws {Error} If the name is invalid, missing, unavailable or malformed.
     */
    async get(slug) {
        validateLinkName(slug);
        return this.#request(`/${slug}`, { method: "GET" }, slug);
    }

    /**
     * Load a published map and its revision through administrator authentication.
     * @param {string} slug Fixed map URL name.
     * @return {Promise<Object>} Validated map with a required revision.
     * @throws {Error} If unauthorized, absent, unavailable or malformed.
     */
    async getForEditing(slug) {
        validateLinkName(slug);
        return this.#request(`/${slug}`, { method: "GET" }, slug, true);
    }

    /**
     * Save a replacement configuration only against the revision opened for editing.
     * @param {string} slug Fixed URL name.
     * @param {Object} candidate Map labels, view and opened revision.
     * @return {Promise<Object>} Updated map and new revision.
     * @throws {Error} If validation, authorization, revision matching or storage fails.
     */
    async update(slug, candidate) {
        const fields = validateMapPublication({ ...candidate, slug });
        if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 1) throw new Error("Reload the map before editing.");
        const view = parseSavedMapView(JSON.stringify(candidate.view));
        return this.#request(`/${slug}`, { method: "PUT",
            headers: { "Content-Type": "application/json", "X-EOLab-Admin": "1" },
            body: JSON.stringify({ ...fields, view, revision: candidate.revision }) }, slug, true);
    }

    /**
     * Fetch a bounded saved-map response and validate its identity and document.
     * @param {string} suffix Validated API path suffix.
     * @param {RequestInit} options Request method and optional JSON body.
     * @param {string} slug Expected record identity.
     * @param {boolean} [administration=false] Use the authenticated editing API and validate its revision.
     * @return {Promise<Object>} Canonical publication labels and view.
     * @throws {Error} For HTTP, timeout, size, JSON or response-contract failures.
     */
    async #request(suffix, options, slug, administration = false) {
        const response = await this.fetch(`/api/${administration ? "admin/" : ""}saved-maps${suffix}`, {
            ...options, cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(15000),
        });
        if (!response.body) throw new Error("Saved-map service returned an empty response. Try again shortly.");
        const reader = response.body.getReader();
        const chunks = []; let size = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > MAX_SAVED_MAP_VIEW_BYTES + 4096) throw new Error("Saved map response exceeds its size limit.");
                chunks.push(value);
            }
        } finally {
            await reader.cancel();
            reader.releaseLock();
        }
        let record;
        try { record = JSON.parse(await new Blob(chunks).text()); }
        catch { throw new Error("Saved-map service returned an unreadable response. Try again shortly."); }
        if (!response.ok) {
            throw new Error(typeof record?.detail === "string" ? record.detail : `Saved-map request failed (${response.status}). Try again shortly.`);
        }
        const fields = validateMapPublication(record);
        if (fields.slug !== slug) throw new Error("Saved-map service returned a different map.");
        if (administration && (!Number.isSafeInteger(record.revision) || record.revision < 1)) {
            throw new Error("Saved-map service returned an invalid revision. Reload before editing.");
        }
        return { ...fields, view: parseSavedMapView(JSON.stringify(record.view)),
            ...(administration ? { revision: record.revision } : {}) };
    }
}
