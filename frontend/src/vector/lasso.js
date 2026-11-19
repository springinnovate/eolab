/** Select original vector features using an exact freehand intersection. */

/**
 * Read a transient selection without changing the target's applied filter.
 * @param {Object} selection Immutable Catalog, upload or result source and predicate.
 * @param {{type:"Polygon",coordinates:number[][][]}} polygon Closed WGS84 lasso.
 * @param {AbortSignal} signal Cancels superseded drawing or source work.
 * @return {Promise<{matched:number,featureIds:number[],geometry:Object|null}>} Exact IDs and optional whole-feature highlights.
 * @throws {Error} If the source, polygon, ownership or bounded comparison is invalid.
 */
export async function selectLassoFeatures(selection, polygon, signal) {
    const response = await fetch("/api/vector-sampling/lasso", {
        method: "POST", credentials: "same-origin", cache: "no-store", signal,
        headers: {"Content-Type": "application/json", "X-EOLab-Uploads": "1", "X-EOLab-Processing": "1"},
        body: JSON.stringify({selection, polygon}),
    });
    const result = await response.json();
    if (!response.ok) {
        throw new Error(typeof result.detail === "string" ? result.detail :
            response.status === 422 ? "Draw a closed outline that does not cross itself." : "Could not select these features. Draw the area again to retry.");
    }
    return result;
}
