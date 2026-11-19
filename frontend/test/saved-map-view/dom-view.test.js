import assert from "node:assert/strict";
import test from "node:test";

import { SavedMapViewDomView } from "../../src/saved-map-view/dom-view.js";

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
      dispatch(type, event = {}) {
        for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
      },
    };
  }

  const selectors = new Map([
    ["#copy-map-link", element()],
    ["#copy-map-link-label", element()],
    ["#reset-map-view", element()],
    ["#undo-reset-map-view", element()],
    ["#show-unavailable-map-layers", element()],
    ["#unavailable-map-layers-label", element()],
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
  for (const name of ["editor", "editor-heading", "edit-title", "edit-subtitle", "edit-url", "save", "cancel", "edit-status"]) {
    selectors.set(`#published-map-${name}`, element());
  }
  for (const name of ["dialog", "form", "fields", "title", "subtitle", "slug", "preview", "status", "submit", "close", "result", "url", "open", "copy"]) {
    selectors.set(`#publish-map-${name}`, element());
  }
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

test("published-map editing shows fixed URL, explicit save, busy state and retained errors", () => {
  const { view, elements } = viewFixture();
  const el = name => elements.get(`#published-map-${name}`);
  let submitted;
  view.bind({ onSavePublishedMap: fields => { submitted = fields; } });
  view.showPublishedMapEditor({ title: "Amazon", subtitle: "Habitat", slug: "amazon" }, true);
  assert.equal(el("editor").hidden, false);
  assert.match(el("editor-heading").textContent, /Amazon/);
  assert.equal(el("edit-url").href, "/maps/amazon");
  el("edit-title").value = "New title";
  el("editor").dispatch("submit", { preventDefault() {} });
  assert.deepEqual(submitted, { title: "New title", subtitle: "Habitat" });
  view.setPublishedMapSaving(true);
  assert.equal(el("cancel").hidden, true);
  assert.equal(el("edit-title").disabled, true);
  view.showPublishedMapEditStatus("Save failed");
  view.setPublishedMapSaving(false);
  assert.equal(el("edit-title").value, "New title");
  assert.equal(el("edit-status").textContent, "Save failed");
  view.showPublishedMapEditor({ title: "Amazon", subtitle: "", slug: "amazon" }, false);
  assert.equal(el("save").disabled, false);
  assert.match(el("edit-status").textContent, /Review the map and any Unavailable layers before saving/);
  view.unbind();
});

test("publication dialog suggests editable names, keeps errors inline and exposes the canonical link", async () => {
  const { view, elements } = viewFixture();
  const el = name => elements.get(`#publish-map-${name}`);
  let submitted;
  view.bind({ onCopy() {}, onReset() {}, onUndo() {}, onPublish: fields => { submitted = fields; } });
  view.showPublicationForm({ title: "Amazon priorities", subtitle: "Explore habitat" });
  assert.equal(el("slug").value, "amazon-priorities");
  el("title").value = "Peru & Brazil";
  el("title").dispatch("input");
  assert.equal(el("slug").value, "peru-brazil");
  el("slug").value = "my-map";
  el("slug").dispatch("input");
  el("title").value = "New title";
  el("title").dispatch("input");
  assert.equal(el("slug").value, "my-map");
  el("subtitle").value = "";
  el("form").dispatch("submit", { preventDefault() {} });
  assert.deepEqual(submitted, { title: "New title", subtitle: "", slug: "my-map" });
  view.setPublicationBusy(true);
  assert.equal(el("fields").disabled, true);
  view.showPublicationError("Name already taken");
  view.setPublicationBusy(false);
  assert.equal(el("status").textContent, "Name already taken");
  assert.equal(el("slug").value, "my-map");
  view.showPublishedMap("my-map");
  assert.equal(el("open").href, "https://viewer.example/maps/my-map");
  assert.equal(el("fields").hidden, true);
  assert.equal(el("result").hidden, false);
  view.location.href = "https://viewer.example/maps/my-map?viewer=shared#private";
  assert.deepEqual(await view.copyNamedMapLink("my-map"), { copied: false, url: "https://viewer.example/maps/my-map" });
  view.unbind();
});

test("successful shared maps dismiss loading without a final click", () => {
  const { elements, view } = viewFixture();
  const dialog = elements.get("#saved-map-view-dialog");

  view.showLoading(2);
  assert.equal(elements.get("#saved-map-view-dialog-title").textContent,
    "Opening map…");
  assert.equal(elements.get("#saved-map-view-dialog-summary").textContent,
    "Loading 2 map items…");
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
    "Map partially opened");
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
    "Map opened with warnings");
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

test("unavailable saved layers remain reachable after closing the dialog and remove only on an explicit action", () => {
  const {elements, view} = viewFixture();
  const actions = [];
  const layers = [{index: 2, label: "Wetland density", sourceSite: "https://other.example", fields: ["Density"]}];
  view.bind({onShowUnavailableLayers: () => {actions.push("open"); view.showUnavailableLayers(layers);},
    onRemoveUnavailableLayer: index => actions.push(index)});
  view.setUnavailableLayerCount(1);
  const entry = elements.get("#show-unavailable-map-layers");
  assert.equal(entry.hidden, false);
  assert.equal(elements.get("#unavailable-map-layers-label").textContent, "Unavailable layers (1)");
  entry.click();
  const dialog = elements.get("#saved-map-view-dialog");
  assert.equal(dialog.open, true);
  const row = elements.get("#saved-map-view-dialog-details").children[0];
  assert.equal(row.children[0].textContent, "Wetland density");
  assert.equal(row.children[1].textContent, "Site: https://other.example");
  assert.equal(row.children[2].textContent, "Calculated fields: Density");
  dialog.close();
  entry.click();
  assert.deepEqual(actions, ["open", "open"]);
  elements.get("#saved-map-view-dialog-details").children[0].children[3].click();
  assert.deepEqual(actions, ["open", "open", 2]);
  view.setBusy(true);
  assert.equal(entry.disabled, true);
  view.setUnavailableLayerCount(0);
  view.showUnavailableLayers([]);
  assert.equal(entry.hidden, true);
  assert.equal(elements.get("#saved-map-view-dialog-details").hidden, true);
  assert.match(elements.get("#saved-map-view-dialog-summary").textContent, /No unavailable/);
  view.unbind();
});
