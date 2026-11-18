import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {exportDrawingCollection, readDrawingView} from "../../src/annotations/source-document.js";

const cases = JSON.parse(readFileSync(new URL("../../../tests/fixtures/drawing-admission.json", import.meta.url), "utf8"));

/** Build one original polygon for the shared server-admission/browser-reader examples.
 * @return {Object} Valid drawing source response, including the owner permission.
 */
function drawing() {
    return {id: "11111111-1111-4111-8111-111111111111", revision: 1, canEdit: true,
        collection: {type: "FeatureCollection", name: "Drawn parcels", features: [
            {type: "Feature", id: "parcel-a", properties: {name: "Priority", note: "Existing forest"},
                geometry: {type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]]}},
        ]}};
}

for (const example of [...cases.geometry, ...cases.text]) {
    test(`drawing admission and editor agree: ${example.name}`, () => {
        const source = drawing();
        if (example.geometry) source.collection.features[0].geometry = example.geometry;
        else {
            const text = example.unit.repeat(example.count);
            if (example.field === "sourceName") source.collection.name = text;
            else source.collection.features[0].properties[example.field === "polygonName" ? "name" : "note"] = text;
        }
        if (!example.valid) assert.throws(() => readDrawingView(source, "drawing-view"));
        else {
            const view = readDrawingView(source, "drawing-view");
            const exported = structuredClone(source.collection);
            if (example.exportGeometry) exported.features[0].geometry = example.exportGeometry;
            assert.deepEqual(exportDrawingCollection(view), exported,
                "IDs, shape and text survive reopening; clockwise rings use the existing counterclockwise export convention");
        }
    });
}
