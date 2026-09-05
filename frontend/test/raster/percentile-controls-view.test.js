import assert from "node:assert/strict";
import test from "node:test";

import {
    RasterPercentileControlsView,
} from "../../src/raster/percentile-controls-view.js";
import {
    FakeRasterControlDocument,
} from "../../test-support/raster/fake-controls-document.js";

test("percentile adapter owns values, feedback, visibility, and listeners", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterPercentileControlsView(documentContext);
    const received = [];
    view.bind({
        onPercentileInput: () => received.push("input"),
        onApplyPercentiles: () => received.push("apply"),
    });

    view.resetPercentiles({ lower: 5, middle: 50, upper: 95 });
    view.setPercentileControlsVisible(true);
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

    assert.deepEqual(view.readPercentiles(), {
        lower: 5,
        middle: 50,
        upper: 95,
    });
    assert.deepEqual(received, ["input", "apply"]);
    assert.equal(
        documentContext.querySelector("#raster-percentile-controls").hidden,
        false
    );
    assert.equal(
        documentContext.querySelector("#raster-middle-percentile-value")
            .textContent,
        "50% ≈ 3"
    );
    assert.equal(
        documentContext.querySelector("#apply-raster-percentiles").disabled,
        false
    );
    assert.equal(
        documentContext.querySelector("#apply-raster-percentiles")
            .textContent,
        "Apply 5/50/95 stretch to map"
    );

    view.renderPercentileValues(
        { lower: 50, middle: 5, upper: 95 },
        { lower: "3", middle: "-4", upper: "20" },
        false,
        true
    );
    assert.equal(
        documentContext.querySelector("#raster-lower-percentile")
            .getAttribute("aria-invalid"),
        "true"
    );
    assert.match(
        documentContext.querySelector("#raster-percentile-error").textContent,
        /in increasing order/
    );
    assert.equal(
        documentContext.querySelector("#apply-raster-percentiles").disabled,
        true
    );

    view.setApplyPercentilesEnabled(true);
    view.setPercentileControlsVisible(false);
    assert.equal(
        documentContext.querySelector("#apply-raster-percentiles").disabled,
        false
    );
    assert.equal(
        documentContext.querySelector("#raster-percentile-controls").hidden,
        true
    );

    view.unbind();
    documentContext.querySelector("#raster-lower-percentile")
        .dispatchEvent(new Event("input"));
    documentContext.querySelector("#apply-raster-percentiles")
        .dispatchEvent(new Event("click"));
    assert.deepEqual(received, ["input", "apply"]);
});

test("percentile adapter fails fast when its semantic root is missing", () => {
    assert.throws(
        () => new RasterPercentileControlsView({ querySelector: () => null }),
        /Required raster control is missing: #raster-percentile-controls/
    );
});
