/** HTTP contracts for catalog vector assessment and publication. */

const PUBLICATION_FAILURE_CATEGORIES = new Set([
    "reader_rejection",
    "connectivity",
    "authentication",
    "timeout",
    "configuration",
    "upstream_failure",
]);

/** Error returned by a vector assessment or publication boundary. */
export class VectorRenderingRequestError extends Error {
    /**
     * Create a rendering request failure.
     *
     * @param {string} message Browser-safe actionable detail.
     * @param {string|null} category Stable publication category.
     */
    constructor(message, category = null) {
        super(message);
        this.name = "VectorRenderingRequestError";
        this.category = category;
    }
}

/**
 * Decode one failed vector rendering response.
 *
 * @param {Response} response Failed fetch response.
 * @param {string} action User-facing action phrase.
 * @return {Promise<VectorRenderingRequestError>} Decoded safe failure.
 */
async function vectorRenderingError(response, action) {
    let detail = null;
    try {
        detail = (await response.json())?.detail ?? null;
    } catch {
        detail = null;
    }
    if (
        detail !== null &&
        typeof detail === "object" &&
        PUBLICATION_FAILURE_CATEGORIES.has(detail.category) &&
        typeof detail.message === "string"
    ) {
        return new VectorRenderingRequestError(
            detail.message,
            detail.category
        );
    }
    if (typeof detail === "string" && detail.length > 0) {
        return new VectorRenderingRequestError(detail);
    }
    return new VectorRenderingRequestError(
        `Vector ${action} returned ${response.status}.`
    );
}

/**
 * Post one selected vector Item identity to an owned rendering action.
 *
 * @param {Object} item Selected STAC Item.
 * @param {"assessments"|"layers"|"styles"} action Rendering action path.
 * @param {string} actionLabel User-facing failure action.
 * @param {typeof fetch} fetchImplementation HTTP implementation.
 * @param {Object} [additionalBody={}] Additional action-owned request fields.
 * @return {Promise<Object>} Parsed response document.
 * @throws {VectorRenderingRequestError} If HTTP or JSON contracts fail.
 */
async function postVectorAction(
    item,
    action,
    actionLabel,
    fetchImplementation,
    additionalBody = {},
) {
    let response;
    try {
        response = await fetchImplementation(`/api/vector-rendering/${action}`, {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                collectionId: item.collection,
                itemId: item.id,
                ...additionalBody,
            }),
        });
    } catch (error) {
        throw new VectorRenderingRequestError(
            `Vector ${actionLabel} could not reach the application.`
        );
    }
    if (!response.ok) {
        throw await vectorRenderingError(response, actionLabel);
    }
    try {
        return await response.json();
    } catch (error) {
        throw new VectorRenderingRequestError(
            `Vector ${actionLabel} returned an invalid response.`
        );
    }
}

/**
 * Assess one exact catalog vector source layer.
 *
 * @param {Object} item Selected vector STAC Item.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP
 * implementation.
 * @return {Promise<Object>} Updated authoritative assessed Item.
 * @throws {VectorRenderingRequestError} If assessment fails.
 */
export function assessCatalogVector(item, fetchImplementation = globalThis.fetch) {
    return postVectorAction(
        item,
        "assessments",
        "assessment",
        fetchImplementation
    );
}

/**
 * Publish one assessed exact catalog vector source layer.
 *
 * @param {Object} item Selected vector STAC Item.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP
 * implementation.
 * @return {Promise<Object>} Published bounded-WMS layer contract.
 * @throws {VectorRenderingRequestError} If publication fails.
 */
export async function publishCatalogVector(
    item,
    fetchImplementation = globalThis.fetch
) {
    const publication = await postVectorAction(
        item,
        "layers",
        "publication",
        fetchImplementation
    );
    if (
        !Array.isArray(publication?.bbox) ||
        publication.bbox.length !== 4 ||
        !publication.bbox.every(Number.isFinite) ||
        typeof publication.layerName !== "string" ||
        !["point", "line", "polygon"].includes(publication.geometryKind) ||
        publication.styleName !== `vector-${publication.geometryKind}` ||
        publication.style?.geometryKind !== publication.geometryKind
    ) {
        throw new VectorRenderingRequestError(
            "Vector publication returned an invalid layer contract."
        );
    }
    return publication;
}

/**
 * Apply one complete single-symbol style to a published catalog vector.
 *
 * @param {Object} item Selected vector STAC Item.
 * @param {Object} style Validated geometry-specific browser style state.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP
 * implementation.
 * @return {Promise<Object>} Normalized applied style state.
 * @throws {VectorRenderingRequestError} If style application fails.
 */
export async function styleCatalogVector(
    item,
    style,
    fetchImplementation = globalThis.fetch,
) {
    const result = await postVectorAction(
        item,
        "styles",
        "styling",
        fetchImplementation,
        { style },
    );
    if (
        typeof result?.styleName !== "string" ||
        !/^vector-single-[0-9a-f]{24}-[0-9a-f]{12}$/.test(
          result.styleName,
        ) ||
        result.style?.geometryKind !== style.geometryKind
    ) {
        throw new VectorRenderingRequestError(
            "Vector styling returned an invalid style contract."
        );
    }
    return result;
}
