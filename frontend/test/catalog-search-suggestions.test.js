import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CATALOG_SEARCH_FILTERS,
  buildCatalogSearch,
} from "../src/catalog.js";
import {
  applyCatalogSearchSuggestion,
  CatalogSearchSuggestions,
  getCatalogSearchSuggestions,
  getCatalogSearchTokenRange,
} from "../src/catalog-search-suggestions.js";

class FakeElement extends EventTarget {
  constructor(ownerDocument) {
    super();
    this.attributes = new Map();
    this.children = [];
    this.hidden = false;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.textContent = "";
    this.value = "";
    this.style = {};
    this.bounds = { left: 40, top: 200, bottom: 236, width: 300, height: 128 };
    this.popoverOpen = false;
  }

  /** Return the layout supplied by the test. @return {Object} Element bounds. */
  getBoundingClientRect() { return this.bounds; }

  /** Show the native popup. @return {void} */
  showPopover() { this.popoverOpen = true; }

  /** Hide the native popup. @return {void} */
  hidePopover() { this.popoverOpen = false; }

  /** Record the option revealed by keyboard navigation. @param {Object} options Scroll alignment. @return {void} */
  scrollIntoView(options) { this.ownerDocument.scrolledOption = { element: this, options }; }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  contains(candidate) {
    if (candidate === null) return false;
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
}

class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.activeElement = null;
    this.elements = new Map();
    this.defaultView = Object.assign(new EventTarget(), { innerWidth: 1366, innerHeight: 768 });
  }

  createElement() {
    return new FakeElement(this);
  }

  querySelector(selector) {
    return this.elements.get(selector) ?? null;
  }
}

function keyboardEvent(key) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  Object.defineProperty(event, "stopPropagation", { value: () => {} });
  return event;
}

function createSuggestionFixture() {
  const document = new FakeDocument();
  const root = document.createElement("div");
  const input = document.createElement("input");
  const panel = document.createElement("div");
  const list = document.createElement("div");
  panel.hidden = true;
  root.append(input, panel);
  panel.append(list);
  document.elements.set("#catalog-search-combobox", root);
  document.elements.set("#catalog-search", input);
  document.elements.set("#catalog-search-suggestions", panel);
  document.elements.set("#catalog-search-suggestion-list", list);
  const component = new CatalogSearchSuggestions(document);
  return { component, document, input, list, panel, root };
}

test("Catalog filter descriptions are executable parser-owned syntax", () => {
  assert.deepEqual(
    CATALOG_SEARCH_FILTERS.map((filter) => filter.field),
    ["type", "type", "type", "date"],
  );
  for (const filter of CATALOG_SEARCH_FILTERS.filter(
    (candidate) => candidate.searchImmediately,
  )) {
    assert.doesNotThrow(() => buildCatalogSearch(filter.token));
  }
});

test("Catalog suggestions follow the current token and omit used fields", () => {
  assert.deepEqual(getCatalogSearchTokenRange("forest ty", 9), {
    start: 7,
    end: 9,
    text: "ty",
  });
  assert.deepEqual(
    getCatalogSearchSuggestions("forest ty", 9).map((filter) => filter.field),
    ["type", "type", "type"],
  );
  assert.deepEqual(
    getCatalogSearchSuggestions("datatype", 8).map((filter) => filter.token),
    ["type:raster", "type:vector", "type:temporal"],
  );
  assert.deepEqual(
    getCatalogSearchSuggestions("forest date:202", 15).map(
      (filter) => filter.field,
    ),
    ["date"],
  );
  assert.deepEqual(
    getCatalogSearchSuggestions("type:raster ", 12).map(
      (filter) => filter.field,
    ),
    ["date"],
  );
});

test("Catalog suggestion replacement preserves the rest of the query", () => {
  assert.deepEqual(
    applyCatalogSearchSuggestion(
      "forest ty date:2024",
      9,
      CATALOG_SEARCH_FILTERS[0],
    ),
    {
      value: "forest type:raster date:2024",
      caretPosition: 18,
    },
  );
});

test("Catalog search suggestions open, navigate, and apply from the keyboard", () => {
  const fixture = createSuggestionFixture();
  let inputEvents = 0;
  fixture.input.addEventListener("input", () => inputEvents += 1);
  fixture.input.value = "forest ty";
  fixture.input.setSelectionRange(9, 9);

  fixture.input.dispatchEvent(new Event("focus"));
  assert.equal(fixture.panel.hidden, false);
  assert.equal(fixture.panel.popoverOpen, true);
  assert.equal(fixture.input.getAttribute("aria-expanded"), "true");
  assert.equal(fixture.list.children.length, 3);

  fixture.input.dispatchEvent(keyboardEvent("ArrowDown"));
  assert.equal(
    fixture.input.getAttribute("aria-activedescendant"),
    "catalog-search-suggestion-type-raster",
  );
  fixture.input.dispatchEvent(keyboardEvent("Enter"));

  assert.equal(fixture.input.value, "forest type:raster");
  assert.equal(fixture.input.selectionStart, 18);
  assert.equal(fixture.panel.hidden, true);
  assert.equal(fixture.panel.popoverOpen, false);
  assert.equal(fixture.input.getAttribute("aria-expanded"), "false");
  assert.equal(inputEvents, 1);
});

test("Raster, vector and temporal type suggestions have unique accessible options", () => {
  const fixture = createSuggestionFixture();
  let inputEvents = 0;
  fixture.input.addEventListener("input", () => inputEvents += 1);
  fixture.input.value = "datatype";
  fixture.input.setSelectionRange(8, 8);

  fixture.input.dispatchEvent(new Event("focus"));

  assert.deepEqual(
    fixture.list.children.map((option) => option.id),
    [
      "catalog-search-suggestion-type-raster",
      "catalog-search-suggestion-type-vector",
      "catalog-search-suggestion-type-temporal",
    ],
  );
  fixture.list.children[1].dispatchEvent(new Event("click"));
  assert.equal(fixture.input.value, "type:vector");
  assert.equal(inputEvents, 1);
});

test("Incomplete date help leaves the caret ready without running a search", () => {
  const fixture = createSuggestionFixture();
  let inputEvents = 0;
  fixture.input.addEventListener("input", () => inputEvents += 1);
  fixture.input.dispatchEvent(new Event("focus"));

  fixture.list.children[3].dispatchEvent(new Event("click"));

  assert.equal(fixture.input.value, "date:");
  assert.equal(fixture.input.selectionStart, 5);
  assert.equal(fixture.panel.hidden, true);
  assert.equal(inputEvents, 0);
});

test("Escape dismisses Catalog suggestions without changing the query", () => {
  const fixture = createSuggestionFixture();
  fixture.input.value = "forest";
  fixture.input.dispatchEvent(new Event("focus"));
  const escape = keyboardEvent("Escape");

  fixture.input.dispatchEvent(escape);

  assert.equal(escape.defaultPrevented, true);
  assert.equal(fixture.input.value, "forest");
  assert.equal(fixture.panel.hidden, true);
});

test("Using every Catalog filter closes the helper instead of showing an empty popup", () => {
  const { component, input, panel } = createSuggestionFixture();
  component.open();
  input.value = "type:raster date:2020 ";
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event("input"));
  assert.equal(panel.popoverOpen, false);
  assert.equal(input.getAttribute("aria-expanded"), "false");
});

test("Arrow Up starts at the final Catalog suggestion", () => {
  const fixture = createSuggestionFixture();
  fixture.input.dispatchEvent(new Event("focus"));

  fixture.input.dispatchEvent(keyboardEvent("ArrowUp"));

  assert.equal(
    fixture.input.getAttribute("aria-activedescendant"),
    "catalog-search-suggestion-date",
  );
  assert.equal(fixture.document.scrolledOption.element.id, "catalog-search-suggestion-date");
  assert.deepEqual(fixture.document.scrolledOption.options, { block: "nearest" });
});

test("Catalog suggestions stay above the input and follow viewport and scroll changes", () => {
  const { component, document, input, panel } = createSuggestionFixture();
  component.open();
  assert.equal(panel.style.top, "68px");
  assert.equal(panel.style.left, "40px");
  assert.equal(panel.style.maxHeight, "160px");

  document.defaultView.innerWidth = 320;
  document.defaultView.dispatchEvent(new Event("resize"));
  assert.equal(panel.style.left, "12px");

  input.bounds = { left: 40, top: 24, bottom: 60, width: 300 };
  document.dispatchEvent(new Event("scroll"));
  assert.equal(panel.style.top, "64px", "use a short list below when the input is near the top edge");
  assert.equal(panel.style.maxHeight, "160px");

  input.bounds = { left: 40, top: -40, bottom: -4, width: 300 };
  document.dispatchEvent(new Event("scroll"));
  assert.equal(panel.popoverOpen, false, "hide suggestions when their input scrolls offscreen");

  input.bounds = { left: 40, top: 24, bottom: 60, width: 300 };
  component.open();
  const focusout = new Event("focusout");
  Object.defineProperty(focusout, "relatedTarget", { value: null });
  component.root.dispatchEvent(focusout);
  assert.equal(panel.popoverOpen, false);
  assert.equal(input.getAttribute("aria-expanded"), "false");
});

test("Catalog suggestion markup retains an accessible listbox outside pane clipping", () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const mainSource = readFileSync(
    new URL("../src/main.js", import.meta.url),
    "utf8",
  );
  const stylesheet = readFileSync(
    new URL("../src/style.css", import.meta.url),
    "utf8",
  );

  assert.match(markup, /id="catalog-search"[\s\S]*role="combobox"/);
  assert.match(markup, /id="catalog-search-suggestion-list"[\s\S]*role="listbox"/);
  assert.match(markup, /id="catalog-search-suggestions"\s+popover="manual"/);
  assert.match(mainSource, /new CatalogSearchSuggestions\(document\)/);
  assert.match(
    stylesheet,
    /\.catalog-search-suggestions\s*\{[^}]*position:\s*fixed/s,
  );
  assert.match(
    stylesheet,
    /\.catalog-search-suggestions\[hidden\],[^{]*\{[^}]*display:\s*none/s,
  );
});
