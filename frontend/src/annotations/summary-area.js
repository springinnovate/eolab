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
    const {matchingIds, ...conditions} = filter;
    const validated = normalizeVectorFilter(conditions, ANNOTATION_FIELDS);
    if (Array.isArray(matchingIds) && matchingIds.every(id => typeof id === "string")) {
        validated.matchingIds = [...matchingIds];
    }
    return validated;
}

/** Match polygon attributes using the existing vector field/operator contract.
 * @param {Object[]} polygons Committed annotation polygons with name and note strings.
 * @param {Object} filter Validated field conditions with case-sensitive text comparisons.
 * @return {Object[]} Matching polygons in original order.
 */
export function filterAnnotationPolygons(polygons, filter) {
    if (!filter.enabled || !filter.rules.length) return polygons;
    if (filter.rules.some(rule => rule.operator === "intersects")) {
        const matches = new Set(filter.matchingIds);
        return polygons.filter(polygon => matches.has(polygon.id));
    }
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

/** Count committed features for a picker without reading or copying vertices.
 * @param {{key:string,label:string,filter:Object,polygons:Object[]}} target Local contribution and applied map filter.
 * @param {Object[]} [contributors] Other contributors' committed polygons in a shared layer.
 * @return {{key:string,label:string,filter:Object,featureCounts:{matched:number,total:number}}} Layer metadata and exact selection counts.
 */
export function describeDrawingVectorLayer({key, label, filter, polygons}, contributors = []) {
    const {matchingIds, ...conditions} = filter;
    return {key, label, filter: structuredClone(conditions), featureCounts: {
        matched: filterAnnotationPolygons(polygons, filter).length + filterAnnotationPolygons(contributors, filter).length,
        total: polygons.length + contributors.length,
    }};
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
 * @param {Object|null} [drawingSource] Linked source when it covers every displayed polygon.
 * @return {Object} Independent summary target with geometry-sensitive identity.
 * @throws {TypeError} If its stored filter is invalid.
 */
export function annotationSummaryTarget(key, layer, drawingSource = layer.drawingSource) {
    const polygons = structuredClone(layer.polygons);
    return { key, label: layer.name, item: null, polygons,
        ...(drawingSource && {drawingSource: {id: drawingSource.id, revision: drawingSource.revision, pending: drawingSource.pending}, selectedIds: filter => filterAnnotationPolygons(polygons, filter).map(polygon => polygon.id)}),
        filter: annotationFilterRules(layer.filter),
        selectionIdentity: filter => JSON.stringify(filterAnnotationPolygons(polygons, filter).map(polygon => polygon.vertices)) };
}
