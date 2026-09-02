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
  }

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

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.elements = new Map();
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
    ["format", "type", "type", "date"],
  );
  for (const filter of CATALOG_SEARCH_FILTERS.filter(
    (candidate) => candidate.searchImmediately,
  )) {
    assert.doesNotThrow(() => buildCatalogSearch(filter.token));
  }
});

test("Catalog suggestions follow the current token and omit used fields", () => {
  assert.deepEqual(getCatalogSearchTokenRange("forest fo", 9), {
    start: 7,
    end: 9,
    text: "fo",
  });
  assert.deepEqual(
    getCatalogSearchSuggestions("forest fo", 9).map((filter) => filter.field),
    ["format"],
  );
  assert.deepEqual(
    getCatalogSearchSuggestions("datatype", 8).map((filter) => filter.token),
    ["format:cog", "type:raster", "type:vector"],
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
    ["format", "date"],
  );
});

test("Catalog suggestion replacement preserves the rest of the query", () => {
  assert.deepEqual(
    applyCatalogSearchSuggestion(
      "forest fo date:2024",
      9,
      CATALOG_SEARCH_FILTERS[0],
    ),
    {
      value: "forest format:cog date:2024",
      caretPosition: 17,
    },
  );
});

test("Catalog search suggestions open, navigate, and apply from the keyboard", () => {
  const fixture = createSuggestionFixture();
  let inputEvents = 0;
  fixture.input.addEventListener("input", () => inputEvents += 1);
  fixture.input.value = "forest fo";
  fixture.input.setSelectionRange(9, 9);

  fixture.input.dispatchEvent(new Event("focus"));
  assert.equal(fixture.panel.hidden, false);
  assert.equal(fixture.input.getAttribute("aria-expanded"), "true");
  assert.equal(fixture.list.children.length, 1);

  fixture.input.dispatchEvent(keyboardEvent("ArrowDown"));
  assert.equal(
    fixture.input.getAttribute("aria-activedescendant"),
    "catalog-search-suggestion-format-cog",
  );
  fixture.input.dispatchEvent(keyboardEvent("Enter"));

  assert.equal(fixture.input.value, "forest format:cog");
  assert.equal(fixture.input.selectionStart, 17);
  assert.equal(fixture.panel.hidden, true);
  assert.equal(fixture.input.getAttribute("aria-expanded"), "false");
  assert.equal(inputEvents, 1);
});

test("Raster and vector type suggestions have unique accessible options", () => {
  const fixture = createSuggestionFixture();
  let inputEvents = 0;
  fixture.input.addEventListener("input", () => inputEvents += 1);
  fixture.input.value = "datatype";
  fixture.input.setSelectionRange(8, 8);

  fixture.input.dispatchEvent(new Event("focus"));

  assert.deepEqual(
    fixture.list.children.map((option) => option.id),
    [
      "catalog-search-suggestion-format-cog",
      "catalog-search-suggestion-type-raster",
      "catalog-search-suggestion-type-vector",
    ],
  );
  fixture.list.children[2].dispatchEvent(new Event("click"));
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

test("Arrow Up starts at the final Catalog suggestion", () => {
  const fixture = createSuggestionFixture();
  fixture.input.dispatchEvent(new Event("focus"));

  fixture.input.dispatchEvent(keyboardEvent("ArrowUp"));

  assert.equal(
    fixture.input.getAttribute("aria-activedescendant"),
    "catalog-search-suggestion-date",
  );
});

test("Catalog suggestion markup and CSS form an overlaid accessible listbox", () => {
  const markup = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const stylesheet = readFileSync(
    new URL("../src/style.css", import.meta.url),
    "utf8",
  );

  assert.match(markup, /id="catalog-search"[\s\S]*role="combobox"/);
  assert.match(markup, /id="catalog-search-suggestion-list"[\s\S]*role="listbox"/);
  assert.match(markup, /Words match filenames, descriptions, and indexed dates/);
  assert.match(
    stylesheet,
    /\.catalog-search-suggestions\s*\{[^}]*position:\s*absolute[^}]*z-index:/s,
  );
  assert.match(
    stylesheet,
    /\.catalog-search-suggestions\[hidden\]\s*\{[^}]*display:\s*none/s,
  );
});
