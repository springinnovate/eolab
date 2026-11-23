/** Validate field display settings carried by a vector map view. */

/**
 * Inspector label and optional numeric display for one vector attribute.
 * @typedef {Object} FeatureFieldFormat
 * @property {string} [displayName] Trimmed, single-line label of at most 160 characters. Omit to use the source field name.
 * @property {"number"|"currency"} [format] Number or currency display; omit for the original value display.
 * @property {number} [decimals] Exact number of displayed decimal places.
 * @property {string} [unit] Text appended after the formatted number.
 * @property {string} [currency] Three-letter code required for currency display.
 */

/** @typedef {Readonly<Record<string, Readonly<FeatureFieldFormat>>>} FeatureFieldFormats */

/** Shared empty settings for a view that uses default field display. */
export const DEFAULT_FIELD_FORMATS = Object.freeze({});

/**
 * Validate one field's inspector label and numeric display for CSV import or a saved map.
 * @param {unknown} candidate Settings for one existing field name.
 * @return {Readonly<FeatureFieldFormat>} Validated display settings.
 * @throws {TypeError} If the format or one of its options is invalid.
 */
export function validateFeatureFieldFormat(candidate) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate) ||
        Object.keys(candidate).some(key => !["displayName", "format", "decimals", "unit", "currency"].includes(key))) {
        throw new TypeError("Use displayName, format, decimals, unit and currency settings.");
    }
    const { displayName, format, decimals, unit, currency } = candidate;
    if (Object.hasOwn(candidate, "displayName") &&
        (typeof displayName !== "string" || !displayName.length || displayName !== displayName.trim() ||
            /[\u0000-\u001f\u007f]/.test(displayName) || [...displayName].length > 160)) {
        throw new TypeError("Enter a display name on one line using at most 160 characters.");
    }
    if (Object.hasOwn(candidate, "format") && format !== "number" && format !== "currency") {
        throw new TypeError('Choose "number" or "currency" as the format.');
    }
    if (!Object.hasOwn(candidate, "format")) {
        if (!Object.hasOwn(candidate, "displayName")) throw new TypeError("Provide a display name or number format.");
        if (["decimals", "unit", "currency"].some(key => Object.hasOwn(candidate, key))) {
            throw new TypeError('Choose "number" or "currency" to set decimal places, units or currency.');
        }
    }
    if (Object.hasOwn(candidate, "decimals") && (!Number.isInteger(decimals) || decimals < 0 || decimals > 20)) {
        throw new TypeError("Enter a whole number of decimal places from 0 to 20.");
    }
    if (Object.hasOwn(candidate, "unit") &&
        (typeof unit !== "string" || !unit.length || unit !== unit.trim() ||
            /[\r\n]/.test(unit) || [...unit].length > 64)) {
        throw new TypeError("Enter a unit on one line using at most 64 characters.");
    }
    if (format === "currency") {
        if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
            throw new TypeError("Enter a three-letter currency code such as USD.");
        }
    } else if (Object.hasOwn(candidate, "currency")) {
        throw new TypeError('Choose the "currency" format to use a currency code.');
    }
    return Object.freeze({ ...candidate });
}

/**
 * Read field display settings from the portable vector layer document.
 * @param {unknown} candidate Settings keyed by exact source field name.
 * @return {FeatureFieldFormats} Detached settings for that layer view.
 * @throws {TypeError} If a field name or its settings violate the document contract.
 */
export function validateFeatureFieldFormats(candidate) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("Field formats must be keyed by field name.");
    }
    return Object.freeze(Object.fromEntries(Object.entries(candidate).map(([field, format]) => {
        if (field.length === 0) throw new TypeError("Field formats require a field name.");
        return [field, validateFeatureFieldFormat(format)];
    })));
}
