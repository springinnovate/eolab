/** Read raster dimensions, bounds and analysis support from the source metadata API. */
import { rasterSourceKey, rasterSourceReference } from "../raster-source.js";

/** Fetch raster metadata with a 45-second timeout and an 8 MiB response limit.
 * Responses bypass HTTP caches so session-owned sources are checked by the server.
 * @param {string} url Same-origin endpoint.
 * @param {Object} body Validated path-free request.
 * @param {AbortSignal} signal Owning request cancellation.
 * @param {typeof fetch} fetcher HTTP implementation.
 * @return {Promise<Object>} Size-bounded JSON response.
 * @throws {Error} If transport, authorization, response size or JSON decoding fails.
 */
async function fetchRasterMetadata(url, body, signal, fetcher) {
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

/** Read source metadata, optionally describing its pixel size in another CRS.
 * @param {Object} source Catalog or run-file identity.
 * @param {AbortSignal} signal Cancellation of an obsolete layer request.
 * @param {typeof fetch} [fetcher=globalThis.fetch] HTTP implementation.
 * @param {string|null} [targetCrs=null] Optional output CRS for projected grid information; null requests only original metadata.
 * @return {Promise<Object & {projectedGrid:{crs:string,unit:string,pixelSize:[number,number],origin:[number,number],approximate:boolean}|null}>} Original metadata and reader support, plus the requested grid's X/Y pixel sizes and units when targetCrs is supplied.
 * @throws {Error} If metadata is unavailable or invalid.
 */
export async function describeRasterSource(source, signal, fetcher = globalThis.fetch, targetCrs = null) {
    const body = {source: rasterSourceReference(source)};
    if (targetCrs !== null) body.targetCrs = targetCrs;
    const metadata = await fetchRasterMetadata("/api/raster-analysis/sources", body, signal, fetcher);
    if (rasterSourceKey(metadata) !== rasterSourceKey(source) || !/^[a-f0-9]{64}$/.test(metadata.version) ||
        ![metadata.width, metadata.height, metadata.bands].every(n => Number.isSafeInteger(n) && n > 0) ||
        !["pixels", "statistics"].every(name => typeof metadata.capabilities?.[name]?.supported === "boolean") ||
        metadata.bounds !== null && (!Array.isArray(metadata.bounds) || metadata.bounds.length !== 4 || !metadata.bounds.every(Number.isFinite))) {
        throw new Error("The server returned invalid raster metadata.");
    }
    return metadata;
}

