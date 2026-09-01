import assert from "node:assert/strict";
import test from "node:test";

import {
    normalizeVectorStyle,
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
    assert.equal(line.fillColor, null);
    assert.equal(line.pointSize, null);
    assert.deepEqual(vectorStyleLegend(line), {
        kind: "fixed",
        label: "Line",
        fill: "#fedcba",
        stroke: "#fedcba",
    });
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
