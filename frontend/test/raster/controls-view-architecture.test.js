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

test("RasterControlsView remains a composition facade without direct DOM work", async () => {
    const source = await readFile(
        new URL("../../src/raster/controls-view.js", import.meta.url),
        "utf8"
    );

    for (const moduleName of Object.keys(FOCUSED_VIEW_IMPORTS)) {
        assert.match(source, new RegExp(`from ["']\\./${moduleName}["']`));
    }
    assert.doesNotMatch(source, /querySelector|addEventListener|removeEventListener/);
});
