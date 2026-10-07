import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseCategoricalVectorCsv, MAX_CATEGORY_CSV_BYTES } from "../../src/vector/categorical-csv.js";
import { normalizeVectorStyle, vectorStyleLegend } from "../../src/vector/style.js";

const fallback = { otherColor: "#abcdef", missingColor: "#112233" };

test("vector CSV preserves file order, exact text, quoted labels and fallback colors", () => {
    const table = parseCategoricalVectorCsv('\ufeffvalue,label,color,opacity\r\n" 01 ","Forest, ""dense""",#228B22,.5\r\n"",Empty,#0000FF,0\r\nA,"Line one\r\nline two",#FFFFFF,', { name: "class", type: "str:80" }, fallback);
    assert.deepEqual(table.rules, [
        { value: { kind: "string", value: " 01 " }, label: 'Forest, "dense"', color: "#228b22", opacity: 0.5 },
        { value: { kind: "string", value: "" }, label: "Empty", color: "#0000ff", opacity: 0 },
        { value: { kind: "string", value: "A" }, label: "Line one\nline two", color: "#ffffff", opacity: 1 },
    ]);
    assert.equal(table.field, "class"); assert.equal(table.limit, 3);
    assert.equal(table.otherColor, fallback.otherColor); assert.equal(table.missingColor, fallback.missingColor);
    assert.ok(Object.isFrozen(table)); assert.ok(table.rules.every(Object.isFrozen));
});

test("vector CSV follows Catalog scalar types rather than guessing from text", () => {
    for (const [type, values, expected] of [
        ["int64", ["+41.000", "-2", "9007199254740991"], [41, -2, Number.MAX_SAFE_INTEGER]],
        ["float", ["1.25", "-.5", "1e2"], [1.25, -0.5, 100]],
        ["bool", ["TRUE", "false"], [true, false]],
        ["str", ["01", "true", "1e2"], ["01", "true", "1e2"]],
    ]) {
        const csv = "color,value,label\n" + values.map((value, index) => `#001122,${value},Row ${index}`).join("\n");
        assert.deepEqual(parseCategoricalVectorCsv(csv, { name: "class", type }, fallback).rules.map(rule => rule.value.value), expected);
    }
    for (const [type, value] of [["int", "1.0000000000000001"], ["int", "1e2"], ["int", "9007199254740992"], ["float", "NaN"], ["float", "1e999"], ["float", "0x10"], ["bool", "1"], ["bool", "yes"]]) {
        assert.throws(() => parseCategoricalVectorCsv(`value,label,color\n${value},Bad,#000000`, { name: "class", type }, fallback), /CSV row 2, column "value"/);
    }
});

test("vector CSV reports typed duplicates, appearance errors and physical rows", () => {
    for (const [csv, pattern] of [
        ['value,label,color\n\n1,"Line one\nline two",#000000\n+1.00,Again,#ffffff', /CSV row 5, column "value": must be unique/],
        ["value,label,color\n1,,#000000", /CSV row 2, column "label"/],
        ["value,label,color\n1,One,red", /CSV row 2, column "color"/],
        ["value,label,color,opacity\n1,One,#000000,50%", /CSV row 2, column "opacity"/],
        ["value,label,color,opacity\n1,One,#000000,1.1", /CSV row 2, column "opacity"/],
        ["value,label,color,opacity\n1,One,#000000,1e999", /CSV row 2, column "opacity"/],
        ['value,label,color\n1,"One"oops,#000000', /CSV row 2, column 2/],
        ["value,label,color\n1,One", /CSV row 2, column 3/],
        ["value,label,color,color\n1,One,#000000,#ffffff", /duplicate column/],
    ]) assert.throws(() => parseCategoricalVectorCsv(csv, { name: "class", type: "int" }, fallback), pattern);
});

test("vector CSV enforces its established 50-rule and UTF-8 byte bounds", () => {
    const rows = Array.from({ length: 50 }, (_, i) => `${i},Row ${i},#000000`);
    const csv = "value,label,color\n" + rows.join("\n");
    assert.equal(parseCategoricalVectorCsv(csv, { name: "class", type: "int" }, fallback).rules.length, 50);
    assert.throws(() => parseCategoricalVectorCsv(csv + "\n50,Extra,#000000", { name: "class", type: "int" }, fallback), /at most 50 category rows/);
    assert.throws(() => parseCategoricalVectorCsv("🌲".repeat(MAX_CATEGORY_CSV_BYTES / 2), { name: "class", type: "str" }, fallback), /UTF-8 bytes/);
    assert.throws(() => parseCategoricalVectorCsv("value,label,color", { name: "class", type: "int" }, fallback), /at least one rule/);
});

test("imported labels and opacity survive JSON, copy normalization and geometry legends", () => {
    const categorical = parseCategoricalVectorCsv("value,label,color,opacity\n2,Wetland,#0000ff,0.25\n1,Hidden,#00ff00,0", { name: "class", type: "int" }, fallback);
    for (const geometryKind of ["point", "line", "polygon"]) {
        const style = normalizeVectorStyle({ geometryKind, categorical, strokeColor: "#123456", strokeOpacity: 0.8, strokeWidth: 2,
            ...(geometryKind !== "line" ? { fillColor: "#ffffff", fillOpacity: 0.4 } : {}), ...(geometryKind === "point" ? { pointSize: 8 } : {}) });
        const restored = normalizeVectorStyle(JSON.parse(JSON.stringify(style)));
        assert.deepEqual(restored, style);
        const legend = vectorStyleLegend(restored);
        assert.equal(legend.entries[0].label, "Wetland");
        assert.equal(legend.entries[0].symbol.strokeOpacity, 0.2);
        assert.equal(legend.entries[0].symbol.fillOpacity, geometryKind === "line" ? 0 : 0.1);
        assert.equal(legend.entries[1].symbol.strokeOpacity, 0);
        assert.equal(legend.entries[1].symbol.fillOpacity, 0);
    }
});

test("category CSV syntax has no feature imports and vector does not import raster", async () => {
    const neutral = await readFile(new URL("../../src/category-csv.js", import.meta.url), "utf8");
    assert.doesNotMatch(neutral, /^\s*import(?:\s|\{)|\braster\b|\bvector\b/m);
    const vector = await readFile(new URL("../../src/vector/categorical-csv.js", import.meta.url), "utf8");
    assert.doesNotMatch(vector, /["']\.\.\/raster\//);
});
