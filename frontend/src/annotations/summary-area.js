/** Annotation-owned polygon snapshots for the shared vector summary workflow. */
import { EMPTY_VECTOR_FILTER, normalizeVectorFilter } from "../vector/filter.js";

/** Fields retained by local and shared annotation layers. @type {{name:string,type:string}[]} */
export const ANNOTATION_FIELDS = Object.freeze([{ name: "name", type: "str" }, { name: "note", type: "str" }]);

/** Read current rules, converting the older name-or-note text search when necessary.
 * New rules use the same case-sensitive comparisons as regular vector layers.
 * @param {string|Object} filter Persisted annotation filter or rule-builder state.
 * @return {Object} Independent field/condition rules.
 * @throws {TypeError} If the filter cannot be represented by the vector rule contract.
 */
export function annotationFilterRules(filter) {
    if (typeof filter === "string") {
        const text = filter.trim();
        if (!text) return structuredClone(EMPTY_VECTOR_FILTER);
        return { enabled: true, match: "any", rules: ANNOTATION_FIELDS.map(({ name }) =>
            ({ field: name, operator: "contains", value: text })) };
    }
    return normalizeVectorFilter(filter, ANNOTATION_FIELDS);
}

/** Match polygon attributes using the existing vector field/operator contract.
 * @param {Object[]} polygons Committed annotation polygons with name and note strings.
 * @param {Object|string} filter Validated field conditions or an older saved text search.
 * @return {Object[]} Matching polygons in original order.
 */
export function filterAnnotationPolygons(polygons, filter) {
    if (typeof filter === "string") {
        const text = filter.trim().toLocaleLowerCase();
        return polygons.filter(polygon => `${polygon.name}\n${polygon.note}`.toLocaleLowerCase().includes(text));
    }
    if (!filter.enabled || !filter.rules.length) return polygons;
    return polygons.filter(polygon => {
        const matches = filter.rules.map(({ field, operator, value }) => {
            const actual = polygon[field];
            if (operator === "missing") return actual == null;
            if (operator === "present") return actual != null;
            if (actual == null) return false;
            if (operator === "eq") return actual === value;
            if (operator === "ne") return actual !== value;
            return actual.includes(value);
        });
        return filter.match === "all" ? matches.every(Boolean) : matches.some(Boolean);
    });
}

/** Preserve an unchanged saved text search; new conditions use vector comparisons.
 * Older annotation searches matched names and notes without case sensitivity.
 * Keep that behavior until the user replaces the saved search with field conditions.
 * @param {Object[]} polygons Committed annotation polygons.
 * @param {Object} filter Current field conditions.
 * @param {string|Object} savedFilter Persisted layer filter.
 * @return {Object[]} Polygons included by the requested filter.
 */
function matchSummaryPolygons(polygons, filter, savedFilter) {
    const unchangedTextSearch = typeof savedFilter === "string" && savedFilter.trim() &&
        JSON.stringify(filter) === JSON.stringify(annotationFilterRules(savedFilter));
    return filterAnnotationPolygons(polygons, unchangedTextSearch ? savedFilter : filter);
}

/** Copy just the matched polygon coordinates, closing each GeoJSON ring.
 * @param {Object[]} polygons Committed annotation polygons.
 * @param {Object} filter Field conditions from the summary controls.
 * @param {string|Object} [savedFilter=filter] Saved filter, retaining older text-search semantics when unchanged.
 * @return {Object[]} Independent geometries without names, notes or styles.
 * @throws {TypeError} If the filter violates the field/operator contract.
 */
export function annotationSummaryPolygons(polygons, filter, savedFilter = filter) {
    const rules = typeof savedFilter === "string" && JSON.stringify(filter) === JSON.stringify(annotationFilterRules(savedFilter))
        ? filter : normalizeVectorFilter(filter, ANNOTATION_FIELDS);
    return matchSummaryPolygons(polygons, rules, savedFilter).map(polygon => ({ type: "Polygon",
        coordinates: [[...polygon.vertices.map(point => [...point]), [...polygon.vertices[0]]]] }));
}

/** Describe a committed layer without exposing its editing draft or renderer.
 * @param {string} key Map-layer identity.
 * @param {Object} layer Committed annotation layer.
 * @return {Object} Independent summary target with geometry-sensitive identity.
 * @throws {TypeError} If its stored filter is invalid.
 */
export function annotationSummaryTarget(key, layer) {
    const polygons = structuredClone(layer.polygons);
    const savedFilter = structuredClone(layer.filter);
    return { key, label: layer.name, item: null, polygons, savedFilter, filter: annotationFilterRules(savedFilter),
        selectionIdentity: filter => JSON.stringify(matchSummaryPolygons(polygons, filter, savedFilter).map(polygon => polygon.vertices)) };
}
