import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MARKUP = readFileSync(
    new URL("../index.html", import.meta.url),
    "utf8"
);

/**
 * Find one stable ID's byte position in the application markup.
 *
 * @param {string} identifier Stable DOM identifier.
 * @return {number} Zero-based byte position.
 * @throws {Error} If the identifier is absent.
 */
function requireMarkupPosition(identifier) {
    const position = MARKUP.indexOf(`id="${identifier}"`);
    if (position < 0) {
        throw new Error(`Required markup ID is missing: ${identifier}`);
    }
    return position;
}

/**
 * Count exact occurrences of one stable DOM ID.
 *
 * @param {string} identifier Stable DOM identifier.
 * @return {number} Number of exact ID attributes.
 */
function countMarkupId(identifier) {
    return MARKUP.match(new RegExp(`id="${identifier}"`, "g"))?.length ?? 0;
}

test("operational status region groups scanning and rendering diagnostics", () => {
    const region = requireMarkupPosition("eomap-operational-status-region");
    const catalogState = requireMarkupPosition("system-state");
    const renderingState = requireMarkupPosition("rendering-diagnostics");
    const panelContent = MARKUP.indexOf('<div class="panel-content">');

    assert.ok(region < catalogState);
    assert.ok(catalogState < renderingState);
    assert.ok(renderingState < panelContent);
    assert.match(
        MARKUP,
        /id="eomap-operational-status-region"[^>]*aria-label="Operational status"/s
    );
});

test("Catalog region retains discovery, inspection, and explicit map action", () => {
    const region = requireMarkupPosition("eomap-catalog-region");
    const results = requireMarkupPosition("catalog-results-pane");
    const inspector = requireMarkupPosition("catalog-item-inspector");
    const addAction = requireMarkupPosition("toggle-catalog-layer");
    const inspectorContent = requireMarkupPosition("catalog-inspector-content");

    assert.ok(region < results);
    assert.ok(results < inspector);
    assert.ok(inspector < addAction);
    assert.ok(addAction < inspectorContent);
    assert.match(MARKUP, />\s*Add to map layers\s*</);
});

test("map and raster regions retain their existing focused controls", () => {
    const mapRegion = requireMarkupPosition("eomap-map-layers-region");
    const layerStack = requireMarkupPosition("raster-layer-stack");
    const layerStatus = requireMarkupPosition("raster-layer-stack-status");
    const rasterRegion = requireMarkupPosition(
        "eomap-raster-interpretation-region"
    );
    const appearance = requireMarkupPosition("raster-style-controls");
    const sampling = requireMarkupPosition("raster-sample-window-range");
    const histogram = requireMarkupPosition("raster-histogram");

    assert.ok(mapRegion < layerStack);
    assert.ok(layerStack < layerStatus);
    assert.ok(layerStatus < rasterRegion);
    assert.ok(rasterRegion < appearance);
    assert.ok(appearance < sampling);
    assert.ok(sampling < histogram);
    assert.match(
        MARKUP,
        /id="eomap-map-layers-region"[^>]*aria-label="Map and layers"[^>]*aria-controls="map"/s
    );
    assert.match(
        MARKUP,
        /id="eomap-raster-interpretation-region"[^>]*aria-label="Raster interpretation"/s
    );
});

test("viewport overlays retain explicit non-reparenting region ownership", () => {
    assert.match(
        MARKUP,
        /id="map"[^>]*role="region"[^>]*data-eomap-region="map-layers"/s
    );
    assert.match(
        MARKUP,
        /id="temporary-aoi"[^>]*data-eomap-region="map-layers"/s
    );
    assert.match(
        MARKUP,
        /id="raster-pixel-probe"[^>]*data-eomap-region="raster-interpretation"/s
    );
});

test("semantic regions preserve one DOM instance of every owned control", () => {
    const uniqueIdentifiers = [
        "system-state",
        "rendering-diagnostics",
        "catalog-search",
        "catalog-results",
        "catalog-item-inspector",
        "toggle-catalog-layer",
        "temporary-aoi",
        "raster-layer-stack",
        "raster-style-controls",
        "raster-sample-window-range",
        "raster-histogram",
        "raster-pixel-probe",
    ];

    for (const identifier of uniqueIdentifiers) {
        assert.equal(countMarkupId(identifier), 1, identifier);
    }
    const allIdentifiers = [
        ...MARKUP.matchAll(/id="([^"]+)"/g),
    ].map((match) => match[1]);
    const duplicateIdentifiers = allIdentifiers.filter(
        (identifier, index) => allIdentifiers.indexOf(identifier) !== index
    );
    assert.deepEqual(duplicateIdentifiers, []);
});
