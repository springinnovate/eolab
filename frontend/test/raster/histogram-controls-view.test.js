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

test("histogram adapter owns status, chart, retry, and disclosure", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(documentContext);
    const received = [];
    view.bind({
        onRetryStatistics: () => received.push("retry"),
    });
    const launcher = documentContext.querySelector(
        "#open-raster-histogram-widget"
    );
    launcher.hidden = true;
    view.setActiveRasterAvailable(true);
    view.setSamplingAreaMode("selectedArea");
    view.showWidget();
    view.setStatisticsBusy(true);
    view.setStatisticsStatus("Ready.");
    view.renderHistogram(RASTER_STATISTICS, DEFAULT_RASTER_STYLE);
    view.showHistogramAxis("≈ -10", "≈ 30");
    view.setStatisticsRetryVisible(true);
    view.enableActiveRasterActions();

    documentContext.querySelector("#retry-raster-statistics")
        .dispatchEvent(new Event("click"));

    assert.deepEqual(received, ["retry"]);
    assert.equal(launcher.hidden, false);
    assert.equal(launcher.getAttribute("aria-expanded"), "true");
    assert.equal(
        documentContext.querySelector("#raster-histogram").hidden,
        false
    );
    assert.deepEqual(
        documentContext.querySelector("#raster-histogram").scrollRequests,
        [{ block: "nearest", inline: "nearest" }]
    );
    assert.equal(
        documentContext.querySelector("#raster-histogram")
            .getAttribute("data-sampling-area"),
        "selectedArea"
    );
    assert.match(
        documentContext.querySelector("#raster-histogram-scope").textContent,
        /Map sample/
    );
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
    view.clearStatistics();
    assert.equal(
        documentContext.querySelector("#raster-histogram-chart")
            .getAttribute("hidden"),
        ""
    );

    documentContext.querySelector("#close-raster-histogram-widget")
        .dispatchEvent(new Event("click"));
    assert.equal(
        documentContext.querySelector("#raster-histogram").hidden,
        true
    );
    assert.equal(launcher.getAttribute("aria-expanded"), "false");
    assert.equal(documentContext.activeElement, launcher);

    launcher.dispatchEvent(new Event("click"));
    const escapeEvent = new Event("keydown", { cancelable: true });
    Object.defineProperty(escapeEvent, "key", { value: "Escape" });
    documentContext.querySelector("#raster-histogram")
        .dispatchEvent(escapeEvent);
    assert.equal(escapeEvent.defaultPrevented, true);
    assert.equal(
        documentContext.querySelector("#raster-histogram").hidden,
        true
    );

    view.unbind();
    documentContext.querySelector("#retry-raster-statistics")
        .dispatchEvent(new Event("click"));
    assert.equal(received.length, 1);
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

test("histogram adapter owns labeled per-raster summaries without double binding", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterHistogramControlsView(documentContext);
    const selected = [];
    view.bind({
        onRetryStatistics() {},
        onSelectHistogram: (key) => selected.push(key),
    });
    view.setActiveRasterAvailable(true);
    view.setActiveLayer("second-raster.tif");
    const summaries = [
        {
            key: "first",
            label: "first-raster.tif",
            state: "ready",
            scope: "200 km map sample",
            counts: [1, 4, 2],
        },
        {
            key: "second",
            label: "second-raster.tif",
            state: "loading",
            scope: "200 km map sample",
            counts: null,
        },
    ];

    view.renderLayerHistograms(summaries, "second");
    const list = documentContext.querySelector("#raster-histogram-list");
    const firstButton = list.children[0];
    const secondButton = list.children[1];
    firstButton.dispatchEvent(new Event("click"));
    view.showWidget();

    assert.deepEqual(selected, ["first"]);
    assert.equal(list.children.length, 2);
    assert.equal(firstButton.getAttribute("aria-label"),
        "Histogram — first-raster.tif");
    assert.equal(
        firstButton.getAttribute("aria-controls"),
        "raster-histogram"
    );
    assert.equal(firstButton.children.at(-1).classNames.includes(
        "raster-histogram-summary-preview"
    ), true);
    assert.equal(secondButton.getAttribute("aria-expanded"), "true");
    assert.equal(
        documentContext.querySelector("#raster-histogram-empty").hidden,
        true
    );
    assert.equal(
        documentContext.querySelector("#raster-histogram-detail-layer")
            .textContent,
        "second-raster.tif"
    );

    secondButton.focus();
    view.renderLayerHistograms(summaries, "first");
    assert.equal(documentContext.activeElement, list.children[1]);
    firstButton.dispatchEvent(new Event("click"));
    list.children[0].dispatchEvent(new Event("click"));
    assert.deepEqual(selected, ["first", "first"]);

    view.unbind();
    list.children[0].dispatchEvent(new Event("click"));
    assert.deepEqual(selected, ["first", "first"]);
});
