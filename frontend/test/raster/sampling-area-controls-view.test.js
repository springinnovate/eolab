import assert from "node:assert/strict";
import test from "node:test";

import {
    RasterSamplingAreaControlsView,
} from "../../src/raster/sampling-area-controls-view.js";
import {
    FakeRasterControlDocument,
} from "../../test-support/raster/fake-controls-document.js";
import { MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM } from "../../src/raster/geometry.js";

test("sampling-area adapter owns size, area choices, status, and listeners", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterSamplingAreaControlsView(documentContext);
    const received = [];
    view.bind({
        onSampleWindowRangeInput: (value) => received.push(["range", value]),
        onSampleWindowNumberInput: (value) => received.push(["number", value]),
        onSampleWindowNumberChange: (value) => received.push(["change", value]),
        onClearSampleWindow: () => received.push(["whole"]),
        onUseMapWindow: () => received.push(["box"]),
        onUseTemporaryAoi: () => received.push(["aoi"]),
    });
    view.setSampleWindowSize(80, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
    view.setSampleWindowInvalid(true);
    view.setSampleWindowStatus("Select an area.");
    view.setClearSampleWindowLabel("Use whole raster");
    view.setTemporaryAoiAvailability({
        filename: "area.gpkg",
        selectedDataset: "boundary",
    });
    view.setSamplingAreaMode("temporaryAoi", "AOI · area.gpkg · boundary");
    const wholeChoice = documentContext.querySelector(
        "#clear-raster-sample-window"
    );
    const mapBoxChoice = documentContext.querySelector(
        "#use-map-window-for-raster"
    );
    const aoiChoice = documentContext.querySelector(
        "#use-temporary-aoi-for-raster"
    );
    for (const [selector, eventType] of [
        ["#raster-sample-window-range", "input"],
        ["#raster-sample-window-number", "input"],
        ["#raster-sample-window-number", "change"],
    ]) {
        documentContext.querySelector(selector).dispatchEvent(new Event(eventType));
    }
    wholeChoice.checked = true;
    wholeChoice.dispatchEvent(new Event("change"));
    mapBoxChoice.checked = true;
    mapBoxChoice.dispatchEvent(new Event("change"));
    aoiChoice.checked = true;
    aoiChoice.dispatchEvent(new Event("change"));

    assert.deepEqual(received, [
        ["range", "80"],
        ["number", "80"],
        ["change", "80"],
        ["whole"],
        ["box"],
        ["aoi"],
    ]);
    assert.equal(
        documentContext.querySelector("#raster-sample-window-number")
            .getAttribute("aria-invalid"),
        "true"
    );
    assert.equal(
        documentContext.querySelector("#raster-sampling-area-summary")
            .textContent,
        "AOI · area.gpkg · boundary"
    );
    assert.equal(aoiChoice.checked, true);
    assert.equal(
        documentContext.querySelector("#raster-sampling-aoi-detail").textContent,
        "area.gpkg · boundary"
    );
    assert.match(
        documentContext.querySelector("#use-temporary-aoi-for-raster").title,
        /area\.gpkg.*boundary/
    );
    assert.throws(() => view.setClearSampleWindowLabel(""), /must not be blank/);

    view.unbind();
    wholeChoice.dispatchEvent(new Event("change"));
    assert.equal(received.length, 6);
});

test("sampling-area adapter presents unavailable AOI and selected map box", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterSamplingAreaControlsView(documentContext);

    view.setTemporaryAoiAvailability({
        filename: "area.gpkg",
        selectedDataset: "boundary",
    });
    view.setTemporaryAoiCompatible(false);
    view.setSamplingAreaMode(
        "selectedArea",
        "75 km × 75 km map box"
    );

    assert.equal(
        documentContext.querySelector("#use-map-window-for-raster").checked,
        true
    );
    assert.equal(
        documentContext.querySelector("#raster-map-box-controls").hidden,
        false
    );
    assert.equal(
        documentContext.querySelector("#use-temporary-aoi-for-raster").disabled,
        true
    );
    assert.match(
        documentContext.querySelector("#raster-sampling-aoi-detail").textContent,
        /Unavailable/
    );
    assert.throws(
        () => view.setSamplingAreaMode("other"),
        /Unknown raster sampling-area mode/
    );
});

test("sampling-area adapter requires its semantic subgroup root", () => {
    assert.throws(
        () => new RasterSamplingAreaControlsView({ querySelector: () => null }),
        /Required raster control is missing: #raster-sampling-area-controls/
    );
});

test("logarithmic box controls preserve exact kilometers and accessible values", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterSamplingAreaControlsView(documentContext);
    const range = documentContext.querySelector("#raster-sample-window-range");
    const number = documentContext.querySelector("#raster-sample-window-number");
    const received = [];
    view.bind({ onSampleWindowRangeInput: value => received.push(Number(value)) });
    view.setSampleWindowSize(200, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
    assert.equal(number.value, "200");
    assert.equal(number.max, String(MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM));
    for (const size of [1, 80, 200, 301, 1000, 5000, 10000, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM]) {
        view.setSampleWindowSize(size, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
        assert.equal(number.value, String(size));
        assert.equal(range.getAttribute("aria-valuetext"), `${size} kilometers`);
        range.dispatchEvent(new Event("input"));
        assert.equal(received.at(-1), size);
    }
    range.value = "500";
    range.dispatchEvent(new Event("input"));
    // Midpoint retains useful local precision instead of being a 7,000 km box.
    assert.ok(received.at(-1) > 100 && received.at(-1) < 150);
    range.value = range.min;
    range.dispatchEvent(new Event("input"));
    assert.equal(received.at(-1), 1);
    range.value = range.max;
    range.dispatchEvent(new Event("input"));
    assert.equal(received.at(-1), MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
    view.unbind();
});

test("keyboard slider steps advance small boxes and support range endpoints", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterSamplingAreaControlsView(documentContext);
    const range = documentContext.querySelector("#raster-sample-window-range");
    const received = [];
    view.bind({onSampleWindowRangeInput: value => received.push(Number(value))});
    view.setSampleWindowSize(1, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
    for (const [key, expected] of [["ArrowRight", 2], ["ArrowUp", 3], ["ArrowLeft", 2],
        ["ArrowDown", 1], ["ArrowLeft", 1], ["End", MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM],
        ["ArrowRight", MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM], ["Home", 1]]) {
        const event = new Event("keydown", {cancelable: true});
        event.key = key;
        range.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        assert.equal(received.at(-1), expected);
        assert.equal(range.getAttribute("aria-valuetext"), `${expected} kilometers`);
    }
    view.unbind();
    const before = received.length;
    const event = new Event("keydown"); event.key = "ArrowRight";
    range.dispatchEvent(event);
    assert.equal(received.length, before);
});
