/** Read saved annotation collections and export committed polygons as GeoJSON. */
import { counterclockwisePolygonRing, polygonValidationMessage } from "./geometry.js";
import { MAX_POLYGON_VERTICES, MAX_POLYGONS_PER_LAYER,
    MAX_ANNOTATION_NAME_LENGTH, MAX_ANNOTATION_NOTE_LENGTH } from "./model.js";

/**
 * @typedef {{name:string,note:string,vertices:number[][]}} AnnotationPolygonContent
 * @typedef {{name:string,polygons:AnnotationPolygonContent[]}} AnnotationLayerContent
 */

/**
 * Read the saved FeatureCollection from a linked drawing or shared contribution.
 * The server bounds collection size at admission. Callers supply local or shared
 * identities separately from the polygon names, notes and coordinates returned here.
 * @param {Object} collection Decoded GeoJSON response.
 * @return {AnnotationLayerContent} Layer name and independent polygon contents for the editor.
 * @throws {Error} If the collection or its polygons violate the editor's contract.
 */
export function readAnnotationCollection(collection) {
    if (collection?.type !== "FeatureCollection") throw new Error("Expected a GeoJSON FeatureCollection.");
    rejectDeclaredCRS(collection, "GeoJSON");
    const { features } = collection;
    if (!Array.isArray(features)) throw new Error("GeoJSON FeatureCollection must contain a features array.");
    if (features.length > MAX_POLYGONS_PER_LAYER) {
        throw new Error(`The layer contains ${features.length} features. It can contain at most ${MAX_POLYGONS_PER_LAYER} polygons.`);
    }
    const name = readAnnotationText(collection.name, MAX_ANNOTATION_NAME_LENGTH, "Layer name");
    const polygons = features.map((feature, index) => {
        const context = `Feature ${index + 1}`;
        if (!feature || feature.type !== "Feature") throw new Error(`${context}: expected a GeoJSON Feature object.`);
        rejectDeclaredCRS(feature, context);
        const properties = feature.properties;
        return {
            name: readAnnotationText(properties?.name, MAX_ANNOTATION_NAME_LENGTH, `${context} name`),
            note: readAnnotationText(properties?.note, MAX_ANNOTATION_NOTE_LENGTH, `${context} note`, true),
            vertices: readPolygonVertices(feature.geometry, context),
        };
    });
    return { name, polygons };
}

/**
 * Read a saved layer name, polygon name or note within the editor's text limit.
 * @param {unknown} value Saved field value.
 * @param {number} maximum Maximum supported length in UTF-16 code units.
 * @param {string} context Field description for errors.
 * @param {boolean} [allowBlank=false] Whether the field can be empty or whitespace only.
 * @return {string} Original text with its whitespace preserved.
 * @throws {Error} If the value is missing, has the wrong type or exceeds the limit.
 */
function readAnnotationText(value, maximum, context, allowBlank = false) {
    if (typeof value !== "string" || (!allowBlank && !value.trim())) {
        throw new Error(`${context} must be ${allowBlank ? "text" : "nonblank text"}.`);
    }
    if (value.length > maximum) throw new Error(`${context} exceeds the ${maximum}-character limit.`);
    return value;
}

/**
 * Reject legacy CRS declarations rather than interpreting projected coordinates as degrees.
 * @param {Object} object GeoJSON object at the current boundary.
 * @param {string} context Object description for the error.
 * @return {void}
 * @throws {Error} If a legacy crs member is present.
 */
function rejectDeclaredCRS(object, context) {
    if (Object.hasOwn(object, "crs")) {
        throw new Error(`${context}: CRS declarations are not supported. Export GeoJSON in WGS84 longitude/latitude without a crs member.`);
    }
}

/**
 * Validate a single closed exterior ring and remove its repeated closing coordinate.
 * @param {Object|null} geometry Untrusted GeoJSON geometry.
 * @param {string} context Feature number for descriptive errors.
 * @return {number[][]} Independent two-dimensional vertices accepted by the annotation editor.
 * @throws {Error} If geometry has holes, another type, invalid coordinates or an invalid ring.
 */
function readPolygonVertices(geometry, context) {
    if (!geometry || geometry.type !== "Polygon") {
        throw new Error(`${context}: expected Polygon geometry, found ${String(geometry?.type ?? "missing geometry").slice(0, 80)}.`);
    }
    rejectDeclaredCRS(geometry, context);
    const rings = geometry.coordinates;
    if (!Array.isArray(rings) || rings.length === 0) throw new Error(`${context}: Polygon must contain an exterior ring.`);
    if (rings.length > 1) throw new Error(`${context}: polygon has holes. Shared layers support polygons with one exterior ring without holes.`);
    const ring = rings[0];
    if (!Array.isArray(ring) || ring.length < 4) throw new Error(`${context}: polygon must have at least 3 vertices and a repeated closing coordinate.`);
    if (ring.length > MAX_POLYGON_VERTICES + 1) throw new Error(`${context}: polygon exceeds the ${MAX_POLYGON_VERTICES}-vertex limit.`);
    for (const point of ring) {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
            throw new Error(`${context}: each coordinate must contain exactly two finite numbers: longitude and latitude. Altitude is not supported.`);
        }
        if (Math.abs(point[0]) > 180 || Math.abs(point[1]) > 85.05112878) {
            throw new Error(`${context}: coordinates are outside the editable map bounds. Use WGS84 longitude from -180 to 180 and latitude from -85.05112878 to 85.05112878.`);
        }
    }
    if (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1]) {
        throw new Error(`${context}: polygon ring is not closed. Its last coordinate must equal its first.`);
    }
    const vertices = ring.slice(0, -1).map(point => [...point]);
    const error = polygonValidationMessage(vertices);
    if (error) throw new Error(`${context}: ${error}`);
    return vertices;
}

/**
 * Export every committed polygon in a layer, including polygons hidden by its filter.
 * Names and notes are plain GeoJSON properties; the layer name is a collection member.
 * Exterior rings use counterclockwise winding. Drafts and local display settings are excluded.
 * @param {import("./model.js").AnnotationLayer} layer Validated local annotation layer.
 * @param {boolean} [includeContributors=false] Include contributor names/colors for a file export, never an ownership claim in an upload.
 * @return {Object} Independent GeoJSON FeatureCollection ready for JSON serialization.
 */
export function exportAnnotationGeoJSON(layer, includeContributors = false) {
    return { type: "FeatureCollection", name: layer.name, ...(includeContributors ? { eolabAnnotations: 1 } : {}), features: layer.polygons.map(polygon => {
        const ring = polygon.vertices.map(point => [...point]);
        ring.push([...ring[0]]);
        return { type: "Feature", id: polygon.id, properties: { name: polygon.name, note: polygon.note,
            ...(includeContributors && polygon.contributorColor ? { contributor: polygon.contributor, contributorColor: polygon.contributorColor } : {}) },
            geometry: { type: "Polygon", coordinates: [counterclockwisePolygonRing(ring)] } };
    }) };
}
