import assert from "node:assert/strict";
import test from "node:test";

import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { vectorInspectionObservation } from "../../src/vector/feature-inspector.js";
import { VectorFeatureProfileController } from "../../src/vector/feature-profile.js";
import { VectorTimeSeriesController } from "../../src/vector/time-series.js";

/**
 * Produce an inspected feature through the same contract used by composition.
 * @param {Record<string,string|number|null>} properties Feature attributes.
 * @param {string} [id="site"] Feature identity.
 * @return {import("../../src/vector/inspection-observation.js").VectorInspectionObservation}
 * Immutable chart input.
 */
function observation(properties, id = "site") {
    return vectorInspectionObservation({
        target: { sourceId: "catalog:depths", label: "Depth observations" },
        feature: { id, properties, bbox: [10, 20, 12, 22] },
        inspectionPosition: { lng: 11, lat: 21 },
    });
}

/**
 * Dispatch a real select change through a controller's registered handler.
 * @param {FakeRasterControlDocument} documentContext Controller document.
 * @param {string} selector Select ID.
 * @param {string} value New value.
 * @return {void}
 */
function change(documentContext, selector, value) {
    const select = documentContext.querySelector(selector);
    select.value = value;
    select.dispatchEvent(new Event("change"));
}

/**
 * Read horizontal painted centers, including rect geometry in bar mode.
 * @param {import("../../test-support/raster/fake-controls-document.js").FakeRasterControlElement}
 * chart Rendered SVG.
 * @return {number[]} Painted centers in observation order.
 */
function positions(chart) {
    return chart.querySelectorAll(".series-chart-point").map((point) =>
        point.tagName === "rect"
            ? Number(point.getAttribute("x")) + Number(point.getAttribute("width")) / 2
            : Number(point.getAttribute("cx"))
    );
}

/**
 * Check left-to-right order and the intended ratio between consecutive gaps.
 * @param {number[]} x Three painted horizontal centers.
 * @param {number} ratio Expected second gap divided by the first.
 * @return {void}
 */
function assertSpacing(x, ratio) {
    assert.equal(x.length, 3);
    assert.ok(x[0] < x[1] && x[1] < x[2], `Expected increasing positions: ${x}`);
    assert.ok(Math.abs((x[2] - x[1]) / (x[1] - x[0]) - ratio) < 1e-10);
}

/**
 * Read the visible horizontal tick labels in their painted left-to-right order.
 * @param {import("../../test-support/raster/fake-controls-document.js").FakeRasterControlElement}
 * chart Rendered SVG.
 * @return {string[]} Tick labels ordered by position.
 */
function axisLabels(chart) {
    return chart.querySelector(".series-chart-x-axis").querySelectorAll(".tick")
        .map(tick => ({
            x: Number(tick.getAttribute("transform").match(/^translate\(([^,]+)/)[1]),
            label: tick.querySelector("text").textContent,
        }))
        .sort((left, right) => left.x - right.x)
        .map(tick => tick.label);
}

for (const chartType of ["line", "scatter", "bar"]) {
    test(`feature ${chartType} follows numeric and categorical order without changing values`, () => {
        const documentContext = new FakeRasterControlDocument();
        const controller = new VectorFeatureProfileController({
            documentContext,
            onVisibilityChange() {},
            onPresentationChange() {},
            onNavigateFeature() {},
            onFeatureZoom() { return true; },
        });
        controller.setCurrentObservation(observation({ depth_2_cm: 0, depth_8_cm: -7, depth_26_cm: 11 }));
        change(documentContext, "#vector-feature-profile-chart-type", chartType);
        const chart = documentContext.querySelector("#vector-feature-profile-chart");
        const table = documentContext.querySelector("#vector-feature-profile-table-body");
        assertSpacing(positions(chart), 3);
        assert.deepEqual(axisLabels(chart), ["2", "8", "26"]);
        const ascendingY = chart.querySelectorAll(".series-chart-point").map(point => point.getAttribute("cy"));

        change(documentContext, "#vector-feature-profile-direction", "descending");
        assertSpacing(positions(chart), 1 / 3);
        assert.deepEqual(axisLabels(chart), ["26", "8", "2"]);
        assert.deepEqual(table.children.map(row => [row.children[0].children[0].textContent, ...row.children.slice(1).map(cell => cell.textContent)]), [
            ["depth_26_cm", "26", "11"], ["depth_8_cm", "8", "-7"], ["depth_2_cm", "2", "0"],
        ]);
        assert.deepEqual(chart.querySelectorAll(".series-chart-point").map(point => point.getAttribute("cy")), ascendingY.toReversed());
        assert.deepEqual(chart.querySelectorAll(".series-chart-point").map(point => point.getAttribute("aria-label")), [
            "depth_26_cm: 11", "depth_8_cm: -7", "depth_2_cm: 0",
        ]);

        controller.setCurrentObservation(observation({ depth_2_cm: 0, depth_8_cm: null, depth_26_cm: 11 }));
        const withGap = positions(chart);
        assert.equal(withGap.length, 2);
        assert.ok(withGap[0] < withGap[1]);
        assert.equal(table.children[1].children[2].textContent, "No value");
        assert.match(documentContext.querySelector("#vector-feature-profile-status").textContent, /One field has no numeric value/);
        if (chartType === "line") assert.doesNotMatch(chart.querySelector(".series-chart-line").getAttribute("d"), /L/);

        controller.setCurrentObservation(observation({ annual_CO2: 0, stored_CO2: -7, total_CO2: 11 }));
        documentContext.querySelector("#vector-feature-profile-clear-fields").dispatchEvent(new Event("click"));
        documentContext.querySelector("#vector-feature-profile-select-matching").dispatchEvent(new Event("click"));
        assertSpacing(positions(chart), 1);
        assert.deepEqual(axisLabels(chart), ["total_CO2", "stored_CO2", "annual_CO2"]);
        assert.deepEqual(table.children.map(row => row.children[1].textContent), ["total_CO2", "stored_CO2", "annual_CO2"]);
        change(documentContext, "#vector-feature-profile-direction", "ascending");
        assertSpacing(positions(chart), 1);
        assert.deepEqual(table.children.map(row => row.children[1].textContent), ["annual_CO2", "stored_CO2", "total_CO2"]);
        controller.destroy();
    });

    test(`across-feature ${chartType} keeps numeric positions, table and selection aligned`, () => {
        const documentContext = new FakeRasterControlDocument();
        const zoomed = [];
        const controller = new VectorTimeSeriesController({
            documentContext,
            onVisibilityChange() {},
            onPresentationChange() {},
            onFeatureZoom: focus => { zoomed.push(focus); return true; },
        });
        const samples = [
            observation({ depth: 8, score: -7, site: "Beta" }, "middle"),
            observation({ depth: 26, score: 11, site: "Gamma" }, "deep"),
            observation({ depth: 2, score: 0, site: "Alpha" }, "shallow"),
            observation({ depth: 14, score: null, site: "Delta" }, "missing"),
        ];
        controller.setSample({ state: "ready", observations: samples, message: "Ready" });
        const find = documentContext.querySelector("#vector-time-series-field-search");
        find.value = "score";
        documentContext.querySelector("#vector-time-series-select-matching").dispatchEvent(new Event("click"));
        change(documentContext, "#vector-time-series-x", "depth");
        change(documentContext, "#vector-time-series-chart-type", chartType);
        const chart = documentContext.querySelector("#vector-time-series-chart");
        const table = documentContext.querySelector("#vector-time-series-table-body");
        assertSpacing(positions(chart), 3);
        assert.deepEqual(axisLabels(chart), ["2", "8", "14", "26"]);

        change(documentContext, "#vector-time-series-direction", "descending");
        assertSpacing(positions(chart), 1 / 3);
        assert.deepEqual(axisLabels(chart), ["26", "14", "8", "2"]);
        assert.deepEqual(table.children.map(row => [row.children[0].children[0].textContent, row.children[0].textContent, row.children[1].children[0].textContent]), [
            ["Depth observations · deep", "26", "11"], ["Depth observations · missing", "14", "No value"],
            ["Depth observations · middle", "8", "-7"], ["Depth observations · shallow", "2", "0"],
        ]);
        assert.match(documentContext.querySelector("#vector-time-series-first").children.at(-1).textContent, /1 feature lacks/);
        const points = chart.querySelectorAll(".series-chart-point");
        points[0].dispatchEvent(new Event("click"));
        assert.match(documentContext.querySelector("#vector-time-series-selection-text").textContent, /Depth observations · deep/);
        const enter = new Event("keydown", { cancelable: true });
        Object.defineProperty(enter, "key", { value: "Enter" });
        points[2].dispatchEvent(enter);
        assert.equal(enter.defaultPrevented, true);
        assert.match(documentContext.querySelector("#vector-time-series-selection-text").textContent, /Depth observations · shallow/);
        documentContext.querySelector("#zoom-vector-time-series-feature").dispatchEvent(new Event("click"));
        assert.deepEqual(zoomed, [samples[2].focus]);

        change(documentContext, "#vector-time-series-x", "site");
        assertSpacing(positions(chart), 1 / 2);
        assert.deepEqual(axisLabels(chart), ["Gamma", "Delta", "Beta", "Alpha"]);
        assert.deepEqual(table.children.map(row => row.children[0].textContent), ["Gamma", "Delta", "Beta", "Alpha"]);
        change(documentContext, "#vector-time-series-direction", "ascending");
        assertSpacing(positions(chart), 2);
        assert.deepEqual(table.children.map(row => row.children[0].textContent), ["Alpha", "Beta", "Delta", "Gamma"]);
        change(documentContext, "#vector-time-series-x", "depth");
        assertSpacing(positions(chart), 3);
        controller.destroy();
    });
}
