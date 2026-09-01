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
const COMPOSITION_SOURCE = readFileSync(
    new URL("../src/main.js", import.meta.url),
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
        depth += tagMatch[0].startsWith("</") ? -1 : 1;
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

test("one sidebar owns the workspace disclosures and compact status", () => {
    const panel = requireElementRange("control-panel");
    const operationalStatus = requireElementRange(
        "eomap-operational-status-region"
    );
    const catalogState = requireMarkupPosition("system-state");
    const renderingState = requireMarkupPosition("rendering-diagnostics");

    assert.ok(panel.start < operationalStatus.start);
    assert.ok(operationalStatus.start < catalogState);
    assert.ok(catalogState < renderingState);
    assert.ok(renderingState < operationalStatus.end);
    assert.match(
        panel.source,
        /class="panel-content workspace-disclosures"[^>]*id="eomap-tools-workbench"[^>]*aria-label="EOMap workspaces"/s
    );
    assert.doesNotMatch(panel.source, /role="tab(?:list|panel)?"/);
    assert.match(
        panel.source,
        /id="toggle-operational-status"[^>]*aria-label="Show status details"[^>]*aria-controls="eomap-operational-status-body"[^>]*aria-expanded="false"[^>]*>\s*Status/s
    );
    assert.match(
        panel.source,
        /id="eomap-operational-status-body"[^>]*aria-hidden="true"[^>]*hidden/s
    );
});

test("compact header owns branding and actions while alerts stay outside hidden details", () => {
    const header = requireElementRange("app-header");
    const status = requireElementRange("eomap-operational-status-region");
    const body = requireElementRange("eomap-operational-status-body");
    for (const id of ["app-title", "app-subtitle", "toggle-operational-status", "collapse-panel"]) {
        assert.match(header.source, new RegExp(`id="${id}"`));
    }
    assert.match(header.source, /class="panel-identity"/);
    assert.match(header.source, /class="panel-header-actions"/);
    assert.doesNotMatch(MARKUP, /Earth observation workspace|operational-status-heading/);
    assert.ok(header.end < status.start);
    for (const id of ["catalog-state-announcement", "rendering-state-announcement"]) {
        const announcement = requireElementRange(id);
        assert.ok(status.start < announcement.start && announcement.end < body.start);
        assert.match(announcement.source, /role="status"[^>]*aria-live="polite"/s);
        assert.doesNotMatch(announcement.source, /aria-hidden|\shidden(?:\s|>)/);
    }
    assert.match(STYLESHEET, /\.panel-header\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s);
    assert.match(STYLESHEET, /\.panel-identity\s*\{[^}]*min-width:\s*0[^}]*flex-wrap:\s*wrap/s);
    assert.match(STYLESHEET, /\.panel-header-actions\s*\{[^}]*display:\s*flex[^}]*flex-shrink:\s*0/s);
    assert.doesNotMatch(STYLESHEET, /\.panel-header \.subtitle\s*\{[^}]*display:\s*none/s);
    assert.match(STYLESHEET, /\.operational-status-notice:not\(\.visually-hidden\)/);
});

test("Catalog, Map layers, and Sampling are independent sibling disclosures", () => {
    const panel = requireElementRange("control-panel");
    const catalogRegion = requireElementRange("eomap-catalog-region");
    const renderingRegion = requireElementRange("eomap-map-layers-region");
    const analysisRegion = requireElementRange(
        "eomap-raster-interpretation-region"
    );
    const disclosures = [
        ["toggle-catalog-workspace", "eomap-catalog-region", "true"],
        ["toggle-map-layers", "eomap-map-layers-region", "false"],
        [
            "toggle-raster-interpretation",
            "eomap-raster-interpretation-region",
            "false",
        ],
    ];

    for (const [toggle, region, expanded] of disclosures) {
        assert.match(
            panel.source,
            new RegExp(
                `class="workspace-disclosure"[^>]*id="${toggle}"[^>]*aria-controls="${region}"[^>]*aria-expanded="${expanded}"`,
                "s"
            )
        );
    }
    const catalogToggle = requireMarkupPosition("toggle-catalog-workspace");
    const renderingToggle = requireMarkupPosition("toggle-map-layers");
    const analysisToggle = requireMarkupPosition(
        "toggle-raster-interpretation"
    );
    assert.ok(catalogToggle < catalogRegion.start);
    assert.ok(catalogRegion.end < renderingToggle);
    assert.ok(renderingToggle < renderingRegion.start);
    assert.ok(renderingRegion.end < analysisToggle);
    assert.ok(analysisToggle < analysisRegion.start);
    for (const [region, toggle] of [
        [catalogRegion.source, "toggle-catalog-workspace"],
        [renderingRegion.source, "toggle-map-layers"],
        [analysisRegion.source, "toggle-raster-interpretation"],
    ]) {
        assert.match(region, /role="region"/);
        assert.match(region, new RegExp(`aria-labelledby="${toggle}"`));
    }
    assert.match(
        catalogRegion.source,
        /id="eomap-catalog-region"[^>]*role="region"[^>]*aria-labelledby="toggle-catalog-workspace"[^>]*>/s
    );
    assert.doesNotMatch(
        catalogRegion.source.match(/<section\b[^>]*>/)?.[0] ?? "",
        /aria-hidden="true"|hidden/
    );
    assert.match(renderingRegion.source, /aria-hidden="true"/);
    assert.match(renderingRegion.source, /hidden/);
    assert.match(analysisRegion.source, /aria-hidden="true"/);
    assert.match(analysisRegion.source, /hidden/);
    assert.match(requireElementRange("toggle-raster-interpretation").source, />\s*Sampling\s*</);
    assert.match(
        MARKUP,
        /id="collapse-panel"[^>]*aria-controls="control-panel"[^>]*aria-expanded="true"/s
    );
    assert.match(
        MARKUP,
        /id="open-panel"[^>]*aria-controls="control-panel"[^>]*aria-expanded="false"[^>]*hidden/s
    );
    assert.doesNotMatch(MARKUP, /id="show-temporary-aoi-workspace"/);
    assert.doesNotMatch(MARKUP, /class="map-workspace-dock"/);
    assert.doesNotMatch(MARKUP, /class="workspace-dock"/);
    assert.doesNotMatch(MARKUP, /id="raster-histogram-connector/);
});

test("Catalog owns discovery, inspection, and its explicit layer action only", () => {
    const catalogRegion = requireElementRange("eomap-catalog-region");
    const catalogInspector = requireElementRange("catalog-item-inspector");
    const catalogActions = requireElementRange("catalog-map-actions");

    assert.match(catalogRegion.source, /id="catalog-results-pane"/);
    assert.match(catalogRegion.source, /id="catalog-search"/);
    assert.match(catalogRegion.source, /id="catalog-item-inspector"/);
    assert.match(catalogInspector.source, /id="toggle-catalog-layer"/);
    assert.match(catalogInspector.source, />\s*Add to map\s*</);
    assert.match(catalogActions.source, /id="catalog-map-action-status"/);
    assert.match(
        catalogActions.source,
        /id="toggle-catalog-layer"[\s\S]*aria-describedby="catalog-map-action-status"/
    );
    assert.match(catalogInspector.source, /id="catalog-inspector-content"/);
    for (const foreignControl of [
        "catalog-layer-status",
        "map-layer-rendering-announcement",
        "raster-layer-stack",
        "raster-detail-preview-controls",
        "raster-style-controls",
        "raster-histogram",
        "temporary-aoi",
    ]) {
        assert.doesNotMatch(
            catalogInspector.source,
            new RegExp(`id="${foreignControl}"`)
        );
    }
});

test("Map layers owns compact rows; one floating editor owns all styling", () => {
    const rendering = requireElementRange("eomap-map-layers-region");
    const editor = requireElementRange("layer-style-editor");
    const panel = requireElementRange("control-panel");
    assert.ok(editor.start > panel.end, "Style editor must be outside sidebar overflow");
    const inspection = requireElementRange("map-inspection");
    assert.ok(editor.start > inspection.start && editor.end < inspection.end);
    assert.match(inspection.source, /popover="manual"/);
    assert.match(editor.source, /role="dialog"/);
    assert.match(editor.source, /aria-modal="false"/);
    for (const id of [
        "layer-style-opacity", "raster-appearance-controls", "raster-percentile-controls",
        "raster-bivariate-panel", "raster-bivariate-palette", "raster-bivariate-legend",
    ]) {
        assert.match(editor.source, new RegExp(`id="${id}"`));
        assert.doesNotMatch(rendering.source, new RegExp(`id="${id}"`));
    }
    assert.match(rendering.source, /id="raster-layer-stack"/);
    assert.match(rendering.source, /id="raster-detail-preview-controls"/);
    assert.doesNotMatch(MARKUP, /id="open-histogram-map-layers"/);
    assert.match(STYLESHEET, /#map-inspection\s*\{[^}]*position:\s*fixed/s);
    assert.match(STYLESHEET, /\.map-inspection-panels\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/s);
    assert.match(STYLESHEET, /@container map-inspection \(min-width: 680px\)/);
    assert.match(STYLESHEET, /max-height:\s*52dvh/);
    assert.match(STYLESHEET, /#map-inspection\s*\{[^}]*pointer-events:\s*none/s);
    assert.match(STYLESHEET, /#map-histogram-panel,\s*#layer-style-editor,\s*#vector-feature-inspector\s*\{[^}]*pointer-events:\s*auto/s);
    assert.match(STYLESHEET, /@container map-inspection[^}]*grid-template-columns:\s*repeat\(2,[^}]*pointer-events:\s*none/s);
});

test("Map layers has one heading and collapse control with no nested list widget", () => {
    const rendering = requireElementRange("eomap-map-layers-region");
    const stack = requireElementRange("raster-layer-stack");
    assert.doesNotMatch(rendering.source, /<h[1-6]\b|workspace-region-heading/);
    assert.match(rendering.source, /aria-labelledby="toggle-map-layers"/);
    assert.match(rendering.source, /No map layers yet\. Add an item from Catalog\./);
    assert.match(stack.source, /id="raster-layer-list" aria-label="Map layers"/);
    assert.match(stack.source, /id="raster-layer-stack-status"[^>]*role="status"/s);
    assert.match(stack.source, /id="raster-layer-stack-limit"/);
    assert.doesNotMatch(stack.source, /aria-expanded|aria-controls/);
    for (const obsolete of [
        "eomap-map-layers-heading", "open-map-layer-histograms",
        "raster-layer-stack-heading", "map-layer-widget", "raster-layer-stack-body",
        "raster-layer-widget-count",
    ]) {
        assert.doesNotMatch(MARKUP, new RegExp(obsolete));
        assert.doesNotMatch(STYLESHEET, new RegExp(obsolete));
    }
    assert.doesNotMatch(MARKUP, /Layers on this map|Hide list/);
});


test("inspector visualization and previews can reveal Map layers through composition", () => {
    assert.match(
        COMPOSITION_SOURCE,
        /setCatalogMapActionFeedback\(item, successStatus\);\s*if \(revealMapLayers && catalogItemsMatch\(catalogState.selectedItem, item\)\) \{\s*onRenderingWorkspaceRequested\(\);/
    );
    assert.match(
        COMPOSITION_SOURCE,
        /preview === null[\s\S]*onRenderingWorkspaceRequested\(\);[\s\S]*catch \(previewError\)/
    );
    assert.match(
        COMPOSITION_SOURCE,
        /\(\) => layoutController\.showWorkspace\("map-layers"\)/
    );
    assert.match(
        COMPOSITION_SOURCE,
        /onHistogramRequested: \(\) => mapInspection\.showHistogram\(\)/
    );
    assert.doesNotMatch(COMPOSITION_SOURCE, /layoutController\.showWorkspace\("histogram"\)/);
    assert.match(COMPOSITION_SOURCE, /new MapInspectionController\(\)/);
    assert.doesNotMatch(COMPOSITION_SOURCE, /stopSampleWindowSelection|onHistogramClose/);
});

test("Sampling keeps area controls and AOI; map exploration owns histogram results", () => {
    const analysisRegion = requireElementRange(
        "eomap-raster-interpretation-region"
    );
    const composite = requireElementRange("raster-style-controls");
    const sampling = requireElementRange("raster-sampling-area-controls");
    const histogramList = requireElementRange("raster-histogram-list");
    const histogram = requireElementRange("raster-histogram");
    const pairedHistogram = requireElementRange(
        "raster-bivariate-statistics"
    );
    const temporaryAoi = requireElementRange("temporary-aoi");
    const panel = requireElementRange("control-panel");
    const exploration = requireElementRange("map-histogram-panel");
    assert.ok(exploration.start > panel.end);
    assert.match(exploration.source, /role="dialog" aria-modal="false"/);
    for (const id of ["raster-comparison-mode", "raster-histogram-list", "raster-histogram", "raster-bivariate-statistics"]) {
        assert.match(exploration.source, new RegExp(`id="${id}"`));
        assert.doesNotMatch(analysisRegion.source, new RegExp(`id="${id}"`));
    }
    assert.match(analysisRegion.source, /id="temporary-aoi"/);
    assert.match(analysisRegion.source, /id="raster-sampling-area-controls"/);

    assert.match(exploration.source, /1D – visible rasters/);
    assert.match(exploration.source, /2D – compare rasters/);
    assert.match(exploration.source, /No visible raster layers/);
    assert.match(composite.source, /<legend>Sample area<\/legend>/);
    assert.match(composite.source, /id="raster-active-controls"/);
    assert.match(composite.source, /id="raster-sampling-area-controls"/);
    assert.match(
        sampling.source,
        /geographic area used by every map-layer histogram/
    );
    for (const action of [
        "clear-raster-sample-window",
        "use-temporary-aoi-for-raster",
    ]) {
        assert.match(sampling.source, new RegExp(`id="${action}"`));
    }
    assert.match(histogramList.source, /aria-label="Raster histograms"/);
    assert.doesNotMatch(analysisRegion.source, /retained/i);
    assert.match(histogram.source, /<h3 id="raster-histogram-heading" class="visually-hidden">Histogram<\/h3>/);
    assert.match(histogram.source, /id="raster-histogram-detail-layer"/);
    assert.match(histogram.source, /id="raster-histogram-status"/);
    assert.match(histogram.source, /id="raster-histogram-chart"/);
    assert.match(
        pairedHistogram.source,
        /<h3 id="raster-bivariate-statistics-heading">Paired raster distribution<\/h3>/
    );
    assert.match(pairedHistogram.source, /id="raster-bivariate-histogram"/);
    assert.match(
        pairedHistogram.source,
        /data-eomap-region="raster-interpretation"/
    );
    assert.doesNotMatch(MARKUP, /pixel-probe-guidance|Pixel values/);
    assert.doesNotMatch(STYLESHEET, /pixel-probe-guidance/);
    assert.match(MARKUP, /id="raster-pixel-probe-reading"/);
    assert.match(temporaryAoi.source, /data-eomap-region="raster-interpretation"/);
    assert.match(temporaryAoi.source, /aria-labelledby="temporary-aoi-heading"/);
    for (const renderingControl of [
        "raster-layer-stack",
        "raster-appearance-controls",
        "raster-percentile-controls",
        "raster-detail-preview-controls",
    ]) {
        assert.doesNotMatch(
            analysisRegion.source,
            new RegExp(`id="${renderingControl}"`)
        );
    }
});

test("map histograms put plots before captions and mode without a visible title strip", () => {
    assert.match(requireElementRange("map-histogram-heading").source,
        /class="visually-hidden">Histogram/);
    assert.match(requireElementRange("close-map-histogram").source,
        /aria-label="Close histogram">×/);
    const mode = requireElementRange("raster-bivariate-controls");
    assert.match(mode.source, /class="visually-hidden">Histogram mode/);
    assert.match(mode.source, /aria-describedby="raster-bivariate-status"/);
    for (const id of ["raster-histogram-list", "raster-histogram", "raster-bivariate-statistics"]) {
        assert.ok(requireElementRange(id).end < mode.start, `${id} precedes mode controls`);
    }
    assert.ok(requireMarkupPosition("raster-histogram-chart") < requireMarkupPosition("raster-histogram-scope"));
    assert.ok(requireMarkupPosition("raster-bivariate-histogram") < requireMarkupPosition("map-histogram-scope"));
    assert.ok(requireMarkupPosition("raster-bivariate-histogram") < requireMarkupPosition("raster-bivariate-statistics-status"));
    assert.match(STYLESHEET, /--map-inspection-height:\s*calc\(100dvh - var\(--map-inspection-top\) - 16px\)/);
    assert.match(STYLESHEET, /#map-inspection\s*\{[^}]*overflow:\s*visible/s);
    assert.match(STYLESHEET, /#map-inspection:has\(#map-histogram-panel:not\(\[hidden\]\)\)\s*\{[^}]*--map-inspection-top:\s*16px/s);
    assert.match(STYLESHEET, /@container map-inspection[^}]*max-height:\s*none[^}]*overflow:\s*visible/s);
    assert.match(STYLESHEET, /\.map-histogram-toolbar\s*\{[^}]*height:\s*0/s);
    assert.match(STYLESHEET, /#map-histogram-panel \.raster-bivariate-statistics,\s*#map-histogram-panel \.raster-histogram\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
    assert.match(STYLESHEET, /#map-histogram-panel \.raster-histogram-heading\s*\{[^}]*padding-right:\s*36px/s);
    assert.match(STYLESHEET, /#explore-map-center\[hidden\],[^{]*\{\s*display:\s*none/s);
    assert.match(MARKUP, /id="explore-map-center"[^>]*>Explore map center<\/button>/);
    assert.doesNotMatch(MARKUP, /Inspect features|Select map window|Sample map center/);
});

test("sidebar panels own deliberate, independent scrolling", () => {
    assert.match(
        STYLESHEET,
        /\.control-panel\s*\{[^}]*width:\s*var\(--active-workspace-width\)[^}]*grid-template-columns:\s*minmax\(0, 1fr\)[^}]*overflow:\s*hidden/s
    );
    assert.match(
        STYLESHEET,
        /\.panel-content\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:[^}]*var\(--workspace-column-rail-width\)[^}]*var\(--workspace-catalog-track\)[^}]*var\(--workspace-map-layers-track\)[^}]*var\(--workspace-histogram-track\)[^}]*overflow:\s*hidden/s
    );
    assert.match(
        STYLESHEET,
        /\.workspace-disclosure\s*\{[^}]*width:\s*var\(--workspace-column-rail-width\)[^}]*writing-mode:\s*vertical-rl/s
    );
    assert.match(
        STYLESHEET,
        /\.workspace-disclosure\[aria-expanded="true"\]\s*\{[^}]*width:\s*100%[^}]*grid-row:\s*1[^}]*box-shadow:\s*inset 0 3px 0 var\(--brand\)[^}]*writing-mode:\s*horizontal-tb/s
    );
    assert.match(
        STYLESHEET,
        /\.catalog-panel,\s*\.map-layers-region,\s*\.raster-interpretation-region\s*\{[^}]*overflow:\s*hidden/s
    );
    assert.match(
        STYLESHEET,
        /\.map-layers-region,\s*\.raster-interpretation-region\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s
    );
    assert.match(
        STYLESHEET,
        /\.catalog-results-scroll\s*\{[^}]*overflow:\s*auto[^}]*overscroll-behavior:\s*contain/s
    );
    assert.match(
        STYLESHEET,
        /\.catalog-inspector-body\s*\{[^}]*overflow-y:\s*auto/s
    );
    assert.match(
        STYLESHEET,
        /\.catalog-panel\[hidden\],\s*\.map-layers-region\[hidden\],\s*\.raster-interpretation-region\[hidden\]\s*\{[^}]*display:\s*none/s
    );
});

test("CSS allocates wide space and intentional medium and narrow overlays", () => {
    assert.match(
        STYLESHEET,
        /#app\s*\{[^}]*--workspace-column-rail-width:\s*44px[^}]*--active-workspace-width:\s*clamp\([^}]*--workspace-maximum-width/s
    );
    for (const [className, allocation] of [
        ["catalog", "catalog"],
        ["map-layers", "map-layers"],
        ["histogram", "histogram"],
    ]) {
        assert.match(
            STYLESHEET,
            new RegExp(
                `#app\\.is-expanded-${className}-workspace\\s*\\{[^}]*--workspace-${allocation}-allocation:`,
                "s"
            )
        );
    }
    for (const [identifier, column] of [
        ["toggle-catalog-workspace", 1],
        ["eomap-catalog-region", 1],
        ["toggle-map-layers", 2],
        ["eomap-map-layers-region", 2],
        ["toggle-raster-interpretation", 3],
        ["eomap-raster-interpretation-region", 3],
    ]) {
        assert.match(
            STYLESHEET,
            new RegExp(`#${identifier}\\s*\\{[^}]*grid-column:\\s*${column}`, "s")
        );
    }
    assert.match(
        STYLESHEET,
        /#map\s*\{[^}]*inset:[^}]*var\(--active-workspace-width\)[^}]*transition:\s*left 220ms ease/s
    );
    assert.match(
        STYLESHEET,
        /#app\.is-control-panel-collapsed #map\s*\{[^}]*left:\s*var\(--workspace-edge\)/s
    );
    assert.match(
        STYLESHEET,
        /#app\.is-expanded-catalog-workspace:has\([\s\S]*?\.catalog-layout\.is-catalog-inspector-visible[\s\S]*?--workspace-catalog-allocation:\s*var\(--workspace-catalog-inspector-width\)/s
    );
    assert.match(
        STYLESHEET,
        /@container catalog-workspace \(max-width: 639px\)\s*\{[\s\S]*?\.catalog-layout\.is-catalog-inspector-visible \.catalog-browser\s*\{[^}]*display:\s*none/s
    );
    assert.match(
        STYLESHEET,
        /@media \(max-width: 1199px\)\s*\{[\s\S]*?#map\s*\{[^}]*inset:\s*0/s
    );
    assert.match(
        STYLESHEET,
        /@media \(max-width: 699px\)\s*\{[\s\S]*?\.control-panel\s*\{[^}]*inset:\s*auto 8px 8px[^}]*height:\s*min\(76dvh, 680px\)/s
    );
    assert.match(
        STYLESHEET,
        /@media \(max-width: 899px\)\s*\{[\s\S]*?\.panel-content\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[\s\S]*?\.workspace-disclosure\s*\{[^}]*width:\s*100%[^}]*writing-mode:\s*horizontal-tb/s
    );
    assert.match(
        STYLESHEET,
        /\.panel-opener\s*\{[^}]*top:\s*auto[^}]*bottom:\s*var\(--workspace-edge\)/s
    );
    assert.match(
        STYLESHEET,
        /@media \(max-width: 1199px\) and \(max-height: 480px\)\s*\{[\s\S]*?\.control-panel\s*\{[^}]*inset:\s*8px[^}]*height:\s*auto/s
    );
    assert.match(
        STYLESHEET,
        /#app:not\(\.is-control-panel-collapsed\) \.map-position\s*\{[^}]*display:\s*none/s
    );
    assert.doesNotMatch(STYLESHEET, /min-height:\s*720px/);
    assert.match(
        STYLESHEET,
        /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*transition-duration:\s*0\.01ms !important/s
    );
});

test("former map widgets are bounded sections inside their owning panel", () => {
    assert.match(
        STYLESHEET,
        /\.raster-layer-stack\s*\{[^}]*position:\s*static[^}]*width:\s*100%[^}]*max-height:\s*none[^}]*box-shadow:\s*none/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-appearance-controls\s*\{[^}]*position:\s*static[^}]*width:\s*100%[^}]*max-height:\s*none[^}]*box-shadow:\s*none/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-histogram\s*\{[^}]*position:\s*static[^}]*width:\s*100%[^}]*max-height:\s*none[^}]*box-shadow:\s*none/s
    );
    assert.match(
        STYLESHEET,
        /\.raster-histogram-list\s*\{[^}]*display:\s*grid[^}]*gap:\s*8px/s
    );
});

test("map overlays retain explicit non-reparenting region ownership", () => {
    assert.match(
        MARKUP,
        /id="map"[^>]*role="region"[^>]*data-eomap-region="map-layers"/s
    );
    assert.match(
        MARKUP,
        /id="temporary-aoi"[^>]*data-eomap-region="raster-interpretation"/s
    );
    assert.match(
        MARKUP,
        /id="raster-pixel-probe"[^>]*data-eomap-region="raster-interpretation"/s
    );
});

test("semantic regions preserve one DOM instance of every owned control", () => {
    const uniqueIdentifiers = [
        "control-panel",
        "system-state",
        "rendering-diagnostics",
        "toggle-operational-status",
        "eomap-operational-status-body",
        "toggle-catalog-workspace",
        "eomap-catalog-region",
        "catalog-search",
        "catalog-results",
        "catalog-item-inspector",
        "toggle-catalog-layer",
        "toggle-map-layers",
        "eomap-map-layers-region",
        "raster-layer-stack",
        "raster-appearance-controls",
        "raster-appearance-layer",
        "raster-percentile-controls",
        "raster-detail-preview-controls",
        "toggle-raster-interpretation",
        "eomap-raster-interpretation-region",
        "raster-style-controls",
        "raster-active-controls",
        "raster-sampling-area-controls",
        "raster-sample-window-range",
        "raster-histogram-list",
        "raster-histogram",
        "raster-histogram-detail-layer",
        "raster-histogram-scope",
        "analysis-aoi-disclosure",
        "toggle-analysis-aoi",
        "temporary-aoi",
        "raster-pixel-probe",
        "map-inspection",
        "map-histogram-panel",
        "map-histogram-scope",
        "explore-map-center",
        "close-map-histogram",
        "layer-style-editor",
    ];

    for (const identifier of uniqueIdentifiers) {
        assert.equal(countMarkupId(identifier), 1, identifier);
    }
    const allIdentifiers = [...MARKUP.matchAll(/id="([^"]+)"/g)].map(
        (match) => match[1]
    );
    const duplicateIdentifiers = allIdentifiers.filter(
        (identifier, index) => allIdentifiers.indexOf(identifier) !== index
    );
    assert.deepEqual(duplicateIdentifiers, []);
});
