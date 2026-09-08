/** Same-origin Processing API. Only catalog identities and opaque job/area IDs cross this boundary. */
import { normalizeRasterSamplingArea } from "../selected-area.js";

/** Browser-safe HTTP failure; transport failures remain ordinary errors. */
export class ProcessingRequestError extends Error {
    /** @param {string} message User-facing detail. @param {number} status HTTP status. @param {string|null} code Stable reason. */
    constructor(message, status, code = null) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/** Validate opaque API path identities. @param {string} id Candidate ID. @return {string} Validated ID. */
function opaqueId(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(id)) {
        throw new TypeError("Invalid processing identity.");
    }
    return id;
}

/** Validate fields used to review native output dimensions. @param {Object} grid API grid. @return {void} */
function validateGrid(grid) {
    if (!grid || ![grid.width, grid.height].every(value => Number.isSafeInteger(value) && value > 0) ||
        typeof grid.crs !== "string" || typeof grid.dtype !== "string" ||
        !Array.isArray(grid.transform) || grid.transform.length !== 6 || !grid.transform.every(Number.isFinite)) {
        throw new Error("Processing returned an invalid native grid.");
    }
}

/** Validate a public owned job before presenting actions. @param {Object} job API response. @return {Object} Validated job. */
function validateJob(job) {
    opaqueId(job?.jobId);
    if (!["queued", "running", "cancelling", "ready", "failed", "cancelled", "interrupted", "expired", "deleted"].includes(job.status) ||
        !job.progress || typeof job.progress !== "object") throw new Error("Processing returned an invalid job state.");
    if (job.grid) validateGrid(job.grid);
    if (job.result) {
        processingDownloadUrl(job.result.url, job.jobId, "result");
        processingDownloadUrl(job.result.provenanceUrl, job.jobId, "provenance");
    }
    return job;
}

/** Own HTTP serialization and cookie-session establishment for Downloads. */
export class ProcessingApiClient {
    /** @param {Function} [fetchImplementation=globalThis.fetch] Same-origin HTTP transport. */
    constructor(fetchImplementation = globalThis.fetch) {
        this.fetch = fetchImplementation;
        this.session = null;
    }

    /** Establish the cookie before concurrent requests. @return {Promise<Object>} Initial job listing. */
    ensureSession() {
        this.session ??= this.request("/jobs").catch((error) => {
            this.session = null;
            throw error;
        });
        return this.session;
    }

    /** Recover owned jobs independently of current map state. @return {Promise<Object[]>} Recent jobs. */
    async listJobs() {
        const response = this.session === null
            ? await this.ensureSession()
            : (await this.ensureSession(), await this.request("/jobs"));
        if (!Array.isArray(response.jobs)) throw new Error("Invalid processing job list.");
        return response.jobs.map(validateJob);
    }

    /**
     * Review a catalog raster and explicit immutable area, without starting work.
     * @param {{collectionId:string,itemId:string}} source Catalog identity.
     * @param {Object} area Selected rectangle or ready AOI reference.
     * @param {AbortSignal} signal Cancels superseded planning.
     * @return {Promise<Object>} Native-grid estimate and expiring plan.
     */
    async planClip(source, area, signal) {
        const selected = normalizeRasterSamplingArea(area);
        if (selected.kind === "wholeRaster") throw new Error("Select a box or uploaded AOI first.");
        if (![source.collectionId, source.itemId].every(value => typeof value === "string" && value.length > 0)) {
            throw new TypeError("A Catalog raster is required.");
        }
        await this.ensureSession();
        const plan = await this.request("/raster-clips/plan", "POST", {
            collectionId: source.collectionId, itemId: source.itemId,
            ...(selected.kind === "selectedArea"
                ? { selectedBounds: selected.selectedBounds }
                : { temporaryAoiId: selected.temporaryAoiId }),
        }, signal);
        opaqueId(plan.planId);
        validateGrid(plan.grid);
        if (!Number.isFinite(Date.parse(plan.expiresAt)) || !Number.isSafeInteger(plan.grid.estimatedRawBytes) ||
            plan.grid.estimatedRawBytes < 1 || !["bounds", "aoi"].includes(plan.area?.kind) ||
            !Array.isArray(plan.area.bounds) || plan.area.bounds.length !== 4 || !plan.area.bounds.every(Number.isFinite)) {
            throw new Error("Processing returned an invalid clip estimate.");
        }
        return plan;
    }

    /** Submit or safely retry one reviewed plan. @param {Object} submission Stable planId/requestId. @return {Promise<Object>} Owned job. */
    async submitClip(submission) {
        await this.ensureSession();
        return validateJob(await this.request("/raster-clips", "POST", submission));
    }

    /** Cancel an owned active job. @param {string} id Job ID. @return {Promise<Object>} Updated job. */
    async cancelJob(id) {
        await this.ensureSession();
        return this.request(`/jobs/${opaqueId(id)}/cancel`, "POST");
    }

    /** Revoke an owned terminal result. @param {string} id Job ID. @return {Promise<Object>} Updated job. */
    async deleteJob(id) {
        await this.ensureSession();
        return this.request(`/jobs/${opaqueId(id)}`, "DELETE");
    }

    /**
     * Send one bounded JSON request and preserve classified API errors.
     * @param {string} path Owned endpoint suffix. @param {string} [method="GET"] HTTP method.
     * @param {Object|undefined} body JSON input. @param {AbortSignal|undefined} signal Planning cancellation.
     * @return {Promise<Object>} Parsed response.
     */
    async request(path, method = "GET", body, signal) {
        const response = await this.fetch.call(globalThis, `/api/processing${path}`, {
            method, credentials: "same-origin", cache: "no-store", signal,
            headers: {
                Accept: "application/json",
                ...(method === "GET" ? {} : { "X-EOLab-Processing": "1" }),
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
            const detail = data?.detail;
            throw new ProcessingRequestError(
                typeof detail === "string" ? detail : detail?.message ?? `Processing request failed (${response.status}).`,
                response.status, detail?.code ?? null,
            );
        }
        if (data === null) throw new Error("Processing returned an unreadable response. Retry to recover your jobs.");
        return data;
    }
}

/**
 * Allow direct browser navigation only to the owned result endpoints.
 * @param {string} value API-supplied relative URL. @param {string} id Owning job.
 * @param {"result"|"provenance"} kind Artifact type. @return {string} Safe local download URL.
 */
export function processingDownloadUrl(value, id, kind) {
    const expected = `/api/processing/jobs/${opaqueId(id)}/${kind}`;
    if (!["result", "provenance"].includes(kind) || value !== expected) {
        throw new TypeError("Invalid processing download address.");
    }
    return expected;
}
