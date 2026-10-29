import assert from "node:assert/strict";
import test from "node:test";

import { RasterPercentileControlsView } from "../../src/raster/percentile-controls-view.js";
import { DEFAULT_RASTER_STYLE } from "../../src/raster/style.js";
import { estimateRasterHistogramPercentile } from "../../src/raster/statistics.js";
import { RASTER_STATISTICS } from "../../test-support/raster/fixtures.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

const SETTINGS = { lower: 5, middle: 50, upper: 95, rescale: false };

test("percentile inspection reports immediate estimates and independent rescale choices", () => {
    const doc = new FakeRasterControlDocument();
    const received = [];
    const view = new RasterPercentileControlsView(doc, settings => received.push(settings));
    const second = new RasterPercentileControlsView(doc, () => assert.fail("Another histogram must remain untouched"));
    view.render(RASTER_STATISTICS, DEFAULT_RASTER_STYLE, SETTINGS, true, "");
    second.render(RASTER_STATISTICS, DEFAULT_RASTER_STYLE, SETTINGS, true, "");

    assert.equal(view.rescaleInput.checked, false);
    assert.match(view.values.lower.textContent, /^5% ≈ /);
    assert.equal(view.inputs.lower.getAttribute("aria-valuetext"), view.values.lower.textContent);
    view.inputs.lower.value = "20";
    view.inputs.lower.dispatchEvent(new Event("input"));
    assert.deepEqual(received, [{ ...SETTINGS, lower: 20 }]);
    assert.equal(view.markers[0].value, estimateRasterHistogramPercentile(RASTER_STATISTICS, 20));
    assert.equal(view.markers[0].label, "lower 20%");
    assert.equal(view.markers[0].color, DEFAULT_RASTER_STYLE.minimumColor);
    assert.equal(second.inputs.lower.value, "5");
    assert.equal(second.rescaleInput.checked, false);

    view.rescaleInput.checked = true;
    view.rescaleInput.dispatchEvent(new Event("change"));
    assert.deepEqual(received.at(-1), { ...SETTINGS, lower: 20, rescale: true });
    view.inputs.lower.focus();
    view.render(RASTER_STATISTICS, { ...DEFAULT_RASTER_STYLE, minimumColor: "#000000" }, received.at(-1), true, "");
    assert.ok(doc.activeElement === view.inputs.lower);
    assert.equal(view.inputs.lower.value, "20");
    assert.equal(view.markers[0].color, "#000000");

    view.dispose();
    view.inputs.lower.dispatchEvent(new Event("input"));
    view.rescaleInput.dispatchEvent(new Event("change"));
    assert.equal(received.length, 2);
    second.dispose();
});

test("invalid ordering prevents rescaling while unavailable results retain the off switch", () => {
    const view = new RasterPercentileControlsView(new FakeRasterControlDocument(), () => {});
    view.render(RASTER_STATISTICS, DEFAULT_RASTER_STYLE, SETTINGS, true, "");
    view.inputs.lower.value = "60";
    view.inputs.lower.dispatchEvent(new Event("input"));
    assert.match(view.status.textContent, /in increasing order/);
    assert.equal(view.inputs.lower.getAttribute("aria-invalid"), "true");
    assert.equal(view.rescaleInput.disabled, true);
    assert.deepEqual(view.markers, []);

    view.render(null, DEFAULT_RASTER_STYLE, { ...SETTINGS, rescale: true }, false, "Updating this histogram…");
    assert.equal(view.inputs.lower.disabled, true);
    assert.equal(view.rescaleInput.disabled, false);
    assert.equal(view.rescaleInput.checked, true);
    assert.equal(view.values.lower.textContent, "5% ≈ —");
    assert.equal(view.status.textContent, "Updating this histogram…");
    view.rescaleInput.checked = false;
    view.rescaleInput.dispatchEvent(new Event("change"));
    assert.equal(view.rescaleInput.disabled, true);

    view.render(RASTER_STATISTICS, DEFAULT_RASTER_STYLE, SETTINGS, false, "Add this raster to the map to rescale its colors.");
    assert.equal(view.inputs.lower.disabled, false);
    assert.equal(view.rescaleInput.disabled, true);
    assert.equal(view.inputs.lower.getAttribute("aria-invalid"), null);
    assert.equal(view.markers.length, 3);
    view.dispose();
});

test("constant histograms show their actual percentile values rather than expanded style limits", () => {
    const view = new RasterPercentileControlsView(new FakeRasterControlDocument(), () => {});
    const constant = { ...RASTER_STATISTICS, sampleMinimum: 7, sampleMaximum: 7,
        percentiles: { p05: 7, p50: 7, p95: 7 } };
    view.render(constant, DEFAULT_RASTER_STYLE, SETTINGS, true, "");
    assert.deepEqual(view.markers.map(marker => marker.value), [7, 7, 7]);
    assert.equal(view.rescaleInput.disabled, false);
    view.dispose();
});
