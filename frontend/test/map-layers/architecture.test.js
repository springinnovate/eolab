import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAP_LAYER_MODULES = [
    "controller.js",
    "layer-stack.js",
    "layer-stack-view.js",
    "leaflet-layer-set.js",
];

test("map-layer modules depend only on their neutral package", async () => {
    for (const moduleName of MAP_LAYER_MODULES) {
        const source = await readFile(
            new URL(`../../src/map-layers/${moduleName}`, import.meta.url),
            "utf8",
        );
        const relativeImports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
            .map((match) => match[1]);

        assert.ok(
            relativeImports.every(
                (modulePath) => modulePath.startsWith("./"),
            ),
            `${moduleName} imports only its package peers`,
        );
    }
});

test("composition owns the controller and raster consumes it", async () => {
    const compositionSource = await readFile(
        new URL("../../src/main.js", import.meta.url),
        "utf8",
    );
    const rasterSource = await readFile(
        new URL("../../src/raster/raster-viewer.js", import.meta.url),
        "utf8",
    );

    assert.match(compositionSource, /new MapLayerController\(/);
    assert.match(compositionSource, /initializeRasterViewer[\s\S]+mapLayerController/);
    assert.doesNotMatch(rasterSource, /new MapLayerStack\(/);
    assert.doesNotMatch(rasterSource, /new LeafletLayerSet\(/);
});
