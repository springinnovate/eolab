/** Minimum interval between raster pixel requests. */
const PIXEL_PROBE_INTERVAL_MILLISECONDS = 100;

/** Preferred gap between the pointer and its pixel readout. */
const PIXEL_PROBE_OFFSET_PIXELS = 12;

/** Minimum gap retained between the pixel readout and viewport edges. */
const PIXEL_PROBE_VIEWPORT_MARGIN_PIXELS = 8;

/**
 * Sample one raster cell at a WGS 84 position.
 *
 * @callback ProbeRasterPixel
 * @param {Object} item Active STAC Item.
 * @param {{longitude: number, latitude: number}} position WGS 84 position.
 * @param {AbortSignal} signal Cancellation signal for stale work.
 * @return {Promise<Object>} Pixel sample response.
 */

/**
 * Receive a current pixel sample.
 *
 * @callback RasterPixelResultHandler
 * @param {Object} result Pixel sample response.
 * @param {{longitude: number, latitude: number}} position Sampled position.
 * @return {void}
 */

/**
 * Receive a current pixel-sampling error.
 *
 * @callback RasterPixelErrorHandler
 * @param {Error} error Non-abort pixel error.
 * @param {{longitude: number, latitude: number}} position Sampled position.
 * @return {void}
 */

/**
 * Read the display basename from a scanner-owned GeoTIFF Asset URL.
 *
 * @param {Object} item Selected mounted GeoTIFF STAC Item.
 * @return {string} Decoded raster filename, including its extension.
 * @throws {TypeError} If the scanner-owned Asset URL is invalid.
 */
export function getCatalogRasterBasename(item) {
    const pathname = new URL(item.assets.data.href).pathname;
    return decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
}

/**
 * Position the pixel readout beside the pointer without viewport overflow.
 *
 * @param {{x: number, y: number}} pointer Browser viewport position.
 * @param {{width: number, height: number}} probeSize Readout dimensions.
 * @param {{width: number, height: number}} viewport Viewport dimensions.
 * @return {{x: number, y: number}} Top-left readout position.
 */
export function getRasterPixelProbePosition(pointer, probeSize, viewport) {
    const maximumX = Math.max(
        PIXEL_PROBE_VIEWPORT_MARGIN_PIXELS,
        viewport.width - probeSize.width -
        PIXEL_PROBE_VIEWPORT_MARGIN_PIXELS
    );
    const maximumY = Math.max(
        PIXEL_PROBE_VIEWPORT_MARGIN_PIXELS,
        viewport.height - probeSize.height -
        PIXEL_PROBE_VIEWPORT_MARGIN_PIXELS
    );
    const preferredX = pointer.x + PIXEL_PROBE_OFFSET_PIXELS;
    const preferredY = pointer.y + PIXEL_PROBE_OFFSET_PIXELS;
    return {
        x: Math.max(
            PIXEL_PROBE_VIEWPORT_MARGIN_PIXELS,
            Math.min(
                preferredX + probeSize.width +
                    PIXEL_PROBE_VIEWPORT_MARGIN_PIXELS <= viewport.width
                    ? preferredX
                    : pointer.x - probeSize.width -
                    PIXEL_PROBE_OFFSET_PIXELS,
                maximumX
            )
        ),
        y: Math.max(
            PIXEL_PROBE_VIEWPORT_MARGIN_PIXELS,
            Math.min(
                preferredY + probeSize.height +
                    PIXEL_PROBE_VIEWPORT_MARGIN_PIXELS <= viewport.height
                    ? preferredY
                    : pointer.y - probeSize.height -
                    PIXEL_PROBE_OFFSET_PIXELS,
                maximumY
            )
        )
    };
}

/**
 * Format one finite pixel value in scientific notation.
 *
 * @param {number} value Sampled raster value.
 * @return {string} Value with four significant digits, or zero.
 */
export function formatRasterPixelValue(value) {
    return value === 0 ? "0" : value.toExponential(3);
}

/** Sample the latest hover position at most every 100 milliseconds. */
export class RasterPixelProbeController {
    /**
     * Create a throttled pixel-probe lifecycle.
     *
     * @param {ProbeRasterPixel} probePixel Samples one Item at one position.
     * @param {RasterPixelResultHandler} onResult Receives the latest result.
     * @param {RasterPixelErrorHandler} onError Receives the latest failure.
     * @param {Object} [timing={}] Injectable clock used by deterministic tests.
     * @param {{setTimeout: (callback: () => void, delay: number) => *,
     * clearTimeout: (identifier: *) => void}} [timing.clock=globalThis]
     * Timeout implementation.
     * @param {() => number} [timing.now=Date.now] Current time in milliseconds.
     */
    constructor(
        probePixel,
        onResult,
        onError,
        { clock = globalThis, now = Date.now } = {}
    ) {
        this.probePixel = probePixel;
        this.onResult = onResult;
        this.onError = onError;
        this.clock = clock;
        this.now = now;
        this.item = null;
        this.pendingPoint = null;
        this.timeoutId = null;
        this.abortController = null;
        this.nextRequestAt = 0;
        this.requestSequence = 0;
    }

    /**
     * Select the Item sampled by subsequent pointer positions.
     *
     * @param {Object} item Selected STAC Item.
     * @return {void}
     */
    activate(item) {
        this.clear();
        this.item = item;
    }

    /**
     * Retain the latest pointer position behind the one in-flight sample.
     *
     * @param {{longitude: number, latitude: number}} position WGS 84 point.
     * @return {void}
     */
    move(position) {
        if (this.item === null) {
            return;
        }
        this.pendingPoint = position;
        this.#schedule();
    }

    /**
     * Cancel pending work while retaining the active Item.
     *
     * @return {void}
     */
    cancel() {
        this.requestSequence += 1;
        this.pendingPoint = null;
        this.nextRequestAt = 0;
        if (this.timeoutId !== null) {
            this.clock.clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        this.abortController?.abort();
        this.abortController = null;
    }

    /**
     * Cancel pending work and remove the active Item.
     *
     * @return {void}
     */
    clear() {
        this.cancel();
        this.item = null;
    }

    /**
     * Schedule the retained position at the next allowed request time.
     *
     * @return {void}
     */
    #schedule() {
        if (
            this.timeoutId !== null ||
            this.pendingPoint === null ||
            this.abortController !== null
        ) {
            return;
        }
        const delay = Math.max(0, this.nextRequestAt - this.now());
        if (delay === 0) {
            void this.#sample();
            return;
        }
        this.timeoutId = this.clock.setTimeout(() => {
            this.timeoutId = null;
            void this.#sample();
        }, delay);
    }

    /**
     * Sample the retained position and deliver only a current result.
     *
     * @return {Promise<void>}
     */
    async #sample() {
        const point = this.pendingPoint;
        const item = this.item;
        if (point === null || item === null) {
            return;
        }
        this.pendingPoint = null;
        this.nextRequestAt =
            this.now() + PIXEL_PROBE_INTERVAL_MILLISECONDS;
        const abortController = new AbortController();
        const requestSequence = ++this.requestSequence;
        this.abortController = abortController;
        try {
            const result = await this.probePixel(
                item,
                point,
                abortController.signal
            );
            if (requestSequence === this.requestSequence) {
                this.onResult(result, point);
            }
        } catch (error) {
            if (
                error.name !== "AbortError" &&
                requestSequence === this.requestSequence
            ) {
                this.onError(error, point);
            }
        } finally {
            if (this.abortController === abortController) {
                this.abortController = null;
            }
            if (this.pendingPoint !== null) {
                this.#schedule();
            }
        }
    }
}
