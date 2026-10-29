import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
    RasterStyleHistogramView,
} from "../../src/raster/style-histogram-view.js";
import { RasterControlsView } from "../../src/raster/controls-view.js";
import {
    FakeRasterControlDocument,
} from "../../test-support/raster/fake-controls-document.js";

test("categorical preview owns loading feedback and histogram navigation", () => {
    const documentContext = new FakeRasterControlDocument();
    const view = new RasterStyleHistogramView(documentContext);
    const opened = [];
    view.bind({ onOpenHistogram: () => opened.push("histogram") });
    view.renderState("Whole raster", "Calculating…", true);
    const root = documentContext.querySelector("#raster-style-histogram");
    assert.equal(root.hidden, false);
    assert.equal(root.getAttribute("aria-busy"), "true");
    assert.equal(documentContext.querySelector("#raster-style-histogram-status").textContent, "Calculating…");
    documentContext.querySelector("#open-raster-histogram-analysis").dispatchEvent(new Event("click"));
    assert.deepEqual(opened, ["histogram"]);
    view.unbind();
    documentContext.querySelector("#open-raster-histogram-analysis").dispatchEvent(new Event("click"));
    assert.deepEqual(opened, ["histogram"]);
    assert.equal(root.hidden, true);
});

test("style distribution markup is outside mode-specific control groups", () => {
    const markup = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    const mode = markup.indexOf('id="raster-appearance-mode"');
    const distribution = markup.indexOf('id="raster-style-histogram"');
    const continuous = markup.indexOf('id="raster-continuous-controls"');
    const categorical = markup.indexOf('id="raster-categorical-editor"');
    assert.ok(mode >= 0 && distribution > mode);
    assert.ok(continuous > distribution && categorical > continuous);
    assert.doesNotMatch(markup, /Categorical distributions and area proportions are not available yet/);
});

for (const boundary of ["view", "controls facade"]) {
    test(`${boundary} displays current scoped feedback alongside a previous distribution and clears it on success`, () => {
        const documentContext = new FakeRasterControlDocument();
        const direct = boundary === "view";
        const view = direct ? new RasterStyleHistogramView(documentContext) : new RasterControlsView(documentContext);
        const categorical = (...args) => direct ? view.renderCategorical(...args) : view.renderCategoricalStyleHistogram(...args);
        const root = documentContext.querySelector("#raster-style-histogram");
        const scope = documentContext.querySelector("#raster-style-histogram-scope");
        const status = documentContext.querySelector("#raster-style-histogram-status");
        const feedback = { message: "200 km map sample: Calculatingâ€¦", isBusy: true };
        const presentation = { validHectares: 1, nodataHectares: 0, sampledPixelCount: 1,
            rows: [{ code: 41, label: "Forest", hectares: 1, percentage: 100, color: "#008800", opacity: 1 }] };
        categorical(presentation, "Previous distribution", feedback);
        assert.equal(status.textContent, feedback.message);
        assert.equal(root.getAttribute("aria-busy"), "true");
        feedback.message = "200 km map sample: Histogram unavailable: No overlap"; feedback.isBusy = false;
        categorical(presentation, "Previous distribution Â· Whole raster", feedback);
        assert.equal(scope.textContent, "Previous distribution Â· Whole raster");
        assert.equal(status.textContent, feedback.message); assert.equal(root.getAttribute("aria-busy"), "false");
        assert.equal(root.children.at(-1).children.length, 1, "Categorical distribution stays visible beside the error");
        categorical(presentation, "200 km map sample");
        assert.equal(scope.textContent, "200 km map sample"); assert.equal(status.textContent, "");
        assert.equal(root.getAttribute("aria-busy"), "false");
    });
}
