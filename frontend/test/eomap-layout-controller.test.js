import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    CONTROL_PANEL_TRANSITION_MILLISECONDS,
    EomapLayoutController,
} from "../src/eomap-layout-controller.js";

/** Minimal token-list contract used by the layout controller tests. */
class FakeClassList {
    /** Create a token list with optional initial class names. */
    constructor(...tokens) {
        this.tokens = new Set(tokens);
    }

    /**
     * Force one class token on or off.
     *
     * @param {string} token Class token.
     * @param {boolean} force Whether the class is present.
     * @return {void}
     */
    toggle(token, force) {
        if (force) {
            this.tokens.add(token);
        } else {
            this.tokens.delete(token);
        }
    }

    /**
     * Report whether one class token is present.
     *
     * @param {string} token Class token.
     * @return {boolean} Whether the token is present.
     */
    contains(token) {
        return this.tokens.has(token);
    }
}

/** Minimal focusable DOM element used by layout controller tests. */
class FakeLayoutElement extends EventTarget {
    /**
     * Create one element with mutable presentation state.
     *
     * @param {Object<string, string>} [attributes={}] Initial attributes.
     * @param {string[]} [classes=[]] Initial class tokens.
     * @param {string} [tagName="DIV"] Uppercase element tag name.
     */
    constructor(attributes = {}, classes = [], tagName = "DIV") {
        super();
        this.attributes = new Map(Object.entries(attributes));
        this.classList = new FakeClassList(...classes);
        this.descendants = new Set();
        this.hidden = false;
        this.inert = false;
        this.open = false;
        this.scrollTop = 0;
        this.textContent = "";
        this.focused = false;
        this.ownerDocument = null;
        this.tagName = tagName;
    }

    /**
     * Return one stored attribute.
     *
     * @param {string} name Attribute name.
     * @return {string|null} Attribute value or null when absent.
     */
    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    /**
     * Store one attribute value.
     *
     * @param {string} name Attribute name.
     * @param {string} value Attribute value.
     * @return {void}
     */
    setAttribute(name, value) {
        this.attributes.set(name, value);
    }

    /**
     * Remove one stored attribute.
     *
     * @param {string} name Attribute name.
     * @return {void}
     */
    removeAttribute(name) {
        this.attributes.delete(name);
    }

    /** Mark this element as the document focus target. @return {void} */
    focus() {
        this.focused = true;
        if (this.ownerDocument !== null) {
            this.ownerDocument.activeElement = this;
        }
    }

    /**
     * Register one descendant for focus-ownership tests.
     *
     * @param {FakeLayoutElement} element Descendant element.
     * @return {void}
     */
    addDescendant(element) {
        this.descendants.add(element);
    }

    /**
     * Report whether this element recursively contains a candidate.
     *
     * @param {FakeLayoutElement|null|undefined} element Candidate element.
     * @return {boolean} Whether this element contains the candidate.
     */
    contains(element) {
        if (element === this) {
            return true;
        }
        return [...this.descendants].some(
            (descendant) => descendant.contains(element)
        );
    }
}

/** Minimal queryable document and keyboard event target. */
class FakeLayoutDocument extends EventTarget {
    /**
     * Create a document backed by stable selector entries.
     *
     * @param {Map<string, FakeLayoutElement>} elements Selector entries.
     */
    constructor(elements) {
        super();
        this.elements = elements;
        this.activeElement = null;
        for (const element of elements.values()) {
            element.ownerDocument = this;
        }
    }

    /**
     * Resolve one registered layout element.
     *
     * @param {string} selector CSS selector.
     * @return {FakeLayoutElement|null} Registered element or null.
     */
    querySelector(selector) {
        return this.elements.get(selector) ?? null;
    }
}

/** Keyboard event with observable default prevention. */
class FakeKeyboardEvent extends Event {
    /**
     * Create one keyboard event.
     *
     * @param {string} key Keyboard key value.
     */
    constructor(key) {
        super("keydown", { cancelable: true });
        this.key = key;
    }
}

/**
 * Build the complete static layout contract and deterministic timer queue.
 *
 * @return {Object} Layout elements, document, scheduler, and timer queue.
 */
function createLayoutFixture() {
    const app = new FakeLayoutElement();
    const panel = new FakeLayoutElement();
    const collapsePanel = new FakeLayoutElement();
    const openPanel = new FakeLayoutElement();
    openPanel.hidden = true;
    const operationalRegion = new FakeLayoutElement();
    const operationalToggle = new FakeLayoutElement({
        "aria-expanded": "false",
    });
    const operationalBody = new FakeLayoutElement({
        "aria-hidden": "true",
    });
    operationalBody.hidden = true;
    operationalRegion.addDescendant(operationalToggle);
    operationalRegion.addDescendant(operationalBody);

    const catalogTab = new FakeLayoutElement({ "aria-expanded": "true" });
    const catalogRegion = new FakeLayoutElement();
    const catalogContent = new FakeLayoutElement();
    catalogRegion.addDescendant(catalogContent);
    const renderingTab = new FakeLayoutElement({ "aria-expanded": "false" });
    const renderingRegion = new FakeLayoutElement();
    const renderingContent = new FakeLayoutElement();
    renderingRegion.addDescendant(renderingContent);
    renderingRegion.hidden = true;
    const rasterAnalysisTab = new FakeLayoutElement({
        "aria-expanded": "false",
    });
    const rasterAnalysisRegion = new FakeLayoutElement();
    const rasterAnalysisContent = new FakeLayoutElement();
    const analysisAoiDisclosure = new FakeLayoutElement();
    const analysisAoiToggle = new FakeLayoutElement({
        "aria-expanded": "false",
    });
    analysisAoiDisclosure.addDescendant(analysisAoiToggle);
    rasterAnalysisRegion.addDescendant(analysisAoiDisclosure);
    rasterAnalysisRegion.addDescendant(rasterAnalysisContent);
    rasterAnalysisRegion.hidden = true;
    const openMapLayerHistograms = new FakeLayoutElement();
    const openHistogramMapLayers = new FakeLayoutElement();

    for (const child of [
        collapsePanel,
        operationalRegion,
        catalogTab,
        catalogRegion,
        renderingTab,
        renderingRegion,
        rasterAnalysisTab,
        rasterAnalysisRegion,
    ]) {
        panel.addDescendant(child);
    }
    const elements = new Map([
        ["#app", app],
        ["#control-panel", panel],
        ["#collapse-panel", collapsePanel],
        ["#open-panel", openPanel],
        ["#eomap-operational-status-region", operationalRegion],
        ["#toggle-operational-status", operationalToggle],
        ["#eomap-operational-status-body", operationalBody],
        ["#toggle-catalog-workspace", catalogTab],
        ["#eomap-catalog-region", catalogRegion],
        ["#toggle-map-layers", renderingTab],
        ["#eomap-map-layers-region", renderingRegion],
        ["#eomap-map-layers-body", renderingContent],
        ["#toggle-raster-interpretation", rasterAnalysisTab],
        ["#eomap-raster-interpretation-region", rasterAnalysisRegion],
        ["#eomap-raster-interpretation-body", rasterAnalysisContent],
        ["#open-map-layer-histograms", openMapLayerHistograms],
        ["#open-histogram-map-layers", openHistogramMapLayers],
        ["#analysis-aoi-disclosure", analysisAoiDisclosure],
        ["#toggle-analysis-aoi", analysisAoiToggle],
    ]);
    const timers = [];
    return {
        app,
        analysisAoiDisclosure,
        analysisAoiToggle,
        catalogContent,
        catalogRegion,
        catalogTab,
        collapsePanel,
        document: new FakeLayoutDocument(elements),
        openPanel,
        operationalBody,
        operationalRegion,
        operationalToggle,
        openHistogramMapLayers,
        openMapLayerHistograms,
        panel,
        rasterAnalysisContent,
        rasterAnalysisRegion,
        rasterAnalysisTab,
        renderingContent,
        renderingRegion,
        renderingTab,
        schedule(callback, delay) {
            timers.push({ callback, delay });
        },
        timers,
    };
}

test("workspace disclosures expose independent initial panel states", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });

    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.catalogRegion.getAttribute("aria-hidden"), "false");
    assert.equal(fixture.catalogTab.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.renderingRegion.hidden, true);
    assert.equal(fixture.renderingTab.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.rasterAnalysisRegion.hidden, true);
    assert.equal(
        fixture.app.classList.contains("is-expanded-catalog-workspace"),
        true
    );
    assert.equal(
        fixture.app.classList.contains("is-expanded-map-layers-workspace"),
        false
    );
    assert.equal(fixture.timers.length, 0);
    controller.destroy();
});

test("click toggles each workspace without changing its siblings", () => {
    const fixture = createLayoutFixture();
    let invalidationCount = 0;
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize: () => invalidationCount += 1,
        schedule: fixture.schedule,
    });

    fixture.renderingTab.dispatchEvent(new Event("click"));

    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.renderingRegion.hidden, false);
    assert.equal(fixture.rasterAnalysisRegion.hidden, true);
    assert.equal(fixture.renderingTab.getAttribute("aria-expanded"), "true");
    assert.equal(
        fixture.app.classList.contains("is-expanded-map-layers-workspace"),
        true
    );
    assert.equal(fixture.timers.length, 1);
    assert.equal(
        fixture.timers[0].delay,
        CONTROL_PANEL_TRANSITION_MILLISECONDS
    );

    fixture.rasterAnalysisTab.dispatchEvent(new Event("click"));
    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.renderingRegion.hidden, false);
    assert.equal(fixture.rasterAnalysisRegion.hidden, false);
    assert.equal(
        fixture.app.classList.contains("is-expanded-histogram-workspace"),
        true
    );

    fixture.renderingTab.dispatchEvent(new Event("click"));
    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.renderingRegion.hidden, true);
    assert.equal(fixture.rasterAnalysisRegion.hidden, false);
    assert.equal(fixture.timers.length, 3);
    for (const timer of fixture.timers) {
        timer.callback();
    }
    assert.equal(invalidationCount, 3);
    controller.destroy();
});

test("composition can expand a named workspace without closing siblings", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });
    fixture.collapsePanel.dispatchEvent(new Event("click"));
    fixture.openPanel.focused = false;

    fixture.rasterAnalysisContent.scrollTop = 240;
    controller.showWorkspace("histogram");

    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.openPanel.hidden, true);
    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.rasterAnalysisRegion.hidden, false);
    assert.equal(fixture.rasterAnalysisTab.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.rasterAnalysisTab.focused, false);
    assert.equal(fixture.rasterAnalysisContent.scrollTop, 0);
    assert.equal(fixture.timers.length, 3);
    assert.throws(
        () => controller.showWorkspace("statistics"),
        /Unknown EOMap workspace: statistics/
    );
    controller.destroy();
});

test("Map layers links to Histograms without a redundant styling shortcut", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });

    fixture.openMapLayerHistograms.dispatchEvent(new Event("click"));
    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.renderingRegion.hidden, true);
    assert.equal(fixture.rasterAnalysisRegion.hidden, false);
    assert.equal(fixture.rasterAnalysisTab.focused, true);

    controller.destroy();
});

test("composition can notify a CSS-driven layout allocation change", () => {
    const fixture = createLayoutFixture();
    let invalidationCount = 0;
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize: () => invalidationCount += 1,
        schedule: fixture.schedule,
    });

    controller.notifyLayoutChange();

    assert.equal(fixture.timers.length, 1);
    assert.equal(
        fixture.timers[0].delay,
        CONTROL_PANEL_TRANSITION_MILLISECONDS
    );
    fixture.timers[0].callback();
    assert.equal(invalidationCount, 1);
    controller.destroy();
});

test("operational status disclosure owns hidden state, Escape, and focus", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });

    assert.equal(fixture.operationalBody.hidden, true);
    assert.equal(fixture.operationalToggle.textContent, "Show status details");
    fixture.operationalToggle.dispatchEvent(new Event("click"));
    assert.equal(fixture.operationalBody.hidden, false);
    assert.equal(fixture.operationalBody.getAttribute("aria-hidden"), "false");
    assert.equal(fixture.operationalToggle.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.operationalToggle.textContent, "Hide status details");
    assert.equal(
        fixture.operationalRegion.classList.contains("is-collapsed"),
        false
    );

    fixture.document.activeElement = fixture.operationalBody;
    const escapeEvent = new FakeKeyboardEvent("Escape");
    fixture.document.dispatchEvent(escapeEvent);
    assert.equal(escapeEvent.defaultPrevented, true);
    assert.equal(fixture.operationalBody.hidden, true);
    assert.equal(fixture.operationalToggle.focused, true);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.timers.length, 2);
    controller.destroy();
});

test("whole sidebar collapse preserves workspace state, inertness, and focus", () => {
    const fixture = createLayoutFixture();
    let invalidationCount = 0;
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize: () => invalidationCount += 1,
        schedule: fixture.schedule,
    });
    fixture.renderingTab.dispatchEvent(new Event("click"));
    fixture.collapsePanel.dispatchEvent(new Event("click"));

    assert.equal(fixture.panel.classList.contains("is-collapsed"), true);
    assert.equal(fixture.panel.getAttribute("aria-hidden"), "true");
    assert.equal(fixture.panel.getAttribute("inert"), "");
    assert.equal(fixture.panel.inert, true);
    assert.equal(
        fixture.app.classList.contains("is-control-panel-collapsed"),
        true
    );
    assert.equal(fixture.openPanel.hidden, false);
    assert.equal(fixture.openPanel.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.collapsePanel.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.openPanel.focused, true);
    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.renderingRegion.hidden, false);

    fixture.openPanel.dispatchEvent(new Event("click"));
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.panel.getAttribute("aria-hidden"), "false");
    assert.equal(fixture.panel.getAttribute("inert"), null);
    assert.equal(fixture.panel.inert, false);
    assert.equal(fixture.openPanel.hidden, true);
    assert.equal(fixture.openPanel.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.collapsePanel.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.collapsePanel.focused, true);
    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.renderingRegion.hidden, false);
    assert.equal(fixture.timers.length, 3);
    for (const timer of fixture.timers) {
        timer.callback();
    }
    assert.equal(invalidationCount, 3);
    controller.destroy();
});

test("Escape inside a workspace collapses that panel and restores focus", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });
    fixture.document.activeElement = fixture.catalogContent;
    const escapeEvent = new FakeKeyboardEvent("Escape");

    fixture.document.dispatchEvent(escapeEvent);

    assert.equal(escapeEvent.defaultPrevented, true);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.catalogTab.focused, true);
    assert.equal(fixture.catalogTab.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.catalogRegion.hidden, true);
    assert.equal(fixture.timers.length, 1);
    controller.destroy();
});

test("Escape preserves native input handling and ignores outside focus", () => {
    const fixture = createLayoutFixture();
    const rasterInput = new FakeLayoutElement({}, [], "INPUT");
    fixture.rasterAnalysisRegion.addDescendant(rasterInput);
    rasterInput.ownerDocument = fixture.document;
    const outsideButton = new FakeLayoutElement({}, [], "BUTTON");
    outsideButton.ownerDocument = fixture.document;
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });

    fixture.document.activeElement = rasterInput;
    const inputEscape = new FakeKeyboardEvent("Escape");
    fixture.document.dispatchEvent(inputEscape);
    assert.equal(inputEscape.defaultPrevented, false);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);

    fixture.document.activeElement = outsideButton;
    const outsideEscape = new FakeKeyboardEvent("Escape");
    fixture.document.dispatchEvent(outsideEscape);
    assert.equal(outsideEscape.defaultPrevented, false);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.timers.length, 0);
    controller.destroy();
});

test("Escape closes the nearest AOI disclosure and restores summary focus", () => {
    const fixture = createLayoutFixture();
    const aoiAction = new FakeLayoutElement({}, [], "BUTTON");
    fixture.analysisAoiDisclosure.addDescendant(aoiAction);
    aoiAction.ownerDocument = fixture.document;
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });
    fixture.analysisAoiDisclosure.open = true;
    fixture.analysisAoiDisclosure.dispatchEvent(new Event("toggle"));
    fixture.document.activeElement = aoiAction;
    const escapeEvent = new FakeKeyboardEvent("Escape");

    fixture.analysisAoiDisclosure.dispatchEvent(escapeEvent);

    assert.equal(escapeEvent.defaultPrevented, true);
    assert.equal(fixture.analysisAoiDisclosure.open, false);
    assert.equal(
        fixture.analysisAoiToggle.getAttribute("aria-expanded"),
        "false"
    );
    assert.equal(fixture.analysisAoiToggle.focused, true);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    controller.destroy();
});

test("destroy detaches every workspace-layout listener", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });
    controller.destroy();

    fixture.renderingTab.dispatchEvent(new Event("click"));
    fixture.rasterAnalysisTab.dispatchEvent(new FakeKeyboardEvent("End"));
    fixture.operationalToggle.dispatchEvent(new Event("click"));
    fixture.collapsePanel.dispatchEvent(new Event("click"));
    fixture.openPanel.dispatchEvent(new Event("click"));
    fixture.analysisAoiDisclosure.open = true;
    fixture.analysisAoiDisclosure.dispatchEvent(new Event("toggle"));
    fixture.analysisAoiDisclosure.dispatchEvent(new FakeKeyboardEvent("Escape"));
    fixture.document.activeElement = fixture.catalogContent;
    fixture.document.dispatchEvent(new FakeKeyboardEvent("Escape"));

    assert.equal(fixture.catalogRegion.hidden, false);
    assert.equal(fixture.renderingRegion.hidden, true);
    assert.equal(fixture.rasterAnalysisRegion.hidden, true);
    assert.equal(fixture.operationalBody.hidden, true);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(
        fixture.analysisAoiToggle.getAttribute("aria-expanded"),
        "false"
    );
    assert.equal(fixture.analysisAoiDisclosure.open, true);
    assert.equal(fixture.timers.length, 0);
});

test("layout controller rejects incomplete DOM and invalid dependencies", () => {
    assert.throws(
        () => new EomapLayoutController({
            documentContext: { querySelector: () => null },
            invalidateMapSize() {},
            schedule() {},
        }),
        /Required EOMap layout element is missing: #app/
    );
    assert.throws(
        () => new EomapLayoutController({ invalidateMapSize: null }),
        /Map-size invalidation must be callable/
    );
    assert.throws(
        () => new EomapLayoutController({
            invalidateMapSize() {},
            schedule: null,
        }),
        /Layout transition scheduling must be callable/
    );
});

test("layout controller retains a feature-neutral dependency boundary", () => {
    const controllerSource = readFileSync(
        new URL("../src/eomap-layout-controller.js", import.meta.url),
        "utf8"
    );
    const controllerImports = [
        ...controllerSource.matchAll(/from\s+["']([^"']+)["']/g),
    ];

    assert.equal(controllerImports.length, 0);
    assert.doesNotMatch(controllerSource, /querySelector\("#catalog-search"/);
    assert.doesNotMatch(controllerSource, /querySelector\("#raster-/);
    assert.doesNotMatch(controllerSource, /fetch\(|L\.|leafletMap/);
    assert.doesNotMatch(
        controllerSource,
        /append\(|appendChild\(|insertBefore\(|replaceChildren\(|matchMedia\(/
    );
    assert.doesNotMatch(
        controllerSource,
        /open-catalog-workspace|open-tools-workspace|show-temporary-aoi-workspace/
    );
});
