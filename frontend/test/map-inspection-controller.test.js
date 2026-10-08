import assert from "node:assert/strict";
import test from "node:test";
import { MapInspectionController } from "../src/map-inspection-controller.js";
import { FakeRasterControlDocument } from "../test-support/raster/fake-controls-document.js";

/**
 * Build a retained map surface with focus and lifecycle spies.
 * @param {(doc: FakeRasterControlDocument) => void} [configureDocument] Optional layout setup.
 * @return {Object} Controller and its document elements.
 */
function fixture(configureDocument = () => {}) {
    const doc = new FakeRasterControlDocument();
    const events = new EventTarget();
    doc.addEventListener = events.addEventListener.bind(events);
    doc.removeEventListener = events.removeEventListener.bind(events);
    doc.dispatchEvent = events.dispatchEvent.bind(events);
    const root = doc.querySelector("#map-inspection");
    doc.querySelector("#map-click-disclosure").open = true;
    const histogram = doc.querySelector("#map-histogram-panel");
    const style = doc.querySelector("#layer-style-editor");
    const feature = doc.querySelector("#vector-feature-inspector");
    const featureDetails = doc.querySelector("#vector-feature-inspector-details");
    const featureDetailsToggle = doc.querySelector(
        "#toggle-vector-inspector-details"
    );
    const vectorTimeSeries = doc.querySelector("#vector-time-series");
    const vectorFeatureProfile = doc.querySelector("#vector-feature-profile");
    doc.querySelector("#vector-filter-panel").hidden = true;
    doc.querySelector("#raster-clips-panel").hidden = true;
    doc.querySelector("#calculations-panel").hidden = true;
    doc.querySelector("#annotations-panel").hidden = true;
    doc.querySelector("#raster-series").hidden = true;
    histogram.hidden = style.hidden = feature.hidden =
        vectorTimeSeries.hidden = vectorFeatureProfile.hidden = true;
    const close = doc.querySelector("#close-map-histogram");
    histogram.append(close);
    const calls = [];
    root.showPopover = () => calls.push("show");
    root.hidePopover = () => calls.push("hide");
    const toolActions = doc.querySelector("#workspace-tool-actions");
    const mapToolsButton = doc.querySelector("#map-tools-more-summary");
    const dockToolsButton = doc.querySelector("#map-inspection-more-summary");
    for (const [id, caption] of [
        ["map-click-histogram", "Distributions"],
        ["open-calculations-dock", "Statistics"],
        ["open-raster-series-dock", "Raster stack"],
    ]) {
        const button = doc.querySelector(`#${id}`);
        button.id = id;
        button.textContent = caption;
    }
    const toolActionsCalls = [];
    let actionsOpen = false;
    let invoker = mapToolsButton;
    /** Model native state events and focus return; dismissal itself is browser-tested.
     * @param {boolean} open Whether to open the popover. @return {void}
     */
    const changeActions = open => {
        actionsOpen = open;
        const event = new Event("beforetoggle");
        Object.defineProperty(event, "newState", { value: open ? "open" : "closed" });
        toolActions.dispatchEvent(event);
        toolActionsCalls.push(open ? "show" : "hide");
        if (!open && toolActions.contains(doc.activeElement)) invoker.focus();
        toolActions.dispatchEvent(new Event("toggle"));
    };
    for (const button of [mapToolsButton, dockToolsButton]) {
        button.click = () => { invoker = button; changeActions(!actionsOpen); };
        button.getBoundingClientRect = () => ({ top: 16, bottom: 56, left: 820, right: 920 });
    }
    toolActions.hidePopover = () => changeActions(false);
    toolActions.getBoundingClientRect = () => ({ width: 240, height: 240 });
    configureDocument(doc);
    const layouts = [];
    const controller = new MapInspectionController({
        documentContext: doc, onLayoutChange: layout => layouts.push(layout),
    });
    return {
        layouts,
        toolActions, mapToolsButton, dockToolsButton, toolActionsCalls,
        doc,
        histogram,
        style,
        feature,
        featureDetails,
        featureDetailsToggle,
        vectorTimeSeries,
        vectorFeatureProfile,
        panels: doc.querySelector("#map-inspection-panels"),
        dockTitle: doc.querySelector("#map-inspection-dock-title"),
        minimizeButton: doc.querySelector("#toggle-map-inspection-dock"),
        featureTab: doc.querySelector("#map-inspection-tab-feature"),
        timeSeriesTab: doc.querySelector("#map-inspection-tab-time-series"),
        featureProfileTab: doc.querySelector("#map-inspection-tab-feature-profile"),
        histogramTab: doc.querySelector("#map-click-histogram"),
        styleTab: doc.querySelector("#map-inspection-tab-style"),
        close,
        calls,
        controller,
        analysisToolsButton: doc.querySelector("#open-analysis-tools"),
        map: doc.querySelector("#map"),
    };
}

test("Tools has one visible home, dismisses on a home change and transfers invoker focus", () => {
    const h = fixture();
    const command = h.doc.createElement();
    h.toolActions.append(command);
    assert.equal(h.mapToolsButton.hidden, false);
    assert.equal(h.dockToolsButton.hidden, true);
    h.controller.showToolActions();
    h.controller.showToolActions();
    assert.deepEqual(h.toolActionsCalls, ["show"], "a restore request does not toggle an open popover closed");
    command.focus();
    h.controller.showStyle("Resistance");
    assert.deepEqual(h.toolActionsCalls, ["show", "hide"]);
    assert.equal(h.mapToolsButton.hidden, true);
    assert.equal(h.dockToolsButton.hidden, false);
    assert.equal(h.doc.activeElement, h.dockToolsButton);

    h.controller.showToolActions();
    command.focus();
    h.controller.hideStyle();
    assert.equal(h.mapToolsButton.hidden, false);
    assert.equal(h.dockToolsButton.hidden, true);
    assert.equal(h.doc.activeElement, h.mapToolsButton);
    assert.deepEqual(h.toolActionsCalls, ["show", "hide", "show", "hide"]);
    h.map.focus();
    h.controller.showStyle("Resistance");
    assert.equal(h.doc.activeElement, h.map, "passive presentation never steals focus");
    h.controller.showToolActions();
    h.controller.destroy();
    assert.equal(h.toolActionsCalls.at(-1), "hide");
    const count = h.toolActionsCalls.length;
    h.mapToolsButton.click();
    h.controller.destroy();
    assert.equal(h.toolActionsCalls.length, count + 1, "destroy detaches popover state listeners");
});

test("Tools placement flips above a low invoker and clamps both viewport edges", () => {
    const h = fixture(doc => {
        doc.defaultView.innerWidth = 320;
        doc.defaultView.innerHeight = 568;
        doc.querySelector("#map-tools-more-summary").getBoundingClientRect = () =>
            ({ top: 510, bottom: 550, right: 315 });
    });
    h.controller.showToolActions();
    assert.equal(h.toolActions.style.top, "264px");
    assert.equal(h.toolActions.style.left, "72px");
    h.toolActions.getBoundingClientRect = () => ({ width: 304, height: 552 });
    h.toolActions.dispatchEvent(new Event("toggle"));
    assert.equal(h.toolActions.style.top, "8px");
    assert.equal(h.toolActions.style.left, "8px");
    h.controller.destroy();
});

test("Tools dismisses enabled action rows before their owner runs, leaving disabled rows alone", () => {
    const h = fixture();
    const button = h.doc.createElement();
    button.closest = () => button;
    h.toolActions.append(button);
    h.controller.showToolActions();
    button.focus();
    const click = new Event("click");
    Object.defineProperty(click, "target", { value: button });
    button.disabled = true;
    h.toolActions.dispatchEvent(click);
    assert.equal(h.toolActionsCalls.at(-1), "show");
    button.disabled = false;
    h.toolActions.dispatchEvent(click);
    assert.equal(h.toolActionsCalls.at(-1), "hide");
    assert.equal(h.doc.activeElement, h.mapToolsButton);
    h.controller.destroy();
});

test("automatic presentation does not move focus and close retains results", () => {
    const h = fixture();
    const chart = h.doc.createElement();
    chart.textContent = "Sampled drought distribution";
    h.histogram.append(chart);
    h.map.focus();
    h.controller.showHistogram();
    h.controller.showHistogram();
    assert.deepEqual(h.calls, ["show"]);
    assert.equal(h.doc.activeElement, h.map);
    assert.equal(h.histogram.hidden, false);
    assert.equal(h.analysisToolsButton.hidden, true);

    h.close.dispatchEvent(new Event("click"));
    assert.equal(h.histogram.hidden, true);
    assert.equal(h.analysisToolsButton.hidden, false);
    assert.equal(h.doc.activeElement, h.map);
    assert.deepEqual(h.calls, ["show", "hide"]);

    h.controller.showHistogram();
    assert.equal(h.histogram.children.at(-1), chart);
    assert.equal(chart.textContent, "Sampled drought distribution");
    assert.deepEqual(h.calls, ["show", "hide", "show"]);
    h.controller.destroy();
});

test("task headers retain their own source and scope while clicks and peer contexts change", () => {
    const h = fixture();
    const context = h.doc.querySelector("#map-inspection-context");
    const histogramContext = { source: "6 raster layers", scope: "200 km map sample" };
    h.controller.setToolContext("histogram", histogramContext);
    histogramContext.scope = "Mutated caller state";
    assert.equal(h.controller.isOpen, false, "context does not open a tool");
    h.controller.showStyle("GEA South Africa");
    h.map.focus();
    h.controller.beginMapClick({ lat: 37.5, lng: 14 });
    h.controller.setClickResult("histogram", { state: "ready", message: "Ready" });
    assert.equal(h.dockTitle.textContent, "Appearance · Style");
    assert.equal(context.textContent, "GEA South Africa");
    assert.match(h.doc.querySelector("#map-click-context").textContent, /37\.5000, 14\.0000/);
    assert.equal(h.doc.activeElement, h.map);
    h.controller.updateLayerEditorName("style", "South Africa renamed");
    assert.equal(context.textContent, "South Africa renamed");
    h.controller.showFilter("WWF Biomes");
    assert.equal(h.dockTitle.textContent, "Data selection · Filter");
    assert.equal(context.textContent, "WWF Biomes");
    h.controller.setToolContext("calculations", { source: "GEA Italy", scope: "Whole raster" });
    h.controller.showCalculations();
    h.controller.setToolContext("histogram", { source: "6 raster layers", scope: "New map sample" });
    assert.equal(h.dockTitle.textContent, "Raster analysis · Statistics");
    assert.equal(context.textContent, "GEA Italy · Whole raster");
    h.controller.setToolContext("raster-clips", { source: "GEA Chile", scope: "Captured box" });
    h.controller.showRasterClips();
    h.controller.beginMapClick({ lat: 40, lng: 20 });
    assert.equal(h.dockTitle.textContent, "Export · Raster clips");
    assert.equal(context.textContent, "GEA Chile · Captured box");
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.dockTitle.textContent, "Export · Raster clips");
    assert.equal(context.textContent, "GEA Chile · Captured box");
    h.controller.showHistogram();
    assert.equal(h.dockTitle.textContent, "Raster analysis · Distributions");
    assert.equal(context.textContent, "6 raster layers · New map sample");
    h.controller.showFeatureInspector();
    assert.match(context.textContent, /Visible vector layers · Point · 40\.0000, 20\.0000/);
    h.controller.destroy();
    assert.equal(h.doc.querySelector("#open-calculations").hidden, false);
});

test("raster destinations retain their buttons and focus through opening, closing and minimization", () => {
    const h = fixture();
    const opener = h.doc.querySelector("#open-calculations-dock");
    const context = h.doc.querySelector("#map-inspection-context");
    h.controller.setToolContext("calculations", { source: "Resistance", scope: "Whole raster" });
    h.controller.showStyle("Countries");
    for (const id of ["map-click-histogram", "open-calculations-dock", "open-raster-series-dock"]) {
        assert.equal(h.doc.querySelector(`#${id}`).hidden, false);
        assert.equal(h.doc.querySelector(`#${id}`).getAttribute("aria-pressed"), "false");
    }

    opener.focus();
    h.controller.showCalculations();
    assert.equal(opener.hidden, false);
    assert.equal(opener.getAttribute("aria-pressed"), "true");
    assert.equal(h.doc.activeElement, opener, "opening never replaces the focused destination");
    assert.equal(h.doc.querySelector("#calculations-panel").getAttribute("aria-labelledby"), opener.id);
    assert.equal(context.textContent, "Resistance · Whole raster");
    const arrow = new Event("keydown", { cancelable: true });
    Object.defineProperty(arrow, "key", { value: "ArrowRight" });
    opener.dispatchEvent(arrow);
    assert.equal(arrow.defaultPrevented, false, "raster destinations use native button navigation");
    assert.equal(h.controller.activeTool, "calculations");

    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.panels.hidden, true);
    assert.equal(opener.hidden, false);
    assert.equal(opener.getAttribute("aria-pressed"), "false");
    opener.focus();
    h.controller.showCalculations();
    assert.equal(h.panels.hidden, false);
    assert.equal(opener.getAttribute("aria-pressed"), "true");
    assert.equal(h.doc.activeElement, opener);
    assert.equal(context.textContent, "Resistance · Whole raster");
    h.map.focus();
    h.controller.showCalculations();
    assert.equal(h.doc.activeElement, h.map, "background presentation never steals focus");

    h.controller.hideCalculations();
    assert.equal(h.controller.activeTool, "style");
    assert.equal(opener.hidden, false);
    assert.equal(opener.getAttribute("aria-pressed"), "false");
    h.controller.destroy();
});

test("context validates its presentation boundary and vector identities clear without moving focus", () => {
    const h = fixture();
    for (const invalid of [{ source: 3, scope: "" }, { source: "Layer" }, "Layer"]) {
        assert.throws(() => h.controller.setToolContext("calculations", invalid), TypeError);
    }
    assert.throws(() => h.controller.setToolContext("unknown", null), RangeError);
    h.controller.showVectorTimeSeries();
    h.map.focus();
    h.controller.setVectorTimeSeriesIdentity({ label: "Temperature", title: "Climate zones · Temperature" });
    assert.equal(h.doc.querySelector("#map-inspection-context").textContent,
        "Climate zones · Temperature · Across sampled vector features");
    assert.equal(h.doc.activeElement, h.map);
    h.controller.setVectorTimeSeriesIdentity(null);
    assert.equal(h.doc.querySelector("#map-inspection-context").hidden, true);
    h.controller.destroy();
});

test("point disclosure preserves choices and its feedback excludes area distributions", () => {
    const h = fixture();
    const disclosure = h.doc.querySelector("#map-click-disclosure");
    const label = h.doc.querySelector("#map-click-disclosure-label");
    h.controller.showStyle("GEA Italy");
    h.controller.beginMapClick({ lat: 37.5, lng: 14 });
    h.controller.setClickResult("histogram", { state: "loading", message: "Updating this area" });
    assert.equal(disclosure.hidden, true, "area results do not create a point-feature disclosure");
    h.controller.setClickResult("feature", { state: "loading", message: "Inspecting this point" });
    assert.equal(disclosure.hidden, false);
    assert.equal(disclosure.open, true, "point and raster navigation are both expanded by default");
    assert.match(label.textContent, /Updating/);
    h.controller.setClickResult("histogram", { state: "error", message: "No overlap" });
    assert.doesNotMatch(label.textContent, /unavailable/);
    assert.match(h.doc.querySelector("#map-click-histogram-status").textContent, /No overlap.*New results/);
    h.controller.setClickResult("feature", { state: "error", message: "Point inspection failed" });
    assert.equal(disclosure.open, true, "a result update preserves the user's disclosure choice");
    assert.match(label.textContent, /Some unavailable.*New results/);
    h.doc.querySelector("#map-click-feature").dispatchEvent(new Event("click"));
    assert.equal(disclosure.open, true);
    assert.doesNotMatch(label.textContent, /New results/);
    h.controller.showCalculations();
    assert.equal(disclosure.open, true, "switching tasks preserves expanded point navigation");
    h.controller.closeHistogram();
    assert.equal(disclosure.hidden, false, "closing an area tool retains independent point recovery");
    h.controller.destroy();
});

test("manual point collapse survives tool switches, new clicks and minimization", () => {
    const h = fixture();
    const disclosure = h.doc.querySelector("#map-click-disclosure");
    h.controller.showHistogram();
    h.controller.beginMapClick({ lat: 22, lng: 78 });
    h.controller.setClickResult("feature", { state: "ready", message: "3 features found" });
    assert.equal(disclosure.open, true);
    disclosure.open = false;
    h.map.focus();
    h.controller.showCalculations();
    h.controller.showRasterSeries();
    h.controller.showFeatureInspector();
    assert.equal(disclosure.open, false);
    h.controller.setClickResult("feature", { state: "error", message: "Point unavailable" });
    assert.equal(disclosure.open, false);
    h.controller.beginMapClick({ lat: 23, lng: 79 });
    h.controller.setClickResult("feature", { state: "loading", message: "Inspecting point" });
    assert.equal(disclosure.hidden, false);
    assert.equal(disclosure.open, false);
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(disclosure.hidden, true);
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(disclosure.hidden, false);
    assert.equal(disclosure.open, false);
    assert.equal(h.doc.activeElement, h.map, "updates never steal focus");
    disclosure.open = true;
    h.controller.showStyle("Countries");
    assert.equal(disclosure.open, true, "manual expansion also survives a tool switch");
    h.controller.destroy();
});

test("map-click summaries retain the chosen panel and expose unseen peer results", () => {
    const h = fixture();
    h.controller.showHistogram();
    h.map.focus();
    h.controller.beginMapClick({lat: 22, lng: 78});
    h.controller.showHistogram(null, {activate: false});
    h.controller.showFeatureInspector({activate: false});
    h.controller.setClickResult("histogram", {state: "loading", message: "Map box · Updating…"});
    h.controller.setClickResult("feature", {state: "ready", message: "3 features returned"});
    assert.equal(h.controller.activeTool, "histogram");
    assert.equal(h.doc.activeElement, h.map);
    assert.equal(h.doc.querySelector("#map-click-feature").getAttribute("data-unread"), "true");
    assert.equal(h.histogram.getAttribute("data-inspection-loading"), "true");
    h.doc.querySelector("#map-click-feature").dispatchEvent(new Event("click"));
    assert.equal(h.controller.activeTool, "feature");
    assert.equal(h.doc.querySelector("#map-click-feature").getAttribute("data-unread"), "false");
    h.controller.setClickResult("histogram", {state: "ready", message: "Map box · Ready"});
    assert.equal(h.controller.activeTool, "feature");
    assert.equal(h.histogramTab.getAttribute("data-unread"), "true");
    h.controller.beginMapClick({lat: 24, lng: 80});
    h.controller.showHistogram(null, {activate: false});
    h.controller.showFeatureInspector({activate: false});
    assert.equal(h.controller.activeTool, "feature");
    assert.equal(h.histogramTab.getAttribute("data-unread"), "false");
    assert.match(h.doc.querySelector("#map-inspection-context").textContent, /24\.0000, 80\.0000/);
    h.controller.destroy();
});

test("raster buttons stay stable beside point results and other retained tools", () => {
    const h = fixture();
    const tabs = h.doc.querySelector("#map-inspection-tabs");
    const raster = h.doc.querySelector("#map-click-histogram");
    const feature = h.doc.querySelector("#map-click-feature");
    h.controller.showHistogram();
    h.controller.showFeatureInspector({activate: false});
    assert.equal(h.dockTitle.textContent, "Raster analysis · Distributions");
    assert.equal(h.histogramTab.hidden, false);
    h.controller.beginMapClick({lat: 22, lng: 78});
    h.controller.setClickResult("histogram", {state: "ready", message: "Ready"});
    h.controller.setClickResult("feature", {state: "ready", message: "One feature"});
    assert.equal(h.histogramTab.hidden, false);
    assert.equal(h.featureTab.hidden, true);
    assert.equal(tabs.hidden, true);
    assert.equal(raster.getAttribute("aria-pressed"), "true");
    assert.equal(feature.getAttribute("aria-pressed"), "false");
    h.controller.showStyle("Countries");
    h.controller.showCalculations();
    raster.dispatchEvent(new Event("click"));
    assert.equal(tabs.hidden, false);
    assert.equal(h.styleTab.tabIndex, 0, "the remaining tab list has its own keyboard entry");
    h.styleTab.dispatchEvent(new Event("click"));
    assert.equal(raster.getAttribute("aria-pressed"), "false");
    feature.dispatchEvent(new Event("click"));
    assert.equal(feature.getAttribute("aria-pressed"), "true");
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(tabs.hidden, true);
    assert.equal(h.doc.querySelector("#map-click-summary").hidden, true);
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(feature.getAttribute("aria-pressed"), "true");
    h.controller.setClickResult("histogram", null);
    assert.equal(h.histogramTab.hidden, false, "retained histogram remains reachable without a click card");
    h.controller.destroy();
});

test("distributions remain reachable before a click and after empty or failed area results", () => {
    const h = fixture();
    const button = h.doc.querySelector("#map-click-histogram");
    h.controller.showStyle("Countries");
    h.controller.setToolContext("histogram", { source: "Visible rasters", scope: "Whole raster" });
    button.dispatchEvent(new Event("click"));
    assert.equal(h.controller.activeTool, "histogram");
    assert.equal(h.controller.hasClick, false, "opening a view does not fabricate a map click");
    assert.equal(h.doc.querySelector("#map-click-disclosure").hidden, true);
    for (const state of ["empty", "error", "invalidated"]) {
        h.controller.showStyle("Countries");
        h.controller.setClickResult("histogram", { state, message: `${state} distribution` });
        assert.equal(button.disabled, false);
        button.dispatchEvent(new Event("click"));
        assert.equal(h.controller.activeTool, "histogram");
        assert.equal(h.doc.querySelector("#map-inspection-context").textContent, "Visible rasters · Whole raster");
        assert.equal(h.doc.querySelector("#map-click-disclosure").hidden, true);
    }
    h.controller.destroy();
});

test("empty and failed streams remain understandable without opening unavailable results", () => {
    const h = fixture();
    h.controller.beginMapClick({lat: 0, lng: 0});
    h.controller.setClickResult("histogram", null);
    h.controller.setClickResult("feature", {state: "empty", message: "No features at this click"});
    assert.equal(h.doc.querySelector("#map-click-histogram").hidden, false);
    assert.equal(h.doc.querySelector("#map-click-histogram").disabled, false);
    assert.equal(h.doc.querySelector("#map-click-feature").disabled, true);
    assert.equal(h.controller.activeTool, null);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.setClickResult("feature", {state: "error", message: "Inspection unavailable"});
    h.doc.querySelector("#map-click-feature").dispatchEvent(new Event("click"));
    assert.equal(h.controller.activeTool, "feature");
    h.controller.showCalculations();
    h.controller.beginMapClick({lat: 1, lng: 1});
    h.controller.showFeatureInspector({activate:false});
    h.controller.showHistogram(null, {activate:false});
    assert.equal(h.controller.activeTool, "calculations");
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.doc.querySelector("#map-click-summary").hidden, true);
    h.controller.destroy();
});

test("Raster clips is transient while retained analysis results remain available", () => {
    const h = fixture();
    h.controller.showHistogram();
    h.controller.showRasterClips();
    const downloads = h.doc.querySelector("#raster-clips-panel");
    assert.equal(downloads.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.histogram.hidden, false);
    h.histogramTab.dispatchEvent(new Event("click"));
    assert.equal(downloads.hidden, true);
    assert.equal(h.histogram.getAttribute("data-map-inspection-active"), "true");
    h.controller.showRasterClips();
    h.controller.hideRasterClips();
    assert.equal(downloads.hidden, true);
    assert.equal(h.histogram.getAttribute("data-map-inspection-active"), "true");
    h.controller.destroy();
});

test("active-tool subscriptions report expanded presentation, support detachment, and clear on destroy", () => {
    const h = fixture(); const changes = [];
    const unsubscribe = h.controller.subscribeActiveTool(tool => changes.push(tool));
    h.controller.showCalculations();
    h.controller.showHistogram(1, {activate:false});
    h.controller.showFeatureInspector({activate:false});
    assert.deepEqual(changes, [null, "calculations"]);
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.dockTitle.textContent, "Raster analysis · Statistics");
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.dockTitle.textContent, "Raster analysis · Statistics");
    h.histogramTab.dispatchEvent(new Event("click"));
    assert.deepEqual(changes, [null, "calculations", null, "calculations", "histogram"]);
    unsubscribe(); h.controller.showRasterClips();
    assert.equal(changes.at(-1), "histogram");
    const final = []; h.controller.subscribeActiveTool(tool => final.push(tool));
    h.controller.destroy(); assert.deepEqual(final, ["raster-clips", null]);
});

test("layout reports follow dock transitions, not repeated result updates", () => {
    const h = fixture();
    assert.deepEqual(h.layouts, [{ open: false, expanded: false, wide: false, compactHeight: 0 }]);
    h.controller.beginMapClick({ lat: 0, lng: 0 });
    h.controller.setClickResult("feature", { state: "empty", message: "No features" });
    assert.deepEqual(h.layouts.at(-1), { open: true, expanded: false, wide: false, compactHeight: 48 });
    h.controller.showHistogram();
    assert.deepEqual(h.layouts.at(-1), { open: true, expanded: true, wide: false, compactHeight: 0 });
    const count = h.layouts.length;
    for (let i = 0; i < 25; i++) {
        h.controller.showHistogram(i, { activate: false });
        h.controller.setClickResult("histogram", { state: "loading", message: `Read ${i}` });
    }
    assert.equal(h.layouts.length, count, "result content does not change shell layout");
    h.controller.showVectorTimeSeries();
    assert.deepEqual(h.layouts.at(-1), { open: true, expanded: true, wide: true, compactHeight: 0 });
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.deepEqual(h.layouts.at(-1), { open: true, expanded: false, wide: true, compactHeight: 48 });
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.deepEqual(h.layouts.at(-1), { open: true, expanded: true, wide: true, compactHeight: 0 });
    h.controller.hideVectorTimeSeries();
    assert.deepEqual(h.layouts.at(-1), { open: true, expanded: true, wide: false, compactHeight: 0 });
    h.controller.closeHistogram();
    assert.deepEqual(h.layouts.at(-1), { open: true, expanded: false, wide: false, compactHeight: 48 });
    h.controller.destroy();
    assert.deepEqual(h.layouts.at(-1), { open: false, expanded: false, wide: false, compactHeight: 0 });
});

test("compact geometry follows dock reflow without losing tools or reporting unchanged sizes", () => {
    let notifyResize;
    const observed = [];
    let disconnected = false;
    let height = 48;
    const h = fixture(doc => {
        doc.querySelector("#map-inspection").getBoundingClientRect = () => ({ height });
        doc.defaultView.ResizeObserver = class {
            /** Capture the native resize callback for deterministic delivery.
             * @param {ResizeObserverCallback} callback Geometry notification.
             */
            constructor(callback) { notifyResize = callback; }
            /** Record each owned presentation element.
             * @param {Element} element Observed dock or Tools popover.
             * @return {void}
             */
            observe(element) { observed.push(element); }
            /** Record lifecycle cleanup. @return {void} */
            disconnect() { disconnected = true; }
        };
    });
    assert.deepEqual(observed, [h.doc.querySelector("#map-inspection"), h.toolActions]);
    h.controller.showHistogram();
    h.controller.showStyle("Countries");
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.layouts.at(-1).compactHeight, 48);
    const count = h.layouts.length;
    notifyResize();
    assert.equal(h.layouts.length, count);
    height = 72.25;
    notifyResize();
    assert.equal(h.layouts.at(-1).compactHeight, 73);
    assert.equal(h.histogram.hidden, false);
    assert.equal(h.style.hidden, false);
    assert.equal(h.controller.activeTool, "style");
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.layouts.at(-1).compactHeight, 0);
    height = 96;
    notifyResize();
    assert.equal(h.layouts.at(-1).compactHeight, 0);
    h.controller.destroy();
    assert.equal(disconnected, true);
    assert.equal(h.layouts.at(-1).open, false);
});

test("compact opening measures its visible popover before a resize notification", () => {
    let visible = false;
    const h = fixture(doc => {
        const root = doc.querySelector("#map-inspection");
        root.showPopover = () => { visible = true; };
        root.hidePopover = () => { visible = false; };
        root.getBoundingClientRect = () => ({ height: visible ? 64 : 0 });
    });
    h.controller.beginMapClick({ lat: 0, lng: 0 });
    h.controller.setClickResult("feature", { state: "empty", message: "No features" });
    assert.equal(h.layouts.at(-1).compactHeight, 64);
    assert.equal(h.layouts.at(-1).expanded, false);
    h.controller.destroy();
    assert.equal(h.layouts.at(-1).compactHeight, 0);
});

test("histogram and style have independent visibility on one persistent surface", () => {
    const h = fixture();
    h.controller.showStyle("Coastal resistance.tif");
    assert.equal(h.analysisToolsButton.hidden, true);
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.styleTab.getAttribute("aria-selected"), "true");
    assert.equal(h.styleTab.textContent, "Style · Coastal resistance.tif");
    assert.equal(h.styleTab.title, "Style Coastal resistance.tif");
    h.controller.showHistogram(2);
    assert.equal(h.style.hidden, false);
    assert.equal(h.histogram.hidden, false);
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "false");
    assert.equal(h.histogram.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.styleTab.hidden, false);
    assert.equal(h.histogramTab.hidden, false);
    assert.equal(h.histogramTab.textContent, "Distributions");
    assert.equal(h.histogramTab.title, "2 raster results");
    h.controller.closeHistogram();
    assert.equal(h.style.hidden, false);
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.analysisToolsButton.hidden, true);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.showHistogram();
    h.controller.hideStyle();
    assert.equal(h.histogram.hidden, false);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.destroy();
    assert.equal(h.analysisToolsButton.hidden, false);
    assert.deepEqual(h.calls, ["show", "hide"]);
});

test("automatic histogram cleanup retains features and current focus", () => {
    const h = fixture();
    h.controller.showFeatureInspector();
    h.controller.showHistogram(1);
    h.featureTab.focus();

    h.controller.closeHistogram(false);

    assert.equal(h.histogram.hidden, true);
    assert.equal(h.histogramTab.hidden, false);
    assert.equal(h.histogramTab.getAttribute("aria-pressed"), "false");
    assert.equal(h.feature.hidden, false);
    assert.equal(h.feature.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.doc.activeElement, h.featureTab);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.destroy();
});

test("combined map results prefer counted features and retain style context", () => {
    const h = fixture();
    h.controller.showStyle("Parcels");
    h.controller.showHistogram(1);
    h.controller.showFeatureInspector();
    assert.equal(h.featureTab.textContent, "Features…");
    assert.equal(h.featureTab.title, "Inspecting vector features");
    assert.equal(h.feature.getAttribute("data-map-inspection-active"), "true");

    h.controller.setFeatureResultCount(1, { loading: true });
    assert.equal(h.featureTab.textContent, "Features · 1…");
    assert.equal(
        h.featureTab.title,
        "1 feature found; vector inspection continues"
    );
    h.controller.setFeatureResultCount(3);
    assert.equal(h.featureTab.textContent, "Features · 3");
    assert.equal(
        h.featureTab.title,
        "3 features at the selected map location"
    );
    assert.equal(h.histogram.hidden, false);
    assert.equal(h.style.hidden, false);

    h.controller.hideFeatureInspector();
    assert.equal(h.featureTab.textContent, "Features");
    assert.equal(h.histogram.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.styleTab.textContent, "Style · Parcels");
    h.controller.hideStyle();
    assert.equal(h.styleTab.textContent, "Style");
    h.controller.destroy();
});

test("map result counts reject invalid presentation values", () => {
    const h = fixture();
    for (const count of [-1, 1.5, NaN]) {
        assert.throws(
            () => h.controller.showHistogram(count),
            /non-negative integer/
        );
        assert.throws(
            () => h.controller.setFeatureResultCount(count),
            /non-negative integer/
        );
    }
    assert.throws(() => h.controller.showStyle(""), /non-empty string/);
    assert.throws(
        () => h.controller.setVectorTimeSeriesIdentity({ label: "", title: "x" }),
        /non-empty label and title/
    );
    assert.throws(
        () => h.controller.setVectorFeatureProfileIdentity({
            label: "Feature · A",
            title: "",
        }),
        /non-empty label and title/
    );
    h.controller.destroy();
});

test("vector feature inspection shares the map-side surface independently", () => {
    const h = fixture();
    const retainedResult = h.doc.createElement();
    retainedResult.textContent = "R2024: -13.09";
    h.feature.append(retainedResult);
    h.controller.showFeatureInspector();
    assert.equal(h.feature.hidden, false);
    assert.equal(h.feature.getAttribute("data-map-inspection-active"), "true");
    assert.deepEqual(h.calls, ["show"]);
    h.controller.showStyle();
    assert.equal(h.feature.hidden, false);
    assert.equal(h.feature.getAttribute("data-map-inspection-active"), "false");
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "true");
    h.featureTab.dispatchEvent(new Event("click"));
    assert.equal(h.feature.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "false");
    assert.equal(retainedResult.textContent, "R2024: -13.09");
    h.controller.hideFeatureInspector();
    assert.equal(h.style.hidden, false);
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "true");
    assert.deepEqual(h.calls, ["show"]);
    h.controller.hideStyle();
    assert.deepEqual(h.calls, ["show", "hide"]);
    h.controller.destroy();
});

test("dock minimization retains open tools and selecting a tab expands it", () => {
    const h = fixture();
    h.controller.showFeatureInspector();
    h.controller.showStyle();

    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.panels.hidden, true);
    assert.equal(h.minimizeButton.textContent, "Expand");
    assert.equal(h.minimizeButton.getAttribute("aria-expanded"), "false");
    assert.equal(h.feature.hidden, false);
    assert.equal(h.style.hidden, false);
    assert.equal(h.styleTab.getAttribute("aria-selected"), "true");

    h.featureTab.dispatchEvent(new Event("click"));
    assert.equal(h.panels.hidden, false);
    assert.equal(h.minimizeButton.textContent, "Minimize");
    assert.equal(h.minimizeButton.getAttribute("aria-expanded"), "true");
    assert.equal(h.feature.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "false");
    h.controller.destroy();
});

test("open dock tabs support wrapping horizontal keyboard navigation", () => {
    const h = fixture();
    h.controller.showFeatureInspector();
    h.controller.showStyle();
    h.styleTab.focus();

    const left = new Event("keydown", { cancelable: true });
    Object.defineProperty(left, "key", { value: "ArrowLeft" });
    h.styleTab.dispatchEvent(left);
    assert.equal(left.defaultPrevented, true);
    assert.equal(h.doc.activeElement, h.featureTab);
    assert.equal(h.featureTab.getAttribute("aria-selected"), "true");

    const right = new Event("keydown", { cancelable: true });
    Object.defineProperty(right, "key", { value: "ArrowRight" });
    h.featureTab.dispatchEvent(right);
    assert.equal(right.defaultPrevented, true);
    assert.equal(h.doc.activeElement, h.styleTab);
    assert.equal(h.styleTab.getAttribute("aria-selected"), "true");
    h.controller.destroy();
});

test("vector time series is an independent retained map-side panel", () => {
    const h = fixture();
    h.controller.setVectorTimeSeriesIdentity({
        label: "R2024 · 4 features",
        title: "R2024 across 4 features · Layer: corridors.shp",
    });
    h.controller.showFeatureInspector();
    h.controller.showVectorTimeSeries();
    assert.equal(h.feature.hidden, false);
    assert.equal(h.vectorTimeSeries.hidden, false);
    assert.equal(h.vectorFeatureProfile.hidden, true);
    assert.equal(h.timeSeriesTab.textContent, "R2024 · 4 features");
    assert.equal(
        h.timeSeriesTab.title,
        "R2024 across 4 features · Layer: corridors.shp"
    );
    assert.deepEqual(h.calls, ["show"]);
    h.controller.hideFeatureInspector();
    assert.equal(h.vectorTimeSeries.hidden, false);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.hideVectorTimeSeries(true);
    assert.equal(h.doc.activeElement, h.map);
    assert.deepEqual(h.calls, ["show", "hide"]);
    h.controller.setVectorTimeSeriesIdentity(null);
    assert.equal(h.timeSeriesTab.textContent, "Field across features");
});

test("feature details collapse without closing retained series state", () => {
    const h = fixture();
    h.controller.showFeatureInspector();
    h.controller.showVectorTimeSeries();
    h.featureDetailsToggle.dispatchEvent(new Event("click"));
    assert.equal(h.feature.hidden, false);
    assert.equal(h.featureDetails.hidden, true);
    assert.equal(h.featureDetailsToggle.getAttribute("aria-expanded"), "false");
    assert.equal(h.featureDetailsToggle.textContent, "Expand");
    assert.equal(h.vectorTimeSeries.hidden, false);
    assert.deepEqual(h.calls, ["show"]);

    h.controller.showFeatureInspector();
    assert.equal(h.featureDetails.hidden, true);
    assert.equal(h.vectorTimeSeries.hidden, false);

    h.featureDetailsToggle.dispatchEvent(new Event("click"));
    assert.equal(h.featureDetails.hidden, false);
    assert.equal(h.featureDetailsToggle.getAttribute("aria-expanded"), "true");
    assert.equal(h.featureDetailsToggle.textContent, "Collapse");
    h.controller.destroy();
});

test("the two series modes share one exclusive presentation position", () => {
    const h = fixture();
    h.controller.setVectorFeatureProfileIdentity({
        label: "Feature · Northern corridor",
        title: "Fields from Northern corridor · Layer: corridors.shp",
    });
    h.controller.showFeatureInspector();
    h.controller.showVectorTimeSeries();
    h.controller.showVectorFeatureProfile();
    assert.equal(h.feature.hidden, false);
    assert.equal(h.vectorTimeSeries.hidden, true);
    assert.equal(h.vectorFeatureProfile.hidden, false);
    assert.equal(h.featureProfileTab.textContent, "Feature · Northern corridor");
    h.controller.showVectorTimeSeries();
    assert.equal(h.vectorTimeSeries.hidden, false);
    assert.equal(h.vectorFeatureProfile.hidden, true);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.hideVectorTimeSeries();
    h.controller.hideFeatureInspector();
    assert.deepEqual(h.calls, ["show", "hide"]);
});

test("Escape is focus-scoped and destroy detaches presentation listeners", () => {
    const h = fixture();
    /** Dispatch one keyboard Escape at the owning document. */
    const escape = () => {
        const event = new Event("keydown", { cancelable: true });
        Object.defineProperty(event, "key", { value: "Escape" });
        h.doc.dispatchEvent(event);
        return event.defaultPrevented;
    };
    h.controller.showHistogram();
    h.map.focus();
    assert.equal(escape(), false);
    assert.equal(h.histogram.hidden, false);
    h.close.focus();
    assert.equal(escape(), true);
    assert.equal(h.histogram.hidden, true);
    h.controller.destroy();
    h.close.dispatchEvent(new Event("click"));
    assert.equal(escape(), false);
    assert.equal(h.histogram.hidden, true);
    assert.deepEqual(h.calls, ["show", "hide"]);
});


test("closing the last tool hides its empty surface while raster navigation remains usable", () => {
    const h = fixture();
    h.controller.beginMapClick({ lat: -10, lng: -60 });
    h.controller.setClickResult("histogram", { state: "ready", message: "1 raster ready" });
    h.controller.showHistogram(1);
    const results = h.doc.querySelector("#map-click-summary");
    const reopen = h.doc.querySelector("#map-click-histogram");
    assert.equal(h.panels.hidden, false);

    h.close.dispatchEvent(new Event("click"));

    assert.equal(h.histogram.hidden, true);
    assert.equal(h.panels.hidden, true, "the empty top-layer container must not intercept map clicks");
    assert.equal(results.hidden, true, "raster results do not create point features");
    assert.equal(h.doc.querySelector("#map-click-histogram-status").hidden, false);
    assert.equal(reopen.disabled, false);
    assert.deepEqual(h.calls, ["show"], "retained results keep their popover");
    assert.equal(h.doc.activeElement, h.map);

    h.minimizeButton.dispatchEvent(new Event("click"));
    h.minimizeButton.dispatchEvent(new Event("click"));
    assert.equal(h.panels.hidden, true, "expanding only the result cards must not restore an empty surface");

    reopen.dispatchEvent(new Event("click"));
    assert.equal(h.panels.hidden, false);
    assert.equal(h.histogram.hidden, false);
    h.controller.showStyle("Raster");
    h.controller.showHistogram(1);
    h.close.dispatchEvent(new Event("click"));
    assert.equal(h.panels.hidden, false, "an open fallback tool still needs its surface");
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "true");
    h.controller.hideStyle();
    assert.equal(h.panels.hidden, true);
    h.controller.destroy();
});


for (const [name, show, hide, args] of [
    ["histogram", "showHistogram", "closeHistogram", []],
    ["features", "showFeatureInspector", "hideFeatureInspector", []],
    ["field across features", "showVectorTimeSeries", "hideVectorTimeSeries", []],
    ["fields from feature", "showVectorFeatureProfile", "hideVectorFeatureProfile", []],
    ["summaries", "showCalculations", "hideCalculations", []],
    ["raster-clips", "showRasterClips", "hideRasterClips", []],
    ["style", "showStyle", "hideStyle", ["Raster"]],
    ["filter", "showFilter", "hideFilter", ["Countries"]],
]) {
    test(`closing ${name} hides the shared surface beneath retained map results`, () => {
        const h = fixture();
        h.controller.beginMapClick({ lat: -10, lng: -60 });
        h.controller.setClickResult("histogram", { state: "ready", message: "Raster ready" });
        h.controller.setClickResult("feature", { state: "ready", message: "Feature ready" });
        h.controller[show](...args);
        assert.equal(h.panels.hidden, false);
        h.controller[hide]();
        assert.equal(h.panels.hidden, true);
        assert.equal(h.doc.querySelector("#map-click-summary").hidden, false);
        assert.deepEqual(h.calls, ["show"]);
        h.controller.destroy();
    });
}

test("mixed raster and vector clicks never restore an empty inspection surface", () => {
    const h = fixture();
    h.controller.beginMapClick({ lat: -10, lng: -60 });
    h.controller.setClickResult("histogram", { state: "loading", message: "Sampling" });
    h.controller.showHistogram();
    h.controller.setClickResult("feature", { state: "ready", message: "Two features" });
    h.controller.showFeatureInspector({ activate: false });
    h.doc.querySelector("#map-click-feature").dispatchEvent(new Event("click"));
    h.controller.showVectorFeatureProfile();
    h.controller.showStyle("Countries");
    h.controller.hideStyle();
    h.controller.hideVectorFeatureProfile();
    h.controller.hideFeatureInspector();
    assert.equal(h.panels.hidden, false, "histogram remains open");
    h.controller.closeHistogram();
    assert.equal(h.panels.hidden, true);

    h.controller.beginMapClick({ lat: -11, lng: -61 });
    h.controller.setClickResult("histogram", { state: "ready", message: "Updated raster" });
    h.controller.setClickResult("feature", { state: "empty", message: "No features" });
    assert.equal(h.panels.hidden, true, "new result cards alone do not occupy panel space");
    h.doc.querySelector("#map-click-histogram").dispatchEvent(new Event("click"));
    assert.equal(h.panels.hidden, false);
    h.controller.closeHistogram(false);
    h.controller.setClickResult("histogram", null);
    h.controller.setClickResult("feature", null);
    assert.equal(h.panels.hidden, true);
    assert.deepEqual(h.calls, ["show", "hide"]);
    h.controller.destroy();
});

test("annotation panel closes independently and cannot leave a hidden input-blocking surface", () => {
    const h = fixture();
    const annotations = h.doc.querySelector("#annotations-panel");
    h.controller.showHistogram();
    h.controller.showAnnotations();
    assert.equal(h.controller.activeTool, "annotations");
    assert.equal(annotations.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.histogram.getAttribute("data-map-inspection-active"), "false");
    h.controller.hideAnnotations();
    assert.equal(h.controller.activeTool, "histogram");
    assert.equal(annotations.hidden, true);
    h.controller.closeHistogram();
    assert.equal(h.panels.hidden, true);
    h.controller.showAnnotations();
    h.controller.hideAnnotations();
    assert.equal(h.panels.hidden, true);
    assert.equal(h.controller.isOpen, false);
});

test("raster series remains active during map inspection and closes without hiding peer results", () => {
    const h = fixture();
    const activity = [];
    h.controller.subscribeActiveTool(tool => activity.push(tool));
    h.controller.showRasterSeries();
    assert.equal(h.controller.activeTool, "raster-series");
    h.controller.beginMapClick({ lat: 22, lng: 78 });
    h.controller.showHistogram(2, { activate: false });
    h.controller.showFeatureInspector({ activate: false });
    assert.equal(h.controller.activeTool, "raster-series");
    h.controller.hideRasterSeries();
    assert.notEqual(activity.at(-1), "raster-series");
    assert.equal(h.doc.querySelector("#raster-series").hidden, true);
    assert.equal(h.histogram.hidden, false);
    h.controller.destroy();
});

test("annotation click details remain active while independent raster and vector results arrive", () => {
    const h = fixture();
    h.controller.beginMapClick({ lat: 22, lng: 78 });
    h.controller.showHistogram(2, { activate: false });
    h.controller.showFeatureInspector({ activate: false });
    h.controller.showAnnotations();
    h.controller.setClickResult("histogram", { state: "ready", message: "2 raster results" });
    h.controller.setClickResult("feature", { state: "ready", message: "1 feature" });
    h.controller.setFeatureResultCount(1);
    assert.equal(h.controller.activeTool, "annotations");
    assert.equal(h.histogram.hidden, false);
    assert.equal(h.feature.hidden, false);
    h.controller.destroy();
});
