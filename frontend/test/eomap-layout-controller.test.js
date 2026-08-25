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
     */
    constructor(attributes = {}, classes = []) {
        super();
        this.attributes = new Map(Object.entries(attributes));
        this.classList = new FakeClassList(...classes);
        this.hidden = false;
        this.textContent = "";
        this.focused = false;
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

    /** Mark this element as the focus target. @return {void} */
    focus() {
        this.focused = true;
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
    const elements = new Map([
        ["#app", app],
        ["#control-panel", panel],
        ["#collapse-panel", collapsePanel],
        ["#open-panel", openPanel],
        ["#toggle-catalog-workspace", catalogToggle],
        ["#catalog-item-inspector", inspector],
    ]);
    const timers = [];
    return {
        app,
        catalogToggle,
        collapsePanel,
        document: new FakeLayoutDocument(elements),
        inspector,
        openPanel,
        panel,
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
    controller.destroy();
});

test("panel collapse and reopen preserve minimized Catalog state", () => {
    const fixture = createLayoutFixture();
    let invalidationCount = 0;
    new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize: () => invalidationCount += 1,
        schedule: fixture.schedule,
    });

    fixture.collapsePanel.dispatchEvent(new Event("click"));

    assert.equal(fixture.panel.classList.contains("is-collapsed"), true);
    assert.equal(fixture.openPanel.hidden, false);
    assert.equal(fixture.catalogToggle.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.timers.length, 1);

    fixture.openPanel.dispatchEvent(new Event("click"));

    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
    assert.equal(fixture.openPanel.hidden, true);
    assert.equal(fixture.catalogToggle.getAttribute("aria-expanded"), "false");
    assert.equal(fixture.timers.length, 2);
    for (const timer of fixture.timers) {
        timer.callback();
    }
    assert.equal(invalidationCount, 2);
});

test("Escape minimizes the Catalog workspace and returns disclosure focus", () => {
    const fixture = createLayoutFixture();
    const controller = new EomapLayoutController({
        documentContext: fixture.document,
        invalidateMapSize() {},
        schedule: fixture.schedule,
    });
    const escapeEvent = new FakeKeyboardEvent("Escape");

    fixture.document.dispatchEvent(escapeEvent);

    assert.equal(escapeEvent.defaultPrevented, true);
    assert.equal(fixture.catalogToggle.focused, true);
    assert.equal(fixture.catalogToggle.getAttribute("aria-expanded"), "false");

    const secondEscape = new FakeKeyboardEvent("Escape");
    fixture.document.dispatchEvent(secondEscape);
    assert.equal(secondEscape.defaultPrevented, false);
    assert.equal(fixture.timers.length, 1);
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
    fixture.document.dispatchEvent(new FakeKeyboardEvent("Escape"));

    assert.equal(fixture.app.classList.contains("is-catalog-workspace"), true);
    assert.equal(fixture.panel.classList.contains("is-collapsed"), false);
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
