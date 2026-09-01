import assert from "node:assert/strict";
import test from "node:test";

import {
    normalizeVectorStyle,
    vectorLabelFields,
    vectorStyleLegend,
} from "../../src/vector/style.js";

test("vector styles normalize geometry-specific symbol state", () => {
    const point = normalizeVectorStyle({
        geometryKind: "point",
        fillColor: "#ABCDEF",
        fillOpacity: 0.5,
        strokeColor: "#123456",
        strokeOpacity: 1,
        strokeWidth: 2,
        pointSize: 12,
    });
    const line = normalizeVectorStyle({
        geometryKind: "line",
        strokeColor: "#FEDCBA",
        strokeOpacity: 0.8,
        strokeWidth: 3.5,
    });

    assert.equal(point.fillColor, "#abcdef");
    assert.equal(point.pointSize, 12);
    assert.equal(point.label, null);
    assert.equal(line.fillColor, null);
    assert.equal(line.pointSize, null);
    assert.deepEqual(vectorStyleLegend(line), {
        kind: "fixed",
        label: "Line",
        fill: "#fedcba",
        stroke: "#fedcba",
    });
});

test("vector labels normalize optional presentation and Catalog fields", () => {
    const style = normalizeVectorStyle({
        geometryKind: "line",
        strokeColor: "#FEDCBA",
        strokeOpacity: 0.8,
        strokeWidth: 3.5,
        label: {
            field: "name",
            fontFamily: "SansSerif",
            fontSize: 13,
            fontWeight: "bold",
            fontColor: "#123456",
            haloColor: "#FFFFFF",
            haloWidth: 1.5,
            placement: "follow-line",
            minimumZoom: 6,
        },
    });
    const fields = vectorLabelFields({
        properties: {
            "table:primary_geometry": "geometry",
            "table:columns": [
                { name: "geometry", type: "LineString" },
                { name: "name", type: "str" },
                { name: "magnitude", type: "float" },
                { name: "name", type: "duplicate" },
            ],
        },
    });

    assert.equal(style.label.haloColor, "#ffffff");
    assert.equal(style.label.placement, "follow-line");
    assert.deepEqual(fields, [
        { name: "name", type: "str" },
        { name: "magnitude", type: "float" },
    ]);
    assert.throws(
        () => normalizeVectorStyle({
            ...style,
            geometryKind: "point",
            fillColor: "#ffffff",
            fillOpacity: 1,
            pointSize: 8,
        }),
        /Only line labels/,
    );
});

test("vector styles reject invalid ranges and cross-geometry controls", () => {
    const line = {
        geometryKind: "line",
        strokeColor: "#000000",
        strokeOpacity: 1,
        strokeWidth: 2,
    };

    assert.throws(
        () => normalizeVectorStyle({ ...line, fillColor: "#ffffff" }),
        /does not apply/,
    );
    assert.throws(
        () => normalizeVectorStyle({ ...line, strokeWidth: 21 }),
        /from 0 to 20/,
    );
    assert.throws(
        () => normalizeVectorStyle({
            ...line,
            geometryKind: "point",
            fillColor: "#ffffff",
            fillOpacity: 1,
        }),
        /Point size/,
    );
});
