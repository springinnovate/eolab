import assert from "node:assert/strict";
import test from "node:test";

import {
  createSavedMapViewUrl,
  SavedMapViewDomView,
} from "../../src/saved-map-view/dom-view.js";

/** Build the minimal semantic DOM required by the shared-map view. */
function viewFixture() {
  function element() {
    const listeners = new Map();
    const attributes = new Map();
    return {
      textContent: "",
      value: "",
      hidden: false,
      disabled: false,
      open: false,
      children: [],
      addEventListener(type, listener) {
        const handlers = listeners.get(type) ?? [];
        handlers.push(listener);
        listeners.set(type, handlers);
      },
      removeEventListener(type, listener) {
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((handler) => handler !== listener),
        );
      },
      setAttribute(name, value) { attributes.set(name, value); },
      removeAttribute(name) { attributes.delete(name); },
      replaceChildren() { this.children = []; },
      append(child) { this.children.push(child); },
      focus() {},
      select() {},
      showModal() { this.open = true; },
      close(returnValue = "") {
        this.open = false;
        this.returnValue = returnValue;
        for (const listener of [...(listeners.get("close") ?? [])]) listener();
        listeners.set("close", []);
      },
      click() {
        for (const listener of [...(listeners.get("click") ?? [])]) listener();
      },
    };
  }

  const selectors = new Map([
    ["#copy-map-link", element()],
    ["#copy-map-link-label", element()],
    ["#reset-map-view", element()],
    ["#undo-reset-map-view", element()],
    ["#saved-map-view-dialog", element()],
    ["#saved-map-view-dialog-title", element()],
    ["#saved-map-view-dialog-summary", element()],
    ["#saved-map-view-dialog-url", element()],
    ["#saved-map-view-dialog-details", element()],
    ["#cancel-open-map-view", element()],
  ]);
  const documentContext = {
    querySelector: (selector) => selectors.get(selector),
    createElement: () => element(),
  };
  selectors.get("#undo-reset-map-view").hidden = true;
  return {
    elements: selectors,
    view: new SavedMapViewDomView(documentContext, {
      locationContext: { href: "https://viewer.example/" },
      clipboard: null,
      setTimer: () => 1,
      clearTimer: () => {},
    }),
  };
}

test("saved map URL keeps the viewer location and replaces its fragment", () => {
  assert.equal(
    createSavedMapViewUrl(
      "https://viewer.example/map?preview=1#old-anchor",
      "#view=abc_123",
    ),
    "https://viewer.example/map?preview=1#view=abc_123",
  );
});

test("saved map URL requires the owned fragment prefix", () => {
  assert.throws(
    () => createSavedMapViewUrl("https://viewer.example/", "#other=value"),
    /complete saved-map fragment/,
  );
});

test("successful shared maps dismiss loading without a final click", () => {
  const { elements, view } = viewFixture();
  const dialog = elements.get("#saved-map-view-dialog");

  view.showLoading(2);
  assert.equal(elements.get("#saved-map-view-dialog-title").textContent,
    "Opening shared map…");
  assert.equal(elements.get("#saved-map-view-dialog-summary").textContent,
    "Loading 2 shared layers…");
  assert.equal(elements.get("#saved-map-view-dialog-details").hidden, true);
  assert.equal(dialog.open, true);

  view.showResults({ loaded: 2, total: 2, details: [] });

  assert.equal(dialog.open, false);
  assert.equal(dialog.returnValue, "loaded");
});

test("partial shared maps retain an actionable result dialog", () => {
  const { elements, view } = viewFixture();
  const dialog = elements.get("#saved-map-view-dialog");

  view.showLoading(2);
  view.showResults({
    loaded: 1,
    total: 2,
    details: ["Roads could not be loaded."],
  });

  assert.equal(dialog.open, true);
  assert.equal(elements.get("#saved-map-view-dialog-title").textContent,
    "Shared map view partially opened");
  assert.equal(elements.get("#cancel-open-map-view").textContent, "Close");
  assert.equal(elements.get("#saved-map-view-dialog-details").children.length, 1);
});

test("shared maps retain actionable restoration warnings", () => {
  const { elements, view } = viewFixture();

  view.showLoading(1);
  view.showResults({
    loaded: 1,
    total: 1,
    details: ["Roads: saved style was not applied."],
  });

  assert.equal(elements.get("#saved-map-view-dialog").open, true);
  assert.equal(elements.get("#saved-map-view-dialog-title").textContent,
    "Shared map opened with warnings");
});

test("saved map controls bind reset and one-step undo accessibly", () => {
  const { elements, view } = viewFixture();
  const actions = [];
  view.bind({
    onCopy: () => actions.push("copy"),
    onReset: () => actions.push("reset"),
    onUndo: () => actions.push("undo"),
  });

  elements.get("#copy-map-link").click();
  elements.get("#reset-map-view").click();
  view.showUndoReset();
  elements.get("#undo-reset-map-view").click();

  assert.deepEqual(actions, ["copy", "reset", "undo"]);
  assert.equal(elements.get("#reset-map-view").hidden, true);
  assert.equal(elements.get("#undo-reset-map-view").hidden, false);
  view.hideUndoReset();
  assert.equal(elements.get("#reset-map-view").hidden, false);
  assert.equal(elements.get("#undo-reset-map-view").hidden, true);

  view.setBusy(true);
  for (const selector of [
    "#copy-map-link", "#reset-map-view", "#undo-reset-map-view",
  ]) {
    assert.equal(elements.get(selector).disabled, true);
  }
});
