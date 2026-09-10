import { readFileSync } from "node:fs";
import { FakeRasterControlDocument } from "../raster/fake-controls-document.js";

/** Current application markup used by every summary-view interaction test. */
export const SUMMARY_MARKUP = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

/** Keep the existing lightweight DOM behavior but never fabricate absent controls. */
export class SummaryControlDocument extends FakeRasterControlDocument {
    /** @param {string} [markup=SUMMARY_MARKUP] Current HTML, optionally mutated to test the contract. */
    constructor(markup = SUMMARY_MARKUP) {
        super();
        this.controlIds = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]));
        this.queries = new Set();
    }

    /**
     * Resolve only an ID declared in the supplied HTML.
     * @param {string} selector Exact ID selector used by the summary view.
     * @return {import("../raster/fake-controls-document.js").FakeRasterControlElement} Stable test node.
     * @throws {Error} If the view queries a control absent from current markup.
     */
    querySelector(selector) {
        if (!selector.startsWith("#") || !this.controlIds.has(selector.slice(1))) {
            throw new Error(`Summary control is absent from current HTML: ${selector}`);
        }
        this.queries.add(selector);
        return super.querySelector(selector);
    }
}
