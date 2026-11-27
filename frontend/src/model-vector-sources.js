/** Adapt map source descriptions to model inputs and bind local features at submission. */
import { ANNOTATION_FIELDS, filterAnnotationPolygons } from "./annotations/summary-area.js";
import { exportAnnotationGeoJSON } from "./annotations/geojson.js";
import { EMPTY_VECTOR_FILTER } from "./vector/filter.js";

/** Describe original-file and editor layers with the same geometry, fields and selection choices.
 * @param {Object[]} files Map vector descriptors supplied by their source owners.
 * @param {Object[]} drawings Committed editor targets, including their current filter.
 * @return {import("./models/vector-input.js").VectorInputSource[]} Source choices in map order within each list.
 */
export function modelVectorSources(files, drawings) {
    const sources = files.filter(target => target.selection).map(({item, ...target}) => ({...item, ...target,
        selection: {...target.selection, filter: target.filter},
        allSelection: {...target.selection, filter: EMPTY_VECTOR_FILTER}}));
    for (const target of drawings) {
        const {matchingIds, ...filter} = target.filter;
        const selection = {kind: "localVector", key: target.key, filter};
        sources.push({key: target.key, label: target.label, sourceOrigin: "drawing", geometryKind: "polygon",
            fields: ANNOTATION_FIELDS, scalarFields: ANNOTATION_FIELDS, numericFields: [], filter,
            selection, allSelection: {...selection, filter: EMPTY_VECTOR_FILTER}, editFilterInMap: true,
            featureCounts: {matched: filterAnnotationPolygons(target.polygons, target.filter).length, total: target.polygons.length}});
    }
    return sources;
}

/** Replace local vector choices throughout an invocation with private source references.
 * Copies every selected layer before the first upload. Repeated uses share the same
 * original features, while retaining each input's independently chosen predicate.
 * @param {Object} inputs Detached invocation inputs to bind before persisting or sending.
 * @param {()=>Object[]} getDrawings Read the editor's current committed layers.
 * @param {(collection:Object)=>Promise<Object>} capture Store one complete GeoJSON source.
 * @param {(id:string)=>void} onCaptured Record every new reference for cleanup on failure.
 * @param {()=>boolean} isCurrent Whether the requesting setup is still active.
 * @return {Promise<void>} Resolves after binding the inputs or abandoning a superseded setup.
 * @throws {Error} If a chosen layer was removed or its capture fails.
 */
export async function bindModelVectorInputs(inputs, getDrawings, capture, onCaptured, isCurrent) {
    const bindings = new Map();
    /** Collect all vector selections, including group members, without interpreting recipe inputs.
     * @param {Object} value A node of the detached model invocation.
     * @return {void}
     */
    function collect(value) {
        if (!value || typeof value !== "object") return;
        if (value.selection?.kind === "localVector") {
            const key = value.selection.key;
            if (!bindings.has(key)) bindings.set(key, []);
            bindings.get(key).push(value);
        } else {
            Object.values(value).forEach(collect);
        }
    }
    collect(inputs);
    if (!bindings.size) return;
    const targets = new Map(getDrawings().map(target => [target.key, target]));
    const captures = Array.from(bindings, ([key, uses]) => {
        const target = targets.get(key);
        if (!target) throw new Error("The chosen vector layer was removed. Choose another layer.");
        return {uses, collection: exportAnnotationGeoJSON({name: target.label, polygons: target.polygons})};
    });
    for (const {uses, collection} of captures) {
        const reference = await capture(collection);
        onCaptured(reference.id);
        if (!isCurrent()) return;
        for (const use of uses) {
            use.selection = {kind: "capturedVector", reference, layerName: "features", filter: use.selection.filter};
        }
    }
}
