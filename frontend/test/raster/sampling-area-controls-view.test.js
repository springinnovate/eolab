import assert from "node:assert/strict";
import test from "node:test";

import {
    RasterSamplingAreaControlsView,
} from "../../src/raster/sampling-area-controls-view.js";
import {
    FakeRasterControlDocument,
} from "../../test-support/raster/fake-controls-document.js";

test("sampling-area adapter owns size, area choices, status, and listeners", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterSamplingAreaControlsView(documentContext);
    const received = [];
    view.bind({
        onSampleWindowRangeInput: (value) => received.push(["range", value]),
        onSampleWindowNumberInput: (value) => received.push(["number", value]),
        onSampleWindowNumberChange: (value) => received.push(["change", value]),
        onClearSampleWindow: () => received.push(["whole"]),
        onUseTemporaryAoi: () => received.push(["aoi"]),
    });
    view.setSampleWindowSize(80);
    view.setSampleWindowInvalid(true);
    view.setSampleWindowStatus("Select an area.");
    view.setClearSampleWindowEnabled(true);
    view.setClearSampleWindowLabel("Use whole raster");
    view.setTemporaryAoiAvailability({
        filename: "area.gpkg",
        selectedDataset: "boundary",
    });
    view.setSamplingAreaMode("temporaryAoi");
    for (const [selector, eventType] of [
        ["#raster-sample-window-range", "input"],
        ["#raster-sample-window-number", "input"],
        ["#raster-sample-window-number", "change"],
        ["#clear-raster-sample-window", "click"],
        ["#use-temporary-aoi-for-raster", "click"],
    ]) {
        documentContext.querySelector(selector).dispatchEvent(new Event(eventType));
    }

    assert.deepEqual(received, [
        ["range", "80"],
        ["number", "80"],
        ["change", "80"],
        ["whole"],
        ["aoi"],
    ]);
    assert.equal(
        documentContext.querySelector("#raster-sample-window-number")
            .getAttribute("aria-invalid"),
        "true"
    );
    assert.equal(
        documentContext.querySelector("#use-temporary-aoi-for-raster")
            .getAttribute("aria-pressed"),
        "true"
    );
    assert.match(
        documentContext.querySelector("#use-temporary-aoi-for-raster").title,
        /area\.gpkg.*boundary/
    );
    assert.throws(() => view.setClearSampleWindowLabel(""), /must not be blank/);

    view.unbind();
    documentContext.querySelector("#clear-raster-sample-window")
        .dispatchEvent(new Event("click"));
    assert.equal(received.length, 5);
});

test("sampling-area adapter requires its semantic subgroup root", () => {
    assert.throws(
        () => new RasterSamplingAreaControlsView({ querySelector: () => null }),
        /Required raster control is missing: #raster-sampling-area-controls/
    );
});
