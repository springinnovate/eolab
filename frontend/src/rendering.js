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

export const DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM = 200;
export const MINIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM = 1;
export const MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM = 300;
export const RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE =
    "Move the sample window away from the pole or date line.";

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
const WGS84_MEAN_RADIUS_KM = 6371.0088;

class RasterSampleWindowBoundaryError extends RangeError {}

/**
 * Build a style-validation error with the affected control group.
 *
 * @param {string} message User-facing validation message.
 * @param {string} fieldGroup Style control group that failed validation.
 * @return {Error & {fieldGroup: string}} Annotated validation error.
 */
function rasterStyleContractError(message, fieldGroup) {
    return Object.assign(new Error(message), { fieldGroup });
}

/**
 * Build a stable error for a malformed statistics response.
 *
 * @param {string} detail Name of the response contract that failed.
 * @return {Error} User-safe response validation error.
 */
function rasterStatisticsContractError(detail) {
    return new Error(`Raster statistics returned invalid ${detail}.`);
}

/**
 * Return a user-safe rendering error from FastAPI or an upstream proxy.
 *
 * @param {Response} response Failed rendering response.
 * @param {string} action User-facing description of the request.
 * @return {Promise<Error>} Structured FastAPI detail or a status fallback.
 */
async function renderingRequestError(response, action) {
    const fallbackMessage = `${action} failed (${response.status})`;
    if (!response.headers.get("content-type")?.toLowerCase().includes(
        "application/json"
    )) {
        return new Error(fallbackMessage);
    }
    try {
        const errorDocument = await response.json();
        return new Error(
            typeof errorDocument.detail === "string" &&
                errorDocument.detail.trim() !== ""
                ? errorDocument.detail
                : fallbackMessage
        );
    } catch {
        return new Error(fallbackMessage);
    }
}

/**
 * Test whether a value is a positive integer.
 *
 * @param {*} value Candidate value.
 * @return {boolean} Whether value is an integer greater than zero.
 */
function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

/**
 * Enforce the fixed user-facing sample-size contract.
 *
 * @param {number} sideLengthKm Requested square side length in kilometers.
 * @return {number} The validated side length.
 * @throws {RangeError} If the side length is nonintegral or outside 1-300 km.
 */
export function validateRasterSampleWindowSize(sideLengthKm) {
    if (
        !Number.isFinite(sideLengthKm) ||
        !Number.isInteger(sideLengthKm) ||
        sideLengthKm < MINIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM ||
        sideLengthKm > MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM
    ) {
        throw new RangeError(
            `Raster sample size must be between ` +
            `${MINIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM} and ` +
            `${MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM} kilometers.`
        );
    }
    return sideLengthKm;
}

/**
 * Validate one server-compatible WGS 84 statistics rectangle.
 *
 * @param {Object} bounds Candidate west, south, east, and north coordinates.
 * @return {Object} The validated non-wrapping WGS 84 bounds.
 * @throws {Error} If fields, ranges, or coordinate ordering are invalid.
 */
export function validateRasterSelectedBounds(bounds) {
    if (bounds === null || typeof bounds !== "object") {
        throw rasterStatisticsContractError("selected bounds");
    }
    const fieldNames = ["west", "south", "east", "north"];
    if (
        Object.keys(bounds).length !== fieldNames.length ||
        !fieldNames.every((fieldName) => Object.hasOwn(bounds, fieldName))
    ) {
        throw rasterStatisticsContractError("selected bounds");
    }
    const { west, south, east, north } = bounds;
    if (
        ![west, south, east, north].every(Number.isFinite) ||
        west < -180 || east > 180 || south < -90 || north > 90 ||
        !(west < east && south < north)
    ) {
        throw rasterStatisticsContractError("selected bounds");
    }
    return bounds;
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
    if (
        statistics.scope === "wholeRaster" &&
        statistics.selectedBounds !== null
    ) {
        throw rasterStatisticsContractError("whole-raster scope");
    }
    if (statistics.scope === "selectedArea") {
        validateRasterSelectedBounds(statistics.selectedBounds);
    } else if (statistics.scope !== "wholeRaster") {
        throw rasterStatisticsContractError("statistics scope");
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
 * Return whether one distribution belongs to the active histogram scope.
 *
 * @param {Object} statistics Validated raster statistics.
 * @param {Object|null} selectedBounds Active selected-area bounds, if any.
 * @return {boolean} Whether statistics describe the active scope exactly.
 */
export function rasterStatisticsMatchesSelection(statistics, selectedBounds) {
    if (selectedBounds === null) {
        return statistics.scope === "wholeRaster";
    }
    return (
        statistics.scope === "selectedArea" &&
        ["west", "south", "east", "north"].every(
            (fieldName) =>
                statistics.selectedBounds?.[fieldName] ===
                selectedBounds[fieldName]
        )
    );
}

/**
 * Return a destination reached along a spherical WGS 84 geodesic.
 *
 * @param {{longitude: number, latitude: number}} center Starting position.
 * @param {number} distanceKm Distance from the center in kilometers.
 * @param {number} bearingDegrees Clockwise bearing from north in degrees.
 * @return {{longitude: number, latitude: number}} Destination in WGS 84.
 */
function rasterSampleDestination(center, distanceKm, bearingDegrees) {
    const latitude = center.latitude * Math.PI / 180;
    const longitude = center.longitude * Math.PI / 180;
    const bearing = bearingDegrees * Math.PI / 180;
    const angularDistance = distanceKm / WGS84_MEAN_RADIUS_KM;
    const destinationLatitude = Math.asin(
        Math.sin(latitude) * Math.cos(angularDistance) +
        Math.cos(latitude) * Math.sin(angularDistance) * Math.cos(bearing)
    );
    const longitudeOffset = Math.atan2(
        Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(latitude),
        Math.cos(angularDistance) -
            Math.sin(latitude) * Math.sin(destinationLatitude)
    );
    const unwrappedLongitude = longitude + longitudeOffset;
    const normalizedLongitude =
        ((unwrappedLongitude * 180 / Math.PI + 540) % 360) - 180;
    return {
        latitude: destinationLatitude * 180 / Math.PI,
        longitude: normalizedLongitude
    };
}

/**
 * Build an axis-aligned WGS 84 square whose ground dimensions approximate the
 * requested side length. A date-line or polar crossing is deliberately not
 * represented by the selected-bounds API contract.
 *
 * @param {{longitude: number, latitude: number}} center Window center.
 * @param {number} sideLengthKm Approximate ground side length in kilometers.
 * @return {Object} Canonical west, south, east, and north WGS 84 bounds.
 * @throws {RangeError} If the center or size violates the selection contract.
 * @throws {RasterSampleWindowBoundaryError} If the window crosses a pole or
 * date line.
 */
export function buildRasterSampleWindowBounds(center, sideLengthKm) {
    if (
        !Number.isFinite(center?.longitude) ||
        !Number.isFinite(center?.latitude) ||
        center.longitude < -180 || center.longitude > 180 ||
        center.latitude < -90 || center.latitude > 90
    ) {
        throw new RangeError("Raster sample center must be a WGS 84 position.");
    }
    validateRasterSampleWindowSize(sideLengthKm);

    const halfDiagonalKm = sideLengthKm / Math.sqrt(2);
    const halfDiagonalRadians = halfDiagonalKm / WGS84_MEAN_RADIUS_KM;
    if (
        Math.abs(center.latitude * Math.PI / 180) +
            halfDiagonalRadians >= Math.PI / 2
    ) {
        throw new RasterSampleWindowBoundaryError(
            RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE
        );
    }
    const corners = [315, 45, 135, 225].map((bearing) =>
        rasterSampleDestination(center, halfDiagonalKm, bearing)
    );
    const longitudes = corners.map((corner) => corner.longitude);
    const latitudes = corners.map((corner) => corner.latitude);
    if (Math.max(...longitudes) - Math.min(...longitudes) >= 180) {
        throw new RasterSampleWindowBoundaryError(
            RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE
        );
    }
    return validateRasterSelectedBounds({
        west: Math.min(...longitudes),
        south: Math.min(...latitudes),
        east: Math.max(...longitudes),
        north: Math.max(...latitudes)
    });
}

/**
 * Convert canonical bounds to Leaflet corners in one visible world copy.
 *
 * @param {Object} bounds Canonical WGS 84 selected bounds.
 * @param {number} [longitudeOffset] World-copy longitude offset in degrees.
 * @return {Array<Array<number>>} Southwest and northeast Leaflet corners.
 * @throws {Error} If bounds or longitudeOffset violate their contracts.
 */
export function rasterSampleBoundsToLeaflet(bounds, longitudeOffset = 0) {
    validateRasterSelectedBounds(bounds);
    if (!Number.isFinite(longitudeOffset)) {
        throw new RangeError("Raster sample longitude offset must be finite.");
    }
    return [
        [bounds.south, bounds.west + longitudeOffset],
        [bounds.north, bounds.east + longitudeOffset]
    ];
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
 * @throws {Error} If percentile is nonfinite or outside 0-100.
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

/**
 * Calculate scale-relative padding for repeated raster values.
 *
 * @param {number[]} values Finite raster values.
 * @return {number} Positive padding suitable for a strict range.
 */
function rasterRangePadding(values) {
    const magnitude = Math.max(...values.map(Math.abs));
    if (magnitude === 0) {
        return 1e-12;
    }
    return Math.max(magnitude * 1e-6, Number.MIN_VALUE);
}

/**
 * Expand repeated quantiles just enough to satisfy the strict style range.
 *
 * @param {number} minimum Approximate lower percentile value.
 * @param {number} midpoint Approximate middle percentile value.
 * @param {number} maximum Approximate upper percentile value.
 * @return {{minimum:number,midpoint:number,maximum:number}} Strict range.
 * @throws {Error} If finite inputs cannot form a strictly ordered range.
 */
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
 * @throws {Error} If percentiles are nonfinite, unordered, or out of range.
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

/**
 * Return an initial style only when the user has not edited the appearance.
 *
 * @param {RasterStyle} style Current colors and thresholds.
 * @param {Object} statistics Validated whole-raster statistics.
 * @param {boolean} styleWasEdited Whether the user changed the appearance.
 * @return {RasterStyle|null} Histogram-derived style, or null after an edit.
 * @throws {Error} If the statistics cannot form a strict raster style.
 */
export function deriveInitialRasterStyleFromStatistics(
    style,
    statistics,
    styleWasEdited
) {
    if (styleWasEdited) {
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

/**
 * Send one selected STAC Item identity to a rendering endpoint.
 *
 * @param {string} endpoint Same-origin rendering API endpoint.
 * @param {Object} item Selected STAC Item.
 * @param {Function} fetchImplementation Browser fetch implementation.
 * @return {Promise<Object>} Parsed JSON response document.
 * @throws {Error} If the request fails or the endpoint rejects it.
 */
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
        throw await renderingRequestError(response, "Rendering request");
    }

    return response.json();
}

/**
 * Assess and update one selected legacy raster Item.
 *
 * @param {Object} item Selected STAC Item.
 * @param {Function} fetchImplementation Browser fetch implementation.
 * @return {Promise<Object>} Updated authoritative STAC Item.
 * @throws {Error} If assessment or catalog persistence fails.
 */
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

/**
 * Ask EOLab to publish the authoritative STAC Item as a WMS layer.
 *
 * @param {Object} item Selected STAC Item.
 * @param {Function} fetchImplementation Browser fetch implementation.
 * @return {Promise<Object>} Published layer identity and bounds.
 * @throws {Error} If publication fails or the raster is not eligible.
 */
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
 * @param {Object|null} selectedBounds Optional WGS 84 sampling rectangle.
 * @param {Function} fetchImplementation Browser fetch implementation.
 * @return {Promise<Object>} Validated fixed-bin raster statistics.
 * @throws {Error} If EOLab cannot calculate or validate the statistics.
 */
export async function loadCatalogRasterStatistics(
    item,
    signal,
    selectedBounds = null,
    fetchImplementation = globalThis.fetch
) {
    const requestDocument = {
        collectionId: item.collection,
        itemId: item.id
    };
    if (selectedBounds !== null) {
        requestDocument.selectedBounds = validateRasterSelectedBounds(
            selectedBounds
        );
    }
    const response = await fetchImplementation.call(
        globalThis,
        "/api/rendering/statistics",
        {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json"
            },
            body: JSON.stringify(requestDocument),
            signal
        }
    );
    if (!response.ok) {
        throw await renderingRequestError(
            response,
            "Raster statistics request"
        );
    }
    const statistics = validateRasterStatistics(await response.json());
    if (selectedBounds === null && statistics.scope !== "wholeRaster") {
        throw rasterStatisticsContractError("whole-raster response scope");
    }
    if (selectedBounds !== null) {
        if (statistics.scope !== "selectedArea") {
            throw rasterStatisticsContractError("selected-area response scope");
        }
        for (const fieldName of ["west", "south", "east", "north"]) {
            if (statistics.selectedBounds[fieldName] !== selectedBounds[fieldName]) {
                throw rasterStatisticsContractError(
                    "selected-area response bounds"
                );
            }
        }
    }
    return statistics;
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
        throw await renderingRequestError(response, "Pixel sample request");
    }
    return response.json();
}

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

/**
 * Interpolate a six-digit RGB color between two ramp stops.
 *
 * @param {string} startColor Lower six-digit hex color.
 * @param {string} endColor Upper six-digit hex color.
 * @param {number} position Interpolation fraction from zero through one.
 * @return {string} Interpolated six-digit hex color.
 */
function interpolateRasterColor(startColor, endColor, position) {
    const start = Number.parseInt(startColor.slice(1), 16);
    const end = Number.parseInt(endColor.slice(1), 16);
    const channels = [16, 8, 0].map((shift) => Math.round(
        ((start >> shift) & 0xff) * (1 - position) +
        ((end >> shift) & 0xff) * position
    ));
    return `#${channels.map((channel) =>
        channel.toString(16).padStart(2, "0")
    ).join("")}`;
}

/**
 * Return the active three-stop raster-ramp color for one pixel value.
 *
 * @param {RasterStyle} style Committed raster style.
 * @param {number} value Raster value to color.
 * @return {string} Interpolated six-digit hex color.
 */
export function getRasterStyleColor(style, value) {
    if (value <= style.minimum) {
        return style.minimumColor;
    }
    if (value <= style.midpoint) {
        return interpolateRasterColor(
            style.minimumColor,
            style.midpointColor,
            (value - style.minimum) / (style.midpoint - style.minimum)
        );
    }
    if (value < style.maximum) {
        return interpolateRasterColor(
            style.midpointColor,
            style.maximumColor,
            (value - style.midpoint) / (style.maximum - style.midpoint)
        );
    }
    return style.maximumColor;
}

/**
 * Render the validated fixed-bin distribution into its SVG chart.
 *
 * SVG elements do not implement HTMLElement.hidden, so visibility is changed
 * through the actual attribute that the stylesheet consumes.
 *
 * @param {SVGSVGElement} chart Histogram chart element.
 * @param {Object} statistics Validated raster statistics.
 * @param {Object} style Committed raster color-map style.
 * @param {Document} [documentContext] DOM document; injectable for tests.
 * @return {void}
 */
export function renderRasterHistogramChart(
    chart,
    statistics,
    style,
    documentContext = globalThis.document
) {
    const svgNamespace = "http://www.w3.org/2000/svg";
    const chartWidth = 640;
    const chartHeight = 112;
    const plotHeight = 100;
    const { counts, edges } = statistics.histogram;
    const maximumCount = Math.max(...counts);
    const barWidth = chartWidth / counts.length;
    const title = documentContext.createElementNS(svgNamespace, "title");
    title.textContent =
        `Approximate band 1 histogram with ${counts.length} bins from ` +
        `${statistics.validSampleCount.toLocaleString()} valid sampled ` +
        `pixels. Values range from ${formatRasterPixelValue(
            statistics.sampleMinimum
        )} to ${formatRasterPixelValue(statistics.sampleMaximum)}; ` +
        `the 5th, 50th, and 95th percentiles are ${formatRasterPixelValue(
            statistics.percentiles.p05
        )}, ${formatRasterPixelValue(statistics.percentiles.p50)}, and ` +
        `${formatRasterPixelValue(statistics.percentiles.p95)}.`;
    chart.replaceChildren(title);
    for (const [binIndex, count] of counts.entries()) {
        const barHeight = count / maximumCount * plotHeight;
        const bar = documentContext.createElementNS(svgNamespace, "rect");
        bar.classList.add("raster-histogram-bar");
        bar.setAttribute("x", String(binIndex * barWidth));
        bar.setAttribute("y", String(chartHeight - barHeight));
        bar.setAttribute("width", String(barWidth - 1));
        bar.setAttribute("height", String(barHeight));
        const binMidpoint = (edges[binIndex] + edges[binIndex + 1]) / 2;
        bar.style.fill = getRasterStyleColor(style, binMidpoint);
        const binTitle = documentContext.createElementNS(
            svgNamespace,
            "title"
        );
        const samplePercent = count / statistics.validSampleCount * 100;
        binTitle.textContent =
            `Bin midpoint ${formatRasterPixelValue(binMidpoint)}; ` +
            `${samplePercent.toFixed(2)}% of the valid sample ` +
            `(${count.toLocaleString()} pixels). Value range ` +
            `${formatRasterPixelValue(edges[binIndex])} to ` +
            `${formatRasterPixelValue(edges[binIndex + 1])}.`;
        bar.append(binTitle);
        chart.append(bar);
    }
    chart.setAttribute("aria-label", title.textContent);
    chart.removeAttribute("hidden");
}

/**
 * Remove a histogram and hide its SVG through the SVG attribute contract.
 *
 * @param {SVGSVGElement} chart Histogram chart element.
 * @return {void}
 */
export function clearRasterHistogramChart(chart) {
    chart.replaceChildren();
    chart.setAttribute("hidden", "");
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
     * @throws {TypeError} If collaborators are not callable when invoked.
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

/** Own the explicit hover-preview and click-to-sample map interaction. */
export class RasterSampleWindowController {
    /**
     * @param {Object} leafletMap Leaflet-compatible map.
     * @param {Function} layerFactory Creates preview or selection rectangles.
     * @param {Function} onSelect Receives committed WGS 84 bounds.
     * @param {Function} onGuidance Receives user-safe selection guidance.
     * @throws {TypeError} If collaborators do not implement their contracts.
     */
    constructor(leafletMap, layerFactory, onSelect, onGuidance) {
        this.leafletMap = leafletMap;
        this.layerFactory = layerFactory;
        this.onSelect = onSelect;
        this.onGuidance = onGuidance;
        this.windowSizeKm = DEFAULT_RASTER_SAMPLE_WINDOW_SIZE_KM;
        this.enabled = false;
        this.lastPosition = null;
        this.previewLayer = null;
        this.selectionLayer = null;
        this.selectionBounds = null;
        this.onMouseMove = (event) => this.#previewAt(event.latlng);
        this.onMouseOut = () => this.#removePreview();
        this.onMouseOver = (event) => {
            const position = event.latlng ?? this.lastPosition;
            if (position !== null) {
                this.#previewAt(position);
            }
        };
        this.onClick = (event) => this.#selectAt(event.latlng);
    }

    /**
     * Start selection handlers without issuing a statistics request.
     *
     * @return {void}
     */
    enable() {
        if (this.enabled) {
            return;
        }
        this.enabled = true;
        this.leafletMap.on("mousemove", this.onMouseMove);
        this.leafletMap.on("mouseout", this.onMouseOut);
        this.leafletMap.on("mouseover", this.onMouseOver);
        this.leafletMap.on("click", this.onClick);
        this.#previewAt(this.leafletMap.getCenter());
    }

    /**
     * Stop selection handlers while retaining the committed rectangle.
     *
     * @return {void}
     */
    disable() {
        if (!this.enabled) {
            return;
        }
        this.leafletMap.off("mousemove", this.onMouseMove);
        this.leafletMap.off("mouseout", this.onMouseOut);
        this.leafletMap.off("mouseover", this.onMouseOver);
        this.leafletMap.off("click", this.onClick);
        this.enabled = false;
        this.#removePreview();
    }

    /**
     * Change the ground-distance side length used by later previews/clicks.
     *
     * @param {number} sideLengthKm Integer side length from 1 through 300 km.
     * @return {void}
     * @throws {RangeError} If the side length violates the window contract.
     */
    setWindowSize(sideLengthKm) {
        this.windowSizeKm = validateRasterSampleWindowSize(sideLengthKm);
        if (this.enabled && this.lastPosition !== null) {
            this.#previewAt(this.lastPosition);
        }
    }

    /**
     * Commit a selection at the current map center for keyboard/touch access.
     *
     * @return {Object|null} Canonical selected bounds, or null near an edge.
     */
    sampleMapCenter() {
        return this.#selectAt(this.leafletMap.getCenter());
    }

    /**
     * Remove only the committed area, retaining the hover interaction.
     *
     * @return {void}
     */
    clearSelection() {
        if (this.selectionLayer !== null) {
            this.leafletMap.removeLayer(this.selectionLayer);
            this.selectionLayer = null;
        }
        this.selectionBounds = null;
    }

    /**
     * Remove all layers, handlers, and pointer state for the active Item.
     *
     * @return {void}
     */
    clear() {
        this.disable();
        this.clearSelection();
        this.lastPosition = null;
        this.onGuidance("");
    }

    /** @return {boolean} Whether hover-and-click selection is active. */
    get isEnabled() {
        return this.enabled;
    }

    /** @return {Object|null} Last committed canonical WGS 84 bounds. */
    get selectedBounds() {
        return this.selectionBounds;
    }

    /**
     * Build API and visible-world bounds at one Leaflet position.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {{bounds:Object,leafletBounds:Array}|null} Sampling window, or
     * null when it crosses a pole or date line.
     * @throws {RangeError} If the position or configured size is invalid.
     */
    #boundsAt(position) {
        const normalizedPosition = this.#normalizePosition(position);
        try {
            const bounds = buildRasterSampleWindowBounds(
                {
                    longitude: normalizedPosition.lng,
                    latitude: normalizedPosition.lat
                },
                this.windowSizeKm
            );
            this.onGuidance("");
            return {
                bounds,
                leafletBounds: rasterSampleBoundsToLeaflet(
                    bounds,
                    position.lng - normalizedPosition.lng
                )
            };
        } catch (error) {
            if (!(error instanceof RasterSampleWindowBoundaryError)) {
                throw error;
            }
            this.#removePreview();
            this.onGuidance(RASTER_SAMPLE_WINDOW_EDGE_GUIDANCE);
            return null;
        }
    }

    /**
     * Move or create the transient preview at one map position.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {void}
     * @throws {RangeError} If the position or configured size is invalid.
     */
    #previewAt(position) {
        this.lastPosition = position;
        const sampleWindow = this.#boundsAt(position);
        if (sampleWindow === null) {
            return;
        }
        if (this.previewLayer === null) {
            this.previewLayer = this.layerFactory(
                sampleWindow.leafletBounds,
                "preview"
            ).addTo(this.leafletMap);
        } else {
            this.previewLayer.setBounds(sampleWindow.leafletBounds);
        }
    }

    /**
     * Commit and report one sample window at a map position.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {Object|null} Canonical bounds, or null near a pole/date line.
     * @throws {RangeError} If the position or configured size is invalid.
     */
    #selectAt(position) {
        this.lastPosition = position;
        const sampleWindow = this.#boundsAt(position);
        if (sampleWindow === null) {
            return null;
        }
        if (this.selectionLayer === null) {
            this.selectionLayer = this.layerFactory(
                sampleWindow.leafletBounds,
                "selection"
            ).addTo(this.leafletMap);
        } else {
            this.selectionLayer.setBounds(sampleWindow.leafletBounds);
        }
        this.selectionBounds = sampleWindow.bounds;
        this.onSelect(sampleWindow.bounds);
        return sampleWindow.bounds;
    }

    /**
     * Normalize a Leaflet world-copy position to canonical WGS 84 longitude.
     *
     * @param {{lng: number, lat: number}} position Leaflet map position.
     * @return {{lng: number, lat: number}} Canonical longitude and latitude.
     */
    #normalizePosition(position) {
        const longitude = ((position.lng + 180) % 360 + 360) % 360 - 180;
        return { lng: longitude, lat: position.lat };
    }

    /**
     * Remove the transient preview layer if present.
     *
     * @return {void}
     */
    #removePreview() {
        if (this.previewLayer !== null) {
            this.leafletMap.removeLayer(this.previewLayer);
            this.previewLayer = null;
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
     * @throws {TypeError} If collaborators are not callable when invoked.
     */
    constructor(loadStatistics, onLoading, onResult, onError) {
        this.loadStatistics = loadStatistics;
        this.onLoading = onLoading;
        this.onResult = onResult;
        this.onError = onError;
        this.item = null;
        this.selectedBounds = null;
        this.abortController = null;
        this.requestSequence = 0;
    }

    /**
     * Start a new statistics request for the active rendered Item.
     *
     * @param {Object} item Selected STAC Item.
     * @param {*} [context] Opaque request context returned to callbacks.
     * @param {Object|null} [selectedBounds] Optional WGS 84 selection.
     * @return {Promise<Object|null>} Current statistics, or null after failure
     * or invalidation.
     */
    async activate(item, context = undefined, selectedBounds = null) {
        this.clear();
        this.item = item;
        this.selectedBounds = selectedBounds;
        const requestSequence = ++this.requestSequence;
        const abortController = new AbortController();
        this.abortController = abortController;
        this.onLoading(item, context);
        let statistics;
        try {
            statistics = await this.loadStatistics(
                item,
                abortController.signal,
                selectedBounds
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

    /**
     * Repeat the active Item's request after a recoverable failure.
     *
     * @param {*} [context] Opaque request context returned to callbacks.
     * @return {Promise<Object|null>} Retried statistics or null without an Item.
     */
    retry(context = undefined) {
        const item = this.item;
        const selectedBounds = this.selectedBounds;
        return item === null
            ? Promise.resolve(null)
            : this.activate(item, context, selectedBounds);
    }

    /**
     * Abort and invalidate pending work and forget the active Item.
     *
     * @return {void}
     */
    clear() {
        this.requestSequence += 1;
        this.abortController?.abort();
        this.abortController = null;
        this.item = null;
        this.selectedBounds = null;
    }
}

/** Manage one WMS layer while ignoring publication results for stale selections. */
export class CatalogRasterLayerController {
    /**
     * @param {Object} leafletMap Leaflet-compatible map.
     * @param {Function} publishRaster Publishes one selected STAC Item.
     * @param {Function} layerFactory Creates a Leaflet layer from publication.
     * @throws {TypeError} If collaborators do not implement their contracts.
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

    /**
     * Invalidate pending publication and remove a displayed layer, if any.
     *
     * @return {void}
     */
    clear() {
        this.requestSequence += 1;
        if (this.activeLayer !== null) {
            this.leafletMap.removeLayer(this.activeLayer);
            this.activeLayer = null;
        }
    }
}
