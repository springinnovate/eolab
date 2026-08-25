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
        this.textContent = "";
        this.focused = false;
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

    /** Mark this element as the focus target. @return {void} */
    focus() {
        this.focused = true;
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
     * Report whether an element is this element or a registered descendant.
     *
     * @param {FakeLayoutElement|null|undefined} element Candidate element.
     * @return {boolean} Whether this element contains the candidate.
     */
    contains(element) {
        return element === this || this.descendants.has(element);
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
    const app = new FakeLayoutElement({}, ["is-catalog-workspace"]);
    const panel = new FakeLayoutElement();
    const collapsePanel = new FakeLayoutElement();
    const openPanel = new FakeLayoutElement();
    openPanel.hidden = true;
    const catalogToggle = new FakeLayoutElement({ "aria-expanded": "true" });
    catalogToggle.textContent = "Minimize catalog";
    const inspector = new FakeLayoutElement({ "aria-hidden": "false" });
    const catalogRegion = new FakeLayoutElement();
    catalogRegion.addDescendant(catalogToggle);
    catalogRegion.addDescendant(inspector);
    const operationalRegion = new FakeLayoutElement();
    const operationalToggle = new FakeLayoutElement({
        "aria-expanded": "true",
    });
    const operationalBody = new FakeLayoutElement({
        "aria-hidden": "false",
    });
    operationalRegion.addDescendant(operationalToggle);
    operationalRegion.addDescendant(operationalBody);
    const mapLayersRegion = new FakeLayoutElement();
    const mapLayersToggle = new FakeLayoutElement({
        "aria-expanded": "true",
    });
    const mapLayersBody = new FakeLayoutElement({ "aria-hidden": "false" });
    mapLayersRegion.addDescendant(mapLayersToggle);
    mapLayersRegion.addDescendant(mapLayersBody);
    const rasterRegion = new FakeLayoutElement();
    const rasterToggle = new FakeLayoutElement({
        "aria-expanded": "true",
    });
    const rasterBody = new FakeLayoutElement({ "aria-hidden": "false" });
    rasterRegion.addDescendant(rasterToggle);
    rasterRegion.addDescendant(rasterBody);
    const elements = new Map([
        ["#app", app],
        ["#control-panel", panel],
        ["#collapse-panel", collapsePanel],
        ["#open-panel", openPanel],
        ["#toggle-catalog-workspace", catalogToggle],
        ["#catalog-item-inspector", inspector],
        ["#eomap-catalog-region", catalogRegion],
        ["#eomap-operational-status-region", operationalRegion],
        ["#toggle-operational-status", operationalToggle],
        ["#eomap-operational-status-body", operationalBody],
        ["#eomap-map-layers-region", mapLayersRegion],
        ["#toggle-map-layers", mapLayersToggle],
        ["#eomap-map-layers-body", mapLayersBody],
        ["#eomap-raster-interpretation-region", rasterRegion],
        ["#toggle-raster-interpretation", rasterToggle],
        ["#eomap-raster-interpretation-body", rasterBody],
    ]);
    const timers = [];
    return {
        app,
        catalogToggle,
        collapsePanel,
        catalogRegion,
        document: new FakeLayoutDocument(elements),
        inspector,
        mapLayersBody,
        mapLayersRegion,
        mapLayersToggle,
        openPanel,
        operationalBody,
        operationalRegion,
        operationalToggle,
        panel,
        rasterBody,
        rasterRegion,
        rasterToggle,
        schedule(callback, delay) {
            timers.push({ callback, delay });
        },
        timers,
    };
}

test("Catalog workspace disclosure owns classes, ARIA, and invalidation timing", () => {
    const fixture = createLayoutFixture();
    let invalidationCount = 0;
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize: () => invalidationCount += 1,
        schedule: fixture.schedule,
    });

    fixture.catalogToggle.dispatchEvent(new Event("click"));

    assert.equal(fixture.app.classList.contains("is-catalog-workspace"), false);
    assert.equal(fixture.catalogToggle.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.catalogToggle.textContent, "Expand catalog");
    assert.equal(fixture.inspector.getAttribute("aria-hidden"), "true");
    assert.equal(fixture.inspector.hidden, true);
    assert.equal(invalidationCount, 0);
    assert.equal(fixture.timers.length, 1);
    assert.equal(
        fixture.timers[0].delay,
        CONTROL_PANEL_TRANSITION_MILLISECONDS
    );

    fixture.timers.shift().callback();
    assert.equal(invalidationCount, 1);

    fixture.catalogToggle.dispatchEvent(new Event("click"));
    assert.equal(fixture.app.classList.contains("is-catalog-workspace"), true);
    assert.equal(fixture.catalogToggle.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.catalogToggle.textContent, "Minimize catalog");
    assert.equal(fixture.inspector.getAttribute("aria-hidden"), "false");
    assert.equal(fixture.inspector.hidden, false);
    controller.destroy();
});

test("panel collapse and reopen preserve state, ARIA, inertness, and focus", () => {
    const fixture = createLayoutFixture();
    let invalidationCount = 0;
    new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize: () => invalidationCount += 1,
        schedule: fixture.schedule,
    });

    fixture.collapsePanel.dispatchEvent(new Event("click"));

    assert.equal(fixture.panel.classList.contains("is-collapsed"), true);
    assert.equal(fixture.panel.getAttribute("aria-hidden"), "true");
    assert.equal(fixture.panel.getAttribute("inert"), "");
    assert.equal(fixture.panel.inert, true);
    assert.equal(fixture.openPanel.hidden, false);
    assert.equal(fixture.openPanel.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.collapsePanel.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.openPanel.focused, true);
    assert.equal(fixture.catalogToggle.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.timers.length, 1);

    fixture.openPanel.dispatchEvent(new Event("click"));

    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.panel.getAttribute("aria-hidden"), "false");
    assert.equal(fixture.panel.getAttribute("inert"), null);
    assert.equal(fixture.panel.inert, false);
    assert.equal(fixture.openPanel.hidden, true);
    assert.equal(fixture.openPanel.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.collapsePanel.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.collapsePanel.focused, true);
    assert.equal(fixture.catalogToggle.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.timers.length, 2);
    for (const timer of fixture.timers) {
        timer.callback();
    }
    assert.equal(invalidationCount, 2);
});

test("workspace disclosures own independent hidden, ARIA, and layout state", () => {
    const fixture = createLayoutFixture();
    let invalidationCount = 0;
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize: () => invalidationCount += 1,
        schedule: fixture.schedule,
    });

    fixture.mapLayersToggle.dispatchEvent(new Event("click"));

    assert.equal(fixture.mapLayersBody.hidden, true);
    assert.equal(fixture.mapLayersBody.getAttribute("aria-hidden"), "true");
    assert.equal(
        fixture.mapLayersRegion.classList.contains("is-collapsed"),
        true
    );
    assert.equal(fixture.mapLayersToggle.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.mapLayersToggle.textContent, "Expand map and layers");
    assert.equal(fixture.operationalBody.hidden, false);
    assert.equal(fixture.rasterBody.hidden, false);
    assert.equal(fixture.timers.length, 1);
    fixture.timers.shift().callback();
    assert.equal(invalidationCount, 1);

    fixture.mapLayersToggle.dispatchEvent(new Event("click"));
    assert.equal(fixture.mapLayersBody.hidden, false);
    assert.equal(fixture.mapLayersBody.getAttribute("aria-hidden"), "false");
    assert.equal(fixture.mapLayersToggle.textContent, "Collapse map and layers");
    controller.destroy();
});

test("Escape collapses only the focused workspace and returns toggle focus", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });
    fixture.document.activeElement = fixture.rasterBody;
    const escapeEvent = new FakeKeyboardEvent("Escape");

    fixture.document.dispatchEvent(escapeEvent);

    assert.equal(escapeEvent.defaultPrevented, true);
    assert.equal(fixture.rasterBody.hidden, true);
    assert.equal(fixture.rasterToggle.focused, true);
    assert.equal(fixture.mapLayersBody.hidden, false);
    assert.equal(fixture.catalogToggle.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.timers.length, 1);
    controller.destroy();
});

test("Escape minimizes focused Catalog workspace and returns disclosure focus", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });
    fixture.document.activeElement = fixture.inspector;
    const escapeEvent = new FakeKeyboardEvent("Escape");

    fixture.document.dispatchEvent(escapeEvent);

    assert.equal(escapeEvent.defaultPrevented, true);
    assert.equal(fixture.catalogToggle.focused, true);
    assert.equal(fixture.catalogToggle.getAttribute("aria-expanded"), "false");

    const secondEscape = new FakeKeyboardEvent("Escape");
    fixture.document.activeElement = fixture.catalogToggle;
    fixture.document.dispatchEvent(secondEscape);
    assert.equal(secondEscape.defaultPrevented, false);
    assert.equal(fixture.timers.length, 1);
    controller.destroy();
});

test("Escape preserves native input handling and unrelated workspace state", () => {
    const fixture = createLayoutFixture();
    const rasterInput = new FakeLayoutElement({}, [], "INPUT");
    fixture.rasterRegion.addDescendant(rasterInput);
    fixture.document.activeElement = rasterInput;
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });
    const escapeEvent = new FakeKeyboardEvent("Escape");

    fixture.document.dispatchEvent(escapeEvent);

    assert.equal(escapeEvent.defaultPrevented, false);
    assert.equal(fixture.catalogToggle.getAttribute("aria-expanded"), "true");
    assert.equal(fixture.operationalBody.hidden, false);
    assert.equal(fixture.mapLayersBody.hidden, false);
    assert.equal(fixture.rasterBody.hidden, false);
    assert.equal(fixture.timers.length, 0);
    controller.destroy();
});

test("destroy detaches every EOMap layout disclosure listener", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });
    controller.destroy();

    fixture.catalogToggle.dispatchEvent(new Event("click"));
    fixture.collapsePanel.dispatchEvent(new Event("click"));
    fixture.openPanel.dispatchEvent(new Event("click"));
    fixture.operationalToggle.dispatchEvent(new Event("click"));
    fixture.mapLayersToggle.dispatchEvent(new Event("click"));
    fixture.rasterToggle.dispatchEvent(new Event("click"));
    fixture.document.dispatchEvent(new FakeKeyboardEvent("Escape"));

    assert.equal(fixture.app.classList.contains("is-catalog-workspace"), true);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.operationalBody.hidden, false);
    assert.equal(fixture.mapLayersBody.hidden, false);
    assert.equal(fixture.rasterBody.hidden, false);
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
});

test("composition delegates layout without adding feature knowledge", () => {
    const mainSource = readFileSync(
        new URL("../src/main.js", import.meta.url),
        "utf8"
    );
    const controllerSource = readFileSync(
        new URL("../src/eomap-layout-controller.js", import.meta.url),
        "utf8"
    );
    const controllerImports = [
        ...controllerSource.matchAll(/from\s+["']([^"']+)["']/g),
    ];

    assert.match(
        mainSource,
        /import \{ EomapLayoutController \} from "\.\/eomap-layout-controller\.js"/
    );
    assert.match(mainSource, /new EomapLayoutController\(\{/);
    assert.doesNotMatch(mainSource, /function initializeControlPanel/);
    assert.doesNotMatch(mainSource, /CONTROL_PANEL_TRANSITION_MILLISECONDS/);
    assert.equal(controllerImports.length, 0);
    assert.doesNotMatch(controllerSource, /querySelector\("#catalog-search"/);
    assert.doesNotMatch(controllerSource, /querySelector\("#raster-/);
    assert.doesNotMatch(controllerSource, /fetch\(|L\.|leafletMap/);
    assert.doesNotMatch(
        controllerSource,
        /append\(|appendChild\(|insertBefore\(|replaceChildren\(|matchMedia\(/
    );
});
