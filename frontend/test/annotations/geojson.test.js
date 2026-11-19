import test from "node:test";
import assert from "node:assert/strict";
import { exportAnnotationGeoJSON, readAnnotationCollection } from "../../src/annotations/geojson.js";
import { AnnotationModel, readAnnotationLayers, MAX_ANNOTATION_LAYERS,
    MAX_POLYGON_VERTICES, MAX_POLYGONS_PER_LAYER } from "../../src/annotations/model.js";
import { EMPTY_VECTOR_FILTER } from "../../src/vector/filter.js";

/** @return {Object} A closed counterclockwise Polygon with optional feature text. */
function feature() {
    return { type: "Feature", id: "external", properties: { name: "Forest", note: "Keep trees\n<plain text>" },
        geometry: { type: "Polygon", coordinates: [[[0, 0], [2, 0], [1, 2], [0, 0]]] } };
}

/** @return {Object} Named collection with one valid feature. */
function collection() { return { type: "FeatureCollection", name: "Workshop areas", features: [feature()] }; }

/** @return {AnnotationModel} Local collection with deterministic unique identifiers. */
function model() {
    let next = 0;
    return new AnnotationModel([], () => `id-${++next}`);
}

test("file downloads preserve contributor names and colors from existing device layers", () => {
    const annotations = model();
    const layer = annotations.addLayerFromPolygons(readAnnotationCollection(collection()));
    Object.assign(layer.polygons[0], { contributor: "Maria", contributorColor: "#FF006E" });
    const [saved] = readAnnotationLayers(annotations.document());
    const exported = exportAnnotationGeoJSON(saved, true);
    assert.equal(exported.eolabAnnotations, 1);
    assert.deepEqual(exported.features[0].properties, {
        ...feature().properties, contributor: "Maria", contributorColor: "#FF006E",
    });
    assert.deepEqual(exportAnnotationGeoJSON(saved).features[0].properties, feature().properties);
});

test("GeoJSON export preserves names, notes and shapes of committed polygons", () => {
    const annotations = model();
    const contents = readAnnotationCollection(collection());
    const layer = annotations.addLayerFromPolygons(contents);
    layer.filter = { enabled: true, match: "all", rules: [{ field: "name", operator: "eq", value: "does not match" }] };
    layer.visible = false;
    annotations.beginPolygon(layer.id);
    annotations.addVertex([40, 40]);
    const exported = exportAnnotationGeoJSON(layer);
    assert.equal(exported.type, "FeatureCollection");
    assert.equal(exported.name, "Workshop areas");
    assert.equal(exported.features.length, 1, "ignore display filtering and unfinished drafts");
    assert.deepEqual(exported.features[0].properties, feature().properties);
    assert.deepEqual(exported.features[0].geometry, feature().geometry);
    assert.equal(exported.features[0].id, layer.polygons[0].id);
    assert.equal(exported.filter, undefined);
    assert.equal(exported.style, undefined);
    assert.deepEqual(readAnnotationCollection(exported), contents);
    assert.deepEqual(readAnnotationLayers(annotations.document()), annotations.layers);
    assert.equal(layer.visible, false, "export does not modify its source");
});

test("export closes and orients clockwise rings without changing local geometry", () => {
    const annotations = model();
    const layer = annotations.addLayerFromPolygons(readAnnotationCollection(collection()));
    layer.polygons[0].vertices.reverse();
    const before = annotations.document();
    const ring = exportAnnotationGeoJSON(layer).features[0].geometry.coordinates[0];
    assert.deepEqual(ring[0], ring.at(-1));
    const area = ring.slice(0, -1).reduce((sum, p, i) => sum + p[0] * ring[i + 1][1] - ring[i + 1][0] * p[1], 0);
    assert.ok(area > 0);
    assert.deepEqual(annotations.document(), before);
});

test("restored contributions get independent layer and feature IDs and default presentation", () => {
    const annotations = model();
    const first = annotations.addLayerFromPolygons(readAnnotationCollection(collection()));
    first.filter = { enabled: true, match: "all", rules: [{ field: "name", operator: "eq", value: "Forest" }] };
    first.visible = false;
    const second = annotations.addLayerFromPolygons(readAnnotationCollection(exportAnnotationGeoJSON(first)));
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.polygons[0].id, second.polygons[0].id);
    assert.equal(second.visible, true);
    assert.deepEqual(second.filter, EMPTY_VECTOR_FILTER);
    second.polygons[0].vertices[0][0] = -3;
    assert.equal(first.polygons[0].vertices[0][0], 0);
});

test("unsupported geometries identify the failing feature and reason", () => {
    for (const [geometry, message] of [
        [null, /missing geometry/],
        [{ type: "MultiPolygon", coordinates: [] }, /MultiPolygon/],
        [{ type: "Point", coordinates: [0, 0] }, /Point/],
        [{ type: "LineString", coordinates: [[0, 0], [1, 1]] }, /LineString/],
        [{ type: "GeometryCollection", geometries: [] }, /GeometryCollection/],
        [{ type: "Polygon", coordinates: [feature().geometry.coordinates[0], feature().geometry.coordinates[0]] }, /holes/],
        [{ type: "Polygon", coordinates: [] }, /exterior ring/],
        [{ type: "Polygon", coordinates: [[]] }, /at least 3 vertices/],
        [{ type: "Polygon", coordinates: [[[0, 0], [2, 0], [1, 2], [1, 1]]] }, /not closed/],
        [{ type: "Polygon", coordinates: [[[0, 0, 1], [2, 0], [1, 2], [0, 0, 1]]] }, /Altitude/],
        [{ type: "Polygon", coordinates: [[[0, 0], [2, 0], [1, 90], [0, 0]]] }, /map bounds/],
        [{ type: "Polygon", coordinates: [[[0, 0], [200, 0], [1, 2], [0, 0]]] }, /WGS84/],
        [{ type: "Polygon", coordinates: [[[0, 0], ["2", 0], [1, 2], [0, 0]]] }, /finite numbers/],
        [{ type: "Polygon", coordinates: [[[0, 0], [null, 0], [1, 2], [0, 0]]] }, /finite numbers/],
        [{ type: "Polygon", coordinates: [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]] }, /edges cross/],
        [{ type: "Polygon", coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]] }, /overlap|enclose an area/],
    ]) {
        const document = collection();
        document.features.push({ ...feature(), geometry });
        assert.throws(() => readAnnotationCollection(document), error => {
            assert.match(error.message, /^Feature 2:/);
            assert.match(error.message, message);
            return true;
        });
    }
});

test("invalid collections, legacy CRS and invalid text produce descriptive errors", () => {
    for (const value of [null, [], feature(), feature().geometry]) {
        assert.throws(() => readAnnotationCollection(value), /Expected a GeoJSON FeatureCollection/);
    }
    assert.throws(() => readAnnotationCollection({ type: "FeatureCollection" }), /features array/);
    assert.throws(() => readAnnotationCollection({ ...collection(), features: [null] }), /Feature 1/);
    for (const target of ["document", "feature", "geometry"]) {
        const document = collection();
        const object = target === "document" ? document : target === "feature" ? document.features[0] : document.features[0].geometry;
        object.crs = { type: "name", properties: { name: "EPSG:3857" } };
        assert.throws(() => readAnnotationCollection(document), /Export GeoJSON in WGS84/);
    }
    const document = collection();
    document.features[0].properties.note = "a".repeat(10001);
    assert.throws(() => readAnnotationCollection(document), /Feature 1 note exceeds the 10000-character limit/);
    document.features[0].properties.note = 42;
    assert.throws(() => readAnnotationCollection(document), /Feature 1 note must be text/);
    document.name = "a".repeat(161);
    assert.throws(() => readAnnotationCollection(document), /Layer name exceeds/);
    document.name = " ";
    assert.throws(() => readAnnotationCollection(document), /Layer name must be nonblank text/);
});

test("feature and vertex limits are checked before expensive geometry work", () => {
    const document = collection();
    document.features = Array.from({ length: MAX_POLYGONS_PER_LAYER + 1 }, () => null);
    assert.throws(() => readAnnotationCollection(document), /at most 500/);
    document.features = [feature()];
    document.features[0].geometry.coordinates = [Array.from({ length: MAX_POLYGON_VERTICES + 2 }, () => [0, 0])];
    assert.throws(() => readAnnotationCollection(document), /2000-vertex/);
});

test("model refuses to add restored polygons during edits or beyond capacity", () => {
    const annotations = model();
    const contents = readAnnotationCollection(collection());
    const layer = annotations.addLayerFromPolygons(contents);
    annotations.beginPolygon(layer.id);
    assert.throws(() => annotations.addLayerFromPolygons(contents), /Save or cancel/);
    annotations.cancelPolygon();
    while (annotations.layers.length < MAX_ANNOTATION_LAYERS) annotations.createLayer();
    const before = annotations.document();
    assert.throws(() => annotations.addLayerFromPolygons(contents), /32 polygon layers/);
    assert.deepEqual(annotations.document(), before);
    const full = model();
    const existing = full.createLayer();
    const polygon = contents.polygons[0];
    existing.polygons = Array.from({ length: MAX_POLYGONS_PER_LAYER }, (_, i) => ({ ...polygon, id: `old-${i}`, note: "a".repeat(10000) }));
    const large = { name: "Another", polygons: existing.polygons.map(({ id, ...polygon }) => polygon) };
    assert.throws(() => full.addLayerFromPolygons(large), /8 MiB polygon storage limit/);
    assert.equal(full.layers.length, 1);
});

test("notes preserve empty strings, whitespace and multiline text exactly", () => {
    for (const note of ["", "   ", "\n", "  Field note\nLine two  "]) {
        const document = collection();
        document.features[0].properties.note = note;
        assert.equal(readAnnotationCollection(document).polygons[0].note, note);
    }
});
