/** Versioned, portable saved-map document validation and construction. */

export const SAVED_MAP_VIEW_FORMAT = "eolab-map-view";
export const SAVED_MAP_VIEW_SCHEMA_VERSION = 3;
export const MAX_SAVED_MAP_VIEW_BYTES = 512 * 1024;
export const MAX_SAVED_MAP_VIEW_LAYERS = 50;

const MAX_IDENTITY_LENGTH = 512;
const MAX_VERSION_LENGTH = 100;
const MAX_APPEARANCE_DEFINITION_BYTES = 65536;

/** Error raised when an imported saved-map document violates its contract. */
export class SavedMapViewValidationError extends Error {
    /**
     * Create a user-facing saved-map validation error.
     *
     * @param {string} message Specific contract failure.
     */
    constructor(message) {
        super(message);
        this.name = "SavedMapViewValidationError";
    }
}

/**
 * Build and validate one canonical portable map document.
 *
 * @param {Object} candidate Complete saved-map fields.
 * @return {Readonly<Object>} Frozen canonical document.
 */
export function createSavedMapView(candidate) {
    return validateSavedMapView({
        format: SAVED_MAP_VIEW_FORMAT,
        schemaVersion: SAVED_MAP_VIEW_SCHEMA_VERSION,
        ...(!candidate.schemaVersion || candidate.schemaVersion === 3 ? { basemap: "detailed" } : {}),
        ...candidate,
    });
}

/**
 * Parse one bounded JSON document from an untrusted transport.
 *
 * @param {string} serialized Candidate JSON text.
 * @return {Readonly<Object>} Frozen canonical saved-map document.
 * @throws {SavedMapViewValidationError} If size, JSON, or fields are invalid.
 */
export function parseSavedMapView(serialized) {
    if (typeof serialized !== "string") {
        throw new SavedMapViewValidationError("Saved map content must be text.");
    }
    if (new TextEncoder().encode(serialized).byteLength > MAX_SAVED_MAP_VIEW_BYTES) {
        throw new SavedMapViewValidationError(
            "Saved map content must be 512 KiB or smaller."
        );
    }
    let candidate;
    try {
        candidate = JSON.parse(serialized);
    } catch {
        throw new SavedMapViewValidationError(
            "The saved map content is not valid JSON."
        );
    }
    return validateSavedMapView(candidate);
}

/**
 * Serialize one already validated saved-map document.
 *
 * @param {Object} savedMapView Canonical saved-map document.
 * @return {string} Indented UTF-8 JSON text.
 */
export function serializeSavedMapView(savedMapView) {
    return `${JSON.stringify(validateSavedMapView(savedMapView), null, 2)}\n`;
}

/**
 * Validate and normalize the complete saved-map contract.
 *
 * @param {unknown} candidate Untrusted parsed value.
 * @return {Readonly<Object>} Frozen canonical document.
 */
function validateSavedMapView(candidate) {
    requirePlainObject(candidate, "Saved map");
    if (![1, 2, SAVED_MAP_VIEW_SCHEMA_VERSION].includes(candidate.schemaVersion)) {
        throw new SavedMapViewValidationError(
            `Saved map schema ${String(candidate.schemaVersion)} is not supported.`
        );
    }
    requireExactKeys(
        candidate,
        ["format", "schemaVersion", "viewer", "createdAt", "viewport", "layers",
            ...(candidate.schemaVersion === 3 ? ["basemap"] : []),
            ...(Object.hasOwn(candidate, "mapLegend") ? ["mapLegend"] : [])],
        "Saved map"
    );
    if (candidate.format !== SAVED_MAP_VIEW_FORMAT) {
        throw new SavedMapViewValidationError(
            "This content is not an EOLab saved map."
        );
    }
    requirePlainObject(candidate.viewer, "Viewer");
    requireExactKeys(candidate.viewer, ["version", "origin"], "Viewer");
    const version = requireBoundedString(
        candidate.viewer.version,
        MAX_VERSION_LENGTH,
        "Viewer version"
    );
    const origin = validateOrigin(candidate.viewer.origin);
    const createdAt = validateTimestamp(candidate.createdAt);
    const viewport = validateViewport(candidate.viewport);
    if (candidate.schemaVersion === 3 && !["detailed", "carto", "maptiler", "outlines", "none"].includes(candidate.basemap)) {
        throw new SavedMapViewValidationError("Saved basemap provider is invalid.");
    }
    if (!Array.isArray(candidate.layers)) {
        throw new SavedMapViewValidationError("Saved map layers must be a list.");
    }
    if (candidate.layers.length > MAX_SAVED_MAP_VIEW_LAYERS) {
        throw new SavedMapViewValidationError(
            `Saved maps may contain at most ${MAX_SAVED_MAP_VIEW_LAYERS} layers.`
        );
    }
    if (Object.hasOwn(candidate, "mapLegend")) {
        requirePlainObject(candidate.mapLegend, "Map legend");
        requireExactKeys(candidate.mapLegend, ["visible", "collapsed"], "Map legend");
        if (typeof candidate.mapLegend.visible !== "boolean" || typeof candidate.mapLegend.collapsed !== "boolean") {
            throw new SavedMapViewValidationError("Map legend visibility and collapse state must be boolean.");
        }
    }
    const layers = candidate.layers.map(layer => {
        requirePlainObject(layer, "Saved layer");
        if (Object.hasOwn(layer, "legendIncluded") && typeof layer.legendIncluded !== "boolean") {
            throw new SavedMapViewValidationError("Layer legend inclusion must be boolean.");
        }
        if (layer?.sharedAnnotation !== undefined) {
            if (candidate.schemaVersion === 1) throw new SavedMapViewValidationError("Shared layers require saved-map version two.");
            return validateAnnotationReference(layer);
        }
        if (Object.hasOwn(layer, "temporalSource") && candidate.schemaVersion !== 3) {
            throw new SavedMapViewValidationError("Temporal layers require saved-map version three.");
        }
        if (Object.hasOwn(layer, "uploadId") && candidate.schemaVersion !== 3) {
            throw new SavedMapViewValidationError("Uploaded layers require saved-map version three.");
        }
        return validateLayer(layer);
    });
    const identities = new Set();
    for (const layer of layers) {
        if (layer.temporalSource) continue;
        const key = layer.sharedAnnotation ? `annotation:${layer.sharedAnnotation.id}`
            : layer.uploadId ? `upload:${layer.uploadId}` : JSON.stringify([
            layer.catalogItem.collection,
            layer.catalogItem.id,
        ]);
        if (identities.has(key)) {
            throw new SavedMapViewValidationError(
                "Saved map layers cannot repeat a layer."
            );
        }
        identities.add(key);
    }
    return Object.freeze({
        format: SAVED_MAP_VIEW_FORMAT,
        schemaVersion: candidate.schemaVersion,
        viewer: Object.freeze({ version, origin }),
        createdAt,
        viewport,
        ...(candidate.schemaVersion === 3 ? { basemap: candidate.basemap } : {}),
        layers: Object.freeze(layers),
        ...(candidate.mapLegend ? { mapLegend: Object.freeze({ ...candidate.mapLegend }) } : {}),
    });
}

/**
 * Validate a same-site invitation and local appearance without accepting polygons or credentials.
 * @param {Object} candidate Untrusted annotation layer entry.
 * @return {Readonly<Object>} Independent portable layer reference.
 * @throws {SavedMapViewValidationError} If any field is unsupported or invalid.
 */
function validateAnnotationReference(candidate) {
    requirePlainObject(candidate, "Shared layer");
    requireExactKeys(candidate, ["sharedAnnotation", "visible", "opacity", "appearance", ...(Object.hasOwn(candidate, "legendIncluded") ? ["legendIncluded"] : [])], "Shared layer");
    const reference = candidate.sharedAnnotation;
    requirePlainObject(reference, "Shared layer reference");
    requireExactKeys(reference, ["id", "joinCode"], "Shared layer reference");
    if (typeof reference.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reference.id) ||
        typeof reference.joinCode !== "string" || !/^[A-Z2-9]{8}$/.test(reference.joinCode)) {
        throw new SavedMapViewValidationError("Shared layer invitation is invalid.");
    }
    const appearance = candidate.appearance;
    requirePlainObject(appearance, "Layer appearance");
    requireExactKeys(appearance, ["outline", "weight", "fillOpacity", "labels", "notes"], "Layer appearance");
    if (typeof candidate.visible !== "boolean" || !Number.isFinite(candidate.opacity) || candidate.opacity < 0 || candidate.opacity > 1 ||
        typeof appearance.outline !== "string" || !/^#[0-9a-f]{6}$/i.test(appearance.outline) ||
        !Number.isFinite(appearance.weight) || appearance.weight < 0 || appearance.weight > 10 ||
        !Number.isFinite(appearance.fillOpacity) || appearance.fillOpacity < 0 || appearance.fillOpacity > 1 ||
        typeof appearance.labels !== "boolean" || typeof appearance.notes !== "boolean") {
        throw new SavedMapViewValidationError("Shared layer appearance is invalid.");
    }
    return Object.freeze(structuredClone(candidate));
}

/**
 * Validate a catalog, temporal or private-upload reference and its saved appearance.
 * Upload identifiers locate data; they never grant another browser access.
 *
 * @param {unknown} candidate Untrusted layer value.
 * @return {Readonly<Object>} Frozen normalized layer entry.
 * @throws {SavedMapViewValidationError} If the identity or presentation is invalid.
 */
function validateLayer(candidate) {
    requirePlainObject(candidate, "Saved layer");
    const isUpload = Object.hasOwn(candidate, "uploadId");
    const isTemporal = Object.hasOwn(candidate, "temporalSource");
    requireExactKeys(
        candidate,
        [isTemporal ? "temporalSource" : isUpload ? "uploadId" : "catalogItem", "visible", "opacity", "style",
            ...(Object.hasOwn(candidate, "legendIncluded") ? ["legendIncluded"] : []),
            ...(Object.hasOwn(candidate, "customName") ? ["customName"] : []),
            ...(!isTemporal && Object.hasOwn(candidate, "filter") ? ["filter"] : [])],
        "Saved layer"
    );
    let customName;
    if (Object.hasOwn(candidate, "customName")) {
        customName = candidate.customName;
        if (customName !== null) {
            if (typeof customName !== "string" || !customName.trim() || [...customName.trim()].length > 160) {
                throw new SavedMapViewValidationError("Layer name must contain 1 to 160 characters.");
            }
            customName = customName.trim();
        }
    }
    let identity;
    if (isTemporal) {
        const source = candidate.temporalSource;
        requirePlainObject(source, "Temporal source");
        requireExactKeys(source, ["collectionId", "itemId", "variable", "time"], "Temporal source");
        if (typeof source.time !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(source.time) ||
            !Number.isFinite(Date.parse(source.time))) {
            throw new SavedMapViewValidationError("Observation time must be a valid timestamp with a timezone.");
        }
        identity = { temporalSource: Object.freeze({
            collectionId: requireBoundedString(source.collectionId, MAX_IDENTITY_LENGTH, "Catalog Collection id"),
            itemId: requireBoundedString(source.itemId, MAX_IDENTITY_LENGTH, "Catalog Item id"),
            variable: requireBoundedString(source.variable, MAX_IDENTITY_LENGTH, "Variable"),
            time: new Date(source.time).toISOString(),
        }) };
    } else if (isUpload) {
        if (typeof candidate.uploadId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(candidate.uploadId)) {
            throw new SavedMapViewValidationError("Uploaded layer identifier is invalid.");
        }
        identity = { uploadId: candidate.uploadId };
    } else {
        requirePlainObject(candidate.catalogItem, "Catalog Item identity");
        requireExactKeys(candidate.catalogItem, ["collection", "id"], "Catalog Item identity");
        identity = { catalogItem: Object.freeze({
            collection: requireBoundedString(candidate.catalogItem.collection, MAX_IDENTITY_LENGTH, "Catalog Collection id"),
            id: requireBoundedString(candidate.catalogItem.id, MAX_IDENTITY_LENGTH, "Catalog Item id"),
        }) };
    }
    if (typeof candidate.visible !== "boolean") {
        throw new SavedMapViewValidationError(
            "Saved layer visibility must be true or false."
        );
    }
    if (!Number.isFinite(candidate.opacity) ||
        candidate.opacity < 0 || candidate.opacity > 1) {
        throw new SavedMapViewValidationError(
            "Saved layer opacity must be from zero through one."
        );
    }
    requirePlainObject(candidate.style, "Saved layer style");
    if (!new Set(["raster", "vector"]).has(candidate.style.kind)) {
        throw new SavedMapViewValidationError(
            "Saved layer style kind must be raster or vector."
        );
    }
    if (isUpload && candidate.style.kind !== "vector") {
        throw new SavedMapViewValidationError("Uploaded layers require a vector style.");
    }
    if (isTemporal && candidate.style.kind !== "raster") {
        throw new SavedMapViewValidationError("Temporal layers require a raster style.");
    }
    validateSavedStyleStructure(candidate.style);
    if (Object.hasOwn(candidate, "filter")) {
        requirePlainObject(candidate.filter, "Saved filter");
        if (JSON.stringify(candidate.filter).length > 8192) {
            throw new SavedMapViewValidationError("Saved filter exceeds its size limit.");
        }
    }
    return Object.freeze({
        ...identity,
        ...(customName === undefined ? {} : { customName }),
        ...(Object.hasOwn(candidate, "legendIncluded") ? { legendIncluded: candidate.legendIncluded } : {}),
        visible: candidate.visible,
        opacity: candidate.opacity,
        style: structuredClone(candidate.style),
        ...(Object.hasOwn(candidate, "filter") ? { filter: structuredClone(candidate.filter) } : {}),
    });
}

/**
 * Check which style fields may be stored in a saved map.
 *
 * Version-one raster styles retain continuous and categorical settings.
 * This checks structure and size; each raster or vector adapter validates the
 * actual colors, ranges and category rules before applying them.
 *
 * @param {Object} style Untrusted raster or vector style record.
 * @return {void}
 * @throws {SavedMapViewValidationError} If required fields, versions or size limits are invalid.
 */
function validateSavedStyleStructure(style) {
    if (style.kind !== "raster") {
        requireExactKeys(style, ["kind", "definition"], "Saved layer style");
        requirePlainObject(style.definition, "Saved style definition");
        return;
    }
    requireExactKeys(style,
        ["kind", "appearanceVersion", "mode", "continuous", "categorical"],
        "Saved raster appearance");
    if (style.appearanceVersion !== 1) {
        throw new SavedMapViewValidationError("Raster appearance version is not supported.");
    }
    if (!["continuous", "categorical"].includes(style.mode)) {
        throw new SavedMapViewValidationError("Raster appearance mode is invalid.");
    }
    requirePlainObject(style.continuous, "Continuous appearance");
    requireExactKeys(style.continuous,
        ["definition", "paletteName", "styleWasEdited"], "Continuous appearance");
    requireBoundedString(style.continuous.paletteName, 100, "Raster palette name");
    if (typeof style.continuous.styleWasEdited !== "boolean") {
        throw new SavedMapViewValidationError("Continuous style edit state must be boolean.");
    }
    validateAppearanceDefinition(style.continuous.definition);
    if (style.categorical !== null) {
        validateAppearanceDefinition(style.categorical);
    } else if (style.mode === "categorical") {
        throw new SavedMapViewValidationError("Categorical mode requires a category table.");
    }
}

/**
 * Check that saved style settings are an object whose JSON fits within 64 KiB.
 *
 * @param {unknown} definition Raster or vector style settings.
 * @return {void}
 * @throws {SavedMapViewValidationError} If shape or serialized size is invalid.
 */
function validateAppearanceDefinition(definition) {
    requirePlainObject(definition, "Saved appearance definition");
    if (new TextEncoder().encode(JSON.stringify(definition)).byteLength >
        MAX_APPEARANCE_DEFINITION_BYTES) {
        throw new SavedMapViewValidationError(
            "Saved appearance definition exceeds 65536 UTF-8 bytes."
        );
    }
}

/**
 * Validate the canonical WGS 84 viewport.
 *
 * @param {unknown} candidate Untrusted viewport value.
 * @return {Readonly<Object>} Frozen canonical viewport.
 */
function validateViewport(candidate) {
    requirePlainObject(candidate, "Viewport");
    requireExactKeys(candidate, ["center", "zoom"], "Viewport");
    requirePlainObject(candidate.center, "Viewport center");
    requireExactKeys(
        candidate.center,
        ["latitude", "longitude"],
        "Viewport center"
    );
    const latitude = candidate.center.latitude;
    const longitude = candidate.center.longitude;
    const zoom = candidate.zoom;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 ||
        !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        throw new SavedMapViewValidationError(
            "Saved viewport center must be within the WGS 84 world."
        );
    }
    if (!Number.isFinite(zoom) || zoom < 0 || zoom > 22) {
        throw new SavedMapViewValidationError(
            "Saved viewport zoom must be from zero through 22."
        );
    }
    return Object.freeze({
        center: Object.freeze({ latitude, longitude }),
        zoom,
    });
}

/**
 * Require an ordinary JSON object.
 *
 * @param {unknown} candidate Untrusted candidate.
 * @param {string} label User-facing field label.
 * @return {void}
 */
function requirePlainObject(candidate, label) {
    if (candidate === null || typeof candidate !== "object" ||
        Array.isArray(candidate) || Object.getPrototypeOf(candidate) !== Object.prototype) {
        throw new SavedMapViewValidationError(`${label} must be an object.`);
    }
}

/**
 * Require exactly the named object fields without extension payloads.
 *
 * @param {Object} candidate Candidate object.
 * @param {string[]} expectedKeys Complete supported fields.
 * @param {string} label User-facing object label.
 * @return {void}
 */
function requireExactKeys(candidate, expectedKeys, label) {
    const actualKeys = Object.keys(candidate).sort();
    const requiredKeys = [...expectedKeys].sort();
    if (JSON.stringify(actualKeys) !== JSON.stringify(requiredKeys)) {
        throw new SavedMapViewValidationError(
            `${label} contains missing or unsupported fields.`
        );
    }
}

/**
 * Require a nonempty bounded string.
 *
 * @param {unknown} candidate Untrusted value.
 * @param {number} maximumLength Maximum accepted characters.
 * @param {string} label User-facing field label.
 * @return {string} Validated string.
 */
function requireBoundedString(candidate, maximumLength, label) {
    if (typeof candidate !== "string" || candidate.length === 0 ||
        candidate.length > maximumLength) {
        throw new SavedMapViewValidationError(
            `${label} must be a nonempty string no longer than ${maximumLength} characters.`
        );
    }
    return candidate;
}

/**
 * Validate one absolute HTTP(S) deployment origin.
 *
 * @param {unknown} candidate Untrusted origin value.
 * @return {string} Validated exact origin.
 */
function validateOrigin(candidate) {
    const value = requireBoundedString(candidate, 2048, "Viewer origin");
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new SavedMapViewValidationError("Viewer origin must be an absolute URL.");
    }
    if (!new Set(["http:", "https:"]).has(parsed.protocol) ||
        parsed.origin !== value) {
        throw new SavedMapViewValidationError(
            "Viewer origin must contain only an HTTP or HTTPS origin."
        );
    }
    return value;
}

/**
 * Validate an ISO timestamp and return its canonical representation.
 *
 * @param {unknown} candidate Untrusted timestamp.
 * @return {string} Canonical ISO timestamp.
 */
function validateTimestamp(candidate) {
    if (typeof candidate !== "string" || !Number.isFinite(Date.parse(candidate))) {
        throw new SavedMapViewValidationError(
            "Saved map creation time must be a valid timestamp."
        );
    }
    return new Date(candidate).toISOString();
}
