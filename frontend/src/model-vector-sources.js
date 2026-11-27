/** Adapt map source descriptions to model inputs and bind local features at submission. */
import { ANNOTATION_FIELDS } from "./annotations/summary-area.js";
import { EMPTY_VECTOR_FILTER } from "./vector/filter.js";

/** User-facing labels for map layers backed by an original file.
 * @type {Record<string, {group:string,label:string}>}
 */
const fileOriginLabels = {
    catalog: {group: "Catalog layers", label: "Catalog"},
    upload: {group: "Your uploads", label: "Uploaded by you"},
    runArtifact: {group: "Completed runs", label: "Completed run"},
};

/** Describe original-file and editor layers with the same geometry, fields and selection choices.
 * @param {Object[]} files Map vector descriptors supplied by their source owners.
 * @param {ReturnType<typeof import("./annotations/summary-area.js").describeDrawingVectorLayer>[]} drawings Editor descriptions with filters and counts.
 * @return {import("./models/vector-input.js").VectorInputSource[]} Source choices in map order within each list.
 */
export function modelVectorSources(files, drawings) {
    const sources = files.filter(target => target.selection).map(({item, sourceOrigin, ...target}) => ({...item, ...target,
        originLabels: fileOriginLabels[sourceOrigin],
        selection: {...target.selection, filter: target.filter},
        allSelection: {...target.selection, filter: EMPTY_VECTOR_FILTER}}));
    for (const target of drawings) {
        const filter = target.filter;
        const selection = {kind: "localVector", key: target.key, filter};
        sources.push({key: target.key, label: target.label, originLabels: {group: "Drawn polygons", label: "Drawing"}, geometryKind: "polygon",
            fields: ANNOTATION_FIELDS, scalarFields: ANNOTATION_FIELDS, numericFields: [], filter,
            selection, allSelection: {...selection, filter: EMPTY_VECTOR_FILTER}, editFilterInMap: true,
            featureCounts: target.featureCounts});
    }
    return sources;
}

/** Replace local vector choices throughout an invocation with private source references.
 * Copies every selected layer before the first upload. Repeated uses share the same
 * original features, while retaining each input's independently chosen predicate.
 * @param {Object} inputs Detached invocation inputs to bind before persisting or sending.
 * @param {(key:string)=>Object|null} readCollection Export the chosen layer's committed features only.
 * @param {(collection:Object)=>Promise<Object>} capture Store one complete GeoJSON source.
 * @param {(id:string)=>void} onCaptured Record every new reference for cleanup on failure.
 * @param {()=>boolean} isCurrent Whether the requesting setup is still active.
 * @return {Promise<void>} Resolves after binding the inputs or abandoning a superseded setup.
 * @throws {Error} If a chosen layer was removed or its capture fails.
 */
export async function bindModelVectorInputs(inputs, readCollection, capture, onCaptured, isCurrent) {
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
    const captures = Array.from(bindings, ([key, uses]) => {
        const collection = readCollection(key);
        if (!collection) throw new Error("The chosen vector layer was removed. Choose another layer.");
        return {uses, collection};
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
