/**
 * Exact raster point-value analysis for one retained map click.
 *
 * The controller accepts already-selected Catalog participants and delegates
 * bounded reads to an injected analysis client. It owns cancellation,
 * stale-response rejection, and immutable result snapshots; map-layer policy,
 * rendering, GeoServer publication, DOM presentation, and panel visibility
 * remain outside this module.
 */
import { isCanonicalWgs84Position } from "./geometry.js";

const MAXIMUM_POINT_SAMPLE_PARTICIPANTS = 2;

/**
 * @typedef {Object} RasterPointSampleParticipant
 * @property {string} key Stable Catalog or retained-session identity.
 * @property {string} label Readable raster filename.
 * @property {Object} item Catalog raster Item passed to the analysis client.
 * @property {"X"|"Y"|null} axis Optional active bivariate axis.
 */

/**
 * @typedef {Object} RasterPointSampleResult
 * @property {string} key Stable participant identity.
 * @property {string} label Readable raster filename.
 * @property {"X"|"Y"|null} axis Optional active bivariate axis.
 * @property {"loading"|"value"|"nodata"|"outside"|"error"} state Result state.
 * @property {number|null} value Finite sampled value only in value state.
 * @property {string} errorMessage Failure detail only in error state.
 */

/**
 * Sample one Catalog raster cell at one WGS 84 position.
 *
 * @callback SampleRasterPoint
 * @param {Object} item Catalog raster Item.
 * @param {{longitude:number,latitude:number}} point Canonical WGS 84 point.
 * @param {AbortSignal} signal Cancellation signal for superseded work.
 * @return {Promise<{inBounds:boolean,value:number|null}>} Pixel outcome.
 */

/**
 * Receive one immutable point-sampling snapshot or a cleared state.
 *
 * @callback RasterPointSamplesChanged
 * @param {{position:Readonly<Object>,samples:ReadonlyArray<Readonly<RasterPointSampleResult>>}|null}
 * snapshot Current result snapshot, or null after explicit clearing.
 * @return {void}
 */

/**
 * Validate and copy one bounded participant list.
 *
 * @param {RasterPointSampleParticipant[]} participants Candidate participants.
 * @return {RasterPointSampleParticipant[]} Copied participants.
 * @throws {TypeError} If the list exceeds the bounded contract or has invalid
 * identity, display, Catalog Item, or axis fields.
 */
function normalizeParticipants(participants) {
    if (
        !Array.isArray(participants) ||
        participants.length > MAXIMUM_POINT_SAMPLE_PARTICIPANTS
    ) {
        throw new TypeError("Raster point sampling accepts at most two participants");
    }
    const keys = new Set();
    return participants.map((participant) => {
        if (
            participant === null ||
            typeof participant !== "object" ||
            typeof participant.key !== "string" ||
            participant.key === "" ||
            typeof participant.label !== "string" ||
            participant.label === "" ||
            participant.item === null ||
            typeof participant.item !== "object" ||
            ![null, "X", "Y"].includes(participant.axis)
        ) {
            throw new TypeError("Raster point sample participant is invalid");
        }
        if (keys.has(participant.key)) {
            throw new TypeError("Raster point sample participants must be distinct");
        }
        keys.add(participant.key);
        return { ...participant };
    });
}

/**
 * Validate one pixel response and reduce it to the point-result state union.
 *
 * @param {unknown} pixel Candidate analysis response.
 * @return {Pick<RasterPointSampleResult,"state"|"value"|"errorMessage">}
 * Normalized result fields.
 * @throws {TypeError} If the analysis response violates the pixel contract.
 */
function normalizePixel(pixel) {
    if (
        pixel === null ||
        typeof pixel !== "object" ||
        typeof pixel.inBounds !== "boolean"
    ) {
        throw new TypeError("Raster point sample response is invalid");
    }
    if (!pixel.inBounds) {
        return { state: "outside", value: null, errorMessage: "" };
    }
    if (pixel.value === null) {
        return { state: "nodata", value: null, errorMessage: "" };
    }
    if (!Number.isFinite(pixel.value)) {
        throw new TypeError("Raster point sample value must be finite or null");
    }
    return { state: "value", value: pixel.value, errorMessage: "" };
}

/** Own exact point reads for the current bounded raster participant set. */
export class RasterPointSamplesController {
    /**
     * Create one renderer- and presentation-independent sampling lifecycle.
     *
     * @param {SampleRasterPoint} samplePoint Bounded Catalog pixel client.
     * @param {RasterPointSamplesChanged} onChange Snapshot observer.
     */
    constructor(samplePoint, onChange) {
        if (typeof samplePoint !== "function" || typeof onChange !== "function") {
            throw new TypeError("Raster point sample collaborators must be callable");
        }
        this.samplePoint = samplePoint;
        this.onChange = onChange;
        this.abortController = null;
        this.generation = 0;
        this.position = null;
        this.participants = [];
        this.results = [];
    }

    /**
     * Start concurrent bounded reads for one authoritative map click.
     *
     * A new click aborts and supersedes all older work. Empty participants
     * explicitly clear the retained result instead of emitting an empty panel.
     *
     * @param {RasterPointSampleParticipant[]} participants Ordered participants.
     * @param {{longitude:number,latitude:number}} position Canonical WGS 84 point.
     * @return {void}
     */
    sample(participants, position) {
        const normalized = normalizeParticipants(participants);
        if (!isCanonicalWgs84Position(position)) {
            throw new TypeError("Raster point sample position must be canonical WGS 84");
        }
        this.#cancelRequests();
        if (normalized.length === 0) {
            this.position = null;
            this.participants = [];
            this.results = [];
            this.onChange(null);
            return;
        }
        this.position = Object.freeze({ ...position });
        this.participants = normalized;
        this.results = normalized.map((participant) => ({
            key: participant.key,
            label: participant.label,
            axis: participant.axis,
            state: "loading",
            value: null,
            errorMessage: "",
        }));
        const generation = this.generation;
        const abortController = new AbortController();
        this.abortController = abortController;
        this.#emit();
        for (const participant of normalized) {
            void this.#readParticipant(
                participant,
                generation,
                abortController
            );
        }
    }

    /**
     * Reconcile retained output with a policy or axis-order change.
     *
     * Results are relabeled and reordered without another read when identity is
     * unchanged. A changed participant set cancels and clears the older click.
     *
     * @param {RasterPointSampleParticipant[]} participants Current participants.
     * @return {void}
     */
    synchronize(participants) {
        const normalized = normalizeParticipants(participants);
        if (this.position === null) {
            return;
        }
        const existingByKey = new Map(this.results.map((result) => [result.key, result]));
        if (
            normalized.length !== this.results.length ||
            normalized.some((participant) => !existingByKey.has(participant.key))
        ) {
            this.clear();
            return;
        }
        this.participants = normalized;
        this.results = normalized.map((participant) => ({
            ...existingByKey.get(participant.key),
            label: participant.label,
            axis: participant.axis,
        }));
        this.#emit();
    }

    /** Cancel pending work and clear the retained map-click result. @return {void} */
    clear() {
        const hadResult = this.position !== null;
        this.#cancelRequests();
        this.position = null;
        this.participants = [];
        this.results = [];
        if (hadResult) {
            this.onChange(null);
        }
    }

    /**
     * Read one participant and publish only a current normalized outcome.
     *
     * @param {RasterPointSampleParticipant} participant Participant to read.
     * @param {number} generation Request generation.
     * @param {AbortController} abortController Shared click cancellation owner.
     * @return {Promise<void>}
     */
    async #readParticipant(participant, generation, abortController) {
        try {
            const pixel = await this.samplePoint(
                participant.item,
                this.position,
                abortController.signal
            );
            if (generation !== this.generation) {
                return;
            }
            const index = this.results.findIndex(
                (result) => result.key === participant.key
            );
            if (index === -1) {
                return;
            }
            this.results[index] = {
                ...this.results[index],
                ...normalizePixel(pixel),
            };
        } catch (error) {
            if (generation !== this.generation || error?.name === "AbortError") {
                return;
            }
            const index = this.results.findIndex(
                (result) => result.key === participant.key
            );
            if (index === -1) {
                return;
            }
            this.results[index] = {
                ...this.results[index],
                state: "error",
                value: null,
                errorMessage: error instanceof Error && error.message !== ""
                    ? error.message
                    : "Raster value request failed.",
            };
        }
        this.#emit();
        if (
            generation === this.generation &&
            this.results.every((result) => result.state !== "loading")
        ) {
            this.abortController = null;
        }
    }

    /** Invalidate and abort all reads from an older click. @return {void} */
    #cancelRequests() {
        this.generation += 1;
        this.abortController?.abort();
        this.abortController = null;
    }

    /** Publish a deeply immutable presentation-neutral snapshot. @return {void} */
    #emit() {
        const samples = Object.freeze(this.results.map(
            (result) => Object.freeze({ ...result })
        ));
        this.onChange(Object.freeze({
            position: this.position,
            samples,
        }));
    }
}
