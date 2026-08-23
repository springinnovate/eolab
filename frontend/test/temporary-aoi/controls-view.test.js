import assert from "node:assert/strict";
import test from "node:test";

import { TemporaryAoiControlsView } from "../../src/temporary-aoi/controls-view.js";

/** Minimal inspectable DOM element for temporary-AOI view tests. */
class FakeElement extends EventTarget {
  /**
   * Create a semantic element with mutable presentation properties.
   */
  constructor() {
    super();
    this.attributes = new Map();
    this.children = [];
    this.dateTime = "";
    this.disabled = false;
    this.files = [];
    this.focused = false;
    this.hidden = false;
    this.textContent = "";
    this.value = "";
  }

  /**
   * Store one serialized attribute.
   *
   * @param {string} name Attribute name.
   * @param {string} value Attribute value.
   * @return {void}
   */
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  /**
   * Return one serialized attribute.
   *
   * @param {string} name Attribute name.
   * @return {string|null} Attribute value or null when absent.
   */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  /**
   * Replace all child elements.
   *
   * @param {...FakeElement} children Replacement child elements.
   * @return {void}
   */
  replaceChildren(...children) {
    this.children = children;
  }

  /**
   * Append one child element.
   *
   * @param {FakeElement} child Child element.
   * @return {void}
   */
  append(child) {
    this.children.push(child);
  }

  /**
   * Record keyboard focus.
   *
   * @return {void}
   */
  focus() {
    this.focused = true;
  }
}

/**
 * Create all fixed elements required by TemporaryAoiControlsView.
 *
 * @return {{document: Object, elements: Map<string, FakeElement>}} DOM fixture.
 */
function createDocumentFixture() {
  const selectors = [
    "#temporary-aoi-upload-form",
    "#temporary-aoi-file",
    "#upload-temporary-aoi",
    "#temporary-aoi-selection-form",
    "#temporary-aoi-dataset",
    "#temporary-aoi-selection-filename",
    "#cancel-temporary-aoi-selection",
    "#temporary-aoi-details",
    "#temporary-aoi-filename",
    "#temporary-aoi-layer",
    "#temporary-aoi-expiration",
    "#temporary-aoi-actions",
    "#toggle-temporary-aoi",
    "#zoom-temporary-aoi",
    "#remove-temporary-aoi",
    "#temporary-aoi-status",
    "#temporary-aoi-error",
    "#temporary-aoi",
  ];
  const elements = new Map(
    selectors.map((selector) => [selector, new FakeElement()]),
  );
  return {
    elements,
    document: {
      querySelector: (selector) => elements.get(selector) ?? null,
      createElement: () => new FakeElement(),
    },
  };
}

test("temporary AOI controls expose native interaction events and detach cleanly", () => {
  const fixture = createDocumentFixture();
  const view = new TemporaryAoiControlsView(fixture.document);
  const calls = [];
  const handlers = {
    onUpload: () => calls.push("upload"),
    onSelectDataset: () => calls.push("select"),
    onCancelSelection: () => calls.push("cancel"),
    onToggleVisibility: () => calls.push("toggle"),
    onZoom: () => calls.push("zoom"),
    onRemove: () => calls.push("remove"),
  };
  view.bind(handlers);

  fixture.elements.get("#temporary-aoi-upload-form").dispatchEvent(
    new Event("submit"),
  );
  fixture.elements.get("#temporary-aoi-selection-form").dispatchEvent(
    new Event("submit"),
  );
  fixture.elements.get("#cancel-temporary-aoi-selection").dispatchEvent(
    new Event("click"),
  );
  fixture.elements.get("#toggle-temporary-aoi").dispatchEvent(new Event("click"));
  fixture.elements.get("#zoom-temporary-aoi").dispatchEvent(new Event("click"));
  fixture.elements.get("#remove-temporary-aoi").dispatchEvent(new Event("click"));

  assert.deepEqual(calls, ["upload", "select", "cancel", "toggle", "zoom", "remove"]);

  view.unbind();
  fixture.elements.get("#toggle-temporary-aoi").dispatchEvent(new Event("click"));
  assert.deepEqual(calls, ["upload", "select", "cancel", "toggle", "zoom", "remove"]);
});

test("temporary AOI controls render selection, metadata, visibility, errors, and focus", () => {
  const fixture = createDocumentFixture();
  const view = new TemporaryAoiControlsView(fixture.document);

  view.renderIdle();
  assert.equal(view.selectionForm.hidden, true);
  assert.equal(view.details.hidden, true);
  assert.equal(view.actions.hidden, true);
  assert.equal(view.region.getAttribute("aria-busy"), "false");

  view.renderBusy("Validating…");
  assert.equal(view.region.getAttribute("aria-busy"), "true");
  assert.equal(view.fileInput.disabled, true);
  assert.equal(view.status.textContent, "Validating…");

  view.renderSelection({
    filename: "layers.gpkg",
    choices: [
      { id: "opaque-a", label: "First layer" },
      { id: "opaque-b", label: "Second layer" },
    ],
  });
  assert.equal(view.selectionForm.hidden, false);
  assert.equal(view.selectionSelect.children.length, 2);
  assert.equal(view.selectionSelect.children[1].value, "opaque-b");
  assert.equal(view.selectionSelect.focused, true);

  view.renderReady(
    {
      filename: "layers.gpkg",
      selectedDataset: "Second layer",
      expiresAt: "2030-01-01T00:30:00Z",
    },
    true,
  );
  assert.equal(view.filename.textContent, "layers.gpkg");
  assert.equal(view.dataset.textContent, "Second layer");
  assert.equal(view.expiration.dateTime, "2030-01-01T00:30:00Z");
  assert.equal(view.toggleButton.getAttribute("aria-pressed"), "true");
  assert.equal(view.toggleButton.textContent, "Hide");
  assert.equal(view.uploadButton.textContent, "Replace AOI");

  view.renderVisibility(false);
  assert.equal(view.toggleButton.getAttribute("aria-pressed"), "false");
  assert.equal(view.toggleButton.textContent, "Show");

  view.renderError(new Error("Unsupported CRS."), "Choose another file.");
  assert.equal(view.error.textContent, "Unsupported CRS. Choose another file.");
  assert.equal(view.region.getAttribute("aria-busy"), "false");

  view.focusFile();
  assert.equal(view.fileInput.focused, true);
});

test("temporary AOI controls fail fast when required semantic markup is absent", () => {
  assert.throws(
    () => new TemporaryAoiControlsView({ querySelector: () => null }),
    /Temporary AOI control is required/,
  );
});
