import test from "node:test";
import assert from "node:assert/strict";
import { renderModelResult } from "../../src/models/result-view.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";
import { clipResult } from "../../test-support/models/fixtures.js";

/** Render one validated result without Catalog, map or controller collaborators.
 * @param {Object} result Saved result metadata.
 * @return {string[]} Text from the raster result card.
 */
function getResultCardText(result) {
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
    renderModelResult(root, result, element);
    return root.children[0].children.map(node => node.textContent);
}

test("period-map result shows saved observations, units and per-pixel missing-data meaning", () => {
    const temporalCoverage = {unit: "K", observationCount: 3,
        firstObservation: "2000-01-01T00:00:00Z", lastObservation: "2000-01-03T12:00:00Z"};
    const text = getResultCardText({...clipResult, label: "Period map", temporalCoverage});
    assert.ok(text.includes("Units: K"));
    assert.ok(text.includes("Observations in this run: 3"));
    assert.ok(text.includes("First observation: 2000-01-01 00:00:00 UTC"));
    assert.ok(text.includes("Last observation: 2000-01-03 12:00:00 UTC"));
    assert.ok(text.includes("Missing values are excluded at each pixel. The count map shows how many valid observations contributed there."));
    assert.ok(text.includes("10 × 10 pixels · 90 valid pixels"));
});

test("ordinary raster results do not show temporal coverage", () => {
    const text = getResultCardText(clipResult);
    assert.equal(text.some(value => /observation|Units:/.test(value)), false);
    assert.ok(text.includes(clipResult.label));
    assert.ok(text.includes("10 × 10 pixels · 90 valid pixels"));
});
