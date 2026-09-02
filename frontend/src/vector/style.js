/** Validated browser representation of vector symbol and category styles. */

const GEOMETRY_KINDS = new Set(["point", "line", "polygon"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const LABEL_FONT_FAMILIES = new Set(["SansSerif", "Serif", "Monospaced"]);
const LABEL_FONT_WEIGHTS = new Set(["normal", "bold"]);
const LABEL_PLACEMENTS = new Set(["center", "above", "below", "follow-line"]);
const CATEGORY_KINDS = new Set(["boolean", "integer", "number", "string"]);
const CATEGORY_MAXIMUM_LIMIT = 50;
const CLASSIFICATION_METHODS = new Set(["equal-interval", "quantile"]);
const SEQUENTIAL_PALETTE_NAMES = new Set(["blues", "viridis", "yellow-red", "purples"]);
const NUMERIC_MINIMUM_CLASS_COUNT = 2;
const NUMERIC_MAXIMUM_CLASS_COUNT = 9;
const SEQUENTIAL_PALETTES = Object.freeze({
    blues: Object.freeze([
        "#f7fbff", "#deebf7", "#c6dbef", "#9ecae1", "#6baed6",
        "#4292c6", "#2171b5", "#08519c", "#08306b",
    ]),
    viridis: Object.freeze([
        "#440154", "#472d7b", "#3b528b", "#2c728e", "#21918c",
        "#27ad81", "#5cc863", "#aadc32", "#fde725",
    ]),
    "yellow-red": Object.freeze([
        "#ffffcc", "#ffeda0", "#fed976", "#feb24c", "#fd8d3c",
        "#fc4e2a", "#e31a1c", "#bd0026", "#800026",
    ]),
    purples: Object.freeze([
        "#fcfbfd", "#efedf5", "#dadaeb", "#bcbddc", "#9e9ac8",
        "#807dba", "#6a51a3", "#54278f", "#3f007d",
    ]),
});
const QUALITATIVE_COLORS = Object.freeze([
    "#d60000", "#8c3bff", "#018700", "#00acc6", "#e6a500",
    "#ff7ed1", "#6b004f", "#573b00", "#005659", "#15e18c",
    "#0000dd", "#a17569", "#bcb6ff", "#95b577", "#bf03b8",
    "#003c86", "#f0623d", "#708297", "#4c0055", "#004400",
    "#f4b8b8", "#001156", "#c2c680", "#ff2f80", "#00c1a3",
    "#6f7f00", "#f1d0ff", "#7e4a7b", "#a47700", "#00687b",
    "#d1ff00", "#6e7bff", "#755840", "#00a100", "#f6a4ff",
    "#0061c9", "#e6d56a", "#a00074", "#5b6454", "#ff8c00",
    "#00e5ff", "#b984c5", "#8c8c00", "#ff5f5f", "#00b55b",
    "#4f2f9f", "#c58c6d", "#6faed9", "#9d2d00", "#8ad0a0",
]);

/**
 * Validate and normalize a complete geometry-specific vector style.
 *
 * @param {Object} candidate Untrusted style-shaped value.
 * @return {Object} Frozen normalized style state.
 * @throws {TypeError|RangeError} If the style contract is invalid.
 */
export function normalizeVectorStyle(candidate) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("Vector style must be an object.");
    }
    const geometryKind = candidate.geometryKind;
    if (!GEOMETRY_KINDS.has(geometryKind)) {
        throw new TypeError("Vector style geometry is invalid.");
    }
    const strokeColor = color(candidate.strokeColor, "Outline color");
    const strokeOpacity = boundedNumber(
        candidate.strokeOpacity,
        0,
        1,
        "Outline opacity",
    );
    const strokeWidth = boundedNumber(
        candidate.strokeWidth,
        0,
        20,
        "Outline width",
    );
    const label = normalizeVectorLabel(candidate.label, geometryKind);
    const categorical = normalizeVectorCategorical(candidate.categorical);
    const graduated = normalizeVectorGraduated(candidate.graduated);
    if (categorical !== null && graduated !== null) {
        throw new TypeError("Vector styles cannot combine categories and ranges.");
    }
    if (geometryKind === "line") {
        requireAbsent(candidate, ["fillColor", "fillOpacity", "pointSize"]);
        return Object.freeze({
            geometryKind,
            fillColor: null,
            fillOpacity: null,
            strokeColor,
            strokeOpacity,
            strokeWidth,
            pointSize: null,
            categorical,
            graduated,
            label,
        });
    }
    const fillColor = color(candidate.fillColor, "Fill color");
    const fillOpacity = boundedNumber(
        candidate.fillOpacity,
        0,
        1,
        "Fill opacity",
    );
    if (geometryKind === "polygon") {
        requireAbsent(candidate, ["pointSize"]);
        return Object.freeze({
            geometryKind,
            fillColor,
            fillOpacity,
            strokeColor,
            strokeOpacity,
            strokeWidth,
            pointSize: null,
            categorical,
            graduated,
            label,
        });
    }
    return Object.freeze({
        geometryKind,
        fillColor,
        fillOpacity,
        strokeColor,
        strokeOpacity,
        strokeWidth,
        pointSize: boundedNumber(candidate.pointSize, 1, 64, "Point size"),
        categorical,
        graduated,
        label,
    });
}

/**
 * Extract exact non-geometry label fields from one Catalog Item.
 *
 * @param {Object} item Authoritative STAC Item already loaded by Catalog.
 * @return {ReadonlyArray<{name:string,type:string}>} Frozen selector options.
 */
export function vectorLabelFields(item) {
    const properties = item?.properties;
    const columns = properties?.["table:columns"];
    const primaryGeometry = properties?.["table:primary_geometry"];
    if (!Array.isArray(columns)) return Object.freeze([]);
    const names = new Set();
    const fields = [];
    for (const column of columns) {
        const name = column?.name;
        if (
            typeof name !== "string" ||
            name.length < 1 ||
            name.length > 256 ||
            /[\u0000-\u001f\u007f]/.test(name) ||
            name === primaryGeometry ||
            names.has(name)
        ) {
            continue;
        }
        names.add(name);
        fields.push(Object.freeze({
            name,
            type: typeof column.type === "string" ? column.type : "unknown",
        }));
    }
    return Object.freeze(fields);
}

/**
 * Keep only Catalog fields supported by the categorical scalar contract.
 *
 * @param {ReadonlyArray<{name:string,type:string}>} fields Catalog fields.
 * @return {ReadonlyArray<{name:string,type:string}>} Frozen eligible options.
 */
export function vectorCategoricalFields(fields) {
    if (!Array.isArray(fields)) return Object.freeze([]);
    return Object.freeze(fields.filter(({ name, type }) =>
        typeof name === "string" && vectorCategoricalFieldKind(type) !== null
    ));
}

/**
 * Keep only Catalog fields supported by graduated numeric styling.
 *
 * @param {ReadonlyArray<{name:string,type:string}>} fields Catalog fields.
 * @return {ReadonlyArray<{name:string,type:string}>} Frozen numeric options.
 */
export function vectorNumericFields(fields) {
    if (!Array.isArray(fields)) return Object.freeze([]);
    return Object.freeze(fields.filter(({ name, type }) =>
        typeof name === "string" && numericFieldKind(type) !== null
    ));
}

/**
 * Validate one bounded category-summary response from the vector boundary.
 *
 * @param {unknown} candidate Untrusted response-shaped value.
 * @return {Object} Frozen normalized category summary.
 * @throws {TypeError|RangeError} If the response contract is invalid.
 */
export function normalizeVectorCategorySummary(candidate) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("Vector category summary must be an object.");
    }
    const field = boundedText(candidate.field, 256, "Category field");
    const fieldType = boundedText(candidate.fieldType, 128, "Category field type");
    const defaultLimit = boundedInteger(
        candidate.defaultLimit, 1, CATEGORY_MAXIMUM_LIMIT, "Default category limit"
    );
    const maximumLimit = boundedInteger(
        candidate.maximumLimit, defaultLimit, CATEGORY_MAXIMUM_LIMIT,
        "Maximum category limit",
    );
    if (!Array.isArray(candidate.values) || candidate.values.length > maximumLimit) {
        throw new RangeError("Category values exceed the advertised maximum.");
    }
    const values = candidate.values.map((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
            throw new TypeError("Category count must be an object.");
        }
        return Object.freeze({
            value: normalizeCategoryValue(entry.value),
            count: boundedInteger(entry.count, 1, 100000, "Category count"),
        });
    });
    const observedDistinctCount = boundedInteger(
        candidate.observedDistinctCount, 0, 100000, "Observed distinct count"
    );
    if (observedDistinctCount < values.length) {
        throw new RangeError("Observed distinct count cannot be below returned values.");
    }
    const complete = candidate.complete;
    if (typeof complete !== "boolean") {
        throw new TypeError("Category summary completeness must be boolean.");
    }
    const distinctCount = candidate.distinctCount === null
        ? null
        : boundedInteger(candidate.distinctCount, 0, 100000, "Distinct count");
    if ((complete && distinctCount === null) || (!complete && distinctCount !== null)) {
        throw new TypeError("Distinct count must agree with summary completeness.");
    }
    if (distinctCount !== null && distinctCount !== observedDistinctCount) {
        throw new RangeError("Complete distinct count must equal the observed count.");
    }
    const scannedFeatureCount = boundedInteger(
        candidate.scannedFeatureCount, 0, 100000, "Scanned feature count"
    );
    const featureCount = boundedInteger(
        candidate.featureCount, 0, Number.MAX_SAFE_INTEGER, "Feature count"
    );
    if (complete && scannedFeatureCount !== featureCount) {
        throw new RangeError("Complete category summaries must scan every feature.");
    }
    return Object.freeze({
        field,
        fieldType,
        values: Object.freeze(values),
        observedDistinctCount,
        distinctCount,
        scannedFeatureCount,
        featureCount,
        nullCount: boundedInteger(candidate.nullCount, 0, 100000, "Null count"),
        unsupportedValueCount: boundedInteger(
            candidate.unsupportedValueCount, 0, 100000, "Unsupported value count"
        ),
        complete,
        defaultLimit,
        maximumLimit,
    });
}

/**
 * Validate one bounded numeric-classification response from the vector boundary.
 *
 * @param {unknown} candidate Untrusted response-shaped value.
 * @return {Object} Frozen normalized numeric classification.
 * @throws {TypeError|RangeError} If the response contract is invalid.
 */
export function normalizeVectorNumericClassification(candidate) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("Vector numeric classification must be an object.");
    }
    const field = boundedText(candidate.field, 256, "Numeric field");
    const fieldType = boundedText(candidate.fieldType, 128, "Numeric field type");
    if (numericFieldKind(fieldType) === null) {
        throw new TypeError("Numeric classification field type is invalid.");
    }
    const method = option(candidate.method, CLASSIFICATION_METHODS, "Classification method");
    const requestedClassCount = boundedInteger(
        candidate.requestedClassCount,
        NUMERIC_MINIMUM_CLASS_COUNT,
        NUMERIC_MAXIMUM_CLASS_COUNT,
        "Requested class count",
    );
    const actualClassCount = boundedInteger(
        candidate.actualClassCount,
        1,
        requestedClassCount,
        "Actual class count",
    );
    if (!Array.isArray(candidate.classes) || candidate.classes.length !== actualClassCount) {
        throw new TypeError("Numeric classes must match the actual class count.");
    }
    const classes = candidate.classes.map((classification) =>
        normalizeNumericRange(classification, true)
    );
    requireAdjacentOpenRanges(classes, "Numeric classes");
    const observedMinimum = finiteNumber(candidate.observedMinimum, "Observed minimum");
    const observedMaximum = finiteNumber(candidate.observedMaximum, "Observed maximum");
    if (observedMinimum > observedMaximum) {
        throw new RangeError("Observed numeric minimum cannot exceed its maximum.");
    }
    const numericValueCount = boundedInteger(
        candidate.numericValueCount, 1, 100000, "Numeric value count"
    );
    if (classes.reduce((total, classification) => total + classification.count, 0) !== numericValueCount) {
        throw new RangeError("Numeric class counts must cover every numeric value.");
    }
    const scannedFeatureCount = boundedInteger(
        candidate.scannedFeatureCount, 1, 100000, "Scanned feature count"
    );
    const featureCount = boundedInteger(
        candidate.featureCount, 1, Number.MAX_SAFE_INTEGER, "Feature count"
    );
    const complete = candidate.complete;
    if (typeof complete !== "boolean") {
        throw new TypeError("Numeric classification completeness must be boolean.");
    }
    if (complete && scannedFeatureCount !== featureCount) {
        throw new RangeError("Complete classifications must scan every feature.");
    }
    const defaultClassCount = boundedInteger(
        candidate.defaultClassCount, NUMERIC_MINIMUM_CLASS_COUNT,
        NUMERIC_MAXIMUM_CLASS_COUNT, "Default class count",
    );
    const minimumClassCount = boundedInteger(
        candidate.minimumClassCount, NUMERIC_MINIMUM_CLASS_COUNT,
        defaultClassCount, "Minimum class count",
    );
    const maximumClassCount = boundedInteger(
        candidate.maximumClassCount, defaultClassCount,
        NUMERIC_MAXIMUM_CLASS_COUNT, "Maximum class count",
    );
    return Object.freeze({
        field,
        fieldType,
        method,
        requestedClassCount,
        actualClassCount,
        classes: Object.freeze(classes),
        observedMinimum,
        observedMaximum,
        numericValueCount,
        scannedFeatureCount,
        featureCount,
        nullCount: boundedInteger(candidate.nullCount, 0, 100000, "Null count"),
        unsupportedValueCount: boundedInteger(
            candidate.unsupportedValueCount, 0, 100000, "Unsupported value count"
        ),
        complete,
        defaultClassCount,
        minimumClassCount,
        maximumClassCount,
    });
}

/**
 * Select perceptually ordered colors for one supported sequential palette.
 *
 * @param {string} palette Supported palette identity.
 * @param {number} classCount Effective class count from the server.
 * @return {ReadonlyArray<string>} Frozen light-to-dark color sequence.
 */
export function sequentialPaletteColors(palette, classCount) {
    const name = option(palette, SEQUENTIAL_PALETTE_NAMES, "Sequential palette");
    const count = boundedInteger(classCount, 1, NUMERIC_MAXIMUM_CLASS_COUNT, "Class count");
    const colors = SEQUENTIAL_PALETTES[name];
    if (count === 1) return Object.freeze([colors[4]]);
    return Object.freeze(Array.from({ length: count }, (_unused, index) =>
        colors[Math.round(index * (colors.length - 1) / (count - 1))]
    ));
}

/**
 * Format one open-ended numeric class for controls and neutral legends.
 *
 * @param {{minimum:number|null,maximum:number|null}} candidate Numeric class.
 * @return {string} Compact inclusive/exclusive range label.
 */
export function formatNumericRange(candidate) {
    const range = normalizeNumericRange({ ...candidate, count: 0 }, true);
    if (range.minimum === null && range.maximum === null) return "All values";
    if (range.minimum === null) return `≤ ${formatNumber(range.maximum)}`;
    if (range.maximum === null) return `> ${formatNumber(range.minimum)}`;
    return `> ${formatNumber(range.minimum)} to ≤ ${formatNumber(range.maximum)}`;
}

/**
 * Return a deterministic qualitative palette color.
 *
 * @param {number} index Stable category rank.
 * @param {number} [generation=0] Explicit palette regeneration number.
 * @return {string} Six-digit CSS hex color.
 */
export function qualitativeCategoryColor(index, generation = 0) {
    if (!Number.isInteger(index) || index < 0) {
        throw new RangeError("Category color index must be non-negative.");
    }
    if (!Number.isInteger(generation) || generation < 0) {
        throw new RangeError("Palette generation must be non-negative.");
    }
    return QUALITATIVE_COLORS[
        (index + generation * 11) % QUALITATIVE_COLORS.length
    ];
}

/**
 * Build a stable type-aware identity for one normalized category value.
 *
 * @param {Object} candidate Explicitly typed category value.
 * @return {string} Stable browser map key.
 */
export function categoryValueKey(candidate) {
    const value = normalizeCategoryValue(candidate);
    return JSON.stringify([value.kind, value.value]);
}

/**
 * Format one typed category value without losing boolean or numeric meaning.
 *
 * @param {Object} candidate Explicitly typed category value.
 * @return {string} User-facing value label.
 */
export function formatCategoryValue(candidate) {
    const value = normalizeCategoryValue(candidate);
    if (value.kind === "boolean") return value.value ? "True" : "False";
    return String(value.value);
}

/**
 * Build the neutral legend presentation from current vector style.
 *
 * @param {Object} candidate Complete vector style state.
 * @return {Object}
 * Map-layer legend contract.
 */
export function vectorStyleLegend(candidate) {
    const style = normalizeVectorStyle(candidate);
    if (style.graduated !== null) {
        const entries = style.graduated.rules.map((rule) => Object.freeze({
            label: formatNumericRange(rule),
            color: rule.color,
        }));
        if (style.graduated.missingColor !== null) {
            entries.push(Object.freeze({ label: "No value", color: style.graduated.missingColor }));
        }
        return {
            kind: "graduated",
            label: style.graduated.field,
            entries: Object.freeze(entries),
        };
    }
    if (style.categorical !== null) {
        const entries = style.categorical.rules.map((rule) => Object.freeze({
            label: formatCategoryValue(rule.value),
            color: rule.color,
        }));
        if (style.categorical.otherColor !== null) {
            entries.push(Object.freeze({ label: "Other", color: style.categorical.otherColor }));
        }
        if (style.categorical.missingColor !== null) {
            entries.push(Object.freeze({ label: "No value", color: style.categorical.missingColor }));
        }
        return {
            kind: "categories",
            label: style.categorical.field,
            entries: Object.freeze(entries),
        };
    }
    return {
        kind: "fixed",
        label: `${style.geometryKind[0].toUpperCase()}${style.geometryKind.slice(1)}`,
        fill: style.fillColor ?? style.strokeColor,
        stroke: style.strokeColor,
    };
}

/**
 * Validate an optional graduated numeric style block.
 *
 * @param {unknown} candidate Candidate graduated state or null.
 * @return {Object|null} Frozen normalized graduated state.
 */
function normalizeVectorGraduated(candidate) {
    if (candidate === undefined || candidate === null) return null;
    if (typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("Graduated style must be an object or null.");
    }
    const field = boundedText(candidate.field, 256, "Graduated field");
    const method = option(candidate.method, CLASSIFICATION_METHODS, "Classification method");
    const classCount = boundedInteger(
        candidate.classCount,
        NUMERIC_MINIMUM_CLASS_COUNT,
        NUMERIC_MAXIMUM_CLASS_COUNT,
        "Class count",
    );
    const palette = option(candidate.palette, SEQUENTIAL_PALETTE_NAMES, "Sequential palette");
    if (!Array.isArray(candidate.rules) || candidate.rules.length < 1 || candidate.rules.length > classCount) {
        throw new RangeError("Graduated rules must fit the selected class count.");
    }
    const rules = candidate.rules.map((rule) => {
        const range = normalizeNumericRange(rule, false);
        return Object.freeze({
            minimum: range.minimum,
            maximum: range.maximum,
            color: color(rule.color, "Graduated color"),
        });
    });
    requireAdjacentOpenRanges(rules, "Graduated rules");
    return Object.freeze({
        field,
        method,
        classCount,
        palette,
        rules: Object.freeze(rules),
        missingColor: candidate.missingColor === undefined || candidate.missingColor === null
            ? null : color(candidate.missingColor, "No value color"),
    });
}

/**
 * Normalize one open-ended numeric range.
 *
 * @param {unknown} candidate Candidate range object.
 * @param {boolean} includeCount Whether to validate and retain a count.
 * @return {Object} Frozen normalized range.
 */
function normalizeNumericRange(candidate, includeCount) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("Numeric range must be an object.");
    }
    const minimum = candidate.minimum === null ? null : finiteNumber(candidate.minimum, "Range minimum");
    const maximum = candidate.maximum === null ? null : finiteNumber(candidate.maximum, "Range maximum");
    if (minimum !== null && maximum !== null && minimum >= maximum) {
        throw new RangeError("Numeric range minimum must be below its maximum.");
    }
    const normalized = { minimum, maximum };
    if (includeCount) normalized.count = boundedInteger(candidate.count, 0, 100000, "Class count");
    return Object.freeze(normalized);
}

/**
 * Require first/last open bounds and exact adjacency between numeric ranges.
 *
 * @param {ReadonlyArray<{minimum:number|null,maximum:number|null}>} ranges Numeric ranges.
 * @param {string} label User-facing contract label.
 * @return {void}
 */
function requireAdjacentOpenRanges(ranges, label) {
    if (ranges[0].minimum !== null || ranges.at(-1).maximum !== null) {
        throw new RangeError(`${label} must cover all numeric values.`);
    }
    for (let index = 0; index < ranges.length - 1; index += 1) {
        if (ranges[index].maximum !== ranges[index + 1].minimum) {
            throw new RangeError(`${label} must be adjacent.`);
        }
    }
}

/**
 * Require one finite number.
 *
 * @param {unknown} value Candidate number.
 * @param {string} label User-facing field label.
 * @return {number} Validated number.
 */
function finiteNumber(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${label} must be finite.`);
    }
    return value;
}

/**
 * Format one finite classification boundary without unreadable precision.
 *
 * @param {number} value Numeric boundary.
 * @return {string} Compact locale-independent representation.
 */
function formatNumber(value) {
    const magnitude = Math.abs(value);
    if ((magnitude !== 0 && magnitude < 0.001) || magnitude >= 1000000) {
        return value.toExponential(3);
    }
    return Number(value.toPrecision(6)).toString();
}

/**
 * Normalize one six-digit CSS hex color.
 *
 * @param {unknown} value Candidate color.
 * @param {string} label User-facing field label.
 * @return {string} Lowercase color.
 */
function color(value, label) {
    if (typeof value !== "string" || !HEX_COLOR.test(value)) {
        throw new TypeError(`${label} must be a six-digit hex color.`);
    }
    return value.toLowerCase();
}

/**
 * Validate an optional categorical style block.
 *
 * @param {unknown} candidate Candidate category state or null.
 * @return {Object|null} Frozen normalized categorical state.
 */
function normalizeVectorCategorical(candidate) {
    if (candidate === undefined || candidate === null) return null;
    if (typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("Categorical style must be an object or null.");
    }
    const field = boundedText(candidate.field, 256, "Category field");
    const limit = boundedInteger(
        candidate.limit, 1, CATEGORY_MAXIMUM_LIMIT, "Category limit"
    );
    if (!Array.isArray(candidate.rules) || candidate.rules.length < 1) {
        throw new TypeError("Categorical style requires at least one rule.");
    }
    if (candidate.rules.length > limit) {
        throw new RangeError("Category rules exceed the selected limit.");
    }
    const seen = new Set();
    const rules = candidate.rules.map((rule) => {
        if (rule === null || typeof rule !== "object" || Array.isArray(rule)) {
            throw new TypeError("Category rule must be an object.");
        }
        const value = normalizeCategoryValue(rule.value);
        const key = categoryValueKey(value);
        if (seen.has(key)) throw new TypeError("Category rule values must be unique.");
        seen.add(key);
        return Object.freeze({ value, color: color(rule.color, "Category color") });
    });
    return Object.freeze({
        field,
        limit,
        rules: Object.freeze(rules),
        otherColor: candidate.otherColor === undefined || candidate.otherColor === null
            ? null : color(candidate.otherColor, "Other color"),
        missingColor:
            candidate.missingColor === undefined || candidate.missingColor === null
                ? null : color(candidate.missingColor, "No value color"),
    });
}

/**
 * Validate one explicit category type and scalar value.
 *
 * @param {unknown} candidate Candidate typed value object.
 * @return {{kind:string,value:boolean|number|string}} Frozen typed value.
 */
function normalizeCategoryValue(candidate) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("Category value must be explicitly typed.");
    }
    if (!CATEGORY_KINDS.has(candidate.kind)) {
        throw new TypeError("Category value kind is invalid.");
    }
    const value = candidate.value;
    if (candidate.kind === "boolean" && typeof value !== "boolean") {
        throw new TypeError("Boolean category value is invalid.");
    }
    if (candidate.kind === "integer" && !Number.isSafeInteger(value)) {
        throw new TypeError("Integer category value is invalid.");
    }
    if (candidate.kind === "number" && !Number.isFinite(value)) {
        throw new TypeError("Numeric category value is invalid.");
    }
    if (candidate.kind === "string") {
        if (
            typeof value !== "string" || value.length > 256 ||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
        ) {
            throw new TypeError("Category text is too long or contains invalid controls.");
        }
    }
    return Object.freeze({ kind: candidate.kind, value });
}

/**
 * Map one Catalog field type to the explicit category value kind.
 *
 * @param {unknown} fieldType Catalog field type.
 * @return {"boolean"|"integer"|"number"|"string"|null} Supported category
 * kind or null when the field cannot be styled categorically.
 */
export function vectorCategoricalFieldKind(fieldType) {
    if (typeof fieldType !== "string") return null;
    const baseType = fieldType.split(":", 1)[0].toLowerCase();
    if (["str", "string"].includes(baseType)) return "string";
    if (["int", "int16", "int32", "int64"].includes(baseType)) return "integer";
    if (["float", "float32", "float64", "real"].includes(baseType)) return "number";
    if (["bool", "boolean"].includes(baseType)) return "boolean";
    return null;
}

/**
 * Map one Catalog field type to a supported numeric scalar kind.
 *
 * @param {unknown} fieldType Catalog field type.
 * @return {"integer"|"number"|null} Numeric kind or null when unsupported.
 */
function numericFieldKind(fieldType) {
    const kind = vectorCategoricalFieldKind(fieldType);
    return kind === "integer" || kind === "number" ? kind : null;
}

/**
 * Validate and normalize an optional vector label.
 *
 * @param {unknown} candidate Candidate nested label state or null.
 * @param {string} geometryKind Validated parent geometry class.
 * @return {Object|null} Frozen normalized label or null when labels are off.
 */
function normalizeVectorLabel(candidate, geometryKind) {
    if (candidate === undefined || candidate === null) return null;
    if (typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new TypeError("Vector label must be an object or null.");
    }
    const field = candidate.field;
    if (
        typeof field !== "string" ||
        field.length < 1 ||
        field.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(field)
    ) {
        throw new TypeError("Label field is invalid.");
    }
    const placement = option(
        candidate.placement,
        LABEL_PLACEMENTS,
        "Label placement",
    );
    if (placement === "follow-line" && geometryKind !== "line") {
        throw new TypeError("Only line labels can follow line geometry.");
    }
    const minimumZoom = candidate.minimumZoom;
    if (!Number.isInteger(minimumZoom) || minimumZoom < 0 || minimumZoom > 22) {
        throw new RangeError("Label minimum zoom must be from 0 to 22.");
    }
    return Object.freeze({
        field,
        fontFamily: option(
            candidate.fontFamily,
            LABEL_FONT_FAMILIES,
            "Label font family",
        ),
        fontSize: boundedNumber(candidate.fontSize, 6, 72, "Label font size"),
        fontWeight: option(
            candidate.fontWeight,
            LABEL_FONT_WEIGHTS,
            "Label font weight",
        ),
        fontColor: color(candidate.fontColor, "Label color"),
        haloColor: color(candidate.haloColor, "Label halo color"),
        haloWidth: boundedNumber(
            candidate.haloWidth,
            0,
            10,
            "Label halo width",
        ),
        placement,
        minimumZoom,
    });
}

/**
 * Require one value from a closed string option set.
 *
 * @param {unknown} value Candidate option.
 * @param {Set<string>} choices Allowed values.
 * @param {string} label User-facing field label.
 * @return {string} Validated option.
 */
function option(value, choices, label) {
    if (typeof value !== "string" || !choices.has(value)) {
        throw new TypeError(`${label} is invalid.`);
    }
    return value;
}

/**
 * Require a finite number inside an inclusive range.
 *
 * @param {unknown} value Candidate number.
 * @param {number} minimum Inclusive minimum.
 * @param {number} maximum Inclusive maximum.
 * @param {string} label User-facing field label.
 * @return {number} Validated number.
 */
function boundedNumber(value, minimum, maximum, label) {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
        throw new RangeError(`${label} must be from ${minimum} to ${maximum}.`);
    }
    return value;
}

/**
 * Require an integer inside an inclusive range.
 *
 * @param {unknown} value Candidate integer.
 * @param {number} minimum Inclusive minimum.
 * @param {number} maximum Inclusive maximum.
 * @param {string} label User-facing field label.
 * @return {number} Validated integer.
 */
function boundedInteger(value, minimum, maximum, label) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`${label} must be from ${minimum} to ${maximum}.`);
    }
    return value;
}

/**
 * Require bounded non-control text.
 *
 * @param {unknown} value Candidate text.
 * @param {number} maximumLength Maximum accepted characters.
 * @param {string} label User-facing field label.
 * @return {string} Validated text.
 */
function boundedText(value, maximumLength, label) {
    if (
        typeof value !== "string" || value.length < 1 ||
        value.length > maximumLength || /[\u0000-\u001f\u007f]/.test(value)
    ) {
        throw new TypeError(`${label} is invalid.`);
    }
    return value;
}

/**
 * Reject non-null values that belong to another geometry class.
 *
 * @param {Object} candidate Complete candidate object.
 * @param {string[]} names Inapplicable field names.
 * @return {void}
 */
function requireAbsent(candidate, names) {
    for (const name of names) {
        if (candidate[name] !== undefined && candidate[name] !== null) {
            throw new TypeError(`${name} does not apply to this geometry.`);
        }
    }
}
