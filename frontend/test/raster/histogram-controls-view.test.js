import assert from "node:assert/strict";
import test from "node:test";

import {
    RasterHistogramControlsView,
} from "../../src/raster/histogram-controls-view.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";
import { RASTER_STATISTICS } from "../../test-support/raster/fixtures.js";
import {
    FakeRasterControlDocument,
    FakeRasterControlElement,
} from "../../test-support/raster/fake-controls-document.js";

test("histogram adapter owns status, chart, percentiles, and listeners", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(documentContext);
    const received = [];
    view.bind({
        onPercentileInput: () => received.push("percentile"),
        onApplyPercentiles: () => received.push("apply"),
        onRetryStatistics: () => received.push("retry"),
    });
    view.resetPercentiles({ lower: 5, middle: 50, upper: 95 });
    view.setStatisticsBusy(true);
    view.setStatisticsStatus("Ready.");
    view.renderHistogram(RASTER_STATISTICS, DEFAULT_RASTER_STYLE);
    view.showHistogramAxis("≈ -10", "≈ 30");
    view.setPercentileControlsVisible(true);
    view.setStatisticsRetryVisible(true);
    view.enableActiveRasterActions();
    view.renderPercentileValues(
        { lower: 5, middle: 50, upper: 95 },
        { lower: "-4", middle: "3", upper: "20" },
        true,
        true
    );

    documentContext.querySelector("#raster-lower-percentile")
        .dispatchEvent(new Event("input"));
    documentContext.querySelector("#apply-raster-percentiles")
        .dispatchEvent(new Event("click"));
    documentContext.querySelector("#retry-raster-statistics")
        .dispatchEvent(new Event("click"));

    assert.deepEqual(view.readPercentiles(), {
        lower: 5,
        middle: 50,
        upper: 95,
    });
    assert.deepEqual(received, ["percentile", "apply", "retry"]);
    assert.equal(
        documentContext.querySelector("#raster-histogram")
            .getAttribute("aria-busy"),
        "true"
    );
    assert.equal(
        documentContext.querySelector("#raster-histogram-chart")
            .getAttribute("hidden"),
        null
    );
    assert.equal(
        documentContext.querySelector("#raster-middle-percentile-value")
            .textContent,
        "50% ≈ 3"
    );

    view.renderPercentileValues(
        { lower: 50, middle: 5, upper: 95 },
        { lower: "3", middle: "-4", upper: "20" },
        false,
        true
    );
    assert.equal(
        documentContext.querySelector("#apply-raster-percentiles").disabled,
        true
    );
    view.clearStatistics();
    assert.equal(
        documentContext.querySelector("#raster-histogram-chart")
            .getAttribute("hidden"),
        ""
    );

    view.unbind();
    documentContext.querySelector("#retry-raster-statistics")
        .dispatchEvent(new Event("click"));
    assert.equal(received.length, 3);
});

test("histogram adapter clears an independently populated chart", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(documentContext);
    const chart = documentContext.querySelector("#raster-histogram-chart");
    chart.append(new FakeRasterControlElement());

    view.clearHistogram();

    assert.equal(chart.children.length, 0);
    assert.equal(chart.getAttribute("hidden"), "");
});
