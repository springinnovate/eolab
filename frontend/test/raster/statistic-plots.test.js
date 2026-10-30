import test from "node:test";
import assert from "node:assert/strict";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { renderOrdinalSeriesChart } from "../../src/charts/series-chart.js";
import { RasterSeriesPlotsView } from "../../src/raster/series-plots-view.js";

/** Render aligned series through the shared production renderer.
 * @param {Array<Array<number|null>>} values Y values for each series.
 * @param {Object} [options={}] Rendering options.
 * @return {Object} Rendered elements and inspection callbacks.
 */
function render(values, options = {}) {
    const documentContext = new FakeRasterControlDocument();
    const chart = documentContext.querySelector("#chart");
    const inspections = [];
    const series = values.map((numbers, index) => ({ id: String(index), label: `Statistic ${index}`, color: "blue", dash: index ? "7 3" : "none",
        points: numbers.map((yValue, i) => ({ xLabel: `Raster ${i}`, yValue })) }));
    const result = renderOrdinalSeriesChart({ documentContext, chart, series,
        chartType: "line", xAxisLabel: "Raster", yAxisLabel: "Value", ariaLabel: "Statistics",
        pointAccessibleLabel: (point, item) => `${item.label}: ${point.yValue}`,
        pointTooltip: point => point.xLabel, onInspect: value => inspections.push(value), ...options });
    /** Read all SVG descendants, including series groups.
     * @param {Object} element Root node. @return {Object[]} Descendants.
     */
    const descendants = element => element.children.flatMap(child => [child, ...descendants(child)]);
    return { ...result, chart, inspections, elements: descendants(chart) };
}

test("multiple statistics share axes and raster positions while missing values break lines", () => {
    const result = render([[0, null, 10], [10, 5, 0]]);
    assert.deepEqual(result.pointElements.map(({circle}) => Number(circle.getAttribute("cx"))), [72, 656, 72, 364, 656]);
    assert.deepEqual(result.pointElements.map(({circle}) => Number(circle.getAttribute("cy"))), [268, 20, 20, 144, 268]);
    const paths = result.elements.filter(element => element.getAttribute("class") === "series-chart-line");
    assert.equal(paths[0].getAttribute("d"), "M72,268ZM656,20Z");
    assert.equal(paths[1].getAttribute("d"), "M72,20L364,144L656,268");
    assert.equal(paths[1].getAttribute("stroke-dasharray"), "7 3");
});

test("logarithmic spacing retains ordinal gaps for zero, negative and missing values", () => {
    const result = render([[1, 0, 10, -3, 100, null]], {yScale:"log"});
    assert.deepEqual(result.pointElements.map(({circle}) => Number(circle.getAttribute("cy"))), [268, 144, 20]);
    const path = result.elements.find(element => element.getAttribute("class") === "series-chart-line").getAttribute("d");
    assert.equal(path.split("M").length, 4);
    assert.ok(!path.includes("L"));
    assert.throws(() => render([[0, -1]], {yScale:"log"}), /finite Y value/);
    for (const value of [Number.MIN_VALUE, Number.MAX_VALUE]) {
        const extreme = render([[value]], {yScale:"log"});
        assert.ok(extreme.elements.every(element => !/Infinity|NaN/.test(element.getAttribute("d") ?? element.textContent)));
    }
});

test("line and point details work on pointer and keyboard without native duplicate tooltips", () => {
    const result = render([[1, 2], [1, 2]]);
    const line = result.elements.find(element => element.getAttribute("class") === "series-chart-line-hit");
    line.dispatchEvent(new Event("focus"));
    assert.equal(result.inspections.at(-1).series.label, "Statistic 0");
    assert.equal(result.inspections.at(-1).point, null);
    line.dispatchEvent(new Event("blur"));
    const point = result.pointElements[0].circle;
    point.dispatchEvent(new Event("pointermove"));
    assert.equal(result.inspections.at(-1).index, 0);
    point.dispatchEvent(new Event("pointerleave"));
    assert.equal(result.inspections.at(-1), null);
    point.dispatchEvent(new Event("focus"));
    line.dispatchEvent(new Event("pointerenter"));
    assert.equal(result.inspections.at(-1).index, 0, "scrolling beneath a stationary pointer must not replace keyboard details");
    line.dispatchEvent(new Event("pointermove"));
    assert.equal(result.inspections.at(-1).point, null);
    line.dispatchEvent(new Event("pointerleave"));
    assert.equal(result.inspections.at(-1).index, 0, "leaving the line restores the focused point's details");
    assert.equal(point.children.length, 0, "custom inspection has no SVG title fallback");
    const description = RasterSeriesPlotsView.prototype.describePoint([
        {label:"Mean · mean(a)",points:[{xLabel:"Full raster name.tif",yValue:1,rawValue:"1.0000000001",unit:""}]},
        {label:"Area · areaha(a > 0)",points:[{xLabel:"Full raster name.tif",yValue:1,rawValue:"1",unit:"ha"}]},
    ],0,"linear",false);
    assert.equal(description, "Full raster name.tif\nMean · mean(a): 1.0000000001\nArea · areaha(a > 0): 1 ha");
});

test("scatter plots keep point inspection and reject misaligned series", () => {
    const result = render([[2, 3], [4, 5]], {chartType:"scatter"});
    assert.equal(result.pointElements.length,4);
    assert.ok(!result.elements.some(element => element.getAttribute("class") === "series-chart-line"));
    assert.throws(() => render([[1, 2]], {series:[{points:[{xLabel:"A",yValue:1}]},{points:[{xLabel:"B",yValue:1}]}]}), /contract/);
});

test("bar plots group series around each observation and retain zero, negative and missing values", () => {
    const result = render([[-4, 0, null, 8], [2, 3, 5, 6]], {chartType: "bar"});
    const bars = result.pointElements.map(({circle}) => circle);
    assert.equal(bars.length, 7);
    assert.ok(bars.every(bar => bar.tagName === "rect" && Number(bar.getAttribute("width")) > 0));
    const negative = bars[0], zero = bars[1], positive = bars[3];
    const baseline = Number(negative.getAttribute("y"));
    assert.ok(Number(negative.getAttribute("height")) > 0);
    assert.equal(Number(zero.getAttribute("height")), 1, "zero remains inspectable without inventing a nonzero value");
    assert.equal(Number(positive.getAttribute("y")) + Number(positive.getAttribute("height")), baseline);
    assert.ok(Number(negative.getAttribute("x")) + Number(negative.getAttribute("width")) < Number(positive.getAttribute("x")));
    assert.equal(negative.getAttribute("cx"), positive.getAttribute("cx"), "series share the same observation position");
    assert.ok(bars.every(bar => Number(bar.getAttribute("x")) >= 72 && Number(bar.getAttribute("x")) + Number(bar.getAttribute("width")) <= 656));
    zero.dispatchEvent(new Event("focus"));
    assert.equal(result.inspections.at(-1).point.yValue, 0);
    negative.dispatchEvent(new Event("pointermove"));
    assert.equal(result.inspections.at(-1).point.yValue, -4);
    assert.equal(result.inspections.at(-1).series.label, "Statistic 0");
});

test("log bars start at the lower axis bound and omit nonpositive values", () => {
    const result = render([[1, 0, 10, -3, 100, null]], {chartType: "bar", yScale: "log"});
    assert.deepEqual(result.pointElements.map(({point}) => point.yValue), [1, 10, 100]);
    const bars = result.pointElements.map(({circle}) => circle);
    assert.equal(Number(bars[0].getAttribute("height")), 1);
    assert.equal(Number(bars[1].getAttribute("y")) + Number(bars[1].getAttribute("height")), 268);
    assert.equal(Number(bars[2].getAttribute("y")) + Number(bars[2].getAttribute("height")), 268);
    for (const value of [Number.MIN_VALUE, Number.MAX_VALUE]) {
        const extreme = render([[value]], {chartType: "bar", yScale: "log"});
        for (const {circle} of extreme.pointElements) {
            assert.ok(["x", "y", "width", "height"].every(name => Number.isFinite(Number(circle.getAttribute(name)))));
        }
    }
});

test("bars preserve native details and keyboard selection for a single observation", () => {
    const selections = [];
    const result = render([[2]], {chartType: "bar", onInspect: null, onPointSelect: point => selections.push(point)});
    const bar = result.pointElements[0].circle;
    assert.equal(Number(bar.getAttribute("cx")), 364);
    assert.equal(bar.getAttribute("role"), "button");
    assert.equal(bar.children[0].textContent, "Raster 0");
    assert.equal(bar.getAttribute("aria-label"), "Statistic 0: 2");
    bar.dispatchEvent(new Event("click"));
    const keyboard = new Event("keydown", {cancelable: true});
    keyboard.key = "Enter";
    bar.dispatchEvent(keyboard);
    assert.equal(keyboard.defaultPrevented, true);
    assert.deepEqual(selections.map(point => point.yValue), [2, 2]);
});

test("dense temporal bars keep every observation in separate horizontal slots", () => {
    const start = Date.UTC(2000, 0, 1);
    const points = Array.from({length: 744}, (_, index) => ({xLabel: String(index), xValue: start + index * 3600000, yValue: index + 1}));
    const result = render([], {series: [{id: "hourly", label: "Hourly values", points}], chartType: "bar", xScale: "numeric"});
    assert.equal(result.pointElements.length, 744);
    const bars = result.pointElements.map(({circle}) => circle);
    assert.ok(Number(bars[0].getAttribute("width")) > 0 && Number(bars[0].getAttribute("width")) < 1);
    for (let index = 1; index < bars.length; index++) {
        assert.ok(Number(bars[index - 1].getAttribute("x")) + Number(bars[index - 1].getAttribute("width")) < Number(bars[index].getAttribute("x")));
    }
});
