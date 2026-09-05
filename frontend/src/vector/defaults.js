/** Pure initial vector appearance derived from Catalog fields and explicit results. */

import {
    normalizeVectorNumericClassification,
    normalizeVectorStyle,
    sequentialPaletteColors,
    vectorCategoricalFieldKind,
    vectorNumericFields,
} from "./style.js";

/** Readable initial label presentation, shared with the vector Style form. */
export const VECTOR_LABEL_DEFAULTS = Object.freeze({
    fontFamily: "SansSerif",
    fontSize: 12,
    fontWeight: "normal",
    fontColor: "#111827",
    haloColor: "#ffffff",
    haloWidth: 1.5,
    minimumZoom: 0,
});

/** Initial bounded classification and low-to-high palette selection. */
export const VECTOR_NUMERIC_DEFAULTS = Object.freeze({
    method: "percentile-interval",
    classCount: 5,
    palette: "blue-yellow-red",
});

/**
 * Choose a recognizable text name without treating arbitrary codes as labels.
 *
 * @param {ReadonlyArray<{name:string,type:string}>} fields Catalog fields.
 * @return {string|null} Exact field identity, or null if none is unambiguous.
 */
export function defaultVectorLabelField(fields) {
    const textFields = fields.filter(({ type }) =>
        vectorCategoricalFieldKind(type) === "string"
    );
    for (const preferred of ["name", "display_name", "common_name", "label", "title", "nm"]) {
        const matches = textFields.filter(({ name }) => name.toLowerCase() === preferred);
        if (matches.length === 1) return matches[0].name;
        if (matches.length > 1) return null;
    }
    const named = textFields.filter(({ name }) => /(?:^(?:name|nm)[_ ]|[_ ](?:name|nm)$)/i.test(name));
    return named.length === 1 ? named[0].name : null;
}

/**
 * Select a sole plausible numeric measurement, excluding obvious identifiers.
 *
 * @param {ReadonlyArray<{name:string,type:string}>} fields Catalog fields.
 * @return {string|null} Exact measurement field, or null when choice is ambiguous.
 */
export function defaultVectorNumericField(fields) {
    const measurements = vectorNumericFields(fields).filter(({ name }) => {
        const words = name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
        return !/(?:^|[_\s-])(?:id|fid|oid|objectid|ogc_fid|gid|uuid|guid|code|index)(?:$|[_\s-])/.test(words)
            && !/^(?:objectid|fid|oid|gid)\d*$/.test(words);
    });
    return measurements.length === 1 ? measurements[0].name : null;
}

/**
 * Return label placement that preserves the visibility of the underlying symbol.
 *
 * @param {string} geometryKind Validated point, line, or polygon geometry.
 * @return {string} Supported geometry-appropriate label placement.
 */
export function defaultVectorLabelPlacement(geometryKind) {
    return geometryKind === "line" ? "follow-line"
        : geometryKind === "point" ? "above" : "center";
}

/**
 * Derive a new layer's style from Catalog fields and a bounded numeric result.
 *
 * @param {Object} initial Validated publication's default symbol style.
 * @param {ReadonlyArray<{name:string,type:string}>} fields Catalog fields.
 * @param {Object|null} [classification=null] Explicit bounded classification result.
 * @return {Object} Complete normalized initial style, including optional labels/ranges.
 * @throws {TypeError} If a classification does not match the default request.
 */
export function deriveDefaultVectorStyle(initial, fields, classification = null) {
    const style = normalizeVectorStyle(initial);
    const field = defaultVectorLabelField(fields);
    const label = field === null ? null : {
        ...VECTOR_LABEL_DEFAULTS,
        field,
        placement: defaultVectorLabelPlacement(style.geometryKind),
    };
    let graduated = null;
    if (classification !== null) {
        const summary = normalizeVectorNumericClassification(classification);
        if (summary.field !== defaultVectorNumericField(fields)
            || summary.method !== VECTOR_NUMERIC_DEFAULTS.method
            || summary.requestedClassCount !== VECTOR_NUMERIC_DEFAULTS.classCount) {
            throw new TypeError("Default numeric classification does not match the request.");
        }
        const colors = sequentialPaletteColors(
            VECTOR_NUMERIC_DEFAULTS.palette, summary.actualClassCount,
        );
        graduated = {
            ...VECTOR_NUMERIC_DEFAULTS,
            field: summary.field,
            rules: summary.classes.map((range, index) => ({
                minimum: range.minimum,
                maximum: range.maximum,
                color: colors[index],
            })),
            missingColor: summary.nullCount > 0 ? "#d1d5db" : null,
        };
    }
    return normalizeVectorStyle({ ...style, label, graduated });
}
