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
 * Copies every selected layer and drawing filter before the first capture. Repeated uses share the same
 * original features, while retaining each input's independently chosen predicate.
 * @param {Object} inputs Detached invocation inputs to bind before persisting or sending.
 * @param {{readLayer:(key:string)=>Object|null,readBoundary:(reference:Object)=>Promise<Object>}} sources Drawing owner providing detached layers and selected boundary polygons.
 * @param {(document:Object)=>Promise<Object>} capture Keep original GeoJSON or boundary polygons for admission.
 * @param {(id:string)=>void} onCaptured Record every new reference for cleanup on failure.
 * @param {()=>boolean} isCurrent Whether the requesting setup is still active.
 * @return {Promise<void>|undefined} Pending capture when drawings need saving, or undefined when the inputs are ready.
 * @throws {Error} If a chosen layer was removed or its capture fails.
 */
export function bindModelVectorInputs(inputs, sources, capture, onCaptured, isCurrent) {
    const layers = new Map(), boundaries = new Map();
    /** Collect all vector selections, including group members, without interpreting recipe inputs.
     * @param {Object} value A node of the detached model invocation.
     * @return {void}
     */
    function collect(value) {
        if (!value || typeof value !== "object") return;
        if (value.selection?.kind === "localVector") {
            const key = value.selection.key;
            if (!layers.has(key)) layers.set(key, []);
            layers.get(key).push(value);
        }
        if (value.kind === "drawing" && value.polygonArea?.drawingLayerId) {
            const key = JSON.stringify(value.polygonArea);
            if (!boundaries.has(key)) boundaries.set(key, []);
            boundaries.get(key).push(value);
        }
        if (value.enabled === false && Array.isArray(value.rules)) return;
        Object.values(value).forEach(collect);
    }
    collect(inputs);
    if (!layers.size && !boundaries.size) return;
    const captures = Array.from(layers, ([key, uses]) => {
        const collection = sources.readLayer(key);
        if (!collection) throw new Error("The chosen vector layer was removed. Choose another layer.");
        return {document: collection, bind: reference => {
            for (const use of uses) use.selection = {kind: "capturedVector", reference, layerName: "features", filter: use.selection.filter};
        }};
    });
    /** Bind each captured reference and record it for cleanup if this setup is abandoned.
     * @return {Promise<void>} Resolves when every chosen source is bound or the setup is superseded.
     * @throws {Error} If the device cannot retain a source.
     */
    async function captureSources() {
        const boundaryCaptures = boundaries.size ? await Promise.all(Array.from(boundaries.values(), async uses => ({
            document: await sources.readBoundary(uses[0].polygonArea),
            bind: reference => { for (const source of uses) source.polygonArea = reference; },
        }))) : [];
        captures.push(...boundaryCaptures);
        for (const {document, bind} of captures) {
            const reference = await capture(document);
            onCaptured(reference.id);
            if (!isCurrent()) return;
            bind(reference);
        }
    }
    return captureSources();
}
