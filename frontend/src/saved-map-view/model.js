/** Versioned, portable saved-map document validation and construction. */

export const SAVED_MAP_VIEW_FORMAT = "eolab-map-view";
export const SAVED_MAP_VIEW_SCHEMA_VERSION = 1;
export const MAX_SAVED_MAP_VIEW_BYTES = 512 * 1024;
export const MAX_SAVED_MAP_VIEW_LAYERS = 50;

const MAX_IDENTITY_LENGTH = 512;
const MAX_VERSION_LENGTH = 100;
const SOURCE_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

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
        ...candidate,
    });
}

/**
 * Parse one bounded JSON document from an untrusted local file.
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
            "Saved map files must be 512 KiB or smaller."
        );
    }
    let candidate;
    try {
        candidate = JSON.parse(serialized);
    } catch {
        throw new SavedMapViewValidationError(
            "The selected file is not valid JSON."
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
 * Hash an opaque scanner-owned source revision without exporting its details.
 *
 * @param {unknown} sourceRevision Scanner-owned source revision value.
 * @param {SubtleCrypto} subtleCrypto Web Crypto digest implementation.
 * @return {Promise<string|null>} SHA-256 fingerprint or null when unavailable.
 */
export async function hashSavedMapSourceRevision(
    sourceRevision,
    subtleCrypto = globalThis.crypto?.subtle
) {
    if (sourceRevision === null || sourceRevision === undefined) {
        return null;
    }
    if (typeof subtleCrypto?.digest !== "function") {
        throw new Error("This browser cannot fingerprint Catalog revisions.");
    }
    const bytes = new TextEncoder().encode(JSON.stringify(sourceRevision));
    const digest = await subtleCrypto.digest("SHA-256", bytes);
    const hexadecimal = [...new Uint8Array(digest)]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
    return `sha256:${hexadecimal}`;
}

/**
 * Validate and normalize the complete saved-map contract.
 *
 * @param {unknown} candidate Untrusted parsed value.
 * @return {Readonly<Object>} Frozen canonical document.
 */
function validateSavedMapView(candidate) {
    requirePlainObject(candidate, "Saved map");
    requireExactKeys(
        candidate,
        ["format", "schemaVersion", "viewer", "createdAt", "viewport", "layers"],
        "Saved map"
    );
    if (candidate.format !== SAVED_MAP_VIEW_FORMAT) {
        throw new SavedMapViewValidationError(
            "This file is not an EOLab saved map."
        );
    }
    if (candidate.schemaVersion !== SAVED_MAP_VIEW_SCHEMA_VERSION) {
        throw new SavedMapViewValidationError(
            `Saved map schema ${String(candidate.schemaVersion)} is not supported.`
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
    if (!Array.isArray(candidate.layers)) {
        throw new SavedMapViewValidationError("Saved map layers must be a list.");
    }
    if (candidate.layers.length > MAX_SAVED_MAP_VIEW_LAYERS) {
        throw new SavedMapViewValidationError(
            `Saved maps may contain at most ${MAX_SAVED_MAP_VIEW_LAYERS} layers.`
        );
    }
    const layers = candidate.layers.map(validateLayer);
    if (layers.filter((layer) => layer.visible).length > 2) {
        throw new SavedMapViewValidationError(
            "Saved maps may have at most two visible layers."
        );
    }
    const identities = new Set();
    for (const layer of layers) {
        const key = JSON.stringify([
            layer.catalogItem.collection,
            layer.catalogItem.id,
        ]);
        if (identities.has(key)) {
            throw new SavedMapViewValidationError(
                "Saved map layers cannot repeat a Catalog Item."
            );
        }
        identities.add(key);
    }
    return Object.freeze({
        format: SAVED_MAP_VIEW_FORMAT,
        schemaVersion: SAVED_MAP_VIEW_SCHEMA_VERSION,
        viewer: Object.freeze({ version, origin }),
        createdAt,
        viewport,
        layers: Object.freeze(layers),
    });
}

/**
 * Validate one layer entry without interpreting its owner-specific style.
 *
 * @param {unknown} candidate Untrusted layer value.
 * @return {Readonly<Object>} Frozen normalized layer entry.
 */
function validateLayer(candidate) {
    requirePlainObject(candidate, "Saved layer");
    requireExactKeys(
        candidate,
        ["catalogItem", "sourceRevision", "visible", "opacity", "style"],
        "Saved layer"
    );
    requirePlainObject(candidate.catalogItem, "Catalog Item identity");
    requireExactKeys(
        candidate.catalogItem,
        ["collection", "id"],
        "Catalog Item identity"
    );
    const catalogItem = Object.freeze({
        collection: requireBoundedString(
            candidate.catalogItem.collection,
            MAX_IDENTITY_LENGTH,
            "Catalog Collection id"
        ),
        id: requireBoundedString(
            candidate.catalogItem.id,
            MAX_IDENTITY_LENGTH,
            "Catalog Item id"
        ),
    });
    if (candidate.sourceRevision !== null &&
        !SOURCE_REVISION_PATTERN.test(candidate.sourceRevision)) {
        throw new SavedMapViewValidationError(
            "Saved layer source revision is invalid."
        );
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
    requireExactKeys(
        candidate.style,
        candidate.style.kind === "raster"
            ? ["kind", "definition", "paletteName"]
            : ["kind", "definition"],
        "Saved layer style"
    );
    requirePlainObject(candidate.style.definition, "Saved style definition");
    return Object.freeze({
        catalogItem,
        sourceRevision: candidate.sourceRevision,
        visible: candidate.visible,
        opacity: candidate.opacity,
        style: structuredClone(candidate.style),
    });
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
