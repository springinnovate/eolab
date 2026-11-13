import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { classifyVectorNumbers } from "../../src/vector/api.js";
import {
    defaultVectorLabelField,
    defaultVectorNumericField,
    deriveDefaultVectorStyle,
} from "../../src/vector/defaults.js";

const fields = [
    { name: "OBJECTID", type: "int64" },
    { name: "NAME", type: "str:80" },
    { name: "score", type: "float" },
];
const initial = {
    geometryKind: "polygon", fillColor: "#2b83ba", fillOpacity: 0.7,
    strokeColor: "#000000", strokeOpacity: 1, strokeWidth: 0.75,
};

test("default-selection policy depends only on vector style values", async () => {
    const source = await readFile(new URL("../../src/vector/defaults.js", import.meta.url), "utf8");
    assert.deepEqual([...source.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]), ["./style.js"]);
    assert.doesNotMatch(source, /\b(?:fetch|document|window|leaflet)\s*[.(]/);
});

test("default labels recognize exact Catalog text names without guessing arbitrary fields", () => {
    assert.equal(defaultVectorLabelField(fields), "NAME");
    assert.equal(defaultVectorLabelField([{ name: "site_name", type: "string" }]), "site_name");
    assert.equal(defaultVectorLabelField([{ name: "node_nm", type: "str:80" }]), "node_nm");
    assert.equal(defaultVectorLabelField([{ name: "name", type: "int" }]), null);
    assert.equal(defaultVectorLabelField([{ name: "code", type: "str" }]), null);
    assert.equal(defaultVectorLabelField([
        { name: "site_name", type: "str" }, { name: "region_name", type: "str" },
    ]), null);
    assert.equal(defaultVectorLabelField([
        { name: "Name", type: "str" }, { name: "NAME", type: "str" },
    ]), null);
});

test("default numeric selection excludes identifiers and uses a measurement immediately", () => {
    assert.equal(defaultVectorNumericField(fields), "score");
    for (const name of ["id", "FID", "OBJECTID_1", "site_id", "siteId", "code", "site_code", "index", "OID1"]) {
        assert.equal(defaultVectorNumericField([{ name, type: "int" }]), null, name);
    }
    assert.equal(defaultVectorNumericField([...fields, { name: "area", type: "float" }]), "score");
    assert.equal(defaultVectorNumericField([{ name: "score", type: "str" }]), null);
    assert.equal(defaultVectorNumericField([]), null);
});

test("annual numeric defaults prefer the latest year regardless of Catalog field ordering", () => {
    const annual = [
        { name: "FID", type: "int" },
        { name: "node_nm", type: "str:80" },
        { name: "area", type: "float" },
        { name: "R2000", type: "float:24.15" },
        { name: "R2024", type: "float:24.15" },
        { name: "R2023", type: "float:24.15" },
        { name: "id_2025", type: "int" },
    ];
    assert.equal(defaultVectorNumericField(annual), "R2024");
    assert.equal(defaultVectorNumericField([...annual].reverse()), "R2024");
});

test("new polygon, point and line styles leave labels off", () => {
    for (const geometryKind of ["polygon", "point", "line"]) {
        const symbol = geometryKind === "line"
            ? { geometryKind, strokeColor: "#2b83ba", strokeOpacity: 1, strokeWidth: 2 }
            : { ...initial, geometryKind, ...(geometryKind === "point" ? { pointSize: 9 } : {}) };
        const styled = deriveDefaultVectorStyle(symbol);
        assert.equal(styled.label, null);
        assert.equal(styled.strokeWidth, symbol.strokeWidth);
        assert.equal(styled.graduated, null);
    }
});

test("default numeric colors consume API-validated constants with and without nulls", async () => {
    const summary = {
        field: "score", fieldType: "float", method: "percentile-interval",
        requestedClassCount: 5, actualClassCount: 1,
        classes: [{ minimum: null, maximum: null, count: 9 }],
        observedMinimum: 3, observedMaximum: 3, numericValueCount: 9,
        scannedFeatureCount: 10, featureCount: 10, nullCount: 1,
        unsupportedValueCount: 0, complete: true,
        defaultClassCount: 5, minimumClassCount: 2, maximumClassCount: 9,
    };
    for (const nullCount of [0, 1]) {
        const classification = await classifyVectorNumbers(
            { collection: "vectors", id: "measurements" },
            "score", "percentile-interval", 5,
            async () => new Response(JSON.stringify({ ...summary, nullCount })),
        );
        const styled = deriveDefaultVectorStyle(initial, classification);
        assert.deepEqual(styled.graduated.rules, [{ minimum: null, maximum: null, color: "#ffffbf" }]);
        assert.equal(styled.graduated.missingColor, nullCount > 0 ? "#d1d5db" : null);
        assert.equal(styled.label, null);
    }
});
