import assert from "node:assert/strict";
import test from "node:test";

import { RasterControlsView } from "../../src/raster/controls-view.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";
import {
    EXACT_RASTER_STATISTICS,
    RASTER_STATISTICS,
} from "../../test-support/raster/fixtures.js";

/** Minimal DOM element used by the raster controls adapter tests. */
class FakeControlElement extends EventTarget {
    /**
     * Create an element with mutable DOM-like presentation state.
     *
     * @param {string} [type] Input type exposed to event handlers.
     */
    constructor(type = "", ownerDocument = null) {
        super();
        this.ownerDocument = ownerDocument;
        this.type = type;
        this.value = "";
        this.textContent = "";
        this.hidden = false;
        this.disabled = false;
        this.title = "";
        this.style = {};
        this.children = [];
        this.attributes = new Map();
        this.classNames = [];
        this.classList = {
            add: (className) => {
                if (!this.classNames.includes(className)) {
                    this.classNames.push(className);
                }
            },
            contains: (className) => this.classNames.includes(className),
            remove: (className) => {
                this.classNames = this.classNames.filter(
                    (candidate) => candidate !== className
                );
            },
        };
    }

    /**
     * Append child elements.
     *
     * @param {...FakeControlElement} children Elements to append.
     * @return {void}
     */
    append(...children) {
        this.children.push(...children);
    }

    /**
     * Replace all child elements.
     *
     * @param {...FakeControlElement} children Replacement elements.
     * @return {void}
     */
    replaceChildren(...children) {
        this.children = children;
    }

    /**
     * Store one element attribute.
     *
     * @param {string} name Attribute name.
     * @param {string} value Attribute value.
     * @return {void}
     */
    setAttribute(name, value) {
        this.attributes.set(name, value);
    }

    /**
     * Remove one element attribute.
     *
     * @param {string} name Attribute name.
     * @return {void}
     */
    removeAttribute(name) {
        this.attributes.delete(name);
    }

    /**
     * Return one element attribute.
     *
     * @param {string} name Attribute name.
     * @return {string|null} Attribute value or null when absent.
     */
    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    /**
     * Return deterministic control dimensions.
     *
     * @return {{width: number, height: number}} Element dimensions.
     */
    getBoundingClientRect() {
        return { width: 120, height: 48 };
    }

    /** Give this control focus in its fake document. @return {void} */
    focus() {
        if (this.ownerDocument !== null) {
            this.ownerDocument.activeElement = this;
        }
    }
}

/** Minimal selector and element factory contract used by the controls view. */
class FakeRasterDocument {
    /** Create an empty document-backed selector registry. */
    constructor() {
        this.activeElement = null;
        this.elements = new Map();
    }

    /**
     * Resolve or create one fake element for a raster selector.
     *
     * @param {string} selector CSS selector.
     * @return {FakeControlElement} Stable fake element.
     */
    querySelector(selector) {
        if (!this.elements.has(selector)) {
            const type = selector.endsWith("-color")
                ? "color"
                : selector.includes("percentile") || selector.endsWith("-range")
                    ? "range"
                    : selector.includes("minimum") ||
                        selector.includes("midpoint") ||
                        selector.includes("maximum") ||
                        selector.endsWith("-number")
                        ? "number"
                        : "";
            this.elements.set(selector, new FakeControlElement(type, this));
        }
        return this.elements.get(selector);
    }

    /**
     * Create one fake HTML element.
     *
     * @return {FakeControlElement} New fake element.
     */
    createElement() {
        return new FakeControlElement("", this);
    }

    /**
     * Create one fake SVG element.
     *
     * @return {FakeControlElement} New fake SVG element.
     */
    createElementNS() {
        return new FakeControlElement("", this);
    }
}

test("RasterControlsView owns style values and semantic control events", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    view.populatePalettes({
        viridis: {
            label: "Viridis",
        },
    });
    assert.equal(documentContext.querySelector("#raster-palette").children.length, 2);

    const style = {
        minimumOpacity: 1,
        midpointOpacity: 1,
        maximumOpacity: 1,
        minimum: -5,
        midpoint: 2,
        maximum: 9,
        minimumColor: "#000000",
        midpointColor: "#888888",
        maximumColor: "#ffffff",
    };
    view.setStyle(style, "viridis");
    view.setAppearanceStatus("Applied the Viridis palette.");
    assert.deepEqual(view.readStyle(), style);
    assert.equal(view.getPaletteName(), "viridis");
    assert.equal(
        documentContext.querySelector("#raster-appearance-status").textContent,
        "Applied the Viridis palette."
    );
    assert.match(
        documentContext.querySelector("#raster-legend").style.backgroundImage,
        /#000000/
    );

    const received = [];
    view.bind({
        onStyleInput: (isColor) => received.push(["style", isColor]),
        onStyleChange: () => received.push(["commit"]),
        onPaletteChange: () => received.push(["palette"]),
        onResetStyle: () => received.push(["reset"]),
        onPercentileInput: () => received.push(["percentile"]),
        onApplyPercentiles: () => received.push(["apply"]),
        onRetryStatistics: () => received.push(["retry"]),
        onSampleWindowRangeInput: (value) => received.push(["range", value]),
        onSampleWindowNumberInput: (value) => received.push(["number", value]),
        onSampleWindowNumberChange: (value) => received.push(["change", value]),
        onClearSampleWindow: () => received.push(["whole"]),
        onUseTemporaryAoi: () => received.push(["aoi"]),
    });
    documentContext
        .querySelector("#raster-minimum-color")
        .dispatchEvent(new Event("input"));
    documentContext.querySelector("#raster-sample-window-range").value = "80";
    documentContext
        .querySelector("#raster-sample-window-range")
        .dispatchEvent(new Event("input"));
    assert.deepEqual(received, [["style", true], ["range", "80"]]);

    documentContext.querySelector("#raster-histogram").hidden = true;
    documentContext.querySelector("#raster-appearance-controls").hidden = true;
    view.setControlsVisible(true);
    view.showHistogramWidget();
    assert.equal(documentContext.querySelector("#raster-histogram").hidden, false);
    view.setRenderingControlsAvailable(true);
    assert.equal(documentContext.querySelector("#raster-histogram").hidden, false);
    assert.equal(
        documentContext.querySelector("#raster-appearance-controls").hidden,
        false
    );

    view.unbind();
    documentContext
        .querySelector("#raster-minimum-color")
        .dispatchEvent(new Event("input"));
    assert.deepEqual(received, [["style", true], ["range", "80"]]);
});

test("RasterControlsView exposes accessible explicit histogram-area choices", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    const received = [];
    view.bind({
        onStyleInput() {},
        onStyleChange() {},
        onPaletteChange() {},
        onResetStyle() {},
        onPercentileInput() {},
        onApplyPercentiles() {},
        onRetryStatistics() {},
        onSampleWindowRangeInput() {},
        onSampleWindowNumberInput() {},
        onSampleWindowNumberChange() {},
        onClearSampleWindow: () => received.push("whole"),
        onUseTemporaryAoi: () => received.push("aoi"),
    });
    const temporaryAoi = {
        id: "A".repeat(32),
        filename: "area.gpkg",
        selectedDataset: "boundary",
    };

    view.setTemporaryAoiAvailability(temporaryAoi);
    view.setSamplingAreaMode("temporaryAoi");
    assert.equal(
        documentContext.querySelector("#raster-histogram")
            .getAttribute("data-sampling-area"),
        "temporaryAoi"
    );
    documentContext
        .querySelector("#clear-raster-sample-window")
        .dispatchEvent(new Event("click"));
    documentContext
        .querySelector("#use-temporary-aoi-for-raster")
        .dispatchEvent(new Event("click"));

    assert.deepEqual(received, ["whole", "aoi"]);
    assert.equal(
        documentContext
            .querySelector("#use-temporary-aoi-for-raster")
            .getAttribute("aria-pressed"),
        "true"
    );
    assert.match(
        documentContext
            .querySelector("#use-temporary-aoi-for-raster")
            .getAttribute("aria-label"),
        /area\.gpkg.*boundary/
    );

    view.setClearSampleWindowLabel("Clear selected histogram");
    view.setSamplingAreaMode("none");
    assert.equal(
        documentContext.querySelector("#clear-raster-sample-window").textContent,
        "Clear selected histogram"
    );
    for (const selector of [
        "#clear-raster-sample-window",
        "#use-temporary-aoi-for-raster",
    ]) {
        assert.equal(
            documentContext.querySelector(selector).getAttribute("aria-pressed"),
            "false"
        );
    }
    assert.throws(
        () => view.setClearSampleWindowLabel(""),
        /must not be blank/
    );
});

test("RasterControlsView clears histogram visibility through its DOM contract", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    const chart = documentContext.querySelector("#raster-histogram-chart");
    chart.append(new FakeControlElement());

    view.clearStatistics();

    assert.equal(chart.children.length, 0);
    assert.equal(chart.getAttribute("hidden"), "");
    assert.equal(
        documentContext.querySelector("#raster-percentile-controls").hidden,
        true
    );
    assert.equal(documentContext.querySelector("#retry-raster-statistics").hidden, true);
});

test("RasterControlsView reports renderer visibility without gating analysis", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);

    view.setActiveLayer("global-temperature.tif", false);

    assert.match(
        documentContext.querySelector("#raster-active-layer-label").textContent,
        /global-temperature\.tif — not visible on the map/
    );
    assert.equal(
        documentContext.querySelector("#retry-raster-statistics").disabled,
        false
    );

    view.setActiveLayer("global-temperature.tif", true);

    assert.equal(
        documentContext.querySelector("#retry-raster-statistics").disabled,
        false
    );
});

test("RasterControlsView delegates retained histogram summaries", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);

    view.renderLayerHistograms([
        {
            key: "retained-raster",
            label: "retained-raster.tif",
            state: "ready",
            scope: "Whole raster",
            counts: [1, 3, 2],
        },
    ], "retained-raster");
    view.setActiveLayer("retained-raster.tif", true);

    assert.equal(
        documentContext.querySelector("#raster-histogram-list").children.length,
        1
    );
    assert.equal(
        documentContext.querySelector("#raster-histogram-detail-layer")
            .textContent,
        "retained-raster.tif"
    );
    assert.equal(
        documentContext.querySelector("#raster-appearance-layer").textContent,
        ""
    );
});

test("RasterControlsView owns composite visibility without clearing subgroup state", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    const root = documentContext.querySelector("#raster-style-controls");
    const histogram = documentContext.querySelector("#raster-histogram");
    const samplingStatus = documentContext.querySelector(
        "#raster-sample-window-status"
    );
    const appearance = documentContext.querySelector(
        "#raster-appearance-controls"
    );

    view.setStatisticsBusy(true);
    view.setStatisticsStatus("Calculating selected-area histogram...");
    view.setSampleWindowStatus("Selected geographic map window.");
    view.setControlsVisible(false);

    assert.equal(root.hidden, true);
    assert.equal(histogram.hidden, true);
    assert.equal(histogram.getAttribute("aria-busy"), "true");
    assert.equal(
        documentContext.querySelector("#raster-histogram-status").textContent,
        "Calculating selected-area histogram..."
    );
    assert.equal(samplingStatus.textContent, "Selected geographic map window.");
    assert.equal(appearance.hidden, false);

    view.setControlsVisible(true);
    assert.equal(root.hidden, false);
    assert.equal(histogram.hidden, false);
    assert.equal(appearance.hidden, false);
    view.setRenderingControlsAvailable(true);
    assert.equal(appearance.hidden, false);
    view.showHistogramWidget();
    assert.equal(histogram.hidden, false);
    assert.equal(histogram.getAttribute("aria-busy"), "true");
    assert.equal(samplingStatus.textContent, "Selected geographic map window.");
});

test("RasterControlsView reveals a successful histogram presentation", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    const chart = documentContext.querySelector("#raster-histogram-chart");
    chart.setAttribute("hidden", "");

    view.renderHistogram(RASTER_STATISTICS, DEFAULT_RASTER_STYLE);
    view.setPercentileControlsVisible(true);
    view.renderPercentileValues(
        { lower: 5, middle: 50, upper: 95 },
        { lower: "-4.000e+0", middle: "3.000e+0", upper: "2.000e+1" },
        true,
        true
    );

    assert.equal(chart.getAttribute("hidden"), null);
    assert.equal(
        chart.children.filter(
            (child) => child.classNames.includes("raster-histogram-bar")
        ).length,
        64
    );
    assert.equal(
        chart.children.filter(
            (child) => child.classNames.includes("raster-histogram-tooltip")
        ).length,
        1
    );
    assert.equal(chart.getAttribute("viewBox"), "0 0 640 190");
    assert.match(chart.getAttribute("aria-label"), /percentage of valid sampled pixels/);
    assert.equal(
        documentContext.querySelector("#raster-percentile-controls").hidden,
        false
    );
    assert.equal(
        documentContext.querySelector("#apply-raster-percentiles").disabled,
        false
    );
    assert.equal(
        documentContext.querySelector("#raster-middle-percentile-value")
            .textContent,
        "50% ≈ 3.000e+0"
    );
});

test("RasterControlsView labels exact bounded histogram provenance", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    const chart = documentContext.querySelector("#raster-histogram-chart");

    view.renderHistogram(EXACT_RASTER_STATISTICS, DEFAULT_RASTER_STYLE, "Raster value (K)");

    assert.match(chart.children[0].textContent, /^Exact bounded band 1/);
    assert.match(chart.getAttribute("aria-label"), /^Exact bounded band 1/);
    assert.match(chart.getAttribute("aria-label"), /Horizontal axis: Raster value \(K\)/);
});

test("RasterControlsView rejects an incomplete application document", () => {
    assert.throws(
        () => new RasterControlsView({ querySelector: () => null }),
        /Required raster control is missing: #raster-style-controls/
    );
});

test("RasterControlsView preserves the raster viewer compatibility surface", () => {
    const view = new RasterControlsView(new FakeRasterDocument());
    const expectedMethods = [
        "populatePalettes",
        "setActiveLayer",
        "renderLayerHistograms",
        "bind",
        "unbind",
        "readStyle",
        "setStyle",
        "getPaletteName",
        "setPaletteName",
        "renderStyleError",
        "renderLegend",
        "readPercentiles",
        "resetPercentiles",
        "renderPercentileValues",
        "clearStatistics",
        "setStatisticsBusy",
        "setStatisticsStatus",
        "renderHistogram",
        "clearHistogram",
        "setPercentileControlsVisible",
        "setStatisticsRetryVisible",
        "setApplyPercentilesEnabled",
        "setSampleWindowSize",
        "setSampleWindowInvalid",
        "setSampleWindowStatus",
        "setClearSampleWindowEnabled",
        "setClearSampleWindowLabel",
        "setTemporaryAoiAvailability",
        "setSamplingAreaMode",
        "showHistogramWidget",
        "showAppearanceWidget",
        "setRenderingControlsAvailable",
        "setControlsVisible",
        "renderPointSamples",
        "clearPointSamples",
    ];

    for (const methodName of expectedMethods) {
        assert.equal(typeof view[methodName], "function", methodName);
    }
});
