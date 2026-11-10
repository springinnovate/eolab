import test from "node:test";
import assert from "node:assert/strict";
import { createAnnotationDownloadFilename, normalizeAnnotationDownloadFilename } from "../../src/annotations/download-filename.js";

const LAYER_ID = "a1b2c3d4-e5f6-4789-8123-456789abcdef";
const EXPORTED_AT = new Date("2026-11-10T18:45:12.123Z");
const SUFFIX = "_a1b2c3d4e5f6_2026-11-10T184512.123Z.geojson";

test("polygon filenames retain the readable layer name, stable identity and UTC export time", () => {
    assert.equal(createAnnotationDownloadFilename({
        name: "Condition layer", layerId: LAYER_ID, exportedAt: EXPORTED_AT,
    }), `Condition-layer${SUFFIX}`);
    assert.equal(createAnnotationDownloadFilename({
        name: "Condition layer", layerId: LAYER_ID,
        exportedAt: new Date("2026-11-10T10:45:12.123-08:00"),
    }), `Condition-layer${SUFFIX}`, "timestamps identify the same instant regardless of local timezone");
});

test("a published map supplies context while the same shared layer retains its identity across maps", () => {
    const input = { name: "Condition layer", layerId: LAYER_ID, exportedAt: EXPORTED_AT };
    assert.equal(createAnnotationDownloadFilename({ ...input, mapSlug: "maui-restoration" }),
        `maui-restoration_Condition-layer${SUFFIX}`);
    assert.equal(createAnnotationDownloadFilename({ ...input, mapSlug: "oahu-restoration" }),
        `oahu-restoration_Condition-layer${SUFFIX}`);
    assert.equal(createAnnotationDownloadFilename({ ...input, mapSlug: null }),
        `Condition-layer${SUFFIX}`, "root-editor downloads have no invented map name");
});

test("different shared layers with the same name remain distinguishable at the same export time", () => {
    const input = { name: "Condition layer", mapSlug: "maui-restoration", exportedAt: EXPORTED_AT };
    const first = createAnnotationDownloadFilename({ ...input, layerId: LAYER_ID });
    const second = createAnnotationDownloadFilename({ ...input, layerId: "b2c3d4e5-f6a7-4789-8123-456789abcdef" });
    assert.notEqual(first, second);
    assert.match(second, /_b2c3d4e5f6a7_2026-11-10T184512\.123Z\.geojson$/);
});

test("successive downloads preserve millisecond precision without claiming a content revision", () => {
    const input = { name: "Condition layer", layerId: LAYER_ID };
    const first = createAnnotationDownloadFilename({ ...input, exportedAt: EXPORTED_AT });
    const second = createAnnotationDownloadFilename({ ...input, exportedAt: new Date("2026-11-10T18:45:12.124Z") });
    assert.notEqual(first, second);
    assert.equal(second, "Condition-layer_a1b2c3d4e5f6_2026-11-10T184512.124Z.geojson");
});

test("polygon filenames sanitize path characters and provide a readable fallback for empty names", () => {
    const input = { layerId: LAYER_ID, exportedAt: EXPORTED_AT };
    const unsafe = createAnnotationDownloadFilename({ ...input, name: '  Condition  <layer>:"/\\|?*\u0000.  ' });
    assert.doesNotMatch(unsafe, /[<>:"/\\|?*\x00-\x1f]/);
    assert.match(unsafe, /^Condition-/);
    assert.ok(unsafe.endsWith(SUFFIX));
    for (const name of ["", "   ", "...", "  ...  "]) {
        assert.equal(createAnnotationDownloadFilename({ ...input, name }), `annotations${SUFFIX}`);
    }
    for (const name of ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"]) {
        assert.equal(createAnnotationDownloadFilename({ ...input, name }), `${name}${SUFFIX}`,
            "identity and time suffixes keep reserved base names usable as filenames");
    }
    for (const name of ["CON.notes", "nul.txt", "LPT¹.data"]) {
        assert.equal(createAnnotationDownloadFilename({ ...input, name }), `_${name}${SUFFIX}`,
            "Windows device names followed by a dot need a safe prefix");
    }
});

test("long Unicode layer names keep map context and distinguishing suffixes within the filename byte budget", () => {
    const mapSlug = "a".repeat(80);
    const name = "珊瑚🌱".repeat(40);
    const filename = createAnnotationDownloadFilename({ name, layerId: LAYER_ID, mapSlug, exportedAt: EXPORTED_AT });
    assert.ok(filename.startsWith(`${mapSlug}_`));
    assert.ok(filename.endsWith(SUFFIX));
    assert.ok(new TextEncoder().encode(filename).byteLength <= 240);
    const retainedName = filename.slice(mapSlug.length + 1, -SUFFIX.length);
    assert.ok(retainedName.length > 0);
    assert.ok(name.startsWith(retainedName));
    assert.equal(retainedName.isWellFormed(), true, "shortening never splits a Unicode code point");
});

test("edited filenames keep user wording and receive exactly one GeoJSON extension", () => {
    assert.equal(normalizeAnnotationDownloadFilename("  Maui condition polygons  "), "Maui condition polygons.geojson");
    assert.equal(normalizeAnnotationDownloadFilename("Maui condition polygons.geojson"), "Maui condition polygons.geojson");
    assert.equal(normalizeAnnotationDownloadFilename("Maui condition polygons.GEOJSON"), "Maui condition polygons.geojson");
    assert.equal(normalizeAnnotationDownloadFilename("珊瑚 🌱 observations"), "珊瑚 🌱 observations.geojson");
    assert.equal(normalizeAnnotationDownloadFilename("Condition.v2"), "Condition.v2.geojson");
});

test("edited filenames reject empty names and unsafe paths with actionable errors", () => {
    for (const name of ["", "  ", ".", "...", ".geojson", "  .GEOJSON  ", "  .geojson", "... .geojson"]) {
        assert.throws(() => normalizeAnnotationDownloadFilename(name), /Enter a filename/);
    }
    for (const name of ["../areas", "folder/areas", "folder\\areas", 'condition:latest', 'condition"layer',
        "condition<layer>", "condition|layer", "condition?", "condition*", "condition\u0000layer", "condition\u007flayer"]) {
        assert.throws(() => normalizeAnnotationDownloadFilename(name), /Remove these characters/);
    }
});

test("edited filenames reject reserved Windows names without rejecting ordinary words", () => {
    for (const name of ["CON", "nul.geojson", "AUX.notes", "COM9", "LPT¹.data", "prn .notes"]) {
        assert.throws(() => normalizeAnnotationDownloadFilename(name), /reserved by Windows/);
    }
    assert.equal(normalizeAnnotationDownloadFilename("CON areas"), "CON areas.geojson");
    assert.equal(normalizeAnnotationDownloadFilename("_CON"), "_CON.geojson");
});

test("edited filenames are bounded by encoded length without truncating the chosen name", () => {
    assert.equal(normalizeAnnotationDownloadFilename("a".repeat(232)), `${"a".repeat(232)}.geojson`);
    assert.throws(() => normalizeAnnotationDownloadFilename("a".repeat(233)), /too long.*Shorten/);
    assert.equal(normalizeAnnotationDownloadFilename("🌱".repeat(58)), `${"🌱".repeat(58)}.geojson`);
    assert.throws(() => normalizeAnnotationDownloadFilename("🌱".repeat(59)), /too long.*Shorten/);
});

test("generated defaults remain valid when the user accepts them unchanged", () => {
    for (const mapSlug of [null, "maui-restoration", "a".repeat(80)]) {
        for (const name of ["Condition layer", "CON", "CON.notes", "珊瑚🌱".repeat(40), 'Unsafe <name>:"/\\|?*', "..."]) {
            const filename = createAnnotationDownloadFilename({ name, layerId: LAYER_ID, mapSlug, exportedAt: EXPORTED_AT });
            assert.equal(normalizeAnnotationDownloadFilename(filename), filename);
        }
    }
});
