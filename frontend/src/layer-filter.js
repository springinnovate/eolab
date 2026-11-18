/** Portable map-view references used by the feature filter and saved maps. */
/** Keep the user's choices when saving or comparing views without retaining private read references.
 * @param {Object} filter Accepted filter or editor draft.
 * @return {Object} Field conditions and stable polygon-view IDs.
 */
export function viewFilter(filter) {
    return {...filter, rules: filter.rules.map(rule => rule.operator === "intersects"
        ? {operator: "intersects", layerId: rule.layerId} : rule)};
}

/** Show an empty view until all its saved polygon sources can be read.
 * @param {Object} filter Saved filter containing at least one spatial clause.
 * @return {Object} An empty selection, or the unrestricted view when filtering is disabled.
 */
export function waitingForPolygonLayer(filter) {
    if (!filter.enabled) return {...filter, rules: filter.rules.map(rule => rule.operator === "intersects"
        ? {...rule, source: {kind: "drawing", polygonArea: null}} : rule)};
    const rule = filter.rules.find(condition => condition.operator === "intersects");
    return {enabled: filter.enabled, match: "all", rules: [{operator: "intersects", layerId: rule.layerId,
        source: {kind: "drawing", polygonArea: null}}]};
}
