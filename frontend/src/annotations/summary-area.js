/** Annotation-owned polygon snapshots for the shared vector summary workflow. */
import { normalizeVectorFilter } from "../vector/filter.js";

/** Fields retained by local and shared annotation layers. @type {{name:string,type:string}[]} */
export const ANNOTATION_FIELDS = Object.freeze([{ name: "name", type: "str" }, { name: "note", type: "str" }]);

/** Validate annotation field conditions using the vector filter contract.
 * @param {Object} filter Persisted annotation filter or rule-builder state.
 * @return {Object} Independent field/condition rules.
 * @throws {TypeError} If the filter cannot be represented by the vector rule contract.
 */
export function annotationFilterRules(filter) {
    return normalizeVectorFilter(filter, ANNOTATION_FIELDS);
}

/** Match polygon attributes using the existing vector field/operator contract.
 * @param {Object[]} polygons Committed annotation polygons with name and note strings.
 * @param {Object} filter Validated field conditions with case-sensitive text comparisons.
 * @return {Object[]} Matching polygons in original order.
 */
export function filterAnnotationPolygons(polygons, filter) {
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

/** Copy just the matched polygon coordinates, closing each GeoJSON ring.
 * @param {Object[]} polygons Committed annotation polygons.
 * @param {Object} filter Field conditions from the summary controls.
 * @return {Object[]} Independent geometries without names, notes or styles.
 * @throws {TypeError} If the filter violates the field/operator contract.
 */
export function annotationSummaryPolygons(polygons, filter) {
    const rules = annotationFilterRules(filter);
    return filterAnnotationPolygons(polygons, rules).map(polygon => ({ type: "Polygon",
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
    return { key, label: layer.name, item: null, polygons, filter: annotationFilterRules(layer.filter),
        selectionIdentity: filter => JSON.stringify(filterAnnotationPolygons(polygons, filter).map(polygon => polygon.vertices)) };
}
