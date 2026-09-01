/** Validated browser representation of vector single-symbol styles. */

const GEOMETRY_KINDS = new Set(["point", "line", "polygon"]);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

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
    });
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
