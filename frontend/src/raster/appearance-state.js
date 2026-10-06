/** Layer-local raster appearance shared by saved maps and style copy/paste. */
import { normalizeCategoricalRasterStyle } from "./categorical-style.js";
import { RASTER_COLOR_PALETTES, validateRasterStyle } from "./style.js";

/**
 * Both committed style configurations and the mode selected for one raster.
 *
 * @typedef {Object} RasterAppearanceState
 * @property {"raster"} kind Layer appearance discriminator.
 * @property {1} appearanceVersion Portable appearance contract version.
 * @property {"continuous"|"categorical"} mode Active style configuration.
 * @property {Readonly<{definition:Readonly<import("./style.js").RasterStyle>,
 * paletteName:string,styleWasEdited:boolean}>} continuous Retained ramp state.
 * @property {Readonly<import("./categorical-style.js").CategoricalRasterStyle>|null}
 * categorical Retained category table, or null before categories are configured.
 */

const CONTINUOUS_STYLE_FIELDS = Object.freeze([
    "minimum", "midpoint", "maximum", "minimumColor", "midpointColor",
    "maximumColor", "minimumOpacity", "midpointOpacity", "maximumOpacity"
]);

/**
 * Require a plain object with exactly the fields owned by this contract.
 *
 * @param {unknown} candidate Untrusted record.
 * @param {string[]} fields Exact required own field names.
 * @param {string} label User-facing record name.
 * @return {Record<string,unknown>} Shape-validated record.
 * @throws {TypeError} If the value is not a plain object or its fields differ.
 */
function appearanceRecord(candidate, fields, label) {
    if (candidate === null || typeof candidate !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(candidate))) {
        throw new TypeError(`${label} must be an object.`);
    }
    const keys = Reflect.ownKeys(candidate);
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) {
        throw new TypeError(`${label} contains missing or unsupported fields.`);
    }
    return candidate;
}

/**
 * Normalize a retained continuous style, including legacy opaque color stops.
 *
 * @param {unknown} candidate Untrusted complete ramp state.
 * @param {boolean} legacy Whether the old six-field ramp may omit all opacities.
 * @return {Readonly<import("./style.js").RasterStyle>} Independent frozen ramp.
 * @throws {Error} If any field, threshold, color, or opacity is invalid.
 */
function normalizeContinuousDefinition(candidate, legacy) {
    const fields = legacy && candidate !== null && typeof candidate === "object" &&
        Reflect.ownKeys(candidate).length === 6
        ? CONTINUOUS_STYLE_FIELDS.slice(0, 6) : CONTINUOUS_STYLE_FIELDS;
    const record = appearanceRecord(candidate, fields, "Saved raster style");
    const definition = Object.fromEntries(CONTINUOUS_STYLE_FIELDS.map(field => [
        field, fields.includes(field) ? record[field] : 1
    ]));
    if (["minimum", "midpoint", "maximum"].some(stop =>
        typeof definition[`${stop}Color`] !== "string" ||
        !Number.isFinite(definition[`${stop}Opacity`]))) {
        throw new TypeError("Saved raster colors and opacities are invalid.");
    }
    validateRasterStyle(definition);
    return Object.freeze(definition);
}

/**
 * Normalize one complete raster appearance at an import or clipboard boundary.
 *
 * Both configurations survive mode changes. Legacy envelopes become continuous
 * appearance with an edited range, preserving the historical restore behavior;
 * legacy six-field ramps gain opaque color stops. Modern envelopes require all
 * fields, and categorical mode requires a valid nonempty category table. No
 * source identity, layer opacity, or renderer state belongs to this contract.
 *
 * @param {unknown} candidate Legacy or versioned portable raster appearance.
 * @return {Readonly<RasterAppearanceState>} Independent immutable appearance.
 * @throws {Error} If the envelope or either retained style is invalid.
 */
export function normalizeRasterAppearanceState(candidate) {
    const legacy = candidate !== null && typeof candidate === "object" &&
        !Object.hasOwn(candidate, "appearanceVersion");
    const envelope = appearanceRecord(candidate, legacy
        ? ["kind", "definition", "paletteName"]
        : ["kind", "appearanceVersion", "mode", "continuous", "categorical"],
    "Raster appearance");
    if (envelope.kind !== "raster") {
        throw new TypeError("Saved style does not belong to a raster.");
    }
    if (!legacy && envelope.appearanceVersion !== 1) {
        throw new TypeError("Raster appearance version is not supported.");
    }
    const mode = legacy ? "continuous" : envelope.mode;
    if (mode !== "continuous" && mode !== "categorical") {
        throw new TypeError("Raster appearance mode must be continuous or categorical.");
    }
    const continuous = legacy ? {
        definition: envelope.definition,
        paletteName: envelope.paletteName,
        styleWasEdited: true
    } : appearanceRecord(envelope.continuous,
        ["definition", "paletteName", "styleWasEdited"], "Continuous appearance");
    if (typeof continuous.paletteName !== "string" ||
        (continuous.paletteName !== "custom" &&
            !Object.hasOwn(RASTER_COLOR_PALETTES, continuous.paletteName))) {
        throw new TypeError("Saved raster palette is invalid.");
    }
    if (typeof continuous.styleWasEdited !== "boolean") {
        throw new TypeError("Continuous style edit state must be boolean.");
    }
    const categorical = legacy || envelope.categorical === null ? null
        : normalizeCategoricalRasterStyle(envelope.categorical);
    if (mode === "categorical" && categorical === null) {
        throw new TypeError("Categorical mode requires a category table.");
    }
    return Object.freeze({
        kind: "raster",
        appearanceVersion: 1,
        mode,
        continuous: Object.freeze({
            definition: normalizeContinuousDefinition(continuous.definition, legacy),
            paletteName: continuous.paletteName,
            styleWasEdited: continuous.styleWasEdited
        }),
        categorical
    });
}
