/** Select original vector features using an exact freehand intersection. */

/**
 * Read a transient selection without changing the target's applied filter.
 * @param {Object} selection Immutable Catalog, upload or result source and predicate.
 * @param {{type:"Polygon",coordinates:number[][][]}} polygon Closed WGS84 lasso.
 * @param {AbortSignal} signal Cancels superseded drawing or source work.
 * @param {typeof fetch} [fetchImplementation=globalThis.fetch] HTTP transport.
 * @return {Promise<{matched:number,featureIds:string[],features:Array<{id:string,properties:Record<string,string|number|bigint|boolean|null>}>,geometry:Object|null}>}
 * Exact native IDs, ordered scalar rows with lossless integers, and optional whole-feature highlights.
 * @throws {Error} If the source, polygon, ownership or bounded comparison is invalid.
 * @throws {DOMException} If the request is aborted.
 */
export async function selectLassoFeatures(selection, polygon, signal, fetchImplementation = globalThis.fetch) {
    const response = await fetchImplementation("/api/vector-sampling/lasso", {
        method: "POST", credentials: "same-origin", cache: "no-store", signal,
        headers: {"Content-Type": "application/json", "X-EOLab-Uploads": "1", "X-EOLab-Processing": "1"},
        body: JSON.stringify({selection, polygon}),
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(typeof result.detail === "string" ? result.detail :
            response.status === 422 ? "Draw a closed outline that does not cross itself." : "Could not select these features. Draw the area again to retry.");
    }
    if (!Array.isArray(result.featureIds) || result.matched !== result.featureIds.length ||
        result.featureIds.some(id => typeof id !== "string" || !/^(0|-?[1-9]\d*)$/.test(id)) ||
        new Set(result.featureIds).size !== result.matched ||
        !(result.geometry === null || typeof result.geometry === "object")) {
        throw new Error("The feature selection response was invalid. Draw the area again to retry.");
    }
    const invalid = "The selected feature attributes were incomplete or invalid. Select the features again.";
    if (!Array.isArray(result.features) || result.features.length !== result.matched) throw new Error(invalid);
    for (const [index, row] of result.features.entries()) {
        if (row?.id !== result.featureIds[index] || row.properties === null ||
            typeof row.properties !== "object" || Array.isArray(row.properties)) throw new Error(invalid);
        for (const [name, value] of Object.entries(row.properties)) {
            if (value === null || typeof value === "string" || typeof value === "boolean" || Number.isFinite(value)) continue;
            if (typeof value?.integer !== "string" || !/^(?:0|-?[1-9]\d*)$/.test(value.integer) ||
                Object.keys(value).length !== 1) throw new Error(invalid);
            row.properties[name] = BigInt(value.integer);
        }
    }
    return result;
}
