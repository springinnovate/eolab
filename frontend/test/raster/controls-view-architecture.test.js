import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const FOCUSED_VIEW_IMPORTS = {
    "appearance-controls-view.js": ["./required-control.js", "./style.js"],
    "sampling-area-controls-view.js": ["./required-control.js"],
    "histogram-controls-view.js": [
        "./histogram-view.js",
        "./required-control.js",
    ],
    "pixel-probe-view.js": ["./required-control.js"],
};

test("focused raster-control views depend only on DOM presentation providers", async () => {
    for (const [moduleName, expectedImports] of Object.entries(
        FOCUSED_VIEW_IMPORTS
    )) {
        const source = await readFile(
            new URL(`../../src/raster/${moduleName}`, import.meta.url),
            "utf8"
        );
        const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
            .map((match) => match[1])
            .sort();

        assert.deepEqual(
            imports,
            [...expectedImports].sort(),
            `${moduleName} imports only its lower-level presentation providers`
        );
    }
});

test("RasterControlsView owns only composite DOM while composing focused views", async () => {
    const source = await readFile(
        new URL("../../src/raster/controls-view.js", import.meta.url),
        "utf8"
    );

    for (const moduleName of Object.keys(FOCUSED_VIEW_IMPORTS)) {
        assert.match(source, new RegExp(`from ["']\\./${moduleName}["']`));
    }
    assert.match(
        source,
        /import \{ requireRasterControl \} from "\.\/required-control\.js"/
    );
    assert.match(source, /"#raster-style-controls"/);
    assert.match(source, /"#raster-active-layer-label"/);
    assert.doesNotMatch(source, /querySelector|addEventListener|removeEventListener/);
    assert.doesNotMatch(source, /"#raster-(palette|histogram|sample-window)/);
});

test("focused raster views validate only their semantic subgroup roots", async () => {
    const appearanceSource = await readFile(
        new URL(
            "../../src/raster/appearance-controls-view.js",
            import.meta.url
        ),
        "utf8"
    );
    const samplingSource = await readFile(
        new URL(
            "../../src/raster/sampling-area-controls-view.js",
            import.meta.url
        ),
        "utf8"
    );
    const histogramSource = await readFile(
        new URL(
            "../../src/raster/histogram-controls-view.js",
            import.meta.url
        ),
        "utf8"
    );

    assert.match(appearanceSource, /"#raster-appearance-controls"/);
    assert.doesNotMatch(appearanceSource, /"#raster-style-controls"/);
    assert.doesNotMatch(appearanceSource, /"#raster-active-layer-label"/);
    assert.match(samplingSource, /"#raster-sampling-area-controls"/);
    assert.match(histogramSource, /"#raster-histogram"/);
});
