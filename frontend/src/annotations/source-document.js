/** Translate linked drawing contents without copying local view settings into the source. */
import { exportAnnotationGeoJSON, parseAnnotationGeoJSON } from "./geojson.js";
import { readAnnotationLayers, DEFAULT_ANNOTATION_STYLE } from "./model.js";

/** Export all committed original polygons while keeping the source's name independent of a view label.
 * @param {import("./model.js").AnnotationLayer} layer Current view and original polygon contents.
 * @return {Object} GeoJSON source document, without filter, appearance or editing draft.
 */
export function exportDrawingCollection(layer) {
    return exportAnnotationGeoJSON({...layer, name: layer.drawingSource?.sourceName ?? layer.name});
}

/** Compare acknowledged drawing content independently of JSON object-key ordering.
 * @param {Object} collection Validated source FeatureCollection.
 * @return {string} Exact content comparison value; not a source identity or version.
 */
export function serializeDrawingContent(collection) {
    return JSON.stringify([collection.name, collection.features.map(feature =>
        [feature.id, feature.properties.name, feature.properties.note, feature.geometry.coordinates])]);
}

/** Validate server geometry and preserve its original feature IDs when creating a local view.
 * @param {Object} record Source response with collection, revision and edit permission.
 * @param {string} localId Fresh device-view identity.
 * @return {import("./model.js").AnnotationLayer} Validated ordinary annotation layer.
 * @throws {Error} If server geometry or original polygon identities violate the drawing contract.
 */
export function readDrawingView(record, localId) {
    const imported = parseAnnotationGeoJSON(JSON.stringify(record.collection));
    const layer = {id: localId, name: imported.name, position: 0, visible: true, opacity: 1,
        style: {...DEFAULT_ANNOTATION_STYLE}, filter: {enabled: false, match: "all", rules: []},
        polygons: imported.polygons.map((polygon, index) => ({...polygon, id: record.collection.features[index].id})),
        drawingSource: {id: record.id, revision: record.revision, canEdit: record.canEdit, pending: false, sourceName: imported.name}};
    return readAnnotationLayers({version: 1, layers: [layer]})[0];
}
