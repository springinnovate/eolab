/** Search MapTiler for places from submitted text. */

const RESULT_LIMIT = 5;
const REQUEST_TIMEOUT_MS = 8000;

/**
 * @typedef {Object} MapTilerPlace
 * @property {string} label Formatted name and geographic context.
 * @property {string} type MapTiler place type, or an empty string when absent.
 * @property {[number, number]} center Latitude and longitude in decimal degrees.
 * @property {unknown} bbox Optional published WGS 84 bounds for the viewport adapter to interpret.
 */

/**
 * Return up to five usable matches for one submitted place name or street address.
 * A match must have a label and a WGS 84 center. The provider can omit its bounds.
 * The request has an eight-second timeout and sends no site credentials.
 * @param {string} query The nonempty user-submitted search text.
 * @param {string} apiKey The site's browser-visible MapTiler key.
 * @param {AbortSignal} signal Cancels the search when the form changes or closes.
 * @param {typeof fetch} [fetcher=globalThis.fetch] Browser HTTP transport.
 * @return {Promise<MapTilerPlace[]>} Matches in provider order.
 * @throws {Error} If the request fails, is cancelled, or lacks a result collection.
 */
export async function searchMapTilerPlaces(query, apiKey, signal, fetcher = globalThis.fetch) {
    const url = new URL(`https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json`);
    url.search = new URLSearchParams({ key: apiKey, autocomplete: "false", limit: String(RESULT_LIMIT) });
    const response = await fetcher(url, {
        headers: { Accept: "application/json" },
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!response.ok) throw new Error("MapTiler place search request failed");
    const data = await response.json();
    if (!Array.isArray(data?.features)) throw new Error("MapTiler place search returned no feature collection");

    /** @type {MapTilerPlace[]} */
    const places = [];
    for (const feature of data.features.slice(0, RESULT_LIMIT)) {
        const label = typeof feature?.place_name === "string" ? feature.place_name.trim() : "";
        const center = feature?.center ?? (feature?.geometry?.type === "Point" ? feature.geometry.coordinates : null);
        if (!label || !Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite)) continue;
        const [longitude, latitude] = center;
        if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
        const type = Array.isArray(feature.place_type) ? feature.place_type[0] : null;
        places.push({ label, center: [latitude, longitude], type: typeof type === "string" ? type : "", bbox: feature.bbox });
    }
    return places;
}
