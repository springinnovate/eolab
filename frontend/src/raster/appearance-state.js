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
 * Check that an appearance object contains exactly the expected fields.
 *
 * @param {unknown} candidate Untrusted record.
 * @param {string[]} fields Exact required own field names.
 * @param {string} label User-facing record name.
 * @return {Record<string,unknown>} Shape-validated record.
 * @throws {TypeError} If the value is not a plain object or its fields differ.
 */
function validateAppearanceFields(candidate, fields, label) {
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
 * Validate and copy a complete retained continuous style.
 *
 * @param {unknown} candidate Untrusted complete ramp state.
 * @return {Readonly<import("./style.js").RasterStyle>} Independent frozen ramp.
 * @throws {Error} If any field, threshold, color, or opacity is invalid.
 */
function normalizeContinuousDefinition(candidate) {
    const record = validateAppearanceFields(candidate, CONTINUOUS_STYLE_FIELDS, "Saved raster style");
    const definition = Object.fromEntries(CONTINUOUS_STYLE_FIELDS.map(field => [field, record[field]]));
    if (["minimum", "midpoint", "maximum"].some(stop =>
        typeof definition[`${stop}Color`] !== "string" ||
        !Number.isFinite(definition[`${stop}Opacity`]))) {
        throw new TypeError("Saved raster colors and opacities are invalid.");
    }
    validateRasterStyle(definition);
    return Object.freeze(definition);
}

/**
 * Validate and copy a raster style loaded from a saved map or the style clipboard.
 *
 * Continuous and categorical settings both survive mode changes. The current
 * versioned appearance requires every field, and categorical mode
 * requires a nonempty category table. Source identity and whole-layer opacity are
 * stored separately from these style settings.
 *
 * @param {unknown} candidate Version-one portable raster appearance.
 * @return {Readonly<RasterAppearanceState>} Independent immutable appearance.
 * @throws {Error} If the appearance fields or either saved style are invalid.
 */
export function normalizeRasterAppearanceState(candidate) {
    const appearanceFields = validateAppearanceFields(candidate,
        ["kind", "appearanceVersion", "mode", "continuous", "categorical"],
    "Raster appearance");
    if (appearanceFields.kind !== "raster") {
        throw new TypeError("Saved style does not belong to a raster.");
    }
    if (appearanceFields.appearanceVersion !== 1) {
        throw new TypeError("Raster appearance version is not supported.");
    }
    const mode = appearanceFields.mode;
    if (mode !== "continuous" && mode !== "categorical") {
        throw new TypeError("Raster appearance mode must be continuous or categorical.");
    }
    const continuous = validateAppearanceFields(appearanceFields.continuous,
        ["definition", "paletteName", "styleWasEdited"], "Continuous appearance");
    if (typeof continuous.paletteName !== "string" ||
        (continuous.paletteName !== "custom" &&
            !Object.hasOwn(RASTER_COLOR_PALETTES, continuous.paletteName))) {
        throw new TypeError("Saved raster palette is invalid.");
    }
    if (typeof continuous.styleWasEdited !== "boolean") {
        throw new TypeError("Continuous style edit state must be boolean.");
    }
    const categorical = appearanceFields.categorical === null ? null
        : normalizeCategoricalRasterStyle(appearanceFields.categorical);
    if (mode === "categorical" && categorical === null) {
        throw new TypeError("Categorical mode requires a category table.");
    }
    return Object.freeze({
        kind: "raster",
        appearanceVersion: 1,
        mode,
        continuous: Object.freeze({
            definition: normalizeContinuousDefinition(continuous.definition),
            paletteName: continuous.paletteName,
            styleWasEdited: continuous.styleWasEdited
        }),
        categorical
    });
}
