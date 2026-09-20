/** Bounded per-tab recovery records for independent calculations. */
import { normalizeCalculationArea } from "./calculation-area.js";
const LEGACY_KEY = "eolab.processing.calculation.v1";
const KEY_PREFIX = "eolab.processing.calculation.v2.";
const CLIENT = /^(summary|raster-series:([0-9]|[1-4][0-9]))$/;
const ID = /^[A-Za-z0-9_-]{32}$/;

/** Validate the optional total-pixel execution budget. @param {number|null} value Setting. @return {number|null} Budget. */
export function chunkPixels(value) {
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value < 1 || value > 4194304) throw new TypeError("Batch size must be 1 to 4,194,304 pixels.");
    return value;
}

/** Copy only the public calculation intent. @param {Object} value Candidate intent. @return {Readonly<Object>} Immutable snapshot. */
export function calculationIntent(value) {
    const { collectionId, itemId, label } = value.source;
    if (![collectionId, itemId, label].every(text => typeof text === "string" && text.length > 0 && text.length <= 512)) {
        throw new TypeError("Choose a Catalog raster.");
    }
    if (!Array.isArray(value.calculations) || value.calculations.length < 1 || value.calculations.length > 5) {
        throw new TypeError("Use one to five calculations.");
    }
    const calculations = value.calculations.map(({ label, expression }) => {
        if (typeof label !== "string" || !label.trim() || label.length > 80 ||
            typeof expression !== "string" || !expression.trim() || expression.length > 4096) {
            throw new TypeError("Each calculation needs a label and expression.");
        }
        return Object.freeze({ label, expression });
    });
    return Object.freeze({ source: Object.freeze({ collectionId, itemId, label }),
        ...(chunkPixels(value.targetChunkPixels) === null ? {} : { targetChunkPixels: value.targetChunkPixels }),
        area: normalizeCalculationArea(value.area), calculations: Object.freeze(calculations) });
}

/** Keep idempotency and cancellation intent across reloads, without persisting cookies. */
export class CalculationSessionStorage {
    /** Bind one recovery record; the bound is the product's 50-raster limit plus summary.
     * @param {Storage|null} storage Browser sessionStorage.
     * @param {string} [client="summary"] Caller identity.
     * @throws {TypeError} If the caller identity is unsupported.
     */
    constructor(storage, client = "summary") {
        if (!CLIENT.test(client)) throw new TypeError("Unsupported calculation caller.");
        this.storage = storage;
        this.client = client;
    }
    /** Bind another record without sharing its submission or cancellation state.
     * @param {string} client Caller identity.
     * @return {CalculationSessionStorage} Independent recovery adapter.
     * @throws {TypeError} If the caller identity is unsupported.
     */
    forClient(client) { return new CalculationSessionStorage(this.storage, client); }
    /** List valid unfinished records, including the previous single-record format.
     * @return {string[]} Callers requiring startup recovery.
     */
    savedClientNames() {
        return ["summary", ...Array.from({ length: 50 }, (_, index) => `raster-series:${index}`)]
            .filter(client => this.forClient(client).read());
    }
    /** Read the old single record only for the caller that originally owned it.
     * @return {string|null} Matching legacy record, or null.
     */
    legacyRecord() {
        try {
            const text = this.storage?.getItem(LEGACY_KEY);
            if (!text || text.length > 16384) return null;
            const owner = JSON.parse(text).client;
            return (owner === "raster-series" ? this.client === "raster-series:0" :
                (!owner || owner === "summary") && this.client === "summary") ? text : null;
        } catch { return null; }
    }
    /** Recover validated execution data and caller context without choosing whether to cancel. @return {Object|null} Owned workflow. */
    read() {
        try {
            const text = this.storage?.getItem(KEY_PREFIX + this.client) ?? this.legacyRecord();
            if (!text || text.length > 16384) return null;
            const value = JSON.parse(text);
            if (typeof value.automatic !== "boolean" || typeof value.cancelRequested !== "boolean" ||
                !(value.jobId === null || ID.test(value.jobId)) ||
                !(value.pending === null || (ID.test(value.pending?.planId) && /^[A-Za-z0-9_-]{16,80}$/.test(value.pending?.requestId))) ||
                (!value.jobId && !value.pending)) return null;
            if (!(value.releasePlanId === undefined || value.releasePlanId === null || ID.test(value.releasePlanId))) return null;
            if (value.client !== undefined && !["summary", "raster-series"].includes(value.client)) return null;
            return { intent: calculationIntent(value.intent), jobId: value.jobId, pending: value.pending,
                releasePlanId: value.releasePlanId ?? null,
                context: Object.freeze({ automatic: value.automatic, ...(value.client ? { client: value.client } : {}) }), cancelRequested: value.cancelRequested };
        } catch { return null; }
    }
    /** Save only this caller's submission before transport; never overwrite a peer.
     * Record contents preserve the old automatic/manual metadata. A successful write
     * migrates this caller's legacy record to its own v2 key, keeping the request ID.
     * @param {Object} record Execution data and optional caller context.
     * @return {void}
     * @throws {Error} If storage is unavailable, full, or the record exceeds its bound.
     */
    write(record) {
        if (!this.storage) throw new Error("Browser session storage is needed for recoverable calculations.");
        const { context, ...execution } = record;
        const text = JSON.stringify({ ...execution, automatic: context?.automatic ?? false, ...(context?.client ? { client: context.client } : {}) });
        if (text.length > 16384) throw new Error("Calculation recovery information is too large.");
        this.storage.setItem(KEY_PREFIX + this.client, text);
        if (this.legacyRecord()) this.storage.removeItem(LEGACY_KEY);
    }
    /** Remove a confirmed terminal workflow. @return {void} */
    clear() {
        this.storage?.removeItem(KEY_PREFIX + this.client);
        if (this.legacyRecord()) this.storage.removeItem(LEGACY_KEY);
    }
}
