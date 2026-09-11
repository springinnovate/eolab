/** Immutable geographic selection values shared by sampling and downloads. No I/O. */
/**
 * Build the stable validation error used for malformed selected bounds.
 *
 * @return {Error} User-safe selected-bounds contract error.
 */
function rasterSelectedBoundsContractError() {
    return new Error("Raster statistics returned invalid selected bounds.");
}

/**
 * Validate one server-compatible WGS 84 statistics rectangle.
 *
 * @param {RasterSelectedBounds} bounds Candidate coordinate rectangle.
 * @return {RasterSelectedBounds} The validated non-wrapping WGS 84 bounds.
 * @throws {Error} If fields, ranges, or coordinate ordering are invalid.
 */
export function validateRasterSelectedBounds(bounds) {
    if (bounds === null || typeof bounds !== "object") {
        throw rasterSelectedBoundsContractError();
    }
    const fieldNames = ["west", "south", "east", "north"];
    if (
        Object.keys(bounds).length !== fieldNames.length ||
        !fieldNames.every((fieldName) => Object.hasOwn(bounds, fieldName))
    ) {
        throw rasterSelectedBoundsContractError();
    }
    const { west, south, east, north } = bounds;
    if (
        ![west, south, east, north].every(Number.isFinite) ||
        west < -180 || east > 180 || south < -90 || north > 90 ||
        !(west < east && south < north)
    ) {
        throw rasterSelectedBoundsContractError();
    }
    return bounds;
}

/** Immutable whole-raster member of the frontend sampling-area union. */
export const WHOLE_RASTER_SAMPLING_AREA = Object.freeze({
    kind: "wholeRaster"
});

/**
 * Normalize one strict raster-statistics sampling-area union.
 *
 * @param {Object} [samplingArea=WHOLE_RASTER_SAMPLING_AREA] Candidate whole,
 * selected-bounds, or catalog-selection area.
 * @return {Readonly<Object>} Validated immutable sampling area.
 * @throws {TypeError} If the discriminator, owned field, or object shape is
 * invalid.
 */
export function normalizeRasterSamplingArea(
    samplingArea = WHOLE_RASTER_SAMPLING_AREA
) {
    if (samplingArea === null || typeof samplingArea !== "object") {
        throw new TypeError("Raster statistics sampling area is invalid.");
    }
    const keys = Object.keys(samplingArea).sort();
    if (
        samplingArea.kind === "wholeRaster" &&
        keys.length === 1 && keys[0] === "kind"
    ) {
        return WHOLE_RASTER_SAMPLING_AREA;
    }
    if (
        samplingArea.kind === "selectedArea" &&
        keys.length === 2 &&
        keys[0] === "kind" &&
        keys[1] === "selectedBounds"
    ) {
        return Object.freeze({
            kind: "selectedArea",
            selectedBounds: Object.freeze({
                ...validateRasterSelectedBounds(samplingArea.selectedBounds)
            })
        });
    }
    if (samplingArea.kind === "catalogSelection" && keys.length === 2 &&
        keys[0] === "catalogSelection" && keys[1] === "kind") {
        return Object.freeze({ kind: "catalogSelection", catalogSelection: validateCatalogSelection(samplingArea.catalogSelection) });
    }
    throw new TypeError("Raster statistics sampling area is invalid.");
}

/** Validate and copy an immutable catalog vector selection.
 * @param {Object} value Public source identity and typed predicate.
 * @return {Readonly<Object>} Deeply immutable descriptor.
 * @throws {TypeError} For paths, geometry, malformed identity or filter fields.
 */
export function validateCatalogSelection(value) {
    const keys = ["assetKey", "collectionId", "filter", "itemId", "layerName", "sourceSignature"];
    if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== keys.join() ||
        value.collectionId !== "eolab-mounted-vectors" ||
        typeof value.itemId !== "string" || value.itemId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(value.itemId) ||
        ![value.assetKey, value.layerName].every(v => typeof v === "string" && v.length > 0 && v.length <= 256) ||
        !/^[0-9a-f]{64}$/.test(value.sourceSignature)) throw new TypeError("Invalid catalog selection identity");
    const input = value.filter;
    if (!input || Object.keys(input).sort().join() !== "enabled,match,rules" ||
        typeof input.enabled !== "boolean" || !["all", "any"].includes(input.match) ||
        !Array.isArray(input.rules) || input.rules.length > 12) throw new TypeError("Invalid catalog selection filter");
    const rules = input.rules.map(rule => {
        if (!rule || Object.keys(rule).sort().join() !== "field,operator,value" ||
            typeof rule.field !== "string" || !rule.field || rule.field.length > 256 || /[\u0000-\u001f]/.test(rule.field) ||
            !["eq", "ne", "gt", "ge", "lt", "le", "contains", "missing", "present"].includes(rule.operator) ||
            !(rule.value === null || typeof rule.value === "boolean" ||
              typeof rule.value === "number" && Number.isFinite(rule.value) && Math.abs(rule.value) <= Number.MAX_SAFE_INTEGER ||
              typeof rule.value === "string" && rule.value.length <= 256 && !/[\u0000-\u001f]/.test(rule.value))) throw new TypeError("Invalid catalog selection rule");
        return Object.freeze({ field: rule.field, operator: rule.operator, value: rule.value });
    });
    const filter = Object.freeze({ enabled: input.enabled, match: input.match, rules: Object.freeze(rules) });
    return Object.freeze({ collectionId: value.collectionId, itemId: value.itemId,
        assetKey: value.assetKey, layerName: value.layerName, sourceSignature: value.sourceSignature, filter });
}

/** Compare immutable selections independently of JSON property order.
 * @param {Object|null|undefined} left First descriptor.
 * @param {Object|null|undefined} right Second descriptor.
 * @return {boolean} Whether both descriptors identify the same exact selection.
 * @throws {TypeError} When a present descriptor violates its public contract.
 */
export function catalogSelectionsEqual(left, right) {
    return left != null && right != null &&
        JSON.stringify(validateCatalogSelection(left)) === JSON.stringify(validateCatalogSelection(right));
}
