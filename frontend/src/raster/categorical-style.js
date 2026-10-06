/**
 * Bounded exact-value raster styling contracts, independent of controls,
 * rendering transport, and raster analysis. Categories describe appearance;
 * transparent categories remain data and do not redefine source NoData.
 */

/**
 * One exact raster value and its presentation.
 *
 * @typedef {Object} RasterCategory
 * @property {number} value Unique safe integer category code.
 * @property {string} label Nonempty label, at most 128 Unicode code points.
 * @property {string} color Six-digit RGB hex color, normalized to lowercase.
 * @property {number} opacity Independent category opacity from zero to one.
 */

/**
 * Appearance for valid raster values absent from the category table.
 *
 * @typedef {Object} UnmappedRasterAppearance
 * @property {string} color Six-digit RGB hex color, normalized to lowercase.
 * @property {number} opacity Independent opacity from zero to one.
 */

/**
 * Immutable normalized categorical appearance, in caller-supplied table order.
 *
 * @typedef {Object} CategoricalRasterStyle
 * @property {"categorical"} mode Exact-value styling discriminator.
 * @property {ReadonlyArray<Readonly<RasterCategory>>} categories Category table.
 * @property {Readonly<UnmappedRasterAppearance>} unmapped Unmapped appearance.
 */

/** Maximum number of category rows carried by one style. */
export const MAX_CATEGORICAL_RASTER_CATEGORIES = 256;

/** Maximum number of Unicode code points in a trimmed category label. */
export const MAX_CATEGORICAL_RASTER_LABEL_LENGTH = 128;

/** Maximum UTF-8 byte length of the normalized style's JSON representation. */
export const MAX_CATEGORICAL_RASTER_STYLE_BYTES = 65536;

/** Default appearance keeps valid values with missing definitions visible. */
export const DEFAULT_UNMAPPED_RASTER_APPEARANCE = Object.freeze({
    color: "#808080",
    opacity: 1
});

/** Exact RGB color syntax; alpha is represented separately by opacity. */
const CATEGORICAL_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/**
 * Require a plain record containing only fields owned by the given contract.
 *
 * @param {unknown} value Candidate record.
 * @param {string[]} fields Permitted own field names.
 * @param {string} location Human-readable field location.
 * @return {Record<string, unknown>} Candidate record after shape validation.
 * @throws {Error} If the value is not a plain record or has unknown fields.
 */
function categoricalRecord(value, fields, location) {
    if (
        value === null || typeof value !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
        throw new Error(`${location} must be an object.`);
    }
    if (Reflect.ownKeys(value).some((field) => !fields.includes(field))) {
        throw new Error(`${location} contains unknown fields.`);
    }
    return value;
}

/**
 * Validate and normalize one RGB color without accepting CSS color syntax.
 *
 * @param {unknown} value Candidate color.
 * @param {string} location Human-readable field location.
 * @return {string} Lowercase six-digit RGB hex color.
 * @throws {Error} If the color is not a six-digit hex string.
 */
function categoricalColor(value, location) {
    if (typeof value !== "string" || !CATEGORICAL_COLOR_PATTERN.test(value)) {
        throw new Error(`${location} must use a six-digit hex color.`);
    }
    return value.toLowerCase();
}

/**
 * Validate an independent opacity, defaulting omitted values to opaque.
 *
 * @param {unknown} value Candidate opacity or undefined when omitted.
 * @param {string} location Human-readable field location.
 * @return {number} Opacity from zero through one.
 * @throws {Error} If supplied opacity is not finite or is outside zero to one.
 */
function categoricalOpacity(value, location) {
    if (value === undefined) return 1;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${location} must be a finite number from zero to one.`);
    }
    return value === 0 ? 0 : value;
}

/**
 * Validate a human-readable category label and trim surrounding whitespace.
 *
 * @param {unknown} value Candidate label.
 * @param {string} location Human-readable field location.
 * @return {string} Nonempty trimmed Unicode label with bounded length.
 * @throws {Error} If the label is missing, too long, or contains invalid Unicode.
 */
function categoricalLabel(value, location) {
    if (typeof value !== "string") {
        throw new Error(`${location} must be a nonempty string.`);
    }
    const label = value.trim();
    const characters = Array.from(label);
    if (!characters.length || characters.length > MAX_CATEGORICAL_RASTER_LABEL_LENGTH) {
        throw new Error(`${location} must contain 1 to 128 Unicode code points.`);
    }
    if (characters.some((character) => {
        const point = character.codePointAt(0);
        return point >= 0xd800 && point <= 0xdfff;
    })) {
        throw new Error(`${location} must contain valid Unicode.`);
    }
    return label;
}

/**
 * Validate and copy a bounded categorical style at the appearance boundary.
 *
 * Exact safe integer codes include zero and negative values. Values are never
 * rounded or coerced. Categories preserve input order, colors become lowercase,
 * labels are trimmed, omitted opacity defaults to one, and omitted unmapped
 * fields default to opaque gray. All returned records and arrays are
 * frozen and independent of the input. The normalized JSON may not exceed
 * 65,536 UTF-8 bytes. Source NoData and layer opacity remain separate contracts.
 *
 * @param {unknown} style Candidate categorical style with optional opacities
 * and optional unmapped appearance.
 * @return {Readonly<CategoricalRasterStyle>} Immutable normalized appearance.
 * @throws {Error} If shape, values, uniqueness, or resource limits are invalid.
 */
export function normalizeCategoricalRasterStyle(style) {
    const record = categoricalRecord(style, ["mode", "categories", "unmapped"], "Style");
    if (record.mode !== "categorical") {
        throw new Error("Style mode must be categorical.");
    }
    if (
        !Array.isArray(record.categories) || record.categories.length < 1 ||
        record.categories.length > MAX_CATEGORICAL_RASTER_CATEGORIES
    ) {
        throw new Error("Style categories must contain 1 to 256 rows.");
    }
    const values = new Set();
    const categories = Array.from(record.categories, (candidate, index) => {
        const location = `Category ${index + 1}`;
        const category = categoricalRecord(
            candidate, ["value", "label", "color", "opacity"], location
        );
        if (!Number.isSafeInteger(category.value)) {
            throw new Error(`${location} value must be a safe integer.`);
        }
        if (values.has(category.value)) {
            throw new Error(`${location} value duplicates another category.`);
        }
        values.add(category.value);
        return Object.freeze({
            value: category.value === 0 ? 0 : category.value,
            label: categoricalLabel(category.label, `${location} label`),
            color: categoricalColor(category.color, `${location} color`),
            opacity: categoricalOpacity(category.opacity, `${location} opacity`)
        });
    });
    const unmapped = record.unmapped === undefined
        ? DEFAULT_UNMAPPED_RASTER_APPEARANCE
        : categoricalRecord(record.unmapped, ["color", "opacity"], "Unmapped appearance");
    const normalized = Object.freeze({
        mode: "categorical",
        categories: Object.freeze(categories),
        unmapped: Object.freeze({
            color: categoricalColor(
                unmapped.color === undefined
                    ? DEFAULT_UNMAPPED_RASTER_APPEARANCE.color : unmapped.color,
                "Unmapped color"
            ),
            opacity: categoricalOpacity(unmapped.opacity, "Unmapped opacity")
        })
    });
    if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength >
        MAX_CATEGORICAL_RASTER_STYLE_BYTES) {
        throw new Error("Categorical style exceeds 65536 UTF-8 bytes.");
    }
    return normalized;
}
