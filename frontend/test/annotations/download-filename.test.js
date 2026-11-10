import test from "node:test";
import assert from "node:assert/strict";
import { createAnnotationDownloadFilename } from "../../src/annotations/download-filename.js";

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
