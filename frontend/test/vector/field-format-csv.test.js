import assert from "node:assert/strict";
import test from "node:test";

import { makeFieldFormatTemplate, MAX_FIELD_FORMAT_CSV_BYTES, parseFieldFormatCsv } from "../../src/vector/field-format-csv.js";

const HEADER = "field,display_name,format,decimals,unit,currency";
const NUMERIC_FIELDS = ["area_ha", "annual_cost", "count"];
const FIELDS = [...NUMERIC_FIELDS, "name"];

test("templates prefill fields, keep existing names and formats and round-trip literal text", () => {
    const fields = [...FIELDS, 'Carbon, "net"', "=balance", "'=balance", "__proto__"];
    const formats = Object.fromEntries([
        ["area_ha", {displayName: "Habitat area", format: "number", decimals: 1, unit: "ha"}],
        ["annual_cost", {format: "currency", decimals: 2, currency: "USD"}],
        ["name", {displayName: 'Site, "name"'}],
        ['Carbon, "net"', {displayName: "Carbon CO₂", format: "number", unit: 't CO₂e, "net"'}],
        ["=balance", {displayName: "=Net balance", format: "currency", currency: "EUR"}],
        ["'=balance", {displayName: "'=Net balance", format: "number", unit: "+margin"}],
        ["__proto__", {displayName: "<b>Count</b>", format: "number", decimals: 0}],
    ]);
    const csv = makeFieldFormatTemplate(fields, formats);
    assert.ok(csv.startsWith(`\ufeff${HEADER}\r\narea_ha,Habitat area,number,1,ha,\r\nannual_cost,,currency,2,,USD\r\ncount,,,,,\r\n`));
    assert.ok(csv.includes('"Carbon, ""net""",Carbon CO₂,number,,"t CO₂e, ""net""",'));
    assert.ok(csv.includes("\r\n'=balance,'=Net balance,currency,,,EUR\r\n''=balance,''=Net balance,number,,'+margin,"));
    const numericFields = fields.filter(name => name !== "name");
    assert.deepEqual(parseFieldFormatCsv(csv, fields, numericFields), formats);
    assert.deepEqual(parseFieldFormatCsv(makeFieldFormatTemplate(fields, {}), fields, numericFields), {});
});

test("CSV import checks the exact fields and numeric display options before accepting the file", () => {
    assert.deepEqual(parseFieldFormatCsv("unit,field,currency,display_name,decimals,format\nha,area_ha,, Habitat area ,,\n,annual_cost,usd,,0,\n,count,,Site count,,\n,name,,Site name,,", FIELDS, NUMERIC_FIELDS), {
        area_ha: {displayName: "Habitat area", format: "number", unit: "ha"},
        annual_cost: {format: "currency", currency: "USD", decimals: 0},
        count: {displayName: "Site count"},
        name: {displayName: "Site name"},
    });
    for (const [input, message] of [
        ["field,display_name,format,decimals,unit,unit\narea_ha,,number,0,ha,", /template columns/],
        ["field,format,decimals,unit,currency\narea_ha,number,0,ha,", /template columns/],
        [`${HEADER}\nArea_ha,,number,1,ha,`, /Area_ha.*not a field/],
        [`${HEADER}\narea_ha,,,,,\narea_ha,,number,1,ha,`, /row 3.*appears more than once/],
        [`${HEADER}\nannual_cost,,currency,2,,$`, /three-letter currency code/],
        [`${HEADER}\nannual_cost,,number,2,,USD`, /Choose the "currency" format/],
        [`${HEADER}\ncount,,number,21,,`, /decimal places from 0 to 20/],
        [`${HEADER}\ncount,,number,0x2,,`, /whole number/],
        [`${HEADER}\narea_ha,,percent,1,,`, /Choose "number" or "currency"/],
        [`${HEADER}\narea_ha,,number,1,"line one\nline two",`, /one line/],
        [`${HEADER}\narea_ha,"line one\nline two",,,,`, /display name.*one line/],
        [`${HEADER}\narea_ha,${"a".repeat(161)},,,,`, /160 characters/],
        [`${HEADER}\nname,Site name,number,,,`, /not a numeric field/],
        [`${HEADER}\narea_ha,,number,1`, /expected 6 fields/],
        ["🪶".repeat(MAX_FIELD_FORMAT_CSV_BYTES / 2), /UTF-8 bytes/],
    ]) assert.throws(() => parseFieldFormatCsv(input, FIELDS, NUMERIC_FIELDS), message);
});
