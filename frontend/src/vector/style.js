/** Validated browser representation of vector single-symbol styles. */

const GEOMETRY_KINDS = new Set(["point", "line", "polygon"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const LABEL_FONT_FAMILIES = new Set(["SansSerif", "Serif", "Monospaced"]);
const LABEL_FONT_WEIGHTS = new Set(["normal", "bold"]);
const LABEL_PLACEMENTS = new Set(["center", "above", "below", "follow-line"]);

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
 * Build the neutral fixed-swatch presentation from current vector style.
 *
 * @param {Object} candidate Complete vector style state.
 * @return {{kind:"fixed",label:string,fill:string,stroke:string}}
 * Map-layer legend contract.
 */
export function vectorStyleLegend(candidate) {
    const style = normalizeVectorStyle(candidate);
    return {
        kind: "fixed",
        label: `${style.geometryKind[0].toUpperCase()}${style.geometryKind.slice(1)}`,
        fill: style.fillColor ?? style.strokeColor,
        stroke: style.strokeColor,
    };
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
