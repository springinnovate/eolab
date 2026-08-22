import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { initializeCatalogPaneControls } from "../src/catalog-pane-controller.js";

class FakeClassList {
  constructor() {
    this.tokens = new Set();
  }

  toggle(token, force) {
    if (force) {
      this.tokens.add(token);
    } else {
      this.tokens.delete(token);
    }
  }

  contains(token) {
    return this.tokens.has(token);
  }
}

class FakeElement extends EventTarget {
  constructor(attributes = {}) {
    super();
    this.attributes = new Map(Object.entries(attributes));
    this.classList = new FakeClassList();
    this.hidden = false;
    this.textContent = "";
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
}

function createCatalogPaneFixture() {
  const layout = new FakeElement();
  const resultsPane = new FakeElement();
  const resultsBody = new FakeElement();
  const resultsToggle = new FakeElement({ "aria-expanded": "true" });
  const inspectorPane = new FakeElement();
  const inspectorBody = new FakeElement();
  const inspectorToggle = new FakeElement({ "aria-expanded": "true" });
  const elements = new Map([
    ["#catalog-layout", layout],
    ["#catalog-results-pane", resultsPane],
    ["#catalog-results-body", resultsBody],
    ["#toggle-catalog-results", resultsToggle],
    ["#catalog-item-inspector", inspectorPane],
    ["#catalog-inspector-body", inspectorBody],
    ["#toggle-catalog-inspector", inspectorToggle],
  ]);
  return {
    document: { querySelector: (selector) => elements.get(selector) ?? null },
    inspectorBody,
    inspectorPane,
    inspectorToggle,
    layout,
    resultsBody,
    resultsPane,
    resultsToggle,
  };
}

test("Catalog panes start expanded and collapse without coupling state", () => {
  const fixture = createCatalogPaneFixture();
  initializeCatalogPaneControls(fixture.document);

  assert.equal(fixture.resultsBody.hidden, false);
  assert.equal(fixture.inspectorBody.hidden, false);
  assert.equal(fixture.resultsToggle.textContent, "Collapse Catalog results");
  assert.equal(fixture.inspectorToggle.textContent, "Collapse Selected record");

  fixture.resultsToggle.dispatchEvent(new Event("click"));

  assert.equal(fixture.resultsBody.hidden, true);
  assert.equal(fixture.resultsToggle.getAttribute("aria-expanded"), "false");
  assert.equal(fixture.resultsToggle.textContent, "Expand Catalog results");
  assert.equal(fixture.resultsPane.classList.contains("is-collapsed"), true);
  assert.equal(
    fixture.layout.classList.contains("is-catalog-browser-collapsed"),
    true,
  );
  assert.equal(fixture.inspectorBody.hidden, false);
  assert.equal(fixture.inspectorToggle.getAttribute("aria-expanded"), "true");
  assert.equal(
    fixture.layout.classList.contains("is-catalog-inspector-collapsed"),
    false,
  );

  fixture.inspectorToggle.dispatchEvent(new Event("click"));
  fixture.resultsToggle.dispatchEvent(new Event("click"));

  assert.equal(fixture.resultsBody.hidden, false);
  assert.equal(fixture.inspectorBody.hidden, true);
  assert.equal(
    fixture.layout.classList.contains("is-catalog-browser-collapsed"),
    false,
  );
  assert.equal(
    fixture.layout.classList.contains("is-catalog-inspector-collapsed"),
    true,
  );
});

test("Catalog pane markup uses named native disclosure buttons", () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  assert.match(
    markup,
    /<button\s+class="secondary-button catalog-pane-toggle"\s+id="toggle-catalog-results"\s+type="button"\s+aria-controls="catalog-results-body"\s+aria-expanded="true"\s*>/,
  );
  assert.match(
    markup,
    /<button\s+class="secondary-button catalog-pane-toggle"\s+id="toggle-catalog-inspector"\s+type="button"\s+aria-controls="catalog-inspector-body"\s+aria-expanded="true"\s*>/,
  );
  assert.match(markup, /Collapse Catalog results/);
  assert.match(markup, /Collapse Selected record/);
});

test("Catalog layout owns independent scroll regions and expansion rules", () => {
  const stylesheet = readFileSync(
    new URL("../src/style.css", import.meta.url),
    "utf8",
  );

  assert.match(stylesheet, /\.catalog-panel\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(
    stylesheet,
    /\.catalog-results-scroll\s*\{[^}]*overflow-y:\s*auto/s,
  );
  assert.match(
    stylesheet,
    /\.catalog-inspector-body\s*\{[^}]*overflow-y:\s*auto/s,
  );
  assert.match(
    stylesheet,
    /\.catalog-pane-body\[hidden\]\s*\{[^}]*display:\s*none/s,
  );
  assert.match(
    stylesheet,
    /\.catalog-inspector\s*\{[^}]*overflow:\s*hidden/s,
  );
  assert.match(stylesheet, /is-catalog-browser-collapsed/);
  assert.match(stylesheet, /is-catalog-inspector-collapsed/);
  assert.match(
    stylesheet,
    /\.catalog-pane\.is-collapsed \.catalog-pane-heading\s*\{[^}]*flex-direction:\s*column/s,
  );
  assert.match(stylesheet, /grid-template-rows:\s*minmax\(0, 1fr\) auto/);
  assert.match(stylesheet, /grid-template-rows:\s*auto minmax\(0, 1fr\)/);
});
