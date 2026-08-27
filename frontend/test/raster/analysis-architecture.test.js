import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ANALYSIS_MODULES = [
    "analysis-api.js",
    "paired-statistics.js",
    "pixel-probe.js",
    "statistics-controller.js",
    "statistics.js",
];
const RENDERING_IMPORTS = [
    "../map-layers/",
    "./api.js",
    "./detail-preview",
    "./leaflet.js",
    "./wms.js",
];

test("raster analysis remains independent from rendering implementations", async () => {
    for (const moduleName of ANALYSIS_MODULES) {
        const source = await readFile(
            new URL(`../../src/raster/${moduleName}`, import.meta.url),
            "utf8"
        );
        const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
            .map((match) => match[1]);

        assert.equal(
            imports.find((modulePath) => RENDERING_IMPORTS.some(
                (prefix) => modulePath.startsWith(prefix)
            )),
            undefined,
            `${moduleName} does not import a raster-rendering implementation`
        );
    }
});
