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
        /id="eomap-operational-status-region"[^>]*aria-labelledby="eomap-operational-status-heading"/s
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

test("map rendering, layer widget, and raster controls retain focused ownership", () => {
    const mapRegion = requireElementRange("eomap-map-layers-region");
    const rasterRegion = requireElementRange(
        "eomap-raster-interpretation-region"
    );
    const layerWidget = requireElementRange("raster-layer-stack");
    const histogramWidget = requireElementRange("raster-histogram");
    const appearanceWidget = requireElementRange("raster-appearance-controls");

    assert.match(mapRegion.source, /id="raster-detail-preview-controls"/);
    assert.match(mapRegion.source, /id="catalog-layer-status"/);
    assert.doesNotMatch(mapRegion.source, /id="raster-layer-stack"/);
    assert.match(layerWidget.source, /id="raster-layer-stack-status"/);
    assert.match(
        MARKUP,
        /class="map-workspace-toolbar"[\s\S]*?id="toggle-map-layer-widget"/
    );
    assert.match(layerWidget.source, /data-eomap-region="map-layers"/);
    assert.match(rasterRegion.source, /id="raster-style-controls"/);
    assert.doesNotMatch(rasterRegion.source, /id="raster-histogram"/);
    assert.doesNotMatch(rasterRegion.source, /id="raster-appearance-controls"/);
    assert.match(histogramWidget.source, /id="raster-percentile-controls"/);
    assert.match(appearanceWidget.source, /id="raster-palette"/);
    assert.match(
        appearanceWidget.source,
        /data-eomap-region="raster-interpretation"/
    );
    assert.match(
        histogramWidget.source,
        /data-eomap-region="raster-interpretation"/
    );
    assert.match(
        MARKUP,
        /id="eomap-map-layers-region"[^>]*role="tabpanel"[^>]*aria-labelledby="toggle-map-layers eomap-map-layers-heading"[^>]*aria-controls="map"/s
    );
    assert.match(
        MARKUP,
        /id="eomap-raster-interpretation-region"[^>]*role="tabpanel"[^>]*aria-labelledby="toggle-raster-interpretation eomap-raster-interpretation-heading"[^>]*hidden/s
    );
});

test("layout exposes compact status, rail, and map-tools tab contracts", () => {
    assert.match(
        MARKUP,
        /id="toggle-operational-status"[^>]*aria-controls="eomap-operational-status-body"[^>]*aria-expanded="false"[^>]*>\s*Show status details/s
    );
    assert.match(
        MARKUP,
        /id="eomap-operational-status-body"[^>]*aria-hidden="true"[^>]*hidden/s
    );
    assert.match(
        MARKUP,
        /id="toggle-catalog-workspace"[^>]*aria-label="Hide Catalog workspace"[^>]*aria-controls="eomap-catalog-region"[^>]*aria-expanded="true"/s
    );
    assert.match(
        MARKUP,
        /id="eomap-tools-workbench"[^>]*aria-labelledby="map-tools-heading"/s
    );
    for (const [tab, panel] of [
        ["toggle-map-layers", "eomap-map-layers-region"],
        ["toggle-raster-interpretation", "eomap-raster-interpretation-region"],
        ["show-temporary-aoi-workspace", "temporary-aoi"],
    ]) {
        assert.match(
            MARKUP,
            new RegExp(
                'id="' + tab + '"[^>]*role="tab"[^>]*aria-controls="' + panel + '"',
                "s"
            )
        );
    }
    assert.match(
        MARKUP,
        /id="collapse-panel"[^>]*aria-controls="control-panel"[^>]*aria-expanded="true"/s
    );
    assert.match(
        MARKUP,
        /id="open-panel"[^>]*aria-controls="control-panel"[^>]*aria-expanded="false"[^>]*hidden/s
    );
    assert.match(
        MARKUP,
        /id="open-catalog-workspace"[^>]*aria-controls="eomap-catalog-region"[^>]*aria-expanded="true"/s
    );
    assert.match(
        MARKUP,
        /id="open-tools-workspace"[^>]*aria-controls="eomap-tools-workbench"[^>]*aria-expanded="true"/s
    );
});

test("raster controls retain groups while distribution is map-associated", () => {
    const composite = requireElementRange("raster-style-controls");
    const active = requireElementRange("raster-active-controls");
    const sampling = requireElementRange("raster-sampling-area-controls");
    const distribution = requireElementRange("raster-histogram");
    const appearance = requireElementRange("raster-appearance-controls");

    assert.ok(composite.start < active.start);
    assert.ok(active.end < sampling.start);
    assert.ok(sampling.end < composite.end);
    assert.ok(composite.end < appearance.start);
    assert.ok(appearance.end < distribution.start);
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
    assert.match(distribution.source, /id="raster-histogram-scope"/);
    assert.match(distribution.source, /id="close-raster-histogram-widget"/);
    assert.match(
        MARKUP,
        /id="open-raster-histogram-widget"[^>]*aria-controls="raster-histogram"[^>]*aria-expanded="false"[^>]*hidden/s
    );
    assert.match(
        MARKUP,
        /id="open-raster-appearance-widget"[^>]*aria-controls="raster-appearance-controls"[^>]*aria-expanded="false"[^>]*hidden/s
    );
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
        /\.catalog-panel\s*\{[^}]*container-name:\s*eomap-catalog[^}]*grid-column:\s*1[^}]*grid-row:\s*3[^}]*overflow:\s*hidden/s
    );
    assert.match(
        STYLESHEET,
        /\.panel-content\s*\{[^}]*display:\s*contents/s
    );
    assert.match(
        STYLESHEET,
        /\.map-layers-body,\s*\.raster-interpretation-body\s*\{[^}]*max-height:\s*none[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s
    );
    assert.match(
        STYLESHEET,
        /\.catalog-inspector-body\s*\{[^}]*overflow-y:\s*auto/s
    );
});

test("CSS owns deliberate wide, intermediate, narrow, and short reflow", () => {
    assert.match(
        STYLESHEET,
        /\.control-panel\s*\{[^}]*grid-template-columns:[^}]*var\(--catalog-workspace-width\)[^}]*var\(--tools-workspace-width\)[^}]*pointer-events:\s*none/s
    );
    assert.match(
        STYLESHEET,
        /@media \(max-width: 1279px\)\s*\{[^}]*#map,[^}]*inset:\s*0/s
    );
    assert.match(
        STYLESHEET,
        /@media \(max-width: 820px\)\s*\{[\s\S]*?\.control-panel\s*\{[^}]*height:\s*min\(72dvh, 680px\)[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s
    );
    assert.match(
        STYLESHEET,
        /@media \(max-width: 820px\)\s*\{[\s\S]*?#app\.is-active-catalog-workspace \.map-tools-navigation,[\s\S]*?#app\.is-active-tools-workspace \.catalog-panel\s*\{[^}]*display:\s*none/s
    );
    assert.match(
        STYLESHEET,
        /#app\.is-catalog-workspace #map\s*\{[^}]*left:\s*calc\([\s\S]*?var\(--catalog-workspace-width\)/s
    );
    assert.doesNotMatch(STYLESHEET, /min-height:\s*720px/);
    assert.match(
        STYLESHEET,
        /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition-duration:\s*0\.01ms !important/s
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
        /\.raster-appearance-body > \.secondary-button\s*\{[^}]*justify-self:\s*start/s
    );
});

test("map widgets stay bounded and visually link distribution to sampling", () => {
    assert.match(
        STYLESHEET,
        /\.map-workspace-dock\s*\{[^}]*position:\s*fixed[^}]*pointer-events:\s*none/s
    );
    assert.match(
        STYLESHEET,
        /\.map-workspace-toolbar\s*\{[^}]*display:\s*flex[^}]*overflow-x:\s*auto/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-layer-stack\s*\{[^}]*width:\s*min\(340px,[^}]*max-height:\s*min\(52dvh, 480px\)/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-histogram\s*\{[^}]*--histogram-link-color:\s*var\(--brand\)[^}]*position:\s*static[^}]*width:\s*min\(440px,[^}]*max-height:\s*min\(52dvh, 480px\)/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-histogram\[data-sampling-area="selectedArea"\]\s*\{[^}]*--histogram-link-color:\s*#2563eb/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-histogram\[data-sampling-area="temporaryAoi"\]\s*\{[^}]*--histogram-link-color:\s*#6d1b7b/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-histogram-connector\s*\{[^}]*position:\s*fixed[^}]*pointer-events:\s*none/s
    );
    assert.match(
        STYLESHEET,
        /#raster-histogram-connector-line\s*\{[^}]*stroke:\s*currentColor[^}]*stroke-dasharray:\s*7 4[^}]*stroke-width:\s*3px/s
    );
    assert.match(
        STYLESHEET,
        /#raster-histogram-connector-target\s*\{[^}]*stroke:\s*currentColor[^}]*stroke-dasharray:\s*6 5/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-sample-window-selection\s*\{[^}]*drop-shadow\(0 0 3px rgb\(37 99 235 \/ 62%\)\)/s
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
        "toggle-operational-status",
        "eomap-operational-status-body",
        "catalog-search",
        "catalog-results",
        "catalog-item-inspector",
        "toggle-catalog-layer",
        "temporary-aoi",
        "raster-layer-stack",
        "raster-layer-stack-body",
        "toggle-map-layer-widget",
        "raster-layer-widget-count",
        "toggle-map-layers",
        "eomap-map-layers-body",
        "raster-style-controls",
        "toggle-raster-interpretation",
        "eomap-raster-interpretation-body",
        "raster-active-controls",
        "raster-sampling-area-controls",
        "raster-sample-window-range",
        "raster-histogram",
        "open-raster-histogram-widget",
        "close-raster-histogram-widget",
        "raster-histogram-scope",
        "raster-histogram-connector",
        "raster-histogram-connector-line",
        "raster-histogram-connector-target",
        "raster-histogram-connector-arrow",
        "raster-appearance-controls",
        "open-raster-appearance-widget",
        "close-raster-appearance-widget",
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
