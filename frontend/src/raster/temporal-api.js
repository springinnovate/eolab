/** Read available observation timestamps through Catalog discovery. */

/**
 * Return actual available months and timestamps for one dataset variable.
 * @param {Object} item Authoritative Catalog Item.
 * @param {string} variable Published variable identifier.
 * @param {string} [month] Requested UTC month, such as "2000-01"; omitted chooses the latest available month.
 * @param {AbortSignal} [signal] Cancellation for an obsolete control selection.
 * @return {Promise<{months:string[],month:string,times:string[]}>} Available coordinate choices.
 * @throws {Error} If discovery fails or the request is cancelled.
 */
export async function loadTemporalTimes(item, variable, month, signal) {
    const response = await fetch("/api/catalog/temporal-times", {
        method: "POST", signal, cache: "no-store",
        headers: {"Content-Type": "application/json", Accept: "application/json"},
        body: JSON.stringify({collectionId: item.collection, itemId: item.id, variable,
            ...(month === undefined ? {} : {month})}),
    });
    if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(typeof failure?.detail === "string" ? failure.detail :
            `Available dates could not be loaded (${response.status}). Try again.`);
    }
    return response.json();
}
