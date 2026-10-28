/** Save raster and temporal calculation inputs for recovery after a tab reload. */
import { labeledRasterSource } from "../raster-source.js";
import { normalizeCalculationArea } from "./calculation-area.js";
const KEY_PREFIX = "eolab.processing.calculation.v2.";
const CLIENT = /^raster-series:(0|[1-9][0-9]{0,15})$/;
const ID = /^[A-Za-z0-9_-]{32}$/;

/** Validate the optional number of pixels processed in each calculation batch.
 * @param {number|null|undefined} value Requested batch size.
 * @return {number|null} Validated batch size, or null for the server default.
 * @throws {TypeError} If the size is not an integer from 1 through 4,194,304.
 */
export function chunkPixels(value) {
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value < 1 || value > 4194304) throw new TypeError("Batch size must be 1 to 4,194,304 pixels.");
    return value;
}

/** Retain a click only for formulas that use pixelValue; the server validates expression syntax.
 * @param {{expression:string}[]} calculations Named calculation expressions.
 * @param {{longitude:number,latitude:number}|null|undefined} point Optional exact map click.
 * @return {Readonly<{longitude:number,latitude:number}>|null} Immutable relevant point, or null when unused or missing.
 * @throws {TypeError} If a supplied pixelValue point is not a strict canonical WGS 84 position.
 */
export function calculationPixelPoint(calculations, point) {
    if (!calculations.some(({expression}) => /\bpixelValue\s*\(/.test(expression)) || point == null) return null;
    if (Object.keys(point).sort().join() !== "latitude,longitude" || ![point.longitude, point.latitude].every(Number.isFinite) ||
        point.longitude < -180 || point.longitude > 180 || point.latitude < -90 || point.latitude > 90) {
        throw new TypeError("Choose a valid map point for pixelValue(a).");
    }
    return Object.freeze({ longitude: point.longitude, latitude: point.latitude });
}

/** Capture a raster or temporal calculation for submission and reload recovery.
 * Temporal calculations also retain their installed model identity and time zone offset.
 * @param {Object} value Source, area, formulas, optional pixelPoint, and temporal model fields when kind is temporal.
 * @return {Readonly<Object>} Immutable snapshot.
 * @throws {TypeError|Error} If the source, model, formulas, area, chunk budget or point is invalid.
 */
export function calculationIntent(value) {
    const temporal = value.kind === "temporal";
    const source = temporal ? temporalIntervalReference(value.source) : labeledRasterSource(value.source, value.source.label);
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
    const pixelPoint = calculationPixelPoint(calculations, value.pixelPoint);
    return Object.freeze({ source,
        ...(temporal ? {kind: "temporal", model: Object.freeze({...validateModelIdentity(value.model)}), utcOffsetMinutes: value.utcOffsetMinutes} : {}),
        ...(chunkPixels(value.targetChunkPixels) === null ? {} : { targetChunkPixels: value.targetChunkPixels }),
        ...(pixelPoint ? { pixelPoint } : {}),
        area: normalizeCalculationArea(value.area), calculations: Object.freeze(calculations) });
}

/** Copy the Catalog variable and UTC interval retained by a temporal calculation.
 * @param {Object} source User-selected or recovered temporal interval.
 * @return {Readonly<Object>} Path-free identity and interval boundaries.
 * @throws {TypeError} If a source field or ordered UTC interval is missing.
 */
function temporalIntervalReference(source) {
    if (![source?.collectionId, source?.itemId, source?.variable].every(value => typeof value === "string" && value.length > 0 && value.length <= 512) ||
        ![source.startTime, source.endTime].every(value => typeof value === "string" && Number.isFinite(Date.parse(value))) ||
        Date.parse(source.startTime) >= Date.parse(source.endTime)) throw new TypeError("Choose a temporal dataset, variable and valid period.");
    return Object.freeze({collectionId: source.collectionId, itemId: source.itemId, variable: source.variable,
        startTime: source.startTime, endTime: source.endTime});
}

/** Check a model identity before building URLs or recovering saved inputs.
 * @param {Object} model Model ID, version and definition checksum.
 * @return {Object} Validated identity.
 * @throws {Error} If identity fields are malformed.
 */
export function validateModelIdentity(model) {
    if (!model || !/^[a-z][a-z0-9_-]{0,63}$/.test(model.id) ||
        !/^\d+\.\d+\.\d+$/.test(model.version) || model.version.length > 32 ||
        !/^[a-f0-9]{64}$/.test(model.definitionSha256)) throw new Error("Invalid model identity.");
    return {id: model.id, version: model.version, definitionSha256: model.definitionSha256};
}

/** Recover submitted calculations and requested cancellations after reloading the tab.
 * Saved retry identifiers let the server recognize a resubmission as the same job.
 * Session cookies are not copied into these records.
 */
export class CalculationSessionStorage {
    /** Bind one recovery record for an independent raster position.
     * Each record retains its size limit; browser storage bounds total saved data.
     * @param {Storage|null} storage Browser sessionStorage.
     * @param {string} [client="raster-series:0"] Caller identity.
     * @throws {TypeError} If the caller identity is unsupported.
     */
    constructor(storage, client = "raster-series:0") {
        if (!CLIENT.test(client) || !Number.isSafeInteger(Number(client.split(":")[1]))) {
            throw new TypeError("Unsupported calculation caller.");
        }
        this.storage = storage;
        this.client = client;
    }
    /** Bind another record without sharing its submission or cancellation state.
     * @param {string} client Caller identity.
     * @return {CalculationSessionStorage} Independent recovery adapter.
     * @throws {TypeError} If the caller identity is unsupported.
     */
    forClient(client) { return new CalculationSessionStorage(this.storage, client); }
    /** List retained calculations without assuming a maximum raster count.
     * Only this component's current per-caller keys are considered.
     * Invalid records are ignored.
     * @return {string[]} Callers requiring startup recovery.
     */
    savedClientNames() {
        const clients = new Set();
        try {
            for (let index = 0; index < (this.storage?.length ?? 0); index++) {
                const key = this.storage.key(index);
                if (key?.startsWith(KEY_PREFIX)) {
                    const client = key.slice(KEY_PREFIX.length);
                    if (CLIENT.test(client) && Number.isSafeInteger(Number(client.split(":")[1]))) clients.add(client);
                }
            }
        } catch { /* read() also handles browsers denying storage access. */ }
        return [...clients].filter(client => this.forClient(client).read())
            .sort((a, b) => Number(a.split(":")[1]) - Number(b.split(":")[1]));
    }
    /** Read one calculation's saved inputs, job identifier and cancellation request.
     * @return {Object|null} Validated recovery record, or null if absent, invalid or unreadable.
     */
    read() {
        try {
            const text = this.storage?.getItem(KEY_PREFIX + this.client);
            if (!text || text.length > 16384) return null;
            const value = JSON.parse(text);
            if (typeof value.automatic !== "boolean" || typeof value.cancelRequested !== "boolean" ||
                !(value.jobId === null || ID.test(value.jobId)) ||
                !(value.pending === null || (value.pending?.planId === undefined && /^[A-Za-z0-9_-]{16,80}$/.test(value.pending?.requestId))) ||
                (!value.jobId && !value.pending)) return null;
            const presentation = value.presentation;
            if (!presentation || typeof presentation.key !== "string" || !presentation.key || presentation.key.length > 2048 ||
                !Array.isArray(presentation.names) || presentation.names.length !== value.intent.calculations.length ||
                presentation.names.some(name => typeof name !== "string" || name.length > 80) ||
                value.intent.calculations.some(formula => !/^stat-[1-9][0-9]*$/.test(formula.label) || !Number.isSafeInteger(Number(formula.label.slice(5))))) return null;
            return { intent: calculationIntent(value.intent), jobId: value.jobId, pending: value.pending,
                context: Object.freeze({ automatic: value.automatic, presentation }), cancelRequested: value.cancelRequested };
        } catch { return null; }
    }
    /** Save only this caller's submission before transport; never overwrite a peer.
     * Store the caller's automatic/manual context alongside its execution data.
     * @param {Object} record Execution data, automatic/manual policy and source/formula presentation.
     * @return {void}
     * @throws {Error} If storage is unavailable, full, or the record exceeds its bound.
     */
    write(record) {
        if (!this.storage) throw new Error("Browser session storage is needed for recoverable calculations.");
        const { context, ...execution } = record;
        const text = JSON.stringify({ ...execution, automatic: context.automatic, presentation: context.presentation });
        if (text.length > 16384) throw new Error("Calculation recovery information is too large.");
        this.storage.setItem(KEY_PREFIX + this.client, text);
    }
    /** Remove this caller's recovery record when cancelled, replaced, or finished automatically. @return {void} */
    clear() {
        this.storage?.removeItem(KEY_PREFIX + this.client);
    }
}
