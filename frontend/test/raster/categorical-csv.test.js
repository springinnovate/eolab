import assert from "node:assert/strict";
import test from "node:test";

import {
    MAX_CATEGORICAL_RASTER_CSV_BYTES,
    parseCategoricalRasterCsv,
} from "../../src/raster/categorical-csv.js";

test("CSV imports normalized categories in file order while preserving the layer fallback", () => {
    const fallback = { color: "#ABCDEF", opacity: 0.25 };
    const style = parseCategoricalRasterCsv(
        "value,label,color,opacity\n41, Forest ,#228B22,.5\n0,Water,#0000FF,0\n-2,Bare,#FFFFFF,\n",
        fallback,
    );
    assert.deepEqual(style, {
        mode: "categorical",
        categories: [
            { value: 41, label: "Forest", color: "#228b22", opacity: 0.5 },
            { value: 0, label: "Water", color: "#0000ff", opacity: 0 },
            { value: -2, label: "Bare", color: "#ffffff", opacity: 1 },
        ],
        unmapped: { color: "#abcdef", opacity: 0.25 },
    });
    assert.ok(Object.isFrozen(style));
    assert.ok(Object.isFrozen(style.categories));
    assert.ok(style.categories.every(Object.isFrozen));
    assert.ok(Object.isFrozen(style.unmapped));
    fallback.opacity = 0;
    assert.equal(style.unmapped.opacity, 0.25);
    const defaults = parseCategoricalRasterCsv("color,value,label\n#001122,7,Wetland");
    assert.equal(defaults.categories[0].opacity, 1);
    assert.deepEqual(defaults.unmapped, { color: "#808080", opacity: 1 });
});

test("CSV handles BOM, headers and quoted punctuation while normalizing label newlines to LF", () => {
    const style = parseCategoricalRasterCsv(
        '\ufeff\r\n COLOR ,"Label",VALUE,Opacity\r\n"#aAbBcC","Forest, ""dense""",+41.000,1.\r\n\r\n#112233,"Line one\r\nline two",-0.0,1e-1\r\n',
    );
    assert.deepEqual(style.categories, [
        { value: 41, label: 'Forest, "dense"', color: "#aabbcc", opacity: 1 },
        { value: 0, label: "Line one\nline two", color: "#112233", opacity: 0.1 },
    ]);
    assert.equal(Object.is(style.categories[1].value, -0), false);
    assert.equal(parseCategoricalRasterCsv('value,label,color\n1,"one\ntwo",#000000').categories[0].label, "one\ntwo");
    assert.equal(parseCategoricalRasterCsv('value,label,color\r\n1,"one\r\ntwo\nthree",#000000').categories[0].label, "one\ntwo\nthree");
});

test("CSV category codes cannot be rounded or coerced into integer categories", () => {
    const accepted = parseCategoricalRasterCsv(
        "value,label,color\n9007199254740991.0,Maximum,#ffffff\n-9007199254740991,Minimum,#000000\n+00041.00,Padded,#123456",
    );
    assert.deepEqual(accepted.categories.map(row => row.value), [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 41]);
    for (const code of ["", "1.0000000000000001", "1.5", "41.", ".0", "1e2", "0x29", "Infinity", "NaN", "true", "1_000"]) {
        assert.throws(() => parseCategoricalRasterCsv(`value,label,color\n${code},Test,#000000`),
            /CSV row 2, column "value": use a whole decimal integer/, code);
    }
    for (const code of ["9007199254740992", "-9007199254740992", "9".repeat(400)]) {
        assert.throws(() => parseCategoricalRasterCsv(`value,label,color\n${code},Test,#000000`),
            /CSV row 2, column "value": must be a safe integer/, code);
    }
});

test("CSV opacity syntax is numeric without accepting hex, percentages or nonfinite values", () => {
    for (const opacity of ["0x1", "50%", "Infinity", "NaN", "true", ".", "1,2"]) {
        assert.throws(() => parseCategoricalRasterCsv(`value,label,color,opacity\n1,Test,#000000,"${opacity}"`),
            /CSV row 2, column "opacity": use a decimal opacity/, opacity);
    }
    for (const opacity of ["1.1", "-0.1", "1e999"]) {
        assert.throws(() => parseCategoricalRasterCsv(`value,label,color,opacity\n1,Test,#000000,${opacity}`),
            /CSV row 2, column "opacity": must be a finite number from zero to one/, opacity);
    }
});

test("CSV header errors identify unknown, duplicate and missing columns", () => {
    assert.throws(() => parseCategoricalRasterCsv("value,label,colour\n1,Test,#000000"),
        /CSV row 1, column 3: unknown column "colour"/);
    assert.throws(() => parseCategoricalRasterCsv("value,label,color,opacity,extra\n1,Test,#000000,1,x"),
        /CSV row 1, column 5: unknown column "extra"/);
    assert.throws(() => parseCategoricalRasterCsv("value,label,color, VALUE \n1,Test,#000000,2"),
        /CSV row 1, column 4: duplicate column "value"/);
    assert.throws(() => parseCategoricalRasterCsv("value,label\n1,Test"),
        /CSV row 1: missing required column "color"/);
    assert.throws(() => parseCategoricalRasterCsv("value,label,color,\n1,Test,#000000,"),
        /CSV row 1, column 4: unknown column ""/);
    assert.throws(() => parseCategoricalRasterCsv("value;label;color\n1;Test;#000000"),
        /unknown column "value;label;color"/);
});

test("CSV malformed quoting and line endings fail at their source location", () => {
    for (const [text, expected] of [
        ['value,label,color\n1,unquoted"quote,#000000', /CSV row 2, column 2: quote the entire field/],
        ['value,label,color\n1,"closed"extra,#000000', /CSV row 2, column 2: only a comma or newline/],
        ['value,label,color\n1,"closed" ,#000000', /CSV row 2, column 2: only a comma or newline/],
        ['value,label,color\n1,"never closed,#000000', /CSV row 2, column 2: quoted field is missing/],
        ['value,label,color\n1, "leading space",#000000', /CSV row 2, column 2: quote the entire field/],
        ["value,label,color\r1,Test,#000000", /CSV row 1, column 3: use LF or CRLF/],
        ['value,label,color\n1,"one\rtwo",#000000', /CSV row 2, column 2: use LF or CRLF/],
    ]) {
        assert.throws(() => parseCategoricalRasterCsv(text), expected);
    }
});

test("CSV row widths and empty fields do not silently create partial imports", () => {
    assert.throws(() => parseCategoricalRasterCsv("value,label,color\n1,Test"),
        /CSV row 2, column 3: expected 3 fields.*found 2/);
    assert.throws(() => parseCategoricalRasterCsv("value,label,color\n1,Test,#000000,1"),
        /CSV row 2, column 4: expected 3 fields.*found 4/);
    assert.throws(() => parseCategoricalRasterCsv('value,label,color\n""\n1,Test,#000000'),
        /CSV row 2, column 2: expected 3 fields.*found 1/);
    assert.throws(() => parseCategoricalRasterCsv("value,label,color\n,,\n1,Test,#000000"),
        /CSV row 2, column "value"/);
    assert.throws(() => parseCategoricalRasterCsv("value,label,color\n1,,#000000"),
        /CSV row 2, column "label": must contain 1 to 128 Unicode code points/);
    assert.throws(() => parseCategoricalRasterCsv("value,label,color\n1,Test,"),
        /CSV row 2, column "color": must use a six-digit hex color/);
    assert.throws(() => parseCategoricalRasterCsv("value,label,color\n\n"),
        /CSV table: Style categories must contain 1 to 256 rows/);
    assert.throws(() => parseCategoricalRasterCsv("\ufeff\n\r\n"), /CSV row 1: add a header/);
});

test("CSV semantic errors retain physical row numbers after blank or multiline records", () => {
    const prefix = '\nvalue,label,color\n1,"First\nlabel",#000000\n\n';
    assert.throws(() => parseCategoricalRasterCsv(`${prefix}+01.0,Duplicate,#ffffff`),
        /CSV row 6, column "value": duplicates another category/);
    assert.throws(() => parseCategoricalRasterCsv(`${prefix}2,Second,red`),
        /CSV row 6, column "color": must use a six-digit hex color/);
    assert.throws(() => parseCategoricalRasterCsv(`${prefix}2,${"x".repeat(129)},#123456`),
        /CSV row 6, column "label": must contain 1 to 128 Unicode code points/);
    assert.throws(() => parseCategoricalRasterCsv("value,label,color\n0,Zero,#000000\n-0.00,Duplicate,#ffffff"),
        /CSV row 3, column "value": duplicates another category/);
});

test("CSV permits Unicode and literal labels without interpreting markup or quote payloads", () => {
    const label = '<img src=x onerror="alert(1)">, 林🌳';
    const quoted = `"${label.replaceAll('"', '""')}"`;
    const style = parseCategoricalRasterCsv(`value,label,color\n1,${quoted},#000000`);
    assert.equal(style.categories[0].label, label);
    assert.equal(parseCategoricalRasterCsv(`value,label,color\n1,${"🌳".repeat(128)},#000000`).categories[0].label.length, 256);
    assert.throws(() => parseCategoricalRasterCsv(`value,label,color\n1,${"🌳".repeat(129)},#000000`), /column "label"/);
    assert.throws(() => parseCategoricalRasterCsv("value,label,color\n1,\ud800,#000000"), /column "label": must contain valid Unicode/);
    assert.throws(() => parseCategoricalRasterCsv('value,label,color\n1,Test,"#000000\",opacity:0"'),
        /CSV row 2, column 4: quote the entire field/);
});

test("CSV enforces input bytes, category count and canonical serialized size independently", () => {
    const small = "value,label,color\n1,Test,#000000\n";
    assert.equal(MAX_CATEGORICAL_RASTER_CSV_BYTES, 131072);
    assert.equal(parseCategoricalRasterCsv(small + "\n".repeat(MAX_CATEGORICAL_RASTER_CSV_BYTES - small.length)).categories.length, 1);
    assert.throws(() => parseCategoricalRasterCsv("x".repeat(MAX_CATEGORICAL_RASTER_CSV_BYTES + 1)), /exceeds 131072 UTF-8 bytes/);
    assert.throws(() => parseCategoricalRasterCsv("🌳".repeat(32769)), /exceeds 131072 UTF-8 bytes/);
    const rows = Array.from({ length: 256 }, (_, index) => `${index},Category ${index},#123456`);
    assert.equal(parseCategoricalRasterCsv(`value,label,color\n${rows.join("\n")}`).categories.length, 256);
    assert.throws(() => parseCategoricalRasterCsv(`value,label,color\n${rows.join("\n")}\n256,Overflow,#123456`),
        /CSV row 258: import at most 256 category rows/);
    const oversizedStyle = Array.from({ length: 140 }, (_, index) => `${index},${"🌳".repeat(128)},#000000`);
    assert.throws(() => parseCategoricalRasterCsv(`value,label,color\n${oversizedStyle.join("\n")}`),
        /CSV table: Categorical style exceeds 65536 UTF-8 bytes/);
    assert.throws(() => parseCategoricalRasterCsv(null), TypeError);
    assert.throws(() => parseCategoricalRasterCsv(small, { color: "red", opacity: 1 }), /CSV table: Unmapped color/);
});
