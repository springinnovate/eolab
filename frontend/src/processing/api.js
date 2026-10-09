/** Same-origin Processing API for catalog rasters, owned polygon inputs and job results. */
import { normalizeRasterSamplingArea } from "../selected-area.js";
import { normalizeCalculationArea, validatePolygonAreaReference } from "./calculation-area.js";
import { calculationPixelPoint, chunkPixels } from "./calculation-session.js";

/** Browser-safe HTTP failure; transport failures remain ordinary errors. */
export class ProcessingRequestError extends Error {
    /** @param {string} message User-facing detail. @param {number} status HTTP status.
     * @param {string|null} [code=null] Stable reason.
     * @param {number|null} [retryAfterSeconds=null] Server's minimum retry delay.
     */
    constructor(message, status, code = null, retryAfterSeconds = null) {
        super(message);
        this.status = status;
        this.code = code;
        this.retryAfterSeconds = retryAfterSeconds;
    }
    /** Whether queue capacity or a stopping attempt temporarily prevented admission.
     * Storage exhaustion and unknown errors require attention instead of automatic retry.
     * @return {boolean} True when admission can be retried with the same request ID.
     */
    get isCapacityRejection() {
        return this.status === 429 && ["owner_queue_full", "queue_full", "previous_attempt_stopping"].includes(this.code);
    }
}

/** Pause before retrying a request rejected or expired while waiting for capacity.
 * Retry-After sets the minimum delay. Repeated rejections back off to 30 seconds,
 * with jitter so concurrent tabs do not all retry together. The caller retains the
 * request until it succeeds or is cancelled. The timer does not check server
 * capacity or submit work; its caller must try admission again after the delay.
 * @param {ProcessingRequestError} error Capacity rejection or planning-queue timeout.
 * @param {number} attempt Number of preceding capacity waits for this request.
 * @param {AbortSignal|undefined} signal Cancel this wait when its calculation changes.
 * @return {Promise<void>} Resolves when the retry delay has elapsed.
 * @throws {DOMException} AbortError when the caller cancels.
 */
export function waitBeforeCapacityRetry(error, attempt, signal) {
    signal?.throwIfAborted();
    const seconds = Math.max(error.retryAfterSeconds ?? 0, Math.min(30, 5 * 2 ** Math.min(attempt, 3)));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, seconds * 1000 + Math.random() * 1000);
        const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(signal.reason); };
        signal?.addEventListener("abort", cancel, { once: true });
    });
}

/** Validate opaque API path identities. @param {string} id Candidate ID. @return {string} Validated ID. */
function opaqueId(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(id)) {
        throw new TypeError("Invalid processing identity.");
    }
    return id;
}

/** Validate fields used to review native output dimensions.
 * @param {Object} grid API grid.
 * @param {string} operation Job operation, permitting empty aggregate reads outside coverage.
 * @return {void}
 * @throws {Error} If dimensions or execution metadata violate their bounded contract.
 */
function validateGrid(grid, operation) {
    const empty = grid?.width === 0 && grid?.height === 0;
    if (!grid || ![grid.width, grid.height].every(value => Number.isSafeInteger(value) && value >= 0) ||
        (grid.width === 0 || grid.height === 0) && !empty ||
        empty && (operation !== "raster.aggregate.v1" || grid.nativeBlocks !== 0 || grid.decodedBytes !== 0 || grid.execution?.readWindows !== 0) ||
        typeof grid.crs !== "string" || typeof grid.dtype !== "string" ||
        !Array.isArray(grid.transform) || grid.transform.length !== 6 || !grid.transform.every(Number.isFinite)) {
        throw new Error("Processing returned an invalid native grid.");
    }
    if (grid.execution) validateExecution(grid.execution);
}

/** Validate bounded execution metadata, including a zero-read point outside coverage.
 * @param {Object} value Plan. @return {void}
 * @throws {Error} If batch dimensions or read-window count are invalid.
 */
function validateExecution(value) {
    chunkPixels(value.targetChunkPixels);
    if (![value.readWidth, value.readHeight, value.evaluationWidth, value.evaluationHeight]
        .every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(value.readWindows) || value.readWindows < 0 || value.readWindows > 65536 ||
        value.evaluationWidth > value.readWidth || value.evaluationHeight > value.readHeight) {
        throw new Error("Processing returned invalid batch dimensions.");
    }
}

/** Validate a public owned job before presenting values or download actions.
 * @param {Object} job API response, including optional cache metadata.
 * @return {Object} Validated job.
 * @throws {Error} If the lifecycle, results, metadata or download links are invalid.
 */
function validateJob(job) {
    opaqueId(job?.jobId);
    if (!["queued", "running", "cancelling", "ready", "failed", "cancelled", "interrupted", "expired", "deleted"].includes(job.status) ||
        !job.progress || typeof job.progress !== "object") throw new Error("Processing returned an invalid job state.");
    if (job.operation === "model.run.v1") {
        validateModelIdentity(job.model);
        if (typeof job.label !== "string" || !["createdAt", "updatedAt"].every(key => Number.isFinite(Date.parse(job[key]))) ||
            !["expiresAt", "metadataExpiresAt"].every(key => job[key] === null || Number.isFinite(Date.parse(job[key]))) ||
            ![job.progress.completed, job.progress.total].every(value => value == null || Number.isSafeInteger(value) && value >= 0) ||
            job.progress.completed != null && job.progress.total != null && job.progress.completed > job.progress.total)
            throw new Error("Processing returned invalid model run details.");
    }
    if (job.grid) validateGrid(job.grid, job.operation);
    if (job.result) {
        processingDownloadUrl(job.result.url, job.jobId, "result");
        processingDownloadUrl(job.result.provenanceUrl, job.jobId, "provenance");
        if (job.operation === "model.run.v1" && job.result.kind === "raster") {
            const result = job.result;
            if (result.mediaType !== "image/tiff" || typeof result.filename !== "string" || !result.filename ||
                !Number.isSafeInteger(result.bytes) || result.bytes <= 0 || !/^[a-f0-9]{64}$/.test(result.sha256) ||
                !Number.isSafeInteger(result.validPixels) || result.validPixels < 1 || result.rows !== undefined)
                throw new Error("Processing returned invalid raster result details.");
            validateGrid(result.grid, "raster.clip.v1");
            if (result.validPixels > result.grid.width * result.grid.height)
                throw new Error("Processing returned invalid raster validity counts.");
        } else if (["raster.aggregate.v1", "model.run.v1"].includes(job.operation)) {
            if (job.operation === "model.run.v1" && job.result.kind !== undefined)
                throw new Error("Processing returned an unsupported model result type.");
            validateCalculationRows(job.result.rows);
            if (job.result.cacheHit != null && typeof job.result.cacheHit !== "boolean") {
                throw new Error("Processing returned invalid cache metadata.");
            }
        }
    }
    return job;
}

/** Validate the bounded typed table consumed by inline results. @param {Object[]} rows API values. @return {void} */
function validateCalculationRows(rows) {
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5 || rows.some(row =>
        typeof row.label !== "string" || typeof row.expression !== "string" ||
        !["ok", "no_matches", "no_valid_data", "invalid_arithmetic", "overflow"].includes(row.state) ||
        !(row.value === null || typeof row.value === "string" &&
            (row.valueType === "integer" ? /^-?\d+$/.test(row.value) : row.valueType === "float" && Number.isFinite(Number(row.value)))) ||
        !Array.isArray(row.aggregates) || row.aggregates.some(aggregate =>
            typeof aggregate.function !== "string" ||
            ![aggregate.validPixels, aggregate.matchedPixels, aggregate.invalidArithmeticPixels]
                .every(value => Number.isSafeInteger(value) && value >= 0)))) {
        throw new Error("Processing returned an invalid calculation result table.");
    }
}

/** Check a model identity before building URLs or recovering saved inputs.
 * @param {Object} model Model ID, version and definition checksum.
 * @return {Object} Validated identity.
 * @throws {Error} If identity fields are malformed.
 */
function validateModelIdentity(model) {
    if (!model || !/^[a-z][a-z0-9_-]{0,63}$/.test(model.id) ||
        !/^\d+\.\d+\.\d+$/.test(model.version) || model.version.length > 32 ||
        !/^[a-f0-9]{64}$/.test(model.definitionSha256)) throw new Error("Invalid model identity.");
    return model;
}

/** Check the recipe fields used to construct a setup form.
 * @param {Object} model Installed recipe with its checksum.
 * @return {Object} Validated recipe.
 * @throws {Error} If the recipe is missing its display or form fields.
 */
function validateAvailableModel(model) {
    validateModelIdentity(model);
    if (model.schema !== "eolab.model/v1" || typeof model.title !== "string" || typeof model.description !== "string" ||
        ![model.inputs, model.parameters, model.outputs].every(value => value && typeof value === "object" && !Array.isArray(value)) ||
        !Object.values(model.inputs).every(input => typeof input?.type === "string" && typeof input.label === "string") ||
        !Object.values(model.parameters).every(parameter => typeof parameter?.type === "string" && typeof parameter.label === "string"))
        throw new Error("Invalid model setup definition.");
    return model;
}

/** Own HTTP serialization and cookie-session establishment for Downloads. */
export class ProcessingApiClient {
    /** @param {Function} [fetchImplementation=globalThis.fetch] Same-origin HTTP transport.
     * @param {Function|undefined} [eventSource=globalThis.EventSource] Optional browser SSE transport. */
    constructor(fetchImplementation = globalThis.fetch, eventSource = globalThis.EventSource) {
        this.fetch = fetchImplementation;
        this.EventSource = eventSource;
        this.session = null;
        this.eventListeners = new Set();
        this.eventStream = null;
        this.pendingCalculations = [];
    }

    /** Share one event stream for planning and job observers after cookie setup.
     * Only fixed changed hints trigger authoritative status reads.
     * @param {Function} changed Request an authoritative job refresh.
     * @return {Function|null} Close the connection, or null when SSE is unavailable. */
    watchJobs(changed) {
        if (typeof this.EventSource !== "function") return null;
        try {
            let closed = false;
            if (!this.eventStream) {
                const source = new this.EventSource("/api/processing/events");
                const receive = event => {
                    if (event.data === "{}") {
                        for (const listener of this.eventListeners) listener();
                    }
                };
                source.addEventListener("changed", receive);
                this.eventStream = {source, receive};
            }
            // Give each subscription its own identity even if a callback is reused.
            const listener = () => { if (!closed) changed(); };
            this.eventListeners.add(listener);
            return () => {
                if (closed) return;
                closed = true;
                this.eventListeners.delete(listener);
                if (this.eventListeners.size === 0) {
                    const {source, receive} = this.eventStream;
                    source.removeEventListener("changed", receive);
                    source.close();
                    this.eventStream = null;
                }
            };
        } catch { return null; } // The existing two-second poll remains authoritative.
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

    /** Read every requested job without relying on the recent-history limit.
     * Larger sets use batches of 100 IDs; no per-job HTTP lookups are needed.
     * @param {string[]} jobIds Public job IDs belonging to this browser session.
     * @return {Promise<{jobs:Object[], unavailableJobIds:string[]}>} Snapshots and unavailable IDs.
     * @throws {Error} If an ID, request, or response is invalid or incomplete.
     */
    async readJobStatuses(jobIds) {
        const requested = [...new Set(jobIds.map(opaqueId))];
        const result = {jobs: [], unavailableJobIds: []};
        await this.ensureSession();
        for (let offset = 0; offset < requested.length; offset += 100) {
            const batch = requested.slice(offset, offset + 100);
            const response = await this.request("/jobs/status", "POST", {jobIds: batch});
            if (!Array.isArray(response.jobs) || !Array.isArray(response.unavailableJobIds))
                throw new Error("Invalid processing status response.");
            const jobs = response.jobs.map(validateJob);
            const unavailable = response.unavailableJobIds.map(opaqueId);
            const returned = [...jobs.map(job => job.jobId), ...unavailable];
            if (returned.length !== batch.length || new Set(returned).size !== batch.length ||
                returned.some(id => !batch.includes(id))) throw new Error("Incomplete processing status response.");
            result.jobs.push(...jobs);
            result.unavailableJobIds.push(...unavailable);
        }
        return result;
    }

    /** Submit complete clip inputs with a stable retry key.
     * @param {Object} submission Captured catalog source, explicit area and requestId.
     * @return {Promise<Object>} Owned queued job; the worker supplies its grid later.
     * @throws {Error} If inputs, admission or the returned job are invalid.
     */
    async submitClip(submission) {
        const {source, requestId} = submission;
        const selected = normalizeRasterSamplingArea(submission.area);
        if (!["selectedArea", "catalogSelection"].includes(selected.kind)) throw new Error("Select a box or catalog vector first.");
        await this.ensureSession();
        return validateJob(await this.request("/raster-clips", "POST", {
            collectionId: source.collectionId, itemId: source.itemId, requestId,
            ...(selected.kind === "selectedArea" ? {selectedBounds: selected.selectedBounds}
                : {catalogSelection: selected.catalogSelection}),
        }));
    }

    /** Validate expressions without opening a raster. @param {Object[]} calculations Named expressions. @param {AbortSignal} signal Superseded edit. @return {Promise<Object>} Validation. */
    async validateCalculation(calculations, signal) {
        await this.ensureSession();
        return this.request("/raster-calculations/validate", "POST", { alias: "a", calculations }, signal);
    }

    /** Upload exact polygons once and receive a private, expiring calculation reference.
     * @param {Object[]} polygons GeoJSON Polygon geometries, excluding feature properties.
     * @param {AbortSignal} [signal] Optional cancellation of the upload request.
     * @return {Promise<Object>} Reference, geographic bounds and polygon count.
     * @throws {Error} If upload fails or the returned area is malformed.
     */
    async uploadPolygonArea(polygons, signal) {
        await this.ensureSession();
        const area = await this.request("/polygon-areas", "POST", { polygons }, signal);
        validatePolygonAreaReference(area.polygonArea);
        if (!Array.isArray(area.bbox) || area.bbox.length !== 4 || !area.bbox.every(Number.isFinite) ||
            !Number.isSafeInteger(area.matched) || area.matched < 1) throw new Error("Invalid polygon area response.");
        return area;
    }

    /** Release an obsolete polygon upload; submitted jobs retain their exact area.
     * @param {string} id Private Processing input ID.
     * @return {Promise<Object>} Idempotent deletion acknowledgement.
     * @throws {Error} If the request fails.
     */
    async discardPolygonArea(id) {
        await this.ensureSession();
        return this.request(`/polygon-areas/${opaqueId(id)}`, "DELETE");
    }

    /** Queue complete inputs, coalescing submissions ready in the same microtask turn.
     * Each caller retains its independent promise, retry key and cancellation lifecycle.
     * @param {Object} submission Source, area, formulas, optional pixelPoint and stable requestId.
     * @return {Promise<Object>} Owned job with progress and results as the worker produces them.
     * @throws {ProcessingRequestError|Error} If admission fails or the response is invalid.
     */
    async submitCalculation(submission) {
        await this.ensureSession();
        const area = normalizeCalculationArea(submission.area);
        const pixelPoint = calculationPixelPoint(submission.calculations, submission.pixelPoint);
        const body = {
            requestId: submission.requestId,
            sources: {a: {collectionId: submission.source.collectionId, itemId: submission.source.itemId}},
            calculations: submission.calculations,
            ...(pixelPoint ? { pixelPoint } : {}),
            ...(chunkPixels(submission.targetChunkPixels) == null ? {} : {targetChunkPixels: submission.targetChunkPixels}),
            ...(area.kind === "selectedArea" ? {selectedBounds: area.selectedBounds}
                : area.kind === "catalogSelection" ? {catalogSelection: area.catalogSelection}
                : area.kind === "polygonArea" ? {polygonArea: area.polygonArea} : {wholeRaster: true}),
        };
        if (new TextEncoder().encode(JSON.stringify(body)).length > 16 * 1024) {
            throw new ProcessingRequestError("Each calculation must fit within 16 KiB.", 413, "request_too_large");
        }
        return new Promise((resolve, reject) => {
            this.pendingCalculations.push({body, resolve, reject});
            if (this.pendingCalculations.length === 1) queueMicrotask(() => {
                const pending = this.pendingCalculations;
                this.pendingCalculations = [];
                for (let offset = 0; offset < pending.length; offset += 50)
                    void this.sendCalculationBatch(pending.slice(offset, offset + 50));
            });
        });
    }

    /** Send one bounded admission batch and settle every independent submission.
     * Unknown outcomes reject with the original transport error so executors retain
     * their saved keys. Per-item capacity errors reuse the existing retry behavior.
     * @param {{body:Object, resolve:function(Object):void, reject:function(Error):void}[]} pending One to fifty submissions.
     * @return {Promise<void>} All entries settled; callers observe their own promises.
     */
    async sendCalculationBatch(pending) {
        try {
            const response = await this.request("/raster-calculations/batch", "POST", {items: pending.map(item => item.body)});
            const items = response.items;
            if (!Array.isArray(items) || items.length !== pending.length ||
                new Set(items.map(item => item?.index)).size !== pending.length ||
                items.some(item => !Number.isSafeInteger(item?.index) || item.index < 0 || item.index >= pending.length ||
                    Boolean(item.job) === Boolean(item.error))) {
                throw new Error("Incomplete calculation admission response. Retry to recover your jobs.");
            }
            for (const item of items) {
                const caller = pending[item.index];
                try {
                    if (item.job) caller.resolve(validateJob(item.job));
                    else {
                        const {message, status, code, retryAfterSeconds} = item.error;
                        if (typeof message !== "string" || !Number.isInteger(status) || status < 400 || status > 599 ||
                            typeof code !== "string" || !(retryAfterSeconds === null ||
                            Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 && retryAfterSeconds <= 86400))
                            throw new Error("Invalid calculation rejection. Retry to recover your jobs.");
                        caller.reject(new ProcessingRequestError(message, status, code, retryAfterSeconds));
                    }
                } catch (error) { caller.reject(error); }
            }
        } catch (error) { for (const caller of pending) caller.reject(error); }
    }

    /** Discover installed model recipes and their form fields.
     * @return {Promise<Object[]>} Recipes available on this server.
     * @throws {Error} If discovery fails or contains malformed definitions.
     */
    async discoverModels() {
        await this.ensureSession();
        const response = await this.request("/models");
        if (!Array.isArray(response.models)) throw new Error("Invalid model library.");
        return response.models.map(validateAvailableModel);
    }

    /** Read a page of this browser session's model history.
     * @param {string|null} [cursor=null] Continuation returned by the preceding page.
     * @return {Promise<{jobs:Object[],nextCursor:string|null}>} Runs and the next page token.
     * @throws {Error} If the request fails or pagination data is invalid.
     */
    async listModelRuns(cursor = null) {
        await this.ensureSession();
        const response = await this.request(`/model-runs?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        if (!Array.isArray(response.jobs) || !(response.nextCursor === null || typeof response.nextCursor === "string"))
            throw new Error("Invalid model run history.");
        response.jobs.forEach(job => {
            validateJob(job);
            if (job.operation !== "model.run.v1") throw new Error("Unexpected job in model history.");
        });
        return response;
    }

    /** Submit the captured setup with the same request ID on every retry.
     * @param {Object} submission Model identity, inputs, parameters, label and request ID.
     * @return {Promise<Object>} Accepted job status.
     * @throws {ProcessingRequestError|Error} If admission fails or the reply is invalid.
     */
    async submitModelRun(submission) {
        await this.ensureSession();
        const job = validateJob(await this.request("/model-runs", "POST", submission));
        if (job.operation !== "model.run.v1") throw new Error("Unexpected model submission response.");
        return job;
    }

    /** Read the exact recipe and inputs originally accepted for a run.
     * @param {string} id Session-owned model run ID.
     * @return {Promise<Object>} Saved invocation for details or duplication.
     * @throws {Error} If access fails, metadata expired, or the reply is invalid.
     */
    async readModelInvocation(id) {
        await this.ensureSession();
        const invocation = await this.request(`/jobs/${opaqueId(id)}/invocation`);
        validateModelIdentity(invocation.model);
        validateAvailableModel({...invocation.model.definition, definitionSha256: invocation.model.definitionSha256});
        if (!invocation.inputs || !invocation.parameters || typeof invocation.label !== "string")
            throw new Error("Invalid saved model inputs.");
        return invocation;
    }

    /** Build the installed recipe's download address.
     * @param {Object} model Validated model identity.
     * @return {string} Same-origin Model YAML URL.
     * @throws {Error} If the model identity is invalid.
     */
    modelYamlUrl(model) {
        validateModelIdentity(model);
        return `/api/processing/models/${model.id}/versions/${model.version}/yaml`;
    }

    /** Read Model YAML for an inline, text-only preview.
     * @param {Object} model Installed recipe identity.
     * @param {string|null} [jobId=null] Read the accepted recipe instead when supplied.
     * @return {Promise<string>} YAML text.
     * @throws {ProcessingRequestError|Error} If access fails or metadata has expired.
     */
    async readModelYaml(model, jobId = null) {
        await this.ensureSession();
        const url = jobId ? processingDownloadUrl(`/api/processing/jobs/${jobId}/model-yaml`, jobId, "model-yaml") : this.modelYamlUrl(model);
        const response = await this.fetch.call(globalThis, url, {credentials: "same-origin", cache: "no-store", headers: {Accept: "application/yaml"}});
        if (!response.ok) throw new ProcessingRequestError("Model YAML is unavailable or has expired.", response.status);
        return response.text();
    }

    /** Read a tracked job even if it falls outside recent history. @param {string} id Job ID. @return {Promise<Object>} Owned job. */
    async getJob(id) {
        await this.ensureSession();
        return validateJob(await this.request(`/jobs/${opaqueId(id)}`));
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
     * HTTP completion does not imply that a job is ready.
     * @param {string} path Owned endpoint suffix. @param {string} [method="GET"] HTTP method.
     * @param {Object|undefined} body JSON input. @param {AbortSignal|undefined} signal Request cancellation.
     * @return {Promise<Object>} Parsed response.
     * @throws {ProcessingRequestError|Error} HTTP rejection, failed transport, or unreadable JSON.
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
            const retryAfterHeader = response.headers?.get("Retry-After");
            const retryAfterSeconds = retryAfterHeader == null ? NaN : /^\d+(\.\d+)?$/.test(retryAfterHeader)
                ? Number(retryAfterHeader) : (Date.parse(retryAfterHeader) - Date.now()) / 1000;
            throw new ProcessingRequestError(
                typeof detail === "string" ? detail : Array.isArray(detail)
                    ? detail.map(item => item.msg).join("; ")
                    : detail?.message ?? `Processing request failed (${response.status}).`,
                response.status, detail?.code ?? null,
                Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 && retryAfterSeconds <= 86400 ? retryAfterSeconds : null,
            );
        }
        if (data === null) throw new Error("Processing returned an unreadable response. Retry to recover your jobs.");
        return data;
    }
}

/**
 * Allow direct browser navigation only to the owned result endpoints.
 * @param {string} value API-supplied relative URL. @param {string} id Owning job.
 * @param {"result"|"provenance"|"model-yaml"|"run-yaml"} kind Artifact type. @return {string} Safe local download URL.
 */
export function processingDownloadUrl(value, id, kind) {
    const expected = `/api/processing/jobs/${opaqueId(id)}/${kind}`;
    if (!["result", "provenance", "model-yaml", "run-yaml"].includes(kind) || value !== expected) {
        throw new TypeError("Invalid processing download address.");
    }
    return expected;
}
