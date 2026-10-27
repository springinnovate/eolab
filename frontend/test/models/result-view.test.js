import test from "node:test";
import assert from "node:assert/strict";
import { renderModelResult } from "../../src/models/result-view.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { clipResult, fileManifest, timeSeriesResult } from "../../test-support/models/fixtures.js";

/** Render one validated result without Catalog, map or controller collaborators.
 * @param {Object} result Saved result metadata.
 * @param {Object|null} [manifest=null] Available result files, or null before the inventory loads.
 * @return {string[]} Text from the result card.
 */
function getResultCardText(result, manifest = null) {
    const document = new FakeRasterControlDocument();
    const root = document.createElement("section");
    /** Create a result-card element with its displayed text.
     * @param {string} tag HTML tag.
     * @param {string} [text=""] Displayed text.
     * @param {string} [className=""] Presentation class.
     * @return {HTMLElement} Result element.
     */
    function element(tag, text = "", className = "") {
        const node = document.createElement(tag);
        node.textContent = text;
        node.className = className;
        return node;
    }
    renderModelResult(root, result, manifest, element, () => {});
    return root.children[0].children.map(node => node.textContent);
}

test("temporal raster results show saved coverage without assuming count files or missing-data rules", () => {
    const temporalCoverage = {unit: "K", observationCount: 3,
        firstObservation: "2000-01-01T00:00:00Z", lastObservation: "2000-01-03T12:00:00Z"};
    const manifest = fileManifest();
    manifest.files[1] = {...manifest.files[1], name: "count", label: "Valid observation count",
        displayName: "Valid observation count", role: "result"};
    for (const files of [manifest.files.slice(0, 1), manifest.files]) {
        const text = getResultCardText({...clipResult, label: "Period map", temporalCoverage}, {...manifest, files});
        assert.ok(text.includes("Units: K"));
        assert.ok(text.includes("Observations in this run: 3"));
        assert.ok(text.includes("First observation: 2000-01-01 00:00:00 UTC"));
        assert.ok(text.includes("Last observation: 2000-01-03 12:00:00 UTC"));
        assert.equal(text.some(value => /missing values|count map/i.test(value)), false);
        assert.ok(text.includes("10 × 10 pixels · 90 valid pixels"));
    }
});

test("ordinary raster results do not show temporal coverage", () => {
    const text = getResultCardText(clipResult);
    assert.equal(text.some(value => /observation|Units:/.test(value)), false);
    assert.ok(text.includes(clipResult.label));
    assert.ok(text.includes("10 × 10 pixels · 90 valid pixels"));
});

test("time-series results name each saved calculation and omit unspecified shared units", () => {
    const text = getResultCardText({...timeSeriesResult,
        calculations: [{label: "mean", expression: "mean(a)"}, {label: "Positive area", expression: "areaha(a > 0)"}],
        temporalCoverage: {...timeSeriesResult.temporalCoverage, unit: ""}});
    assert.ok(text.includes("Statistic: Mean"));
    assert.ok(text.includes("Statistic: Positive area"));
    assert.ok(text.includes("mean(a)"));
    assert.ok(text.includes("areaha(a > 0)"));
    assert.equal(text.some(value => value.startsWith("Units:")), false);
    assert.ok(text.includes("Observations in this run: 3"));
    assert.ok(text.includes("Download the CSV for values and per-calculation pixel counts."));
});
