import test from "node:test";
import assert from "node:assert/strict";
import { ANNOTATION_FIELDS, annotationFilterRules, annotationSummaryTarget, annotationSummaryPolygons } from "../../src/annotations/summary-area.js";
import { AnnotationModel, matchingAnnotationPolygons, readAnnotationLayers } from "../../src/annotations/model.js";
import { parseAnnotationGeoJSON } from "../../src/annotations/geojson.js";
import { VectorSamplingController } from "../../src/vector/sampling.js";

/** @return {Object} Two overlapping committed polygons with different text attributes. */
function layer() {
    return { id: "layer", name: "Study areas", filter: annotationFilterRules(""), polygons: [
        { id: "one", name: "Forest", note: "Restore trees", vertices: [[0, 0], [3, 0], [3, 3], [0, 3]] },
        { id: "two", name: "Water", note: "Monitor flooding", vertices: [[2, 2], [5, 2], [5, 5], [2, 5]] },
    ] };
}

test("summary and map filters select the same annotation names and notes", () => {
    const value = layer();
    for (const rule of [{ field: "name", operator: "eq", value: "Forest" },
        { field: "note", operator: "contains", value: "flood" }, { field: "name", operator: "ne", value: "Forest" },
        { field: "note", operator: "missing", value: null }]) {
        value.filter = { enabled: true, match: "all", rules: [rule] };
        const expected = matchingAnnotationPolygons(value);
        const actual = annotationSummaryPolygons(value.polygons, value.filter);
        assert.equal(actual.length, expected.length);
        actual.forEach((polygon, i) => assert.deepEqual(polygon.coordinates[0], [...expected[i].vertices, expected[i].vertices[0]]));
    }
    value.filter.enabled = false;
    assert.equal(annotationSummaryPolygons(value.polygons, value.filter).length, 2);
    assert.throws(() => annotationSummaryPolygons(value.polygons, { enabled: true, match: "all", rules: [{ field: "path", operator: "eq", value: "x" }] }), /choose a field/);
    assert.deepEqual(ANNOTATION_FIELDS.map(field => field.name), ["name", "note"]);
});

test("summary snapshots exclude drafts, styles and text that does not change membership", () => {
    const model = new AnnotationModel();
    const imported = parseAnnotationGeoJSON(JSON.stringify({ type: "FeatureCollection", name: "Study areas",
        features: layer().polygons.map(polygon => ({ type: "Feature", properties: { name: polygon.name, note: polygon.note },
            geometry: { type: "Polygon", coordinates: [[...polygon.vertices, polygon.vertices[0]]] } })) }));
    const value = model.importLayer(imported);
    const before = annotationSummaryTarget("layer", value);
    model.beginPolygon(value.id, value.polygons[0].id);
    model.draft.polygon.vertices[0] = [-1, 0];
    assert.deepEqual(annotationSummaryTarget("layer", value).polygons, before.polygons);
    value.polygons[0].note = "Changed note"; value.style.labels = false; value.visible = false;
    const after = annotationSummaryTarget("layer", value);
    assert.equal(after.selectionIdentity(after.filter), before.selectionIdentity(before.filter));
    model.savePolygon();
    assert.notEqual(annotationSummaryTarget("layer", value).selectionIdentity(after.filter), before.selectionIdentity(before.filter));
    value.filter = { enabled: true, match: "all", rules: [{ field: "name", operator: "eq", value: "Forest" }] };
    assert.deepEqual(readAnnotationLayers(model.document())[0].filter, value.filter);
    assert.equal(annotationSummaryPolygons(value.polygons, value.filter).length, 1);
    value.polygons[0].name = "Grass";
    assert.equal(annotationSummaryPolygons(value.polygons, value.filter).length, 0);
});

test("obsolete polygon uploads are released, and presentation edits retain active selections", async () => {
    let value = layer(), targets = [annotationSummaryTarget("layer", value)], resolve;
    const released = [], invalidated = [], activated = [];
    const area = { polygonArea: { id: "a".repeat(32), sha256: "b".repeat(64) }, bbox: [0, 0, 5, 5],
        matched: 2, total: 2, label: "Study areas", filter: annotationFilterRules("") };
    const view = { bind() {}, render() {}, unbind() {} };
    const controller = new VectorSamplingController({ view, getTargets: () => targets,
        createArea: () => new Promise(done => { resolve = done; }), onEditFilter() {},
        onActivate: item => activated.push(item), onInvalidate: (_, item) => invalidated.push(item), releaseArea: item => released.push(item) });
    const first = controller.use({ analysis: true });
    await Promise.resolve();
    controller.invalidate("Cancelled"); resolve(area); await first;
    assert.deepEqual(released, [area]); assert.equal(activated.length, 0);
    const second = controller.use({ analysis: true }); await Promise.resolve(); resolve(area); await second;
    controller.activate(area.polygonArea, true);
    assert.equal(activated.length, 1);
    value.name = "Renamed"; value.polygons[0].note = "Other note";
    targets = [annotationSummaryTarget("layer", value)]; controller.refresh();
    assert.equal(invalidated.length, 0);
    value.polygons[0].vertices[0] = [-1, 0]; targets = [annotationSummaryTarget("layer", value)]; controller.refresh();
    assert.deepEqual(invalidated, [area]); assert.equal(released.length, 2);
    assert.equal(controller.state.area, null);
});


test("unchanged saved text searches retain the same case-insensitive map and summary selection", () => {
    const value = layer(); value.filter = "FOREST";
    const target = annotationSummaryTarget("layer", value);
    const geometry = annotationSummaryPolygons(target.polygons, target.filter, target.savedFilter);
    assert.equal(geometry.length, matchingAnnotationPolygons(value).length);
    assert.equal(geometry.length, 1);
    const different = { enabled: true, match: "all", rules: [{ field: "name", operator: "eq", value: "Water" }] };
    assert.equal(annotationSummaryPolygons(target.polygons, different, target.savedFilter).length, 1);
});
