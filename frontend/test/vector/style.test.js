import assert from "node:assert/strict";
import test from "node:test";

import {
    categoryValueKey,
    formatNumericRange,
    normalizeVectorCategorySummary,
    normalizeVectorNumericClassification,
    normalizeVectorStyle,
    qualitativeCategoryColor,
    sequentialPaletteColors,
    vectorCategoricalFields,
    vectorLabelFields,
    vectorNumericFields,
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
    assert.equal(point.categorical, null);
    assert.equal(point.graduated, null);
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

test("graduated styles normalize server ranges, palettes, and legends", () => {
    const summary = normalizeVectorNumericClassification({
        field: "score",
        fieldType: "float",
        method: "quantile",
        requestedClassCount: 5,
        actualClassCount: 2,
        classes: [
            { minimum: null, maximum: 1, count: 6 },
            { minimum: 1, maximum: null, count: 4 },
        ],
        observedMinimum: 0,
        observedMaximum: 9,
        numericValueCount: 10,
        scannedFeatureCount: 11,
        featureCount: 11,
        nullCount: 1,
        unsupportedValueCount: 0,
        complete: true,
        defaultClassCount: 5,
        minimumClassCount: 2,
        maximumClassCount: 9,
    });
    const colors = sequentialPaletteColors("viridis", summary.actualClassCount);
    const style = normalizeVectorStyle({
        geometryKind: "polygon",
        fillColor: "#a855f7",
        fillOpacity: 0.38,
        strokeColor: "#581c87",
        strokeOpacity: 1,
        strokeWidth: 2,
        graduated: {
            field: summary.field,
            method: summary.method,
            classCount: summary.requestedClassCount,
            palette: "viridis",
            rules: summary.classes.map((classification, index) => ({
                minimum: classification.minimum,
                maximum: classification.maximum,
                color: colors[index],
            })),
            missingColor: "#D1D5DB",
        },
    });

    assert.equal(summary.actualClassCount, 2);
    assert.deepEqual(colors, ["#440154", "#fde725"]);
    assert.equal(formatNumericRange(summary.classes[0]), "≤ 1");
    assert.deepEqual(vectorNumericFields([
        { name: "score", type: "float" },
        { name: "rank", type: "int32" },
        { name: "risk", type: "str" },
    ]), [
        { name: "score", type: "float" },
        { name: "rank", type: "int32" },
    ]);
    assert.deepEqual(vectorStyleLegend(style), {
        kind: "graduated",
        label: "score",
        entries: [
            { label: "≤ 1", color: "#440154" },
            { label: "> 1", color: "#fde725" },
            { label: "No value", color: "#d1d5db" },
        ],
    });
    assert.throws(
        () => normalizeVectorStyle({ ...style, categorical: {
            field: "risk",
            limit: 1,
            rules: [{ value: { kind: "string", value: "high" }, color: "#d60000" }],
        } }),
        /cannot combine/,
    );
});

test("categorical styles preserve explicit value types and qualitative colors", () => {
    const style = normalizeVectorStyle({
        geometryKind: "polygon",
        fillColor: "#a855f7",
        fillOpacity: 0.38,
        strokeColor: "#581c87",
        strokeOpacity: 1,
        strokeWidth: 2,
        categorical: {
            field: "risk",
            limit: 20,
            rules: [
                { value: { kind: "integer", value: 1 }, color: "#D60000" },
                { value: { kind: "number", value: 1 }, color: "#018700" },
            ],
            otherColor: "#9CA3AF",
            missingColor: "#D1D5DB",
        },
    });

    assert.equal(style.categorical.rules[0].color, "#d60000");
    assert.notEqual(
        categoryValueKey(style.categorical.rules[0].value),
        categoryValueKey(style.categorical.rules[1].value),
    );
    assert.notEqual(qualitativeCategoryColor(0), qualitativeCategoryColor(1));
    assert.notEqual(qualitativeCategoryColor(0), qualitativeCategoryColor(0, 1));
    assert.deepEqual(vectorStyleLegend(style), {
        kind: "categories",
        label: "risk",
        entries: [
            { label: "1", color: "#d60000" },
            { label: "1", color: "#018700" },
            { label: "Other", color: "#9ca3af" },
            { label: "No value", color: "#d1d5db" },
        ],
    });
});

test("category summaries advertise bounded complete values and eligible fields", () => {
    const summary = normalizeVectorCategorySummary({
        field: "risk",
        fieldType: "str:40",
        values: [{ value: { kind: "string", value: "high" }, count: 4 }],
        observedDistinctCount: 1,
        distinctCount: 1,
        scannedFeatureCount: 4,
        featureCount: 4,
        nullCount: 0,
        unsupportedValueCount: 0,
        complete: true,
        defaultLimit: 20,
        maximumLimit: 50,
    });

    assert.equal(summary.values[0].value.kind, "string");
    assert.deepEqual(vectorCategoricalFields([
        { name: "risk", type: "str:40" },
        { name: "score", type: "float" },
        { name: "observed", type: "date" },
    ]), [
        { name: "risk", type: "str:40" },
        { name: "score", type: "float" },
    ]);
    assert.throws(
        () => normalizeVectorCategorySummary({ ...summary, complete: false }),
        /Distinct count must agree/,
    );
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
