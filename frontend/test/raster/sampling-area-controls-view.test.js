import assert from "node:assert/strict";
import test from "node:test";

import {
    RasterSamplingAreaControlsView,
} from "../../src/raster/sampling-area-controls-view.js";
import {
    FakeRasterControlDocument,
} from "../../test-support/raster/fake-controls-document.js";
import { MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM } from "../../src/raster/geometry.js";

test("sampling controls expose map boxes and vector selection without an upload choice", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterSamplingAreaControlsView(documentContext);
    const received = [];
    view.bind({ onSampleWindowRangeInput: value => received.push(value),
        onClearSampleWindow: () => received.push("whole"), onUseMapWindow: () => received.push("box") });
    view.setSampleWindowSize(80, MAXIMUM_RASTER_SAMPLE_WINDOW_SIZE_KM);
    view.setSamplingAreaMode("catalogSelection", "Vector selection · countries");
    assert.equal(documentContext.querySelector("#use-vector-for-raster").checked, true);
    assert.equal(documentContext.querySelector("#raster-map-box-controls").hidden, true);
    assert.equal(view.setTemporaryAoiAvailability, undefined);
    view.setSamplingAreaMode("selectedArea", "80 km box");
    assert.equal(documentContext.querySelector("#raster-map-box-controls").hidden, false);
    const choice = documentContext.querySelector("#use-map-window-for-raster");
    choice.dispatchEvent(new Event("change"));
    assert.deepEqual(received, ["box"]);
    view.unbind();
    choice.dispatchEvent(new Event("change"));
    assert.deepEqual(received, ["box"]);
    assert.throws(() => view.setSamplingAreaMode("other"), /Unknown raster sampling-area mode/);
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
