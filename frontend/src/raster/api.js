/** Same-origin HTTP adapter for original-raster publication. */
import { rasterSourceReference } from "../raster-source.js";

/** Stable publication categories exposed by the rendering API. */
const RASTER_PUBLICATION_FAILURE_CATEGORIES = new Set([
    "reader_rejection",
    "connectivity",
    "authentication",
    "timeout",
    "configuration",
    "upstream_failure"
]);

/** Represent one browser-safe rendering API failure. */
export class RenderingRequestError extends Error {
    /**
     * Create a rendering failure with optional stable publication metadata.
     *
     * @param {string} message Concise user-facing failure explanation.
     * @param {string|null} category Stable publication category, when supplied.
     * @param {number} status Rendering API HTTP response status.
     */
    constructor(message, category, status) {
        super(message);
        this.name = "RenderingRequestError";
        this.category = category;
        this.status = status;
    }
}

/**
 * Return a user-safe rendering error from FastAPI or an upstream proxy.
 *
 * @param {Response} response Failed rendering response.
 * @param {string} action User-facing description of the request.
 * @return {Promise<RenderingRequestError>} Structured FastAPI detail or a
 * status fallback.
 */
async function renderingRequestError(response, action) {
    const fallbackMessage = `${action} failed (${response.status})`;
    if (!response.headers.get("content-type")?.toLowerCase().includes(
        "application/json"
    )) {
        return new RenderingRequestError(fallbackMessage, null, response.status);
    }
    try {
        const errorDocument = await response.json();
        const detail = errorDocument.detail;
        if (
            typeof detail === "object" && detail !== null &&
            RASTER_PUBLICATION_FAILURE_CATEGORIES.has(detail.category) &&
            typeof detail.message === "string" && detail.message.trim() !== ""
        ) {
            return new RenderingRequestError(
                detail.message, detail.category, response.status
            );
        }
        return new RenderingRequestError(
            typeof detail === "string" && detail.trim() !== ""
                ? detail : fallbackMessage,
            null,
            response.status
        );
    } catch {
        return new RenderingRequestError(fallbackMessage, null, response.status);
    }
}

/**
 * Publish a catalog or temporary GeoTIFF through the ordinary tile renderer.
 *
 * @param {Object} item Catalog item or original-source descriptor.
 * @param {typeof globalThis.fetch} [fetchImplementation=globalThis.fetch]
 * Browser fetch implementation.
 * @param {AbortSignal} [signal] Cancellation of an obsolete publication request.
 * @return {Promise<Object>} Published layer identity and bounds.
 * @throws {Error} If publication fails.
 */
export async function publishRasterSource(
    item,
    fetchImplementation = globalThis.fetch,
    signal
) {
    const response = await fetchImplementation.call(
        globalThis,
        "/api/rendering/layers",
        {
            method: "POST", credentials: "same-origin", cache: "no-store", signal,
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-EOLab-Processing": "1"
            },
            body: JSON.stringify(item.source ? {source: rasterSourceReference(item)} : rasterSourceReference(item))
        }
    );
    if (!response.ok) {
        throw await renderingRequestError(response, "Rendering request");
    }
    return response.json();
}
