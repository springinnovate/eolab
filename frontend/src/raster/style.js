/**
 * Domain model and calculations for continuous raster appearance.
 *
 * This module validates the canonical three-stop style, derives thresholds
 * from statistics, applies palettes, and builds legend/color values. WMS
 * serialization, control elements, and layer updates are intentionally separate.
 */
import {
    DEFAULT_RASTER_PERCENTILES,
    estimateRasterHistogramPercentile
} from "./statistics.js";

/**
 * Numeric thresholds and colors for the dynamic raster color map.
 *
 * @typedef {Object} RasterStyle
 * @property {number} minimum Lowest color-map quantity.
 * @property {number} midpoint Middle color-map quantity.
 * @property {number} maximum Highest color-map quantity.
 * @property {string} minimumColor Six-digit hex color for the minimum.
 * @property {string} midpointColor Six-digit hex color for the midpoint.
 * @property {string} maximumColor Six-digit hex color for the maximum.
 * @property {number} [minimumOpacity=1] Minimum-stop opacity, zero through one.
 * @property {number} [midpointOpacity=1] Midpoint-stop opacity, zero through one.
 * @property {number} [maximumOpacity=1] Maximum-stop opacity, zero through one.
 */

/** Default three-stop raster style shown before statistics are available. */
export const DEFAULT_RASTER_STYLE = Object.freeze({
    minimum: 0,
    midpoint: 50,
    maximum: 100,
    minimumColor: "#ffffcc",
    midpointColor: "#fd8d3c",
    maximumColor: "#800026",
    minimumOpacity: 1,
    midpointOpacity: 1,
    maximumOpacity: 1
});

/** Named palette applied to newly created and explicitly reset raster styles. */
export const DEFAULT_RASTER_PALETTE_NAME = "yellow-red";

/** Named color palettes available from the raster appearance controls. */
export const RASTER_COLOR_PALETTES = Object.freeze({
    "yellow-red": Object.freeze({
        label: "Yellow–red",
        minimumColor: "#ffffcc",
        midpointColor: "#fd8d3c",
        maximumColor: "#800026"
    }),
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

/** Exact color syntax accepted by the GeoServer dynamic style contract. */
const RASTER_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

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
 * Validate the canonical numeric and color fields of a raster style.
 *
 * @param {RasterStyle} style Candidate numeric thresholds and colors.
 * @return {RasterStyle} The validated style.
 * @throws {Error} If thresholds or colors violate the style contract.
 */
export function validateRasterStyle(style) {
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
    const opacities = ["minimum", "midpoint", "maximum"].map(
        (stop) => style[`${stop}Opacity`] === undefined ? 1 : style[`${stop}Opacity`]
    );
    if (!opacities.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
        throw rasterStyleContractError(
            "Color opacity must be a number from 0 to 100 percent.",
            "opacities"
        );
    }
    return style;
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
 * @param {{lower:number,middle:number,upper:number}} [percentiles=DEFAULT_RASTER_PERCENTILES]
 * Histogram positions used for the three thresholds.
 * @return {RasterStyle} Style with bounded histogram-derived thresholds.
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
    const transparent = ["minimum", "midpoint", "maximum"].some(
        (stop) => (style[`${stop}Opacity`] ?? 1) !== 1
    );
    // Sample RGB and alpha separately: CSS otherwise premultiplies the ramp,
    // unlike the independent color/opacity interpolation used by GeoServer.
    const positions = [...new Set([
        ...Array.from({ length: 33 }, (_, index) => index / 32),
        midpointPosition / 100
    ])].sort((a, b) => a - b);
    const alphaGradient = transparent ? positions.map((position) => {
        const value = style.minimum + position * (style.maximum - style.minimum);
        const color = getRasterStyleColor(style, value);
        const alpha = Math.round(getRasterStyleOpacity(style, value) * 255)
            .toString(16).padStart(2, "0");
        return `${color}${alpha} ${position * 100}%`;
    }).join(", ") : null;
    return {
        midpointPosition,
        gradient: alphaGradient === null
            ? `linear-gradient(90deg, ${style.minimumColor} 0%, ` +
                `${style.midpointColor} ${midpointPosition}%, ${style.maximumColor} 100%)`
            : `linear-gradient(90deg, ${alphaGradient})`,
        description:
            `Color ramp: ${style.minimum} at ${style.minimumColor}, ` +
            `${style.midpoint} at ${style.midpointColor}, and ` +
            `${style.maximum} at ${style.maximumColor}.` +
            (transparent ? " Color opacity (minimum, midpoint, maximum): " +
                ["minimum", "midpoint", "maximum"].map(
                    (stop) => `${Math.round((style[`${stop}Opacity`] ?? 1) * 100)}%`
                ).join(", ") + "." : "")
    };
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
 * Interpolate value-dependent alpha independently of RGB and layer opacity.
 * Legacy styles without alpha fields are fully opaque. Endpoints clamp to
 * their stop opacity, matching the GeoServer continuous color-map contract.
 * @param {RasterStyle} style Validated raster style.
 * @param {number} value Finite raster value.
 * @return {number} Pixel opacity from zero through one.
 */
export function getRasterStyleOpacity(style, value) {
    const minimum = style.minimumOpacity ?? 1;
    const midpoint = style.midpointOpacity ?? 1;
    const maximum = style.maximumOpacity ?? 1;
    if (value <= style.minimum) return minimum;
    if (value >= style.maximum) return maximum;
    const lower = value <= style.midpoint;
    const start = lower ? minimum : midpoint;
    const end = lower ? midpoint : maximum;
    const startValue = lower ? style.minimum : style.midpoint;
    const endValue = lower ? style.midpoint : style.maximum;
    return start + (end - start) * (value - startValue) / (endValue - startValue);
}
