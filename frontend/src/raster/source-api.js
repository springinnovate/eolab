/** Authorized original-source metadata transport. */
import { rasterSourceKey, rasterSourceReference } from "../raster-source.js";

/** Request a bounded private response without browser or shared HTTP caching.
 * @param {string} url Same-origin endpoint.
 * @param {Object} body Validated path-free request.
 * @param {AbortSignal} signal Owning request cancellation.
 * @param {typeof fetch} fetcher HTTP implementation.
 * @return {Promise<Object>} Size-bounded JSON response.
 * @throws {Error} If transport, authorization, response size or JSON decoding fails.
 */
async function readJson(url, body, signal, fetcher) {
    const response = await fetcher(url, {method: "POST", credentials: "same-origin", cache: "no-store",
        headers: {"Content-Type": "application/json", "X-EOLab-Processing": "1"}, body: JSON.stringify(body),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45000)])});
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try {
        while (true) {
            const {value, done} = await reader.read(); if (done) break;
            bytes += value.byteLength;
            if (bytes > 8 * 1024 * 1024) throw new Error("The raster metadata response is too large.");
            chunks.push(value);
        }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const combined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
    const value = JSON.parse(new TextDecoder().decode(combined));
    if (!response.ok) throw Object.assign(new Error(value.detail?.message ?? value.detail ?? "The raster could not be loaded."), {status: response.status});
    return value;
}

/** Read metadata used by the common raster layer and analysis controls.
 * @param {Object} source Catalog or run-file identity.
 * @param {AbortSignal} signal Cancellation of an obsolete layer request.
 * @param {typeof fetch} [fetcher=globalThis.fetch] HTTP implementation.
 * @return {Promise<Object>} Checked metadata and declared format capabilities.
 * @throws {Error} If metadata is unavailable or invalid.
 */
export async function describeRasterSource(source, signal, fetcher = globalThis.fetch) {
    const value = await readJson("/api/raster-analysis/sources", {source: rasterSourceReference(source)}, signal, fetcher);
    if (rasterSourceKey(value) !== rasterSourceKey(source) || !/^[a-f0-9]{64}$/.test(value.version) ||
        ![value.width, value.height, value.bands].every(n => Number.isSafeInteger(n) && n > 0) ||
        !["pixels", "statistics"].every(name => typeof value.capabilities?.[name]?.supported === "boolean") ||
        value.bounds !== null && (!Array.isArray(value.bounds) || value.bounds.length !== 4 || !value.bounds.every(Number.isFinite))) {
        throw new Error("The server returned invalid raster metadata.");
    }
    return value;
}

