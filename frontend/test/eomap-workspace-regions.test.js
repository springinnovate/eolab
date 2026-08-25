import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const MARKUP = readFileSync(
    new URL("../index.html", import.meta.url),
    "utf8"
);
const STYLESHEET = readFileSync(
    new URL("../src/style.css", import.meta.url),
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

/**
 * Find the complete source range for one non-void element with a stable ID.
 *
 * Matching tags are balanced so nested sections do not truncate a workspace.
 *
 * @param {string} identifier Stable DOM identifier.
 * @return {{start: number, end: number, source: string}} Complete element
 * range and source, including its opening and closing tags.
 * @throws {Error} If the element or its matching closing tag is absent.
 */
function requireElementRange(identifier) {
    const openingPattern = new RegExp(
        `<([a-z][\\w-]*)\\b[^>]*\\bid="${identifier}"[^>]*>`,
        "i"
    );
    const openingMatch = openingPattern.exec(MARKUP);
    if (openingMatch === null) {
        throw new Error(`Required markup element is missing: ${identifier}`);
    }
    const tagName = openingMatch[1];
    const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
    tagPattern.lastIndex = openingMatch.index;
    let depth = 0;
    for (const tagMatch of MARKUP.matchAll(tagPattern)) {
        const isClosingTag = tagMatch[0].startsWith("</");
        depth += isClosingTag ? -1 : 1;
        if (depth === 0) {
            const end = tagMatch.index + tagMatch[0].length;
            return {
                start: openingMatch.index,
                end,
                source: MARKUP.slice(openingMatch.index, end),
            };
        }
    }
    throw new Error(`Required markup element is not closed: ${identifier}`);
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

test("Catalog owns only discovery, inspection, and its explicit layer action", () => {
    const catalogRegion = requireElementRange("eomap-catalog-region");
    const catalogInspector = requireElementRange("catalog-item-inspector");

    assert.match(catalogRegion.source, /id="catalog-results-pane"/);
    assert.match(catalogRegion.source, /id="catalog-search"/);
    assert.match(catalogRegion.source, /id="catalog-item-inspector"/);
    assert.match(catalogInspector.source, /id="toggle-catalog-layer"/);
    assert.match(catalogInspector.source, />\s*Add to map layers\s*</);
    assert.match(catalogInspector.source, /id="catalog-inspector-content"/);
    assert.doesNotMatch(catalogInspector.source, /id="catalog-layer-status"/);
    assert.doesNotMatch(catalogInspector.source, /id="raster-layer-stack"/);
    assert.doesNotMatch(
        catalogInspector.source,
        /id="raster-detail-preview-controls"/
    );
    assert.doesNotMatch(
        catalogInspector.source,
        /id="raster-style-controls"/
    );
});

test("layout shell owns three physically separate sibling workspaces", () => {
    const catalogRegion = requireElementRange("eomap-catalog-region");
    const mapRegion = requireElementRange("eomap-map-layers-region");
    const rasterRegion = requireElementRange(
        "eomap-raster-interpretation-region"
    );

    assert.equal(MARKUP.slice(catalogRegion.end, mapRegion.start).trim(), "");
    assert.equal(MARKUP.slice(mapRegion.end, rasterRegion.start).trim(), "");
    assert.ok(catalogRegion.end < mapRegion.start);
    assert.ok(mapRegion.end < rasterRegion.start);
});

test("map and raster siblings retain their focused controls", () => {
    const mapRegion = requireElementRange("eomap-map-layers-region");
    const rasterRegion = requireElementRange(
        "eomap-raster-interpretation-region"
    );

    assert.match(mapRegion.source, /id="raster-detail-preview-controls"/);
    assert.match(mapRegion.source, /id="catalog-layer-status"/);
    assert.match(mapRegion.source, /id="raster-layer-stack"/);
    assert.match(mapRegion.source, /id="raster-layer-stack-status"/);
    assert.match(rasterRegion.source, /id="raster-style-controls"/);
    assert.match(
        MARKUP,
        /id="eomap-map-layers-region"[^>]*aria-label="Map and layers"[^>]*aria-controls="map"/s
    );
    assert.match(
        MARKUP,
        /id="eomap-raster-interpretation-region"[^>]*aria-label="Raster interpretation"/s
    );
});

test("raster interpretation groups active target, area, distribution, then appearance", () => {
    const composite = requireElementRange("raster-style-controls");
    const active = requireElementRange("raster-active-controls");
    const sampling = requireElementRange("raster-sampling-area-controls");
    const distribution = requireElementRange("raster-histogram");
    const appearance = requireElementRange("raster-appearance-controls");

    assert.ok(composite.start < active.start);
    assert.ok(active.end < sampling.start);
    assert.ok(sampling.end < distribution.start);
    assert.ok(distribution.end < appearance.start);
    assert.ok(appearance.end < composite.end);
    assert.match(active.source, /id="raster-active-layer-label"/);
    assert.match(
        active.source,
        /aria-describedby="raster-sample-window-status raster-histogram-status"/
    );
    assert.match(sampling.source, /id="clear-raster-sample-window"/);
    assert.match(sampling.source, /id="sample-raster-map-center"/);
    assert.match(sampling.source, /id="select-raster-sample-window"/);
    assert.match(sampling.source, /id="raster-sample-window-range"/);
    assert.match(sampling.source, /id="use-temporary-aoi-for-raster"/);
    assert.match(distribution.source, /id="raster-histogram-status"/);
    assert.match(distribution.source, /id="raster-percentile-controls"/);
    assert.match(appearance.source, /id="raster-palette"/);
    assert.match(appearance.source, /id="raster-minimum"/);
    assert.match(appearance.source, /id="raster-midpoint"/);
    assert.match(appearance.source, /id="raster-maximum"/);
    assert.match(appearance.source, /id="raster-legend"/);
    assert.match(appearance.source, /id="reset-raster-style"/);
    assert.match(
        sampling.source,
        /geographic area represented by the distribution/
    );
    assert.match(
        appearance.source,
        /numeric display thresholds.*independently of the geographic sampling area/s
    );
});

test("each sibling workspace receives an independent bounded scroll budget", () => {
    assert.match(
        STYLESHEET,
        /\.catalog-panel\s*\{[^}]*flex:\s*1 1 50%[^}]*overflow:\s*hidden/s
    );
    assert.match(
        STYLESHEET,
        /\.map-layers-region,\s*\.raster-interpretation-region\s*\{[^}]*max-height:\s*min\(40vh, 480px\)[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s
    );
    assert.match(
        STYLESHEET,
        /\.catalog-inspector-body\s*\{[^}]*overflow-y:\s*auto/s
    );
});

test("raster interpretation groups retain compact visual separation", () => {
    assert.match(
        STYLESHEET,
        /\.raster-control-group\s*\{[^}]*display:\s*grid[^}]*gap:\s*8px/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-control-group \+ \.raster-control-group\s*\{[^}]*border-top:\s*1px solid var\(--border-2\)[^}]*padding-top:\s*12px/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-appearance-controls > \.secondary-button\s*\{[^}]*justify-self:\s*start/s
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
        "raster-active-controls",
        "raster-sampling-area-controls",
        "raster-sample-window-range",
        "raster-histogram",
        "raster-appearance-controls",
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
