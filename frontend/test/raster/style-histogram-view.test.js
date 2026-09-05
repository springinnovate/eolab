import assert from "node:assert/strict";
import test from "node:test";

import {
    RasterStyleHistogramView,
} from "../../src/raster/style-histogram-view.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";
import { RASTER_STATISTICS } from "../../test-support/raster/fixtures.js";
import {
    FakeRasterControlDocument,
} from "../../test-support/raster/fake-controls-document.js";

test("style histogram owns candidate markers, state, and analysis navigation", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterStyleHistogramView(documentContext);
    const opened = [];
    view.bind({ onOpenHistogram: () => opened.push("histogram") });

    view.render(
        RASTER_STATISTICS,
        DEFAULT_RASTER_STYLE,
        "200 km map sample",
        "Raster value (%)",
        { lower: 5, middle: 50, upper: 95 }
    );

    const root = documentContext.querySelector("#raster-style-histogram");
    const chart = documentContext.querySelector(
        "#raster-style-histogram-chart"
    );
    const markerGroup = chart.children.find((child) =>
        child.classList.contains("raster-histogram-thresholds")
    );
    assert.equal(root.hidden, false);
    assert.equal(root.getAttribute("aria-busy"), "false");
    assert.equal(
        documentContext.querySelector("#raster-style-histogram-scope")
            .textContent,
        "200 km map sample"
    );
    assert.match(chart.getAttribute("aria-label"), /Raster value \(%\)/);
    assert.match(chart.getAttribute("aria-label"), /lower 5%/);
    assert.equal(markerGroup.children.length, 9);
    assert.deepEqual(
        markerGroup.children.filter((child) =>
            child.classList.contains("raster-histogram-threshold")
        ).map((child) => child.style.stroke),
        [
            DEFAULT_RASTER_STYLE.minimumColor,
            DEFAULT_RASTER_STYLE.midpointColor,
            DEFAULT_RASTER_STYLE.maximumColor,
        ]
    );

    documentContext.querySelector("#open-raster-histogram-analysis")
        .dispatchEvent(new Event("click"));
    assert.deepEqual(opened, ["histogram"]);

    view.renderState("Whole raster", "Calculating…", true);
    assert.equal(root.getAttribute("aria-busy"), "true");
    assert.equal(chart.getAttribute("hidden"), "");
    assert.equal(
        documentContext.querySelector("#raster-style-histogram-status")
            .textContent,
        "Calculating…"
    );

    view.unbind();
    documentContext.querySelector("#open-raster-histogram-analysis")
        .dispatchEvent(new Event("click"));
    assert.deepEqual(opened, ["histogram"]);
    assert.equal(root.hidden, true);
});
