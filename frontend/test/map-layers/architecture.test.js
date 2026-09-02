import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const MAP_LAYER_MODULES = [
    "controller.js",
    "layer-stack.js",
    "layer-stack-view.js",
    "leaflet-layer-set.js",
];

test("map-layer modules depend only on peers and Catalog identity", async () => {
    for (const moduleName of MAP_LAYER_MODULES) {
        const source = await readFile(
            new URL(`../../src/map-layers/${moduleName}`, import.meta.url),
            "utf8",
        );
        const relativeImports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
            .map((match) => match[1]);

        const externalImports = relativeImports.filter(
            (modulePath) => !modulePath.startsWith("./"),
        );
        assert.deepEqual(
            externalImports,
            moduleName === "layer-stack.js" || moduleName === "controller.js"
                ? ["../catalog-item-identity.js"]
                : [],
            `${moduleName} imports only peers and the Catalog identity contract`,
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
    assert.match(compositionSource, /onItemZoom: zoomRetainedMapLayer/);
    assert.match(compositionSource, /onItemInfo: inspectRetainedMapLayer/);
    assert.doesNotMatch(
        compositionSource,
        /zoomRetainedMapLayer[\s\S]{0,300}\.state\.item/
    );
});

test("map-layer presentation does not name its parent workspace layout", async () => {
    const viewSource = await readFile(
        new URL("../../src/map-layers/layer-stack-view.js", import.meta.url),
        "utf8",
    );

    assert.doesNotMatch(viewSource, /eomap-map-layers-body/);
});

test("composition has no approximate raster view or preflight edge", async () => {
    const compositionSource = await readFile(
        new URL("../../src/main.js", import.meta.url),
        "utf8",
    );
    const removedModules = [
        "detail-preview-controller.js",
        "detail-preview-image.js",
        "detail-preview-leaflet.js",
        "detail-preview-status.js",
        "detail-preview-viewport.js",
    ];

    for (const moduleName of removedModules) {
        await assert.rejects(
            readFile(
                new URL(`../../src/raster/${moduleName}`, import.meta.url),
                "utf8",
            ),
            (error) => error.code === "ENOENT",
        );
    }
    assert.doesNotMatch(compositionSource, /detail-preview|assessCatalogRaster/);
});
