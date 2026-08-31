/**
 * Pure bivariate palette definitions, color math, and mode invariants.
 *
 * Every map axis ramp, legend cell, histogram cell, and probe marker derives
 * from the same palette object and fixed additive RGB operation.
 */
import { getRasterStyleColor } from "./style.js";

/** Coordinated palette definitions carried forward from ESOS-C. */
export const BIVARIATE_RASTER_PALETTES = Object.freeze({
    orangeBlue: Object.freeze({
        label: "Orange / Blue",
        baseRamp: Object.freeze(["#000000", "#ff8000", "#ffcc00"]),
        lightenerColor: "#00ffff",
        strength: 1,
    }),
    grayWhite: Object.freeze({
        label: "Gray / White",
        baseRamp: Object.freeze(["#222222", "#777777", "#dddddd"]),
        lightenerColor: "#ffffff",
        strength: 1,
    }),
    tealMagenta: Object.freeze({
        label: "Teal / Magenta",
        baseRamp: Object.freeze(["#003333", "#00b3b3", "#00ffff"]),
        lightenerColor: "#ff66cc",
        strength: 0.9,
    }),
    greenPurple: Object.freeze({
        label: "Green / Purple",
        baseRamp: Object.freeze(["#003300", "#66aa55", "#ccff99"]),
        lightenerColor: "#aa55ff",
        strength: 1,
    }),
    redCyan: Object.freeze({
        label: "Red / Cyan",
        baseRamp: Object.freeze(["#220000", "#cc3333", "#ff6666"]),
        lightenerColor: "#00ffff",
        strength: 0.8,
    }),
    indigoGold: Object.freeze({
        label: "Indigo / Gold",
        baseRamp: Object.freeze(["#1a0033", "#4b33cc", "#ccbb33"]),
        lightenerColor: "#ffef99",
        strength: 1,
    }),
    brownSky: Object.freeze({
        label: "Brown / Sky",
        baseRamp: Object.freeze(["#332211", "#996633", "#ffcc66"]),
        lightenerColor: "#66ccff",
        strength: 1,
    }),
    steelRose: Object.freeze({
        label: "Steel / Rose",
        baseRamp: Object.freeze(["#111827", "#3b82f6", "#93c5fd"]),
        lightenerColor: "#f472b6",
        strength: 1,
    }),
});

/**
 * Clamp one numeric coordinate to the palette unit interval.
 *
 * @param {number} value Candidate normalized coordinate.
 * @return {number} Value clamped from zero through one.
 */
function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

/**
 * Convert a six-digit hexadecimal color to integer RGB channels.
 *
 * @param {string} hexColor Six-digit hexadecimal CSS color.
 * @return {number[]} Red, green, and blue integer channels.
 * @throws {TypeError} If the color is outside the fixed representation.
 */
function hexToRgb(hexColor) {
    const match = /^#([0-9a-f]{6})$/i.exec(hexColor);
    if (match === null) {
        throw new TypeError(`Invalid bivariate color: ${hexColor}`);
    }
    const value = Number.parseInt(match[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Convert integer RGB channels to a canonical lowercase hex color.
 *
 * @param {number} red Red channel.
 * @param {number} green Green channel.
 * @param {number} blue Blue channel.
 * @return {string} Canonical six-digit lowercase hexadecimal color.
 */
function rgbToHex(red, green, blue) {
    return `#${[red, green, blue]
        .map((value) => Math.round(value).toString(16).padStart(2, "0"))
        .join("")}`;
}

/**
 * Convert a supported hexadecimal color to an integer RGB CSS value.
 *
 * @param {string} hexColor Six-digit hexadecimal CSS color.
 * @return {string} Integer-channel CSS RGB color.
 */
function hexToRgbCss(hexColor) {
    const [red, green, blue] = hexToRgb(hexColor);
    return `rgb(${red},${green},${blue})`;
}

/**
 * Convert RGB channels to HSL unit coordinates.
 *
 * @param {number} red Red channel from zero through 255.
 * @param {number} green Green channel from zero through 255.
 * @param {number} blue Blue channel from zero through 255.
 * @return {number[]} Hue, saturation, and lightness unit coordinates.
 */
function rgbToHsl(red, green, blue) {
    const channels = [red, green, blue].map((value) => value / 255);
    const maximum = Math.max(...channels);
    const minimum = Math.min(...channels);
    const lightness = (maximum + minimum) / 2;
    if (maximum === minimum) {
        return [0, 0, lightness];
    }
    const difference = maximum - minimum;
    const saturation = lightness > 0.5
        ? difference / (2 - maximum - minimum)
        : difference / (maximum + minimum);
    let hue;
    if (maximum === channels[0]) {
        hue = (channels[1] - channels[2]) / difference +
            (channels[1] < channels[2] ? 6 : 0);
    } else if (maximum === channels[1]) {
        hue = (channels[2] - channels[0]) / difference + 2;
    } else {
        hue = (channels[0] - channels[1]) / difference + 4;
    }
    return [hue / 6, saturation, lightness];
}

/**
 * Convert HSL unit coordinates to RGB channels.
 *
 * @param {number} hue Hue unit coordinate.
 * @param {number} saturation Saturation unit coordinate.
 * @param {number} lightness Lightness unit coordinate.
 * @return {number[]} Red, green, and blue channels from zero through 255.
 */
function hslToRgb(hue, saturation, lightness) {
    if (saturation === 0) {
        const gray = lightness * 255;
        return [gray, gray, gray];
    }
    /**
     * Convert one normalized hue offset into its RGB channel value.
     *
     * @param {number} p Lower channel interpolation endpoint.
     * @param {number} q Upper channel interpolation endpoint.
     * @param {number} candidate Normalized hue offset.
     * @return {number} Interpolated normalized channel value.
     */
    const hueToRgb = (p, q, candidate) => {
        let value = candidate;
        if (value < 0) value += 1;
        if (value > 1) value -= 1;
        if (value < 1 / 6) return p + (q - p) * 6 * value;
        if (value < 1 / 2) return q;
        if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
        return p;
    };
    const q = lightness < 0.5
        ? lightness * (1 + saturation)
        : lightness + saturation - lightness * saturation;
    const p = 2 * lightness - q;
    return [
        hueToRgb(p, q, hue + 1 / 3) * 255,
        hueToRgb(p, q, hue) * 255,
        hueToRgb(p, q, hue - 1 / 3) * 255,
    ];
}

/**
 * Interpolate hue across its shortest circular distance.
 *
 * @param {number} start Starting hue unit coordinate.
 * @param {number} end Ending hue unit coordinate.
 * @param {number} amount Interpolation amount from zero through one.
 * @return {number} Interpolated hue unit coordinate.
 */
function interpolateHue(start, end, amount) {
    let difference = end - start;
    if (difference > 0.5) difference -= 1;
    if (difference < -0.5) difference += 1;
    const hue = start + difference * amount;
    return (hue + 1) % 1;
}

/**
 * Resolve one registered palette or reject an unowned name.
 *
 * @param {string} paletteName Registered palette identity.
 * @return {Object} Frozen coordinated palette definition.
 * @throws {Error} If the name is outside the eight-palette contract.
 */
function requirePalette(paletteName) {
    const palette = BIVARIATE_RASTER_PALETTES[paletteName];
    if (palette === undefined) {
        throw new Error(`Unknown bivariate raster palette: ${paletteName}`);
    }
    return palette;
}

/**
 * Create the continuous ESOS-C surface used to derive both axis ramps.
 *
 * @param {Object} palette Registered palette definition.
 * @return {(x:number,y:number)=>string} Continuous normalized color surface.
 */
export function createBivariateColormap(palette) {
    const baseColors = palette.baseRamp.map(hexToRgb);
    const lightener = hexToRgb(palette.lightenerColor);
    /**
     * Interpolate one numeric channel between two endpoints.
     *
     * @param {number} start Lower interpolation endpoint.
     * @param {number} end Upper interpolation endpoint.
     * @param {number} amount Normalized interpolation amount.
     * @return {number} Interpolated channel value.
     */
    const interpolate = (start, end, amount) =>
        start + (end - start) * amount;
    /**
     * Sample the palette's three-color base ramp.
     *
     * @param {number} amount Normalized ramp position.
     * @return {number[]} Red, green, and blue channels.
     */
    const ramp = (amount) => {
        const position = clamp01(amount);
        const lower = position <= 0.5 ? baseColors[0] : baseColors[1];
        const upper = position <= 0.5 ? baseColors[1] : baseColors[2];
        const local = position <= 0.5
            ? position / 0.5
            : (position - 0.5) / 0.5;
        return lower.map((channel, index) =>
            Math.round(interpolate(channel, upper[index], local))
        );
    };
    return (x, y) => {
        const base = ramp(x);
        const amount = clamp01(y * palette.strength);
        const baseHsl = rgbToHsl(...base);
        const lightHsl = rgbToHsl(...lightener);
        const mixed = hslToRgb(
            interpolateHue(baseHsl[0], lightHsl[0], amount),
            interpolate(baseHsl[1], lightHsl[1], amount),
            interpolate(baseHsl[2], lightHsl[2], amount),
        );
        return rgbToHex(...mixed.map(Math.round));
    };
}

/**
 * Add two RGB colors and clamp every channel to eight-bit output.
 *
 * @param {string|number[]} firstColor Hex color or three RGB channels.
 * @param {string|number[]} secondColor Hex color or three RGB channels.
 * @return {string} Additively blended six-digit hexadecimal color.
 */
export function blendAdditiveRgb(firstColor, secondColor) {
    const first = typeof firstColor === "string"
        ? hexToRgb(firstColor)
        : firstColor;
    const second = typeof secondColor === "string"
        ? hexToRgb(secondColor)
        : secondColor;
    return rgbToHex(
        Math.min(255, first[0] + second[0]),
        Math.min(255, first[1] + second[1]),
        Math.min(255, first[2] + second[2]),
    );
}

/**
 * Apply the ESOS-C density encoding to one additive histogram-cell color.
 *
 * @param {string} color Additively blended six-digit hexadecimal RGB color.
 * @param {number} densityWeight ESOS-C density weight from zero through one.
 * @return {string} Density-adjusted RGB CSS color.
 */
export function getBivariateHistogramCellColor(color, densityWeight) {
    const amount = clamp01(densityWeight);
    const [hue, saturation, lightness] = rgbToHsl(...hexToRgb(color));
    const saturationOutput = 0.08 + (saturation - 0.08) * amount;
    const lightnessOutput = 0.28 + (lightness - 0.28) *
        (0.25 + 0.75 * amount);
    const [red, green, blue] = hslToRgb(
        hue,
        saturationOutput,
        lightnessOutput
    );
    return `rgb(${red | 0},${green | 0},${blue | 0})`;
}

/**
 * Return one axis-ramp color as the integer RGB CSS used by ESOS-C marginals.
 *
 * @param {Object} style Coordinated X or Y raster style.
 * @param {number} value Finite value at the histogram-bin midpoint.
 * @return {string} Integer RGB CSS color.
 */
export function getBivariateAxisCssColor(style, value) {
    return hexToRgbCss(getRasterStyleColor(style, value));
}

/**
 * Normalize one populated paired bin with ESOS-C log, smoothstep, and gamma.
 *
 * @param {number} binCount Nonnegative count for one paired bin.
 * @param {number} maximumCount Largest populated paired-bin count.
 * @return {number} Density weight from zero through one.
 */
export function getBivariateDensityWeight(binCount, maximumCount) {
    if (!maximumCount || binCount <= 0) return 0;
    const logarithmic = Math.log1p(binCount) / Math.log1p(maximumCount);
    const smooth = logarithmic * logarithmic * (3 - 2 * logarithmic);
    return Math.pow(smooth, 1.2);
}

/**
 * Derive the X and Y WMS ramps from one palette definition.
 *
 * @param {string} paletteName Registered palette identity.
 * @param {Object} xStyle X raster's retained numeric range.
 * @param {Object} yStyle Y raster's retained numeric range.
 * @return {{xStyle:Object,yStyle:Object}} Coordinated axis styles.
 */
export function getBivariateAxisStyles(paletteName, xStyle, yStyle) {
    const color = createBivariateColormap(requirePalette(paletteName));
    return {
        xStyle: {
            ...xStyle,
            minimumColor: color(0, 0),
            midpointColor: color(0.5, 0),
            maximumColor: color(1, 0),
            minimumOpacity: 1,
            midpointOpacity: 1,
            maximumOpacity: 1,
        },
        yStyle: {
            ...yStyle,
            minimumColor: color(0, 0),
            midpointColor: color(0, 0.5),
            maximumColor: color(0, 1),
            minimumOpacity: 1,
            midpointOpacity: 1,
            maximumOpacity: 1,
        },
    };
}

/**
 * Return the exact map-composite color for one paired value.
 *
 * @param {string} paletteName Registered palette identity.
 * @param {Object} xStyle Retained X numeric range.
 * @param {Object} yStyle Retained Y numeric range.
 * @param {number} xValue Finite X raster value.
 * @param {number} yValue Finite Y raster value.
 * @return {string} Additively clipped hexadecimal RGB color.
 */
export function getBivariateColorForValues(
    paletteName,
    xStyle,
    yStyle,
    xValue,
    yValue,
) {
    const axisStyles = getBivariateAxisStyles(paletteName, xStyle, yStyle);
    return blendAdditiveRgb(
        getRasterStyleColor(axisStyles.xStyle, xValue),
        getRasterStyleColor(axisStyles.yStyle, yValue),
    );
}

/**
 * Return a normalized legend color through the same three-stop map ramps.
 *
 * @param {string} paletteName Registered palette identity.
 * @param {number} x Normalized X position.
 * @param {number} y Normalized Y position.
 * @return {string} Additively clipped hexadecimal RGB color.
 */
export function getBivariateColorAt(paletteName, x, y) {
    const normalizedStyle = {
        minimum: 0,
        midpoint: 0.5,
        maximum: 1,
        minimumColor: "#000000",
        midpointColor: "#000000",
        maximumColor: "#000000",
    };
    return getBivariateColorForValues(
        paletteName,
        normalizedStyle,
        normalizedStyle,
        clamp01(x),
        clamp01(y),
    );
}

/** Own explicit overlay/bivariate mode and deterministic X/Y assignments. */
export class BivariateRasterMode {
    /**
     * Create inactive normal-overlay state with the default palette.
     *
     * @return {void}
     */
    constructor() {
        this.active = false;
        this.paletteName = "orangeBlue";
        this.xKey = null;
        this.yKey = null;
    }

    /**
     * Enter with exactly two catalog keys in deterministic selection order.
     *
     * @param {string[]} eligibleKeys Two distinct catalog raster keys.
     * @return {void}
     * @throws {Error} If the exact two-raster contract is not satisfied.
     */
    enter(eligibleKeys) {
        if (
            !Array.isArray(eligibleKeys) ||
            eligibleKeys.length !== 2 ||
            eligibleKeys.some((key) => typeof key !== "string") ||
            eligibleKeys[0] === eligibleKeys[1]
        ) {
            throw new Error(
                "Bivariate mode requires exactly two selected catalog rasters."
            );
        }
        this.active = true;
        [this.xKey, this.yKey] = eligibleKeys;
    }

    /** Leave bivariate mode and remove both role assignments. @return {void} */
    leave() {
        this.active = false;
        this.xKey = null;
        this.yKey = null;
    }

    /**
     * Swap the current X and Y roles.
     *
     * @return {void}
     * @throws {Error} If bivariate mode is inactive.
     */
    swap() {
        if (!this.active) {
            throw new Error("Bivariate mode is not active.");
        }
        [this.xKey, this.yKey] = [this.yKey, this.xKey];
    }

    /**
     * Select one registered coordinated palette.
     *
     * @param {string} paletteName Registered palette identity.
     * @return {void}
     */
    setPalette(paletteName) {
        requirePalette(paletteName);
        this.paletteName = paletteName;
    }

    /**
     * Return whether one retained key participates in the active pair.
     *
     * @param {string} key Retained layer key.
     * @return {boolean} Whether key owns either current axis.
     */
    contains(key) {
        return this.active && (key === this.xKey || key === this.yKey);
    }
}
