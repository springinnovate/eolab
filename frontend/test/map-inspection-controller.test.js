import assert from "node:assert/strict";
import test from "node:test";
import { MapInspectionController } from "../src/map-inspection-controller.js";
import { FakeRasterControlDocument } from "../test-support/raster/fake-controls-document.js";

/** Build a retained, non-modal map surface with focus and lifecycle spies. */
function fixture() {
    const doc = new FakeRasterControlDocument();
    const events = new EventTarget();
    doc.addEventListener = events.addEventListener.bind(events);
    doc.removeEventListener = events.removeEventListener.bind(events);
    doc.dispatchEvent = events.dispatchEvent.bind(events);
    const root = doc.querySelector("#map-inspection");
    const histogram = doc.querySelector("#map-histogram-panel");
    const style = doc.querySelector("#layer-style-editor");
    const feature = doc.querySelector("#vector-feature-inspector");
    const featureDetails = doc.querySelector("#vector-feature-inspector-details");
    const featureDetailsToggle = doc.querySelector(
        "#toggle-vector-inspector-details"
    );
    const vectorTimeSeries = doc.querySelector("#vector-time-series");
    const vectorFeatureProfile = doc.querySelector("#vector-feature-profile");
    histogram.hidden = style.hidden = feature.hidden =
        vectorTimeSeries.hidden = vectorFeatureProfile.hidden = true;
    const close = doc.querySelector("#close-map-histogram");
    histogram.append(close);
    const calls = [];
    root.showPopover = () => calls.push("show");
    root.hidePopover = () => calls.push("hide");
    const controller = new MapInspectionController({ documentContext: doc });
    return {
        doc,
        histogram,
        style,
        feature,
        featureDetails,
        featureDetailsToggle,
        vectorTimeSeries,
        vectorFeatureProfile,
        panels: doc.querySelector("#map-inspection-panels"),
        minimizeButton: doc.querySelector("#toggle-map-inspection-dock"),
        featureTab: doc.querySelector("#map-inspection-tab-feature"),
        timeSeriesTab: doc.querySelector("#map-inspection-tab-time-series"),
        featureProfileTab: doc.querySelector("#map-inspection-tab-feature-profile"),
        histogramTab: doc.querySelector("#map-inspection-tab-histogram"),
        styleTab: doc.querySelector("#map-inspection-tab-style"),
        close,
        calls,
        controller,
        analysisToolsButton: doc.querySelector("#open-analysis-tools"),
        map: doc.querySelector("#map"),
    };
}

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

test("histogram and style have independent visibility on one persistent surface", () => {
    const h = fixture();
    h.controller.showStyle();
    assert.equal(h.analysisToolsButton.hidden, true);
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.styleTab.getAttribute("aria-selected"), "true");
    h.controller.showHistogram();
    assert.equal(h.style.hidden, false);
    assert.equal(h.histogram.hidden, false);
    assert.equal(h.style.getAttribute("data-map-inspection-active"), "false");
    assert.equal(h.histogram.getAttribute("data-map-inspection-active"), "true");
    assert.equal(h.styleTab.hidden, false);
    assert.equal(h.histogramTab.hidden, false);
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
    h.controller.showFeatureInspector();
    h.controller.showVectorTimeSeries();
    assert.equal(h.feature.hidden, false);
    assert.equal(h.vectorTimeSeries.hidden, false);
    assert.equal(h.vectorFeatureProfile.hidden, true);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.hideFeatureInspector();
    assert.equal(h.vectorTimeSeries.hidden, false);
    assert.deepEqual(h.calls, ["show"]);
    h.controller.hideVectorTimeSeries(true);
    assert.equal(h.doc.activeElement, h.map);
    assert.deepEqual(h.calls, ["show", "hide"]);
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
    h.controller.showFeatureInspector();
    h.controller.showVectorTimeSeries();
    h.controller.showVectorFeatureProfile();
    assert.equal(h.feature.hidden, false);
    assert.equal(h.vectorTimeSeries.hidden, true);
    assert.equal(h.vectorFeatureProfile.hidden, false);
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
