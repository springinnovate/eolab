/**
 * @typedef {Object} RasterStyle
 * @property {number} minimum Lowest color-map quantity.
 * @property {number} midpoint Middle color-map quantity.
 * @property {number} maximum Highest color-map quantity.
 * @property {string} minimumColor Six-digit hex color for the minimum.
 * @property {string} midpointColor Six-digit hex color for the midpoint.
 * @property {string} maximumColor Six-digit hex color for the maximum.
 */

export const DEFAULT_RASTER_STYLE = Object.freeze({
    minimum: 0,
    midpoint: 50,
    maximum: 100,
    minimumColor: "#2b83ba",
    midpointColor: "#ffffbf",
    maximumColor: "#d7191c"
});

export const DEFAULT_RASTER_PERCENTILES = Object.freeze({
    lower: 5,
    middle: 50,
    upper: 95
});

export const RASTER_COLOR_PALETTES = Object.freeze({
    "blue-yellow-red": Object.freeze({
        label: "Blue–yellow–red",
        minimumColor: "#2b83ba",
        midpointColor: "#ffffbf",
        maximumColor: "#d7191c"
    }),
    viridis: Object.freeze({
        label: "Viridis",
        minimumColor: "#440154",
        midpointColor: "#21918c",
        maximumColor: "#fde725"
    }),
    magma: Object.freeze({
        label: "Magma",
        minimumColor: "#000004",
        midpointColor: "#b73779",
        maximumColor: "#fcfdbf"
    }),
    grayscale: Object.freeze({
        label: "Grayscale",
        minimumColor: "#000000",
        midpointColor: "#808080",
        maximumColor: "#ffffff"
    }),
    terrain: Object.freeze({
        label: "Terrain",
        minimumColor: "#1a9850",
        midpointColor: "#fee08b",
        maximumColor: "#8c510a"
    })
});

const RASTER_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
export const PIXEL_PROBE_INTERVAL_MILLISECONDS = 100;
const PIXEL_PROBE_OFFSET_PIXELS = 12;
const PIXEL_PROBE_VIEWPORT_MARGIN_PIXELS = 8;

function rasterStyleContractError(message, fieldGroup) {
    return Object.assign(new Error(message), { fieldGroup });
}

function rasterStatisticsContractError(detail) {
    return new Error(`Raster statistics returned invalid ${detail}.`);
}

function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

/**
 * Validate the fixed, bounded raster-statistics response contract.
 *
 * @param {Object} statistics Candidate response from EOLab.
 * @return {Object} The validated response.
 * @throws {Error} If the document violates the rendering API contract.
 */
export function validateRasterStatistics(statistics) {
    if (statistics === null || typeof statistics !== "object") {
        throw rasterStatisticsContractError("response data");
    }
    if (statistics.band !== 1) {
        throw rasterStatisticsContractError("band identity");
    }

    const dimensions = [
        statistics.sourceWidth,
        statistics.sourceHeight,
        statistics.sourcePixelCount,
        statistics.sampleWidth,
        statistics.sampleHeight,
        statistics.sampledPixelCount,
        statistics.validSampleCount
    ];
    if (!dimensions.every(isPositiveInteger)) {
        throw rasterStatisticsContractError("sample dimensions");
    }
    if (
        statistics.sampleWidth > statistics.sourceWidth ||
        statistics.sampleHeight > statistics.sourceHeight ||
        statistics.sampleWidth > 512 ||
        statistics.sampleHeight > 512 ||
        statistics.sourcePixelCount !==
            statistics.sourceWidth * statistics.sourceHeight ||
        statistics.sampledPixelCount !==
            statistics.sampleWidth * statistics.sampleHeight ||
        statistics.validSampleCount > statistics.sampledPixelCount
    ) {
        throw rasterStatisticsContractError("sample counts");
    }
    if (typeof statistics.estimated !== "boolean") {
        throw rasterStatisticsContractError("estimate metadata");
    }

    const sampleValues = [
        statistics.sampleMinimum,
        statistics.sampleMaximum,
        statistics.percentiles?.p05,
        statistics.percentiles?.p50,
        statistics.percentiles?.p95
    ];
    if (!sampleValues.every(Number.isFinite)) {
        throw rasterStatisticsContractError("sample values");
    }
    const [sampleMinimum, sampleMaximum, p05, p50, p95] = sampleValues;
    if (!(
        sampleMinimum <= p05 &&
        p05 <= p50 &&
        p50 <= p95 &&
        p95 <= sampleMaximum
    )) {
        throw rasterStatisticsContractError("percentile order");
    }

    const counts = statistics.histogram?.counts;
    const edges = statistics.histogram?.edges;
    if (
        !Array.isArray(counts) ||
        counts.length !== 64 ||
        !counts.every((count) => Number.isInteger(count) && count >= 0) ||
        counts.reduce((total, count) => total + count, 0) !==
            statistics.validSampleCount
    ) {
        throw rasterStatisticsContractError("histogram counts");
    }
    if (
        !Array.isArray(edges) ||
        edges.length !== counts.length + 1 ||
        !edges.every(Number.isFinite) ||
        !edges.slice(1).every((edge, index) => edge > edges[index]) ||
        edges[0] > sampleMinimum ||
        edges.at(-1) < sampleMaximum
    ) {
        throw rasterStatisticsContractError("histogram edges");
    }

    const suggestedRange = statistics.suggestedRange;
    if (
        suggestedRange === null ||
        typeof suggestedRange !== "object" ||
        ![
            suggestedRange.minimum,
            suggestedRange.midpoint,
            suggestedRange.maximum
        ].every(Number.isFinite) ||
        !(
            suggestedRange.minimum < suggestedRange.midpoint &&
            suggestedRange.midpoint < suggestedRange.maximum
        )
    ) {
        throw rasterStatisticsContractError("suggested range");
    }
    return statistics;
}

/**
 * Estimate one percentile from the validated fixed-bin histogram.
 *
 * Exact p05, p50, and p95 sample percentiles are retained from the backend;
 * other positions are interpolated within the containing histogram bin.
 *
 * @param {Object} statistics Validated raster statistics.
 * @param {number} percentile Percentile from 0 through 100.
 * @return {number} Approximate sampled raster value.
 */
export function estimateRasterHistogramPercentile(statistics, percentile) {
    if (!Number.isFinite(percentile) || percentile < 0 || percentile > 100) {
        throw new Error("Raster percentile must be between 0 and 100.");
    }
    if (statistics.sampleMinimum === statistics.sampleMaximum) {
        return statistics.sampleMinimum;
    }
    if (percentile === 0) {
        return statistics.sampleMinimum;
    }
    if (percentile === 5) {
        return statistics.percentiles.p05;
    }
    if (percentile === 50) {
        return statistics.percentiles.p50;
    }
    if (percentile === 95) {
        return statistics.percentiles.p95;
    }
    if (percentile === 100) {
        return statistics.sampleMaximum;
    }

    const { counts, edges } = statistics.histogram;
    const target = statistics.validSampleCount * percentile / 100;
    let cumulative = 0;
    for (let binIndex = 0; binIndex < counts.length; binIndex += 1) {
        const nextCumulative = cumulative + counts[binIndex];
        if (target <= nextCumulative && counts[binIndex] > 0) {
            const fraction = (target - cumulative) / counts[binIndex];
            const value = edges[binIndex] +
                fraction * (edges[binIndex + 1] - edges[binIndex]);
            let lowerBound = statistics.sampleMinimum;
            let upperBound = statistics.percentiles.p05;
            if (percentile > 5 && percentile < 50) {
                lowerBound = statistics.percentiles.p05;
                upperBound = statistics.percentiles.p50;
            } else if (percentile > 50 && percentile < 95) {
                lowerBound = statistics.percentiles.p50;
                upperBound = statistics.percentiles.p95;
            } else if (percentile > 95) {
                lowerBound = statistics.percentiles.p95;
                upperBound = statistics.sampleMaximum;
            }
            return Math.max(lowerBound, Math.min(upperBound, value));
        }
        cumulative = nextCumulative;
    }
    return statistics.sampleMaximum;
}

function rasterRangePadding(values) {
    const magnitude = Math.max(...values.map(Math.abs));
    if (magnitude === 0) {
        return 1e-12;
    }
    return Math.max(magnitude * 1e-6, Number.MIN_VALUE);
}

/** Expand repeated quantiles just enough to satisfy the strict style range. */
function makeRasterRangeStrict(minimum, midpoint, maximum) {
    if (minimum < midpoint && midpoint < maximum) {
        return { minimum, midpoint, maximum };
    }

    const padding = rasterRangePadding([minimum, midpoint, maximum]);
    if (minimum === midpoint && midpoint === maximum) {
        const expandedMinimum = midpoint - padding;
        const expandedMaximum = midpoint + padding;
        if (
            Number.isFinite(expandedMinimum) &&
            Number.isFinite(expandedMaximum) &&
            expandedMinimum < midpoint &&
            midpoint < expandedMaximum
        ) {
            return {
                minimum: expandedMinimum,
                midpoint,
                maximum: expandedMaximum
            };
        }
        if (Number.isFinite(expandedMinimum) && expandedMinimum < midpoint) {
            return {
                minimum: midpoint - 2 * padding,
                midpoint: expandedMinimum,
                maximum: midpoint
            };
        }
        return {
            minimum: midpoint,
            midpoint: midpoint + padding,
            maximum: midpoint + 2 * padding
        };
    }
    if (minimum === midpoint) {
        const expandedMinimum = minimum - padding;
        if (Number.isFinite(expandedMinimum) && expandedMinimum < midpoint) {
            return { minimum: expandedMinimum, midpoint, maximum };
        }
    }
    if (midpoint === maximum) {
        const expandedMaximum = maximum + padding;
        if (Number.isFinite(expandedMaximum) && midpoint < expandedMaximum) {
            return { minimum, midpoint, maximum: expandedMaximum };
        }
    }
    throw new Error("Raster percentiles could not form an ordered range.");
}

/**
 * Apply histogram percentile values to the canonical raster style.
 *
 * @param {RasterStyle} style Current colors and thresholds.
 * @param {Object} statistics Validated raster statistics.
 * @param {{lower:number,middle:number,upper:number}} percentiles Selection.
 * @return {RasterStyle} Style with approximate histogram-derived thresholds.
 */
export function deriveRasterStyleFromStatistics(
    style,
    statistics,
    percentiles = DEFAULT_RASTER_PERCENTILES
) {
    const { lower, middle, upper } = percentiles;
    if (!(
        Number.isFinite(lower) &&
        Number.isFinite(middle) &&
        Number.isFinite(upper) &&
        0 <= lower &&
        lower < middle &&
        middle < upper &&
        upper <= 100
    )) {
        throw rasterStyleContractError(
            "Lower, middle, and upper percentiles must be in increasing order.",
            "percentiles"
        );
    }

    let range = statistics.suggestedRange;
    if (
        lower !== DEFAULT_RASTER_PERCENTILES.lower ||
        middle !== DEFAULT_RASTER_PERCENTILES.middle ||
        upper !== DEFAULT_RASTER_PERCENTILES.upper
    ) {
        const values = [
            estimateRasterHistogramPercentile(statistics, lower),
            estimateRasterHistogramPercentile(statistics, middle),
            estimateRasterHistogramPercentile(statistics, upper)
        ];
        range = makeRasterRangeStrict(...values);
    }
    return {
        ...style,
        minimum: range.minimum,
        midpoint: range.midpoint,
        maximum: range.maximum
    };
}

/** Return an initial style only if no manual edit superseded its request. */
export function deriveInitialRasterStyleFromStatistics(
    style,
    statistics,
    requestedStyleRevision,
    currentStyleRevision
) {
    if (requestedStyleRevision !== currentStyleRevision) {
        return null;
    }
    return deriveRasterStyleFromStatistics(style, statistics);
}

/**
 * Apply one named color palette without changing numeric thresholds.
 *
 * @param {RasterStyle} style Current raster style.
 * @param {string} paletteName Name from RASTER_COLOR_PALETTES.
 * @return {RasterStyle} New style with the selected colors.
 * @throws {Error} If paletteName is not part of the application contract.
 */
export function applyRasterColorPalette(style, paletteName) {
    const palette = Object.hasOwn(RASTER_COLOR_PALETTES, paletteName)
        ? RASTER_COLOR_PALETTES[paletteName]
        : undefined;
    if (palette === undefined) {
        throw new Error(`Unknown raster palette: ${paletteName}`);
    }
    return {
        ...style,
        minimumColor: palette.minimumColor,
        midpointColor: palette.midpointColor,
        maximumColor: palette.maximumColor
    };
}

/**
 * Validate and serialize a raster style for GeoServer's dynamic SLD.
 *
 * @param {RasterStyle} style Numeric thresholds and six-digit hex colors.
 * @return {string} Canonical six-assignment WMS environment value.
 * @throws {Error} If thresholds or colors violate the style contract.
 */
export function serializeRasterStyle(style) {
    const thresholds = [style.minimum, style.midpoint, style.maximum];
    if (!thresholds.every(Number.isFinite)) {
        throw rasterStyleContractError(
            "Raster thresholds must be finite numbers.",
            "thresholds"
        );
    }
    if (!(style.minimum < style.midpoint && style.midpoint < style.maximum)) {
        throw rasterStyleContractError(
            "Minimum must be less than midpoint, and midpoint less than maximum.",
            "thresholds"
        );
    }
    const colors = [
        style.minimumColor,
        style.midpointColor,
        style.maximumColor
    ];
    if (!colors.every((color) => RASTER_COLOR_PATTERN.test(color))) {
        throw rasterStyleContractError(
            "Raster colors must use six-digit hex values.",
            "colors"
        );
    }
    return [
        `min:${style.minimum}`,
        `med:${style.midpoint}`,
        `max:${style.maximum}`,
        `cmin:${style.minimumColor.toLowerCase()}`,
        `cmed:${style.midpointColor.toLowerCase()}`,
        `cmax:${style.maximumColor.toLowerCase()}`
    ].join(";");
}

/**
 * Build the visible and accessible legend from a validated raster style.
 *
 * @param {RasterStyle} style Committed raster style.
 * @return {{midpointPosition: number, gradient: string, description: string}}
 * Legend position, CSS gradient, and text alternative.
 */
export function buildRasterLegend(style) {
    const midpointPosition =
        ((style.midpoint - style.minimum) /
            (style.maximum - style.minimum)) * 100;
    return {
        midpointPosition,
        gradient: `linear-gradient(90deg, ${style.minimumColor} 0%, ` +
            `${style.midpointColor} ${midpointPosition}%, ` +
            `${style.maximumColor} 100%)`,
        description:
            `Color ramp: ${style.minimum} at ${style.minimumColor}, ` +
            `${style.midpoint} at ${style.midpointColor}, and ` +
            `${style.maximum} at ${style.maximumColor}.`
    };
}

/**
 * Request and validate the public WMS capabilities document.
 *
 * @param {string} wmsUrl Browser-facing WMS endpoint.
 * @param {Function} fetchImplementation Fetch implementation used by the browser.
 * @return {Promise<string>} URL of the validated capabilities document.
 * @throws {Error} If WMS is unavailable or returns a different document.
 */
export async function loadWmsCapabilities(
    wmsUrl,
    fetchImplementation = globalThis.fetch
) {
    const query = new URLSearchParams({
        service: "WMS",
        version: "1.3.0",
        request: "GetCapabilities"
    });
    const capabilitiesUrl = `${wmsUrl}${wmsUrl.includes("?") ? "&" : "?"}${query}`;
    const response = await fetchImplementation.call(globalThis, capabilitiesUrl, {
        headers: { Accept: "application/xml" }
    });
    if (!response.ok) {
        throw new Error(`WMS GetCapabilities returned ${response.status}`);
    }

    const capabilitiesDocument = await response.text();
    if (
        !capabilitiesDocument.includes("<WMS_Capabilities") &&
        !capabilitiesDocument.includes("<WMT_MS_Capabilities")
    ) {
        throw new Error("WMS GetCapabilities returned an unexpected document");
    }
    return capabilitiesUrl;
}

/** Send one selected STAC Item identity to a rendering endpoint. */
async function postCatalogRasterAction(
    endpoint,
    item,
    fetchImplementation = globalThis.fetch
) {
    const response = await fetchImplementation.call(
        globalThis,
        endpoint,
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                collectionId: item.collection,
                itemId: item.id
            })
        }
    );
    if (!response.ok) {
        const errorDocument = await response.json();
        throw new Error(errorDocument.detail);
    }

    return response.json();
}

/** Assess and update one selected legacy raster Item. */
export function assessCatalogRaster(
    item,
    fetchImplementation = globalThis.fetch
) {
    return postCatalogRasterAction(
        "/api/rendering/assessments",
        item,
        fetchImplementation
    );
}

/** Ask EOLab to publish the authoritative STAC Item as a WMS layer. */
export function publishCatalogRaster(
    item,
    fetchImplementation = globalThis.fetch
) {
    return postCatalogRasterAction(
        "/api/rendering/layers",
        item,
        fetchImplementation
    );
}

/**
 * Load the bounded band-1 sample statistics for one published Catalog raster.
 *
 * @param {Object} item Selected STAC Item.
 * @param {AbortSignal} signal Cancellation signal for a stale selection.
 * @param {Function} fetchImplementation Browser fetch implementation.
 * @return {Promise<Object>} Validated fixed-bin raster statistics.
 * @throws {Error} If EOLab cannot calculate or validate the statistics.
 */
export async function loadCatalogRasterStatistics(
    item,
    signal,
    fetchImplementation = globalThis.fetch
) {
    const response = await fetchImplementation.call(
        globalThis,
        "/api/rendering/statistics",
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                collectionId: item.collection,
                itemId: item.id
            }),
            signal
        }
    );
    if (!response.ok) {
        const errorDocument = await response.json();
        throw new Error(errorDocument.detail);
    }
    return validateRasterStatistics(await response.json());
}

/**
 * Read one band-1 pixel from the selected, published Catalog raster.
 *
 * @param {Object} item Selected STAC Item.
 * @param {{longitude: number, latitude: number}} position WGS 84 position.
 * @param {AbortSignal} signal Cancellation signal for a superseded position.
 * @param {Function} fetchImplementation Browser fetch implementation.
 * @return {Promise<Object>} Source cell, bounds state, and value.
 * @throws {Error} If EOLab cannot sample the raster.
 */
export async function sampleCatalogRasterPixel(
    item,
    position,
    signal,
    fetchImplementation = globalThis.fetch
) {
    const response = await fetchImplementation.call(
        globalThis,
        "/api/rendering/pixels",
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                collectionId: item.collection,
                itemId: item.id,
                longitude: position.longitude,
                latitude: position.latitude
            }),
            signal
        }
    );
    if (!response.ok) {
        const errorDocument = await response.json();
        throw new Error(errorDocument.detail);
    }
    return response.json();
}

/**
 * Read the display basename from a scanner-owned GeoTIFF Asset URL.
 *
 * @param {Object} item Selected mounted GeoTIFF STAC Item.
 * @return {string} Decoded raster filename, including its extension.
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
     * @param {Function} probePixel Samples one Item at one WGS 84 position.
     * @param {Function} onResult Receives the latest successful sample.
     * @param {Function} onError Receives the latest non-abort failure.
     * @param {Object} [timing] Injectable clock used by deterministic tests.
     * @param {Object} [timing.clock] setTimeout/clearTimeout implementation.
     * @param {Function} [timing.now] Current time in milliseconds.
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

    /** Cancel pending work while retaining the active Item. */
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

    /** Cancel pending work and remove the active Item. */
    clear() {
        this.cancel();
        this.item = null;
    }

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

/** Manage one statistics lifecycle and ignore stale raster responses. */
export class RasterStatisticsController {
    /**
     * @param {Function} loadStatistics Loads one Item with an AbortSignal.
     * @param {Function} onLoading Receives the active Item and request context.
     * @param {Function} onResult Receives current statistics, Item, and context.
     * @param {Function} onError Receives the current failure, Item, and context.
     */
    constructor(loadStatistics, onLoading, onResult, onError) {
        this.loadStatistics = loadStatistics;
        this.onLoading = onLoading;
        this.onResult = onResult;
        this.onError = onError;
        this.item = null;
        this.abortController = null;
        this.requestSequence = 0;
    }

    /** Start a new statistics request for the active rendered Item. */
    async activate(item, context = undefined) {
        this.clear();
        this.item = item;
        const requestSequence = ++this.requestSequence;
        const abortController = new AbortController();
        this.abortController = abortController;
        this.onLoading(item, context);
        let statistics;
        try {
            statistics = await this.loadStatistics(
                item,
                abortController.signal
            );
        } catch (error) {
            if (
                error.name !== "AbortError" &&
                requestSequence === this.requestSequence
            ) {
                this.onError(error, item, context);
            }
            return null;
        } finally {
            if (this.abortController === abortController) {
                this.abortController = null;
            }
        }
        if (requestSequence !== this.requestSequence) {
            return null;
        }
        this.onResult(statistics, item, context);
        return statistics;
    }

    /** Repeat the active Item's request after a recoverable failure. */
    retry(context = undefined) {
        const item = this.item;
        return item === null
            ? Promise.resolve(null)
            : this.activate(item, context);
    }

    /** Abort and invalidate pending work and forget the active Item. */
    clear() {
        this.requestSequence += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.item = null;
    }
}

/** Manage one WMS layer while ignoring publication results for stale selections. */
export class CatalogRasterLayerController {
    /**
     * @param {Object} leafletMap Leaflet-compatible map.
     * @param {Function} publishRaster Publishes one selected STAC Item.
     * @param {Function} layerFactory Creates a Leaflet layer from publication.
     */
    constructor(leafletMap, publishRaster, layerFactory) {
        this.leafletMap = leafletMap;
        this.publishRaster = publishRaster;
        this.layerFactory = layerFactory;
        this.activeLayer = null;
        this.requestSequence = 0;
    }

    /**
     * Publish and display one Item unless selection changed while awaiting it.
     *
     * @param {Object} item Selected STAC Item.
     * @return {Promise<Object|null>} Published layer details, or null after a
     * selection change.
     */
    async show(item) {
        const requestSequence = ++this.requestSequence;
        const publishedRaster = await this.publishRaster(item);
        if (requestSequence !== this.requestSequence) {
            return null;
        }
        this.clear();
        this.activeLayer = this.layerFactory(publishedRaster).addTo(
            this.leafletMap
        );
        return publishedRaster;
    }

    /** Invalidate pending publication and remove a displayed layer, if any. */
    clear() {
        this.requestSequence += 1;
        if (this.activeLayer !== null) {
            this.leafletMap.removeLayer(this.activeLayer);
            this.activeLayer = null;
        }
    }
}
