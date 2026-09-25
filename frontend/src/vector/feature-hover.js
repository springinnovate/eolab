import { fetchVectorFeatureInfo } from "./feature-info.js";

/**
 * Find the topmost catalog-vector layer with a feature near the pointer.
 * Query layers sequentially in display order, stopping at the first hit. The
 * entire lookup has a 2.5 second deadline and uses the click inspector's bounded
 * feature query. A failure leaves identification to explicit click inspection.
 * @param {Object} options Query inputs supplied by browser composition.
 * @param {import("./feature-info.js").VectorFeatureInspectionTarget[]} options.targets Visible layers, top first.
 * @param {import("./feature-info.js").VectorFeatureInfoViewport} options.viewport Projected pointer and viewport.
 * @param {string} options.wmsUrl Restricted WMS endpoint.
 * @param {AbortSignal} options.signal Superseded-pointer cancellation.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP provider.
 * @return {Promise<string|null>} Layer name, or null when no feature was found.
 * @throws {Error} If the lookup fails, is cancelled, or exceeds its deadline.
 */
export async function findVectorLayerAtPointer({ targets, viewport, wmsUrl, signal }, fetchImplementation = globalThis.fetch) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 2500);
    const combinedSignal = AbortSignal.any([signal, deadline.signal]);
    try {
        for (const target of targets) {
            combinedSignal.throwIfAborted();
            const features = await fetchVectorFeatureInfo({
                wmsUrl, viewport, publication: target.publication,
                // Only existence is needed; one declared field avoids full geometry.
                propertyNames: target.propertyNames.slice(0, 1),
                signal: combinedSignal,
            }, fetchImplementation);
            combinedSignal.throwIfAborted();
            if (features.length) return target.label;
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
}
