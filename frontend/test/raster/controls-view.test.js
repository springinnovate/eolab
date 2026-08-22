import assert from "node:assert/strict";
import test from "node:test";

import { RasterControlsView } from "../../src/raster/controls-view.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";
import { RASTER_STATISTICS } from "../../test-support/raster/fixtures.js";

/** Minimal DOM element used by the raster controls adapter tests. */
class FakeControlElement extends EventTarget {
    /**
     * Create an element with mutable DOM-like presentation state.
     *
     * @param {string} [type] Input type exposed to event handlers.
     */
    constructor(type = "") {
        super();
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
     * Return deterministic pointer-probe dimensions.
     *
     * @return {{width: number, height: number}} Element dimensions.
     */
    getBoundingClientRect() {
        return { width: 120, height: 48 };
    }
}

/** Minimal selector and element factory contract used by the controls view. */
class FakeRasterDocument {
    /** Create an empty document-backed selector registry. */
    constructor() {
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
            this.elements.set(selector, new FakeControlElement(type));
        }
        return this.elements.get(selector);
    }

    /**
     * Create one fake HTML element.
     *
     * @return {FakeControlElement} New fake element.
     */
    createElement() {
        return new FakeControlElement();
    }

    /**
     * Create one fake SVG element.
     *
     * @return {FakeControlElement} New fake SVG element.
     */
    createElementNS() {
        return new FakeControlElement();
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
        minimum: -5,
        midpoint: 2,
        maximum: 9,
        minimumColor: "#000000",
        midpointColor: "#888888",
        maximumColor: "#ffffff",
    };
    view.setStyle(style, "viridis");
    assert.deepEqual(view.readStyle(), style);
    assert.equal(view.getPaletteName(), "viridis");
    assert.match(
        documentContext.querySelector("#raster-legend").style.background,
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
        onSampleMapCenter: () => received.push(["center"]),
        onClearSampleWindow: () => received.push(["whole"]),
    });
    documentContext
        .querySelector("#raster-minimum-color")
        .dispatchEvent(new Event("input"));
    documentContext.querySelector("#raster-sample-window-range").value = "80";
    documentContext
        .querySelector("#raster-sample-window-range")
        .dispatchEvent(new Event("input"));
    assert.deepEqual(received, [["style", true], ["range", "80"]]);

    view.unbind();
    documentContext
        .querySelector("#raster-minimum-color")
        .dispatchEvent(new Event("input"));
    assert.deepEqual(received, [["style", true], ["range", "80"]]);
});

test("RasterControlsView clears histogram visibility through its DOM contract", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    const chart = documentContext.querySelector("#raster-histogram-chart");
    chart.append(new FakeControlElement());

    view.clearStatistics();

    assert.equal(chart.children.length, 0);
    assert.equal(chart.getAttribute("hidden"), "");
    assert.equal(documentContext.querySelector("#raster-histogram-axis").hidden, true);
    assert.equal(
        documentContext.querySelector("#raster-percentile-controls").hidden,
        true
    );
    assert.equal(documentContext.querySelector("#retry-raster-statistics").hidden, true);
});

test("RasterControlsView identifies the active layer and disables map reads while hidden", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);

    view.setActiveLayer("global-temperature.tif", false);

    assert.match(
        documentContext.querySelector("#raster-active-layer-label").textContent,
        /global-temperature\.tif; this layer is hidden/
    );
    assert.equal(
        documentContext.querySelector("#sample-raster-map-center").disabled,
        true
    );
    assert.equal(
        documentContext.querySelector("#retry-raster-statistics").disabled,
        true
    );

    view.setActiveLayer("global-temperature.tif", true);

    assert.equal(
        documentContext.querySelector("#sample-raster-map-center").disabled,
        false
    );
    assert.equal(
        documentContext.querySelector("#retry-raster-statistics").disabled,
        false
    );
});

test("RasterControlsView reveals a successful histogram presentation", () => {
    const documentContext = new FakeRasterDocument();
    const view = new RasterControlsView(documentContext);
    const chart = documentContext.querySelector("#raster-histogram-chart");
    chart.setAttribute("hidden", "");

    view.renderHistogram(RASTER_STATISTICS, DEFAULT_RASTER_STYLE);
    view.showHistogramAxis("≈ -1.000e+1", "≈ 3.000e+1");
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
    assert.equal(
        documentContext.querySelector("#raster-histogram-axis").hidden,
        false
    );
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

test("RasterControlsView rejects an incomplete application document", () => {
    assert.throws(
        () => new RasterControlsView({ querySelector: () => null }),
        /Required raster control is missing: #raster-style-controls/
    );
});
